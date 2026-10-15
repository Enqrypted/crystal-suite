// Rendering: composites every frame with the preview's compositor, mixes audio offline in segments,
// encodes with WebCodecs (H.264 + AAC in MP4, or VP9 + Opus in WebM) and streams the file to disk.
import {
  Output, Mp4OutputFormat, WebMOutputFormat, StreamTarget, CanvasSource, AudioBufferSource,
  QUALITY_VERY_HIGH, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_LOW, canEncodeVideo, canEncodeAudio,
  type StreamTargetChunk,
} from 'mediabunny';
import { native } from './native';
import { media } from './media';
import { FrameStream, type Drawable } from './frames';
import { drawFrame, visualClipsAt } from './compositor';
import { decodeNeeded, renderMix } from './audio';
import { clipEnd, overlapMap, sourceTime, type Project } from './model';

export type RenderFormat = 'mp4' | 'webm';
export type RenderQuality = 'best' | 'high' | 'good' | 'small';

export interface RenderOptions {
  path: string;
  format: RenderFormat;
  width: number;
  height: number;
  fps: number;
  quality: RenderQuality;
  audioBitrate: number;
  from: number;
  to: number;
}

export interface RenderProgress {
  frame: number;
  frames: number;
  elapsed: number;
  fps: number;
}

const SAMPLE_RATE = 48000;
const AUDIO_SEGMENT = 5 * SAMPLE_RATE; // mix 5 s at a time

/** Which formats this computer can encode. */
export async function encoderSupport(width: number, height: number) {
  const [avc, aac, vp9, opus] = await Promise.all([
    canEncodeVideo('avc', { width, height }), canEncodeAudio('aac'), canEncodeVideo('vp9', { width, height }), canEncodeAudio('opus'),
  ]);
  return { mp4: avc && aac, webm: vp9 && opus };
}

/** Rough output size in bytes for the given options. */
export function estimateSize(o: Pick<RenderOptions, 'width' | 'height' | 'fps' | 'quality' | 'audioBitrate' | 'format'>, seconds: number) {
  const bpp = { best: 0.2, high: 0.12, good: 0.07, small: 0.035 }[o.quality] * (o.format === 'webm' ? 0.8 : 1);
  const video = o.width * o.height * Math.min(o.fps, 60) * bpp;
  return ((video + o.audioBitrate) * seconds) / 8;
}

export async function render(p: Project, o: RenderOptions, onProgress: (pr: RenderProgress, canvas: OffscreenCanvas) => void, signal: AbortSignal) {
  const W = Math.round(o.width / 2) * 2;
  const H = Math.round(o.height / 2) * 2;
  const frames = Math.max(1, Math.round((o.to - o.from) * o.fps));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingQuality = 'high';
  const overlaps = overlapMap(p);
  const streams = new Map<string, FrameStream>();
  const hasAudio = p.clips.some((c) => c.mediaId && !c.mute && p.tracks.find((t) => t.id === c.trackId)?.kind === 'audio');
  const handle = await native.openWrite(o.path);
  let ok = false;
  let output: Output | null = null;
  try {
    const writable = new WritableStream<StreamTargetChunk>({ write: (chunk) => native.writeAt(handle, chunk.data, chunk.position) });
    output = new Output({
      format: o.format === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 4 * 2 ** 20 }),
    });
    const bitrate = { best: QUALITY_VERY_HIGH, high: QUALITY_HIGH, good: QUALITY_MEDIUM, small: QUALITY_LOW }[o.quality];
    const video = new CanvasSource(canvas, { codec: o.format === 'mp4' ? 'avc' : 'vp9', bitrate, keyFrameInterval: 2 });
    output.addVideoTrack(video, { frameRate: o.fps });
    let sound: AudioBufferSource | null = null;
    if (hasAudio) {
      sound = new AudioBufferSource({ codec: o.format === 'mp4' ? 'aac' : 'opus', bitrate: o.audioBitrate });
      output.addAudioTrack(sound);
      await decodeNeeded(p, o.from, o.to);
    }
    await output.start();

    const startSample = Math.round(o.from * SAMPLE_RATE);
    const totalSamples = Math.max(1, Math.round((o.to - o.from) * SAMPLE_RATE));
    let mixed = 0; // samples of audio already added
    const mixUntil = async (t: number) => {
      if (!sound) return;
      const target = Math.min(totalSamples, Math.ceil((t - o.from) * SAMPLE_RATE));
      while (mixed < target) {
        const n = Math.min(AUDIO_SEGMENT, totalSamples - mixed);
        const a = (startSample + mixed) / SAMPLE_RATE;
        const buf = await renderMix(p, a, a + n / SAMPLE_RATE, SAMPLE_RATE);
        await sound.add(buf);
        mixed += n;
      }
    };

    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException('Render cancelled', 'AbortError');
      const t = o.from + i / o.fps;
      await mixUntil(t + 2); // keep audio a little ahead so the file interleaves nicely
      const needed = visualClipsAt(p, t, overlaps);
      const got = new Map<string, Drawable | null>();
      for (const c of needed) {
        const r = media.get(c.mediaId);
        if (!r || r.status !== 'ready') { got.set(c.id, null); continue; }
        if (r.image) { got.set(c.id, r.image); continue; }
        let s = streams.get(c.id);
        if (!s) {
          const sink = media.videoSink(c.mediaId);
          if (!sink) { got.set(c.id, null); continue; }
          s = new FrameStream(sink, Math.max(0, sourceTime(c, t)), 8);
          streams.set(c.id, s);
        }
        got.set(c.id, await s.at(sourceTime(c, t)));
      }
      drawFrame(ctx, p, t, W, H, overlaps, (clip) => got.get(clip.id) ?? null);
      await video.add(i / o.fps, 1 / o.fps);
      // free decoders of clips that are over
      for (const [id, s] of streams) {
        const c = p.clips.find((x) => x.id === id);
        if (!c || clipEnd(c) <= t) { s.close(); streams.delete(id); }
      }
      if (i % 3 === 0 || i === frames - 1) {
        const elapsed = (performance.now() - t0) / 1000;
        onProgress({ frame: i + 1, frames, elapsed, fps: (i + 1) / Math.max(0.001, elapsed) }, canvas);
      }
    }
    await mixUntil(o.to + 1);
    video.close();
    sound?.close();
    await output.finalize();
    ok = true;
  } catch (e) {
    if (output && output.state !== 'finalized') await output.cancel().catch(() => {});
    throw e;
  } finally {
    for (const s of streams.values()) s.close();
    await native.closeWrite(handle, ok ? undefined : o.path);
  }
}
