// Audio mixing. The same graph is built for live playback (AudioContext) and for rendering
// (OfflineAudioContext): every audio event is a buffer source with its gain envelope (event volume,
// fades, crossfades), feeding its track (volume, pan, mute/solo) and the master bus.
import { media } from './media';
import { audibleTrack, clipEnd, clipsOnTrack, curve, overlapMap, sourceTime, type Clip, type Overlaps, type Project } from './model';

const ENVELOPE_RATE = 200; // automation points per second inside fades

/** Envelope level of an audio clip at timeline time t (fades and crossfades included). */
export function clipLevel(c: Clip, t: number, o: Overlaps | undefined) {
  const fadeIn = Math.max(c.fadeIn, o?.before ?? 0);
  const fadeOut = Math.max(c.fadeOut, o?.after ?? 0);
  let v = c.gain;
  const local = t - c.start;
  if (fadeIn > 0 && local < fadeIn) v *= curve(local / fadeIn, c.fadeInCurve);
  const toEnd = clipEnd(c) - t;
  if (fadeOut > 0 && toEnd < fadeOut) v *= curve(toEnd / fadeOut, c.fadeOutCurve);
  return v;
}

/**
 * Schedules the mix of [from, to) into `ctx`, with timeline time `from` playing at context time `when`.
 * Returns the created sources so live playback can stop them.
 */
export function scheduleMix(ctx: BaseAudioContext, p: Project, from: number, to: number, when: number, out: AudioNode) {
  const sources: AudioScheduledSourceNode[] = [];
  const overlaps = overlapMap(p);
  const master = ctx.createGain();
  master.gain.value = p.masterVolume;
  master.connect(out);
  for (const tr of p.tracks) {
    if (tr.kind !== 'audio' || !audibleTrack(p, tr)) continue;
    const trackGain = ctx.createGain();
    trackGain.gain.value = tr.volume;
    const pan = ctx.createStereoPanner();
    pan.pan.value = tr.pan;
    trackGain.connect(pan).connect(master);
    for (const c of clipsOnTrack(p, tr.id)) {
      if (c.mute || !c.mediaId) continue;
      const cs = Math.max(c.start, from);
      const ce = Math.min(clipEnd(c), to);
      if (ce - cs <= 1e-4) continue;
      const buf = media.get(c.mediaId)?.audio;
      if (!buf) continue;
      const offset = sourceTime(c, cs);
      if (offset >= buf.duration) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = c.speed;
      const g = ctx.createGain();
      const start = when + (cs - from);
      automate(g.gain, c, cs, ce, start, overlaps.get(c.id));
      let node: AudioNode = g;
      if (c.pan) { const cp = ctx.createStereoPanner(); cp.pan.value = c.pan; g.connect(cp); node = cp; }
      src.connect(g);
      node.connect(trackGain);
      src.start(Math.max(start, (ctx as AudioContext).currentTime ?? 0), offset, (ce - cs) * c.speed);
      sources.push(src);
    }
  }
  return { sources, master };
}

/** Writes the clip's gain envelope for timeline [cs, ce) starting at context time `at`. */
function automate(param: AudioParam, c: Clip, cs: number, ce: number, at: number, o: Overlaps | undefined) {
  const fadeIn = Math.max(c.fadeIn, o?.before ?? 0);
  const fadeOut = Math.max(c.fadeOut, o?.after ?? 0);
  const inEnd = c.start + fadeIn;
  const outStart = clipEnd(c) - fadeOut;
  const needsIn = fadeIn > 0 && cs < inEnd;
  const needsOut = fadeOut > 0 && ce > outStart;
  // a value curve per fade, sampled finely; the level holds steady in between
  const curveSeg = (a: number, b: number) => {
    if (b - a <= 1e-4) return;
    const n = Math.max(2, Math.min(4000, Math.ceil((b - a) * ENVELOPE_RATE)));
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = clipLevel(c, a + ((b - a) * i) / (n - 1), o);
    param.setValueCurveAtTime(values, at + (a - cs), b - a);
  };
  if (!needsIn && !needsOut) { param.setValueAtTime(clipLevel(c, cs, o), at); return; }
  if (needsIn && needsOut && inEnd >= outStart) { curveSeg(cs, ce); return; } // the fades meet
  let cursor = cs;
  if (needsIn) { cursor = Math.min(inEnd, ce); curveSeg(cs, cursor); }
  else param.setValueAtTime(clipLevel(c, cs, o), at);
  if (needsOut) {
    const start = Math.max(outStart, needsIn ? cursor + 1e-5 : cs);
    if (!needsIn && start <= cs + 1e-4) param.cancelScheduledValues(at); // the curve starts right away
    curveSeg(start, ce);
  }
}

/** Live playback through the speakers, with master peak meters. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private live: { sources: AudioScheduledSourceNode[]; master: GainNode } | null = null;
  private meterL!: AnalyserNode;
  private meterR!: AnalyserNode;
  private bus!: GainNode;
  private buf = new Float32Array(2048);

  context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      this.bus = this.ctx.createGain();
      const split = this.ctx.createChannelSplitter(2);
      this.meterL = this.ctx.createAnalyser();
      this.meterR = this.ctx.createAnalyser();
      this.meterL.fftSize = this.meterR.fftSize = 2048;
      this.bus.connect(this.ctx.destination);
      this.bus.connect(split);
      split.connect(this.meterL, 0);
      split.connect(this.meterR, 1);
    }
    return this.ctx;
  }

  /** Starts the mix at timeline time `from`; returns the context time at which `from` is heard. */
  start(p: Project, from: number, to: number): number {
    const ctx = this.context();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    this.stop();
    const when = ctx.currentTime + 0.06;
    this.live = scheduleMix(ctx, p, from, to, when, this.bus);
    return when;
  }

  stop() {
    if (!this.live) return;
    for (const s of this.live.sources) { try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.live.master.disconnect();
    this.live = null;
  }

  /** Current peak levels (0..1) of the left and right master channels. */
  levels(): [number, number] {
    if (!this.ctx || !this.live) return [0, 0];
    const peak = (a: AnalyserNode) => {
      a.getFloatTimeDomainData(this.buf);
      let m = 0;
      for (let i = 0; i < this.buf.length; i++) { const v = Math.abs(this.buf[i]); if (v > m) m = v; }
      return m;
    };
    return [peak(this.meterL), peak(this.meterR)];
  }

  /** Total output delay, to line the picture up with what is heard. */
  get latency() { return this.ctx ? (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) : 0; }
}

/** Mixes [from, to) offline (for rendering). */
export async function renderMix(p: Project, from: number, to: number, sampleRate: number): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.round((to - from) * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate });
  scheduleMix(ctx, p, from, to, 0, ctx.destination);
  return ctx.startRendering();
}

/** Makes sure every audio clip in [from, to) has decoded audio before rendering. */
export async function decodeNeeded(p: Project, from: number, to: number) {
  const ids = new Set<string>();
  for (const c of p.clips) {
    const tr = p.tracks.find((t) => t.id === c.trackId);
    if (tr?.kind === 'audio' && c.mediaId && c.start < to && clipEnd(c) > from) ids.add(c.mediaId);
  }
  await Promise.all([...ids].map((id) => media.audio(id)));
}

export const audio = new AudioEngine();
