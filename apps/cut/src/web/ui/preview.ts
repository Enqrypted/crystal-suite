// Video Preview: draws the project at the cursor (live during playback) with the shared compositor.
import { store } from '../core/store';
import { transport } from '../core/playback';
import { PreviewFrames } from '../core/frames';
import { drawFrame } from '../core/compositor';
import { clipEnd, overlapMap, type Overlaps } from '../core/model';
import { timecode } from '../core/timecode';
import { h } from './dom';

export class Preview {
  readonly el: HTMLElement;
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frames = new PreviewFrames();
  private overlaps: Map<string, Overlaps> = new Map();
  private tc: HTMLElement;
  private info: HTMLElement;
  private quality: HTMLSelectElement;
  private raf = 0;
  private fpsCount = { n: 0, t: performance.now(), fps: 0 };

  constructor() {
    this.canvas = h('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.stage = h('div', { class: 'stage' }, this.canvas);
    this.quality = h('select', { title: 'Preview quality' },
      h('option', { value: 'auto' }, 'Preview (Auto)'), h('option', { value: 'full' }, 'Best (Full)'),
      h('option', { value: 'half' }, 'Good (Half)'), h('option', { value: 'quarter' }, 'Draft (Quarter)')) as HTMLSelectElement;
    this.quality.value = store.view.previewQuality;
    this.quality.addEventListener('change', () => store.setView('previewQuality', this.quality.value as never));
    this.tc = h('span', { class: 'tc' });
    this.info = h('span');
    this.el = h('div', { class: 'preview' },
      h('div', { class: 'panel-head' }, h('span', { class: 'title' }, 'Video Preview'), h('div', { class: 'spacer' }), this.quality),
      this.stage,
      h('div', { class: 'foot' }, this.tc, h('div', { style: 'flex:1' }), this.info));
    this.frames.onFrame = () => this.request();
    new ResizeObserver(() => this.request()).observe(this.stage);
    this.overlaps = overlapMap(store.project);
    store.on((t) => {
      if (t.has('project')) { this.overlaps = overlapMap(store.project); this.frames.prune(store.project); }
      if (t.has('transport') && !transport.playing) this.frames.stopStreams();
      if (t.has('project') || t.has('media') || t.has('view') || (t.has('time') && !transport.playing) || t.has('transport')) this.request();
      if (t.has('time')) this.tc.textContent = timecode(store.time, store.project.fps);
    });
    transport.onFrame = (time) => this.draw(time);
    this.tc.textContent = timecode(0, 30);
  }

  /** Canvas size for the current panel size and quality. */
  private size() {
    const p = store.project;
    const sw = Math.max(16, this.stage.clientWidth - 12);
    const sh = Math.max(16, this.stage.clientHeight - 12);
    const k = Math.min(sw / p.width, sh / p.height);
    const cssW = Math.max(1, Math.floor(p.width * k));
    const cssH = Math.max(1, Math.floor(p.height * k));
    const dpr = window.devicePixelRatio || 1;
    const q = store.view.previewQuality;
    let scale = Math.min(1, (cssW * dpr) / p.width);
    if (q === 'full') scale = 1;
    else if (q === 'half') scale = 0.5;
    else if (q === 'quarter') scale = 0.25;
    return { cssW, cssH, w: Math.max(2, Math.round(p.width * scale)), h: Math.max(2, Math.round(p.height * scale)) };
  }

  request() {
    if (this.raf || transport.playing) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(store.time); });
  }

  draw(t: number) {
    const p = store.project;
    const s = this.size();
    if (this.canvas.width !== s.w || this.canvas.height !== s.h) { this.canvas.width = s.w; this.canvas.height = s.h; }
    this.canvas.style.width = `${s.cssW}px`;
    this.canvas.style.height = `${s.cssH}px`;
    const playing = transport.playing;
    if (playing) {
      // warm up decoders for clips starting soon, release ones that are done
      const keep = new Set<string>();
      for (const c of p.clips) {
        if (c.start <= t + 1.2 && clipEnd(c) > t - 0.1) {
          keep.add(c.id);
          if (c.start > t && c.start <= t + 1.2) this.frames.prepare(c);
        }
      }
      this.frames.closeStreamsExcept(keep);
    }
    this.ctx.imageSmoothingQuality = 'medium';
    drawFrame(this.ctx, p, t, s.w, s.h, this.overlaps, (clip) => this.frames.frame(p, clip, t, playing));
    // info
    const f = this.fpsCount;
    f.n++;
    const now = performance.now();
    if (now - f.t > 1000) { f.fps = Math.round((f.n * 1000) / (now - f.t)); f.n = 0; f.t = now; }
    this.info.textContent = `${p.width}×${p.height}, ${+p.fps.toFixed(3)} fps · display ${s.w}×${s.h}${playing ? ` · ${f.fps} fps` : ''}`;
  }

  /** The current frame at full project resolution as PNG bytes (Save Snapshot). */
  async snapshot(): Promise<Blob> {
    const p = store.project;
    const c = new OffscreenCanvas(p.width, p.height);
    const ctx = c.getContext('2d', { alpha: false })!;
    drawFrame(ctx, p, store.time, p.width, p.height, this.overlaps, (clip) => this.frames.frame(p, clip, store.time, false));
    return c.convertToBlob({ type: 'image/png' });
  }
}
