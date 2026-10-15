// Video frame access. FrameStream decodes a clip sequentially with a little read-ahead (playback and
// rendering); PreviewFrames serves the preview: streams while playing, single still frames while
// scrubbing or paused (always showing the closest frame it already has, so scrubbing stays fluid).
import type { VideoSample, VideoSampleSink } from 'mediabunny';
import { media } from './media';
import { sourceTime, type Clip, type Project } from './model';

export type Drawable = VideoSample | ImageBitmap;

export class FrameStream {
  private iter: AsyncGenerator<VideoSample, void, unknown>;
  private queue: VideoSample[] = [];
  current: VideoSample | null = null;
  ended = false;
  private closed = false;
  private wakePump: (() => void) | null = null;
  private wakeReader: (() => void) | null = null;

  constructor(sink: VideoSampleSink, readonly start: number, private readAhead = 3) {
    this.iter = sink.samples(start);
    this.pump();
  }

  private async pump() {
    try {
      while (!this.closed) {
        if (this.queue.length >= this.readAhead) {
          await new Promise<void>((r) => { this.wakePump = r; });
          continue;
        }
        const r = await this.iter.next();
        if (this.closed) { if (!r.done) r.value.close(); break; }
        if (r.done) break;
        this.queue.push(r.value);
        this.wakeReader?.();
      }
    } catch (e) {
      console.warn('frame stream', e);
    }
    this.ended = true;
    this.wakeReader?.();
  }

  /** Moves to the newest decoded frame at or before source time t (never waits). */
  peek(t: number): VideoSample | null {
    let moved = false;
    while (this.queue.length && this.queue[0].timestamp <= t + 1e-4) {
      this.current?.close();
      this.current = this.queue.shift()!;
      moved = true;
    }
    if (moved) this.wakePump?.();
    if (!this.current && this.queue.length) return this.queue[0]; // first frame not reached yet: show it anyway
    return this.current;
  }

  /** The exact frame for source time t, waiting for the decoder if needed (rendering). */
  async at(t: number): Promise<VideoSample | null> {
    for (;;) {
      this.peek(t);
      if (this.queue.length && this.queue[0].timestamp > t + 1e-4) return this.current ?? this.queue[0];
      if (this.ended) return this.current;
      await new Promise<void>((r) => { this.wakeReader = r; this.wakePump?.(); });
    }
  }

  /** How far behind the requested time the stream is (seconds); null while nothing is decoded yet. */
  lag(t: number): number | null {
    if (this.current) return t - this.current.timestamp;
    if (this.queue.length) return t - this.queue[0].timestamp;
    return null;
  }

  close() {
    this.closed = true;
    this.wakePump?.();
    this.iter.return(undefined).catch(() => {});
    this.current?.close();
    this.current = null;
    for (const s of this.queue) s.close();
    this.queue = [];
  }
}

/** Frames for the preview window. `onFrame` asks the preview to redraw when a frame arrives. */
export class PreviewFrames {
  private streams = new Map<string, { stream: FrameStream; mediaId: string; last: number }>();
  private stills = new Map<string, { sample: VideoSample; t: number; mediaId: string }>();
  private inflight = new Map<string, { want: number }>();
  private sinks = new Map<string, VideoSampleSink>();
  onFrame: () => void = () => {};

  private sinkFor(mediaId: string) {
    let s = this.sinks.get(mediaId);
    if (!s) { const n = media.videoSink(mediaId); if (!n) return null; s = n; this.sinks.set(mediaId, s); }
    return s;
  }

  /** What to draw for a visual clip at timeline time t. */
  frame(p: Project, clip: Clip, t: number, playing: boolean): Drawable | null {
    if (!clip.mediaId) return null;
    const r = media.get(clip.mediaId);
    if (!r || r.status !== 'ready') return null;
    if (r.image) return r.image;
    const src = sourceTime(clip, t);
    if (playing) {
      let s = this.streams.get(clip.id);
      // Restart the stream when the playhead jumped (seek, loop) or it belongs to other media. A stream
      // that is merely slow — still decoding up from a distant keyframe, or behind on a busy machine — is
      // kept: it catches up by skipping frames, while a new one would have to start over from a keyframe.
      const lag = s ? s.stream.lag(src) : null;
      const jumped = s ? src < s.last - 0.05 || src > s.last + 0.75 : false;
      if (s && (s.mediaId !== clip.mediaId || jumped || (lag !== null && (lag > 8 || lag < -0.5)) || (s.stream.ended && !s.stream.current))) {
        s.stream.close();
        this.streams.delete(clip.id);
        s = undefined;
      }
      if (!s) {
        const sink = media.videoSink(clip.mediaId);
        if (!sink) return null;
        s = { stream: new FrameStream(sink, Math.max(0, src), 4), mediaId: clip.mediaId, last: src };
        this.streams.set(clip.id, s);
      }
      s.last = src;
      const f = s.stream.peek(src);
      if (f) return f;
      return this.stills.get(clip.id)?.sample ?? null;
    }
    return this.still(clip, src, p.fps);
  }

  /** Warms up streams for clips about to start, so cuts don't stall. */
  prepare(clip: Clip) {
    if (!clip.mediaId || this.streams.has(clip.id)) return;
    const r = media.get(clip.mediaId);
    if (!r?.video || r.status !== 'ready') return;
    const sink = media.videoSink(clip.mediaId);
    if (sink) this.streams.set(clip.id, { stream: new FrameStream(sink, clip.offset, 4), mediaId: clip.mediaId, last: clip.offset });
  }

  private still(clip: Clip, src: number, fps: number): Drawable | null {
    const have = this.stills.get(clip.id);
    const exact = have && have.mediaId === clip.mediaId && Math.abs(have.t - src) < 0.5 / fps;
    if (!exact) this.request(clip, src);
    return have?.sample ?? null;
  }

  private request(clip: Clip, src: number) {
    const job = this.inflight.get(clip.id);
    if (job) { job.want = src; return; }
    const sink = this.sinkFor(clip.mediaId!);
    if (!sink) return;
    const state = { want: src };
    this.inflight.set(clip.id, state);
    const run = async () => {
      for (;;) {
        const target = state.want;
        const sample = await sink.getSample(Math.max(0, target)).catch(() => null);
        if (sample) {
          this.stills.get(clip.id)?.sample.close();
          this.stills.set(clip.id, { sample, t: target, mediaId: clip.mediaId! });
          this.onFrame();
        }
        if (state.want === target) break; // nothing newer was asked for meanwhile
      }
      this.inflight.delete(clip.id);
    };
    run();
  }

  /** Drops streams (after stopping playback) and frames of clips that no longer exist. */
  stopStreams() {
    for (const s of this.streams.values()) {
      s.stream.close();
    }
    this.streams.clear();
  }
  closeStreamsExcept(keep: Set<string>) {
    for (const [id, s] of this.streams) if (!keep.has(id)) { s.stream.close(); this.streams.delete(id); }
  }
  prune(p: Project) {
    const ids = new Set(p.clips.map((c) => c.id));
    for (const [id, s] of this.stills) if (!ids.has(id)) { s.sample.close(); this.stills.delete(id); }
    for (const [id, s] of this.streams) if (!ids.has(id)) { s.stream.close(); this.streams.delete(id); }
  }
}
