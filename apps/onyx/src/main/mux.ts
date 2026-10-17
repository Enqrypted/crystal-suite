// Turns a clip the helper wrote out (a JSON header line, then H.264 and AAC packets; see Recorder.Save in
// native/OnyxHelper.cs) into an MP4. Nothing is re-encoded: the packets go into the file as they are.
import fs from 'fs';
import { ALL_FORMATS, EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, FilePathSource, FilePathTarget, Input, Mp4OutputFormat, Output } from 'mediabunny';

export interface DumpHeader {
  version: number;
  width: number;
  height: number;
  fps: number;
  /** SPS and PPS (Annex B), base64; added in front of the first frame when it doesn't carry them itself. */
  videoHeader: string;
  /** AAC AudioSpecificConfig, base64; empty when the clip has no sound. */
  audioConfig: string;
  /** Time of the first frame (100 ns units on the helper's clock). */
  start: number;
  encoder: string;
}

interface Record { track: number; key: boolean; time: number; duration: number; data: Uint8Array }

/** Reads the dump front to back in large pieces. */
class DumpReader {
  private buf = Buffer.alloc(0);
  private pos = 0;
  private eof = false;
  private chunk = Buffer.alloc(8 << 20);

  constructor(private fd: fs.promises.FileHandle) {}

  private async fill(need: number) {
    while (this.buf.length - this.pos < need && !this.eof) {
      const { bytesRead } = await this.fd.read(this.chunk, 0, this.chunk.length, null);
      if (bytesRead === 0) { this.eof = true; break; }
      this.buf = Buffer.concat([this.buf.subarray(this.pos), this.chunk.subarray(0, bytesRead)]);
      this.pos = 0;
    }
    return this.buf.length - this.pos >= need;
  }

  async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf(0x0a, this.pos);
      if (i >= 0) { const s = this.buf.toString('utf8', this.pos, i); this.pos = i + 1; return s; }
      if (!(await this.fill(this.buf.length - this.pos + 1))) throw new Error('The clip file is incomplete.');
    }
  }

  async next(): Promise<Record | null> {
    if (!(await this.fill(22))) return null;
    const b = this.buf, p = this.pos;
    const track = b[p], key = b[p + 1] === 1;
    const time = Number(b.readBigInt64LE(p + 2)), duration = Number(b.readBigInt64LE(p + 10));
    const len = b.readInt32LE(p + 18);
    if (len < 0 || !(await this.fill(22 + len))) throw new Error('The clip file is incomplete.');
    const start = this.pos + 22;
    // a copy: the reader's buffer is reused for what follows
    const data = new Uint8Array(this.buf.subarray(start, start + len));
    this.pos = start + len;
    return { track, key, time, duration, data };
  }
}

/** NAL unit types in an Annex B packet. */
function nalTypes(data: Uint8Array): number[] {
  const types: number[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const at = data[i + 2] === 1 ? i + 3 : i + 4;
      if (at < data.length) types.push(data[at] & 0x1f);
      i = at;
    }
  }
  return types;
}

/** "avc1.PPCCLL" from the SPS (profile, constraint flags, level). */
function avcCodec(data: Uint8Array): string {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7 && i + 6 < data.length) {
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`;
    }
  }
  return 'avc1.640028';
}

/** Length and picture size of a video file (null when it can't be read). */
export async function probeClip(file: string): Promise<{ duration: number; width: number; height: number } | null> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    const v = await input.getPrimaryVideoTrack();
    const duration = await input.computeDuration();
    return { duration: Math.round(duration * 100) / 100, width: v?.displayWidth ?? 0, height: v?.displayHeight ?? 0 };
  } catch { return null; } finally { input.dispose(); }
}

export interface MuxResult { duration: number; width: number; height: number; video: number; audio: number }

/**
 * Writes `dump` as an MP4 at `out`. `counts` (from the helper's save reply) lets the index go at the front of
 * the file, so the clip starts playing at once when it is shared.
 */
export async function muxDump(dump: string, out: string, counts: { videoPackets: number; audioPackets: number }): Promise<MuxResult> {
  const fd = await fs.promises.open(dump, 'r');
  let output: Output | null = null;
  try {
    const reader = new DumpReader(fd);
    const header = JSON.parse(await reader.line()) as DumpHeader;
    if (header.version !== 1) throw new Error('This clip was written by a newer Onyx.');
    const hasAudio = !!header.audioConfig && counts.audioPackets > 0;
    output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new FilePathTarget(out) });
    const video = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(video, { frameRate: header.fps, maximumPacketCount: counts.videoPackets + 2 });
    const audio = hasAudio ? new EncodedAudioPacketSource('aac') : null;
    if (audio) output.addAudioTrack(audio, { maximumPacketCount: counts.audioPackets + 2 });
    await output.start();

    const seqHeader = header.videoHeader ? new Uint8Array(Buffer.from(header.videoHeader, 'base64')) : null;
    const asc = hasAudio ? new Uint8Array(Buffer.from(header.audioConfig, 'base64')) : null;
    const t0 = header.start;
    let firstVideo = true, firstAudio = true, lastVideoEnd = 0, nVideo = 0, nAudio = 0;
    for (let r = await reader.next(); r; r = await reader.next()) {
      const ts = Math.max(0, (r.time - t0) / 1e7), dur = Math.max(0, r.duration / 1e7);
      if (r.track === 0) {
        let data = r.data;
        if (firstVideo) {
          // the MP4's decoder configuration comes from the SPS/PPS, which the first frame needs to carry
          if (seqHeader && !nalTypes(data).includes(7)) {
            const joined = new Uint8Array(seqHeader.length + data.length);
            joined.set(seqHeader, 0);
            joined.set(data, seqHeader.length);
            data = joined;
          }
          await video.add(new EncodedPacket(data, 'key', ts, dur), {
            decoderConfig: { codec: avcCodec(data), codedWidth: header.width, codedHeight: header.height },
          });
          firstVideo = false;
        } else {
          await video.add(new EncodedPacket(data, r.key ? 'key' : 'delta', ts, dur));
        }
        lastVideoEnd = Math.max(lastVideoEnd, ts + dur);
        nVideo++;
      } else if (audio && asc && nVideo > 0) {
        // sound from before the first frame is left out, so both tracks start together
        const packet = new EncodedPacket(r.data, 'key', ts, dur);
        if (firstAudio) {
          await audio.add(packet, { decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: asc } });
          firstAudio = false;
        } else await audio.add(packet);
        nAudio++;
      }
    }
    if (!nVideo) throw new Error('The clip has no video.');
    video.close();
    audio?.close();
    await output.finalize();
    output = null;
    return { duration: lastVideoEnd, width: header.width, height: header.height, video: nVideo, audio: nAudio };
  } catch (e) {
    if (output) { try { await output.cancel(); } catch { /* already failed */ } }
    fs.rmSync(out, { force: true });
    throw e;
  } finally {
    await fd.close();
  }
}
