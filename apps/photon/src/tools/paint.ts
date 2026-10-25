import { Tool, PointerInfo } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { bus } from '../core/bus';
import { h } from '../ui/dom';
import { toolHeader, sep, num, pct, check, sel, blendSel, brushPicker, iconToggle } from '../ui/optbits';
import { toast } from '../ui/widgets';
import { BrushOptions, defaultBrush, getTip, StrokePath, PaintStroke, DirectStroke, Dab } from '../core/brush';
import { currentTarget, editableTarget, PixelTarget } from '../ops/target';
import { sampleColor } from '../ops/paintops';
import { flattenLayers } from '../core/compositor';
import { Doc, Patch } from '../core/document';
import { createCanvas, ctx2d, Point, Rect, rgbToHsl, hslToRgb, luminance, cloneCanvas, rectIntersect, rectOut, getImageData } from '../core/util';
import { healRegion, spotHeal } from '../core/heal';
import { colorRegion } from '../core/selection';
import { selOpts } from './select';

/** Base for brush-driven tools: cursor outline, [ ] sizing, Alt-eyedropper, Shift-click lines. */
export abstract class BrushBase extends Tool {
  opts: BrushOptions;
  protected path: StrokePath | null = null;
  protected doc: Doc | null = null;
  protected target: PixelTarget | null = null;
  protected lastEnd: Point | null = null;
  protected hoverP: Point | null = null;
  protected altPicks = true;
  protected strokeName = 'Brush Tool';
  constructor(o: Partial<BrushOptions> = {}) { super(); this.opts = defaultBrush(o); }

  get size() { return this.opts.size; }
  set size(v: number | null) { if (v) { this.opts.size = Math.max(1, Math.min(5000, Math.round(v))); bus.emit('options'); } }
  get hardness() { return this.opts.hardness; }
  set hardness(v: number | null) { if (v !== null) { this.opts.hardness = Math.max(0, Math.min(1, v)); bus.emit('options'); } }
  setOpts(o: Partial<BrushOptions>) { Object.assign(this.opts, o); bus.emit('options'); }

  cursor(p?: PointerInfo | null) {
    if (p?.alt && this.altPicks) return 'crosshair';
    const z = app.doc?.zoom ?? 1;
    return this.opts.size * z >= 5 && app.prefs.brushCursor !== 'precise' ? 'none' : 'crosshair';
  }
  hover(p: PointerInfo) { this.hoverP = { x: p.x, y: p.y }; }

  /** Create the stroke object; return false to abort. */
  protected abstract begin(doc: Doc, t: PixelTarget, p: PointerInfo): boolean;
  protected abstract dab(d: Dab): void;
  protected abstract flush(): Rect | null;
  protected abstract end(): void;

  down(p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    this.hoverP = { x: p.x, y: p.y };
    if (p.alt && this.altPicks) {
      const c = sampleColor(doc, p.x, p.y, 1, true);
      if (c) app.setFg(c);
      return;
    }
    const t = currentTarget(doc);
    const L = doc.active;
    const blocked = !t || (t.kind === 'layer' && (!L!.editable || !L!.visible));
    if (blocked) { editableTarget(doc, `use the ${this.name.replace(' Tool', '')}`); return; }
    this.doc = doc;
    this.target = t;
    if (!this.begin(doc, t!, p)) { this.doc = null; this.target = null; return; }
    this.path = new StrokePath(this.opts, (d) => this.dab(d));
    if (p.shift && this.lastEnd) {
      this.path.start(this.lastEnd.x, this.lastEnd.y, p.pressure);
      this.path.lineTo(p.x, p.y, p.pressure);
    } else this.path.start(p.x, p.y, p.pressure);
    this.flushInvalidate();
  }
  move(p: PointerInfo) {
    this.hoverP = { x: p.x, y: p.y };
    if (!this.path) return;
    this.path.move(p.x, p.y, p.pressure);
    this.flushInvalidate();
  }
  up(p: PointerInfo) {
    if (!this.path) return;
    this.path.end();
    this.flushInvalidate();
    this.lastEnd = { x: p.x, y: p.y };
    this.path = null;
    this.end();
    this.doc = null;
    this.target = null;
  }
  protected flushInvalidate() {
    const r = this.flush();
    if (r && this.doc) this.doc.invalidate(r);
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    if (!this.hoverP || !v.doc) return;
    const s = v.toScreen(this.hoverP.x, this.hoverP.y);
    const z = v.doc.zoom;
    const r = (this.opts.size / 2) * z;
    if (r < 2.5 || app.prefs.brushCursor === 'precise') return;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate((this.opts.angle * Math.PI) / 180);
    ctx.scale(1, this.opts.roundness);
    ctx.lineWidth = 1;
    const rr = this.opts.tip === 'round' && this.opts.hardness < 0.99 && app.prefs.brushCursor !== 'full' ? r * (0.5 + this.opts.hardness * 0.5) : r;
    ctx.beginPath();
    if (this.opts.tip === 'square') ctx.rect(-rr, -rr, rr * 2, rr * 2); else ctx.arc(0, 0, rr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.stroke();
    ctx.beginPath();
    if (this.opts.tip === 'square') ctx.rect(-rr + 1, -rr + 1, rr * 2 - 2, rr * 2 - 2); else ctx.arc(0, 0, Math.max(0.5, rr - 1), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.restore();
  }
  deactivate() { this.hoverP = null; }
}

// ---------- buffered paint tools ----------
export abstract class PaintBase extends BrushBase {
  protected stroke: PaintStroke | null = null;
  protected aliased = false;
  protected dab(d: Dab) {
    if (!this.stroke) return;
    this.stroke.dab(d, getTip(this.opts.tip, this.aliased ? Math.max(1, Math.round(d.size)) : d.size, this.opts.hardness, this.opts.roundness, this.aliased));
  }
  protected flush() { return this.stroke?.flush() ?? null; }
  protected end() { this.stroke?.finish(this.strokeName); this.stroke = null; }
  protected alphaValue() { return luminance(app.fg.r, app.fg.g, app.fg.b) / 255; }
}

export class BrushTool extends PaintBase {
  id = 'brush'; name = 'Brush Tool'; icon = 'brush'; key = 'B'; group = 'brush';
  constructor() { super({ size: 30, hardness: 0 }); }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      blendSel(() => this.opts.mode, (v) => { this.opts.mode = v as any; }, [{ value: 'behind', label: 'Behind' }, { value: 'clear', label: 'Clear' }]),
      pct('Opacity:', () => this.opts.opacity, (v) => { this.opts.opacity = v; }),
      iconToggle('lock-pixels', 'Always use Pressure for Opacity', () => this.opts.opacityPressure, (v) => { this.opts.opacityPressure = v; }),
      pct('Flow:', () => this.opts.flow, (v) => { this.opts.flow = v; }),
      pct('Smoothing:', () => this.opts.smoothing, (v) => { this.opts.smoothing = v; }),
      num('∠', () => this.opts.angle, (v) => { this.opts.angle = v; }, { min: -180, max: 180, unit: '°', width: 40, title: 'Brush angle' }),
      iconToggle('pen', 'Always use Pressure for Size', () => this.opts.sizePressure, (v) => { this.opts.sizePressure = v; }));
  }
  protected begin(doc: Doc, t: PixelTarget) {
    this.strokeName = t.kind === 'layer' ? 'Brush Tool' : 'Brush Tool';
    this.stroke = new PaintStroke(doc, t, { mode: 'paint', source: { kind: 'color', color: app.fg }, opacity: this.opts.opacity, blend: this.opts.mode, alphaValue: this.alphaValue() });
    return true;
  }
}

export class PencilTool extends PaintBase {
  id = 'pencil'; name = 'Pencil Tool'; icon = 'pencil'; key = 'B'; group = 'brush';
  autoErase = false;
  constructor() { super({ size: 1, hardness: 1, spacing: 0.05, smoothing: 0, sizePressure: false }); this.aliased = true; this.strokeName = 'Pencil'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      brushPicker(() => this.opts, (o) => this.setOpts(o), { noHardness: true }), sep(),
      blendSel(() => this.opts.mode, (v) => { this.opts.mode = v as any; }, [{ value: 'behind', label: 'Behind' }, { value: 'clear', label: 'Clear' }]),
      pct('Opacity:', () => this.opts.opacity, (v) => { this.opts.opacity = v; }),
      pct('Smoothing:', () => this.opts.smoothing, (v) => { this.opts.smoothing = v; }),
      check('Auto Erase', () => this.autoErase, (v) => { this.autoErase = v; }));
  }
  protected begin(doc: Doc, t: PixelTarget, p: PointerInfo) {
    let color = app.fg;
    if (this.autoErase) {
      const c = sampleColor(doc, p.x, p.y, 1, false);
      if (c && c.r === app.fg.r && c.g === app.fg.g && c.b === app.fg.b) color = app.bg;
    }
    this.stroke = new PaintStroke(doc, t, { mode: 'paint', source: { kind: 'color', color }, opacity: this.opts.opacity, blend: this.opts.mode, aliased: true, alphaValue: luminance(color.r, color.g, color.b) / 255 });
    return true;
  }
}

export class EraserTool extends PaintBase {
  id = 'eraser'; name = 'Eraser Tool'; icon = 'eraser'; key = 'E'; group = 'eraser';
  eraseMode: 'brush' | 'pencil' | 'block' = 'brush';
  toHistory = false;
  constructor() { super({ size: 40, hardness: 0.8 }); this.strokeName = 'Eraser'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      sel('Mode:', [{ value: 'brush', label: 'Brush' }, { value: 'pencil', label: 'Pencil' }, { value: 'block', label: 'Block' }], () => this.eraseMode, (v) => { this.eraseMode = v as any; }),
      pct('Opacity:', () => this.opts.opacity, (v) => { this.opts.opacity = v; }),
      pct('Flow:', () => this.opts.flow, (v) => { this.opts.flow = v; }),
      pct('Smoothing:', () => this.opts.smoothing, (v) => { this.opts.smoothing = v; }),
      check('Erase to History', () => this.toHistory, (v) => { this.toHistory = v; }));
  }
  protected begin(doc: Doc, t: PixelTarget) {
    this.aliased = this.eraseMode !== 'brush';
    if (this.toHistory && t.kind === 'layer') {
      const src = historySource(doc, t);
      if (!src) return false;
      this.stroke = new PaintStroke(doc, t, { mode: 'paint', source: src, opacity: this.opts.opacity });
      return true;
    }
    const L = t.layer;
    const eraseColor = app.bg;
    this.stroke = new PaintStroke(doc, t, { mode: 'erase', source: { kind: 'color', color: app.bg }, opacity: this.opts.opacity, aliased: this.aliased, eraseColor });
    void L;
    return true;
  }
  protected dab(d: Dab) {
    if (!this.stroke) return;
    const tip = this.eraseMode === 'block' ? getTip('square', 16 / (app.doc?.zoom ?? 1), 1, 1, true) : getTip(this.opts.tip, d.size, this.opts.hardness, this.opts.roundness, this.aliased);
    this.stroke.dab(this.eraseMode === 'block' ? { ...d, size: tip.width, angle: 0 } : d, tip);
  }
}

/** Source canvas for history brush: the layer's pixels in the active snapshot. */
function historySource(doc: Doc, t: PixelTarget): { kind: 'canvas'; canvas: HTMLCanvasElement; dx: number; dy: number } | null {
  const snap = doc.snapshots.find((s) => s.id === doc.activeSnapshotId) ?? doc.snapshots[0];
  const ls = snap?.state.layers.find((l) => l.layer === t.layer);
  if (!snap || !ls) { toast('The history brush source does not exist in the selected state for this layer.'); return null; }
  // target canvas coord c -> doc (c + t.x) -> snapshot canvas (doc - ls.x)
  return { kind: 'canvas', canvas: ls.canvas, dx: t.x - ls.x, dy: t.y - ls.y };
}

export class HistoryBrushTool extends PaintBase {
  id = 'history-brush'; name = 'History Brush Tool'; icon = 'history-brush'; key = 'Y'; group = 'history';
  constructor() { super({ size: 40, hardness: 0 }); this.strokeName = 'History Brush'; this.altPicks = false; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      blendSel(() => this.opts.mode, (v) => { this.opts.mode = v as any; }),
      pct('Opacity:', () => this.opts.opacity, (v) => { this.opts.opacity = v; }),
      pct('Flow:', () => this.opts.flow, (v) => { this.opts.flow = v; }),
      h('span', { class: 'opt-label', style: { marginLeft: '8px' } }, 'Source: the snapshot marked in the History panel'));
  }
  protected begin(doc: Doc, t: PixelTarget) {
    if (t.kind !== 'layer') { toast('History Brush works on pixel layers'); return false; }
    const src = historySource(doc, t);
    if (!src) return false;
    this.stroke = new PaintStroke(doc, t, { mode: 'paint', source: src, opacity: this.opts.opacity, blend: this.opts.mode });
    return true;
  }
}

// ---------- clone / heal ----------
type SampleMode = 'current' | 'below' | 'all';
class CloneSource {
  point: Point | null = null;
  offset: Point | null = null;
  aligned = true;
  sample: SampleMode = 'current';
  /** Source canvas + its doc offset captured at stroke start. */
  capture(doc: Doc, t: PixelTarget): { canvas: HTMLCanvasElement; x: number; y: number } {
    if (this.sample === 'current' || t.kind !== 'layer') return { canvas: cloneCanvas(t.canvas), x: t.x, y: t.y };
    const L = t.layer!;
    const layers = this.sample === 'all' ? doc.layers : doc.layers.slice(0, doc.indexOf(L) + 1);
    return { canvas: flattenLayers(doc, layers), x: 0, y: 0 };
  }
}

export class CloneStampTool extends PaintBase {
  id = 'clone'; name = 'Clone Stamp Tool'; icon = 'clone'; key = 'S'; group = 'clone';
  src = new CloneSource();
  protected cur: Point | null = null;
  constructor() { super({ size: 60, hardness: 0.3 }); this.strokeName = 'Clone Stamp'; this.altPicks = false; }
  cursor(p?: PointerInfo | null) { return p?.alt ? 'crosshair' : super.cursor(p); }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      blendSel(() => this.opts.mode, (v) => { this.opts.mode = v as any; }),
      pct('Opacity:', () => this.opts.opacity, (v) => { this.opts.opacity = v; }),
      pct('Flow:', () => this.opts.flow, (v) => { this.opts.flow = v; }),
      check('Aligned', () => this.src.aligned, (v) => { this.src.aligned = v; }),
      sel('Sample:', [{ value: 'current', label: 'Current Layer' }, { value: 'below', label: 'Current & Below' }, { value: 'all', label: 'All Layers' }], () => this.src.sample, (v) => { this.src.sample = v as SampleMode; }));
  }
  down(p: PointerInfo, v: Viewport) {
    if (p.alt) { this.src.point = { x: p.x, y: p.y }; this.src.offset = null; toast('Clone source set'); return; }
    if (!this.src.point) { toast('Alt-click to define a source point.'); return; }
    super.down(p, v);
  }
  protected begin(doc: Doc, t: PixelTarget, p: PointerInfo) {
    if (!this.src.offset || !this.src.aligned) this.src.offset = { x: this.src.point!.x - p.x, y: this.src.point!.y - p.y };
    const s = this.src.capture(doc, t);
    // target canvas coord c -> doc (c + t.x) -> source doc (+offset) -> source canvas (- s.x)
    this.stroke = new PaintStroke(doc, t, { mode: 'paint', source: { kind: 'canvas', canvas: s.canvas, dx: t.x + this.src.offset.x - s.x, dy: t.y + this.src.offset.y - s.y }, opacity: this.opts.opacity, blend: this.opts.mode });
    return true;
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    super.overlay(ctx, v);
    if (!this.hoverP || !this.src.point) return;
    const o = this.src.offset ?? (this.path ? null : { x: this.src.point.x - this.hoverP.x, y: this.src.point.y - this.hoverP.y });
    const sp = o && this.src.aligned ? { x: this.hoverP.x + o.x, y: this.hoverP.y + o.y } : this.src.point;
    const s = v.toScreen(sp.x, sp.y);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(s.x - 8, s.y); ctx.lineTo(s.x + 8, s.y); ctx.moveTo(s.x, s.y - 8); ctx.lineTo(s.x, s.y + 8); ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.stroke();
  }
}

export class HealTool extends CloneStampTool {
  id = 'heal'; name = 'Healing Brush Tool'; icon = 'heal'; key = 'J'; group = 'heal';
  private srcCanvas: { canvas: HTMLCanvasElement; dx: number; dy: number } | null = null;
  constructor() { super(); this.strokeName = 'Healing Brush'; this.opts.hardness = 0.5; this.opts.size = 40; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      h('span', { class: 'opt-label' }, 'Source: Sampled'),
      check('Aligned', () => this.src.aligned, (v) => { this.src.aligned = v; }),
      sel('Sample:', [{ value: 'current', label: 'Current Layer' }, { value: 'below', label: 'Current & Below' }, { value: 'all', label: 'All Layers' }], () => this.src.sample, (v) => { this.src.sample = v as SampleMode; }));
  }
  protected begin(doc: Doc, t: PixelTarget, p: PointerInfo) {
    super.begin(doc, t, p);
    const s = this.stroke!.o.source as any;
    this.srcCanvas = { canvas: s.canvas, dx: s.dx, dy: s.dy };
    return true;
  }
  protected end() {
    const st = this.stroke;
    this.stroke = null;
    if (!st || !this.srcCanvas) return;
    st.flush();
    const r = st.total;
    if (!r) return;
    const t = st.t;
    const pad = 3;
    const rr = rectIntersect(rectOut(r, pad), { x: 0, y: 0, w: t.canvas.width, h: t.canvas.height })!;
    const dst = ctx2d(st.original).getImageData(rr.x, rr.y, rr.w, rr.h);
    const srcC = createCanvas(rr.w, rr.h);
    ctx2d(srcC).drawImage(this.srcCanvas.canvas, -(rr.x + this.srcCanvas.dx), -(rr.y + this.srcCanvas.dy));
    const src = getImageData(srcC);
    const cov = ctx2d(st.coverage).getImageData(rr.x, rr.y, rr.w, rr.h).data;
    const mask = new Float32Array(rr.w * rr.h);
    for (let i = 0; i < mask.length; i++) mask[i] = (cov[i * 4 + 3] / 255) * this.opts.opacity;
    applySelectionWeights(st.doc, t, rr, mask);
    const out = healRegion(dst, src, mask);
    ctx2d(t.canvas).putImageData(out, rr.x, rr.y);
    t.layer?.touch();
    commitPatch(st.doc, t, st.original, rr, 'Healing Brush', st.before);
  }
}

function applySelectionWeights(doc: Doc, t: PixelTarget, r: Rect, mask: Float32Array) {
  if (!doc.selection || t.kind === 'quickmask') return;
  const c = createCanvas(r.w, r.h);
  ctx2d(c).drawImage(doc.selection, -t.x - r.x, -t.y - r.y);
  const s = getImageData(c).data;
  for (let i = 0; i < mask.length; i++) mask[i] *= s[i * 4 + 3] / 255;
}
export function commitPatch(doc: Doc, t: PixelTarget, original: HTMLCanvasElement, r: Rect, name: string, before: ReturnType<Doc['captureState']>) {
  const patch: Patch = {
    canvas: t.canvas, x: r.x, y: r.y,
    before: ctx2d(original).getImageData(r.x, r.y, r.w, r.h),
    after: ctx2d(t.canvas).getImageData(r.x, r.y, r.w, r.h),
  };
  doc.commit(name, before, [patch]);
}

export class SpotHealTool extends BrushBase {
  id = 'spot-heal'; name = 'Spot Healing Brush Tool'; icon = 'spot-heal'; key = 'J'; group = 'heal';
  private cov: HTMLCanvasElement | null = null;
  private covRect: Rect | null = null;
  private before: ReturnType<Doc['captureState']> | null = null;
  constructor() { super({ size: 30, hardness: 0.6, spacing: 0.15, sizePressure: false }); this.altPicks = false; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      h('span', { class: 'opt-label' }, 'Type: Content-Aware'),
      check('Sample All Layers', () => false, () => toast('Spot healing samples the current layer')));
  }
  protected begin(doc: Doc, t: PixelTarget) {
    this.cov = createCanvas(t.canvas.width, t.canvas.height);
    this.covRect = null;
    this.before = doc.captureState();
    return true;
  }
  protected dab(d: Dab) {
    if (!this.cov || !this.target) return;
    const x = d.x - this.target.x, y = d.y - this.target.y;
    const c = ctx2d(this.cov);
    c.globalAlpha = 1;
    const tip = getTip('round', d.size, this.opts.hardness, 1);
    c.drawImage(tip, x - d.size / 2, y - d.size / 2, d.size, d.size);
    const r = rectOut({ x: x - d.size / 2 - 1, y: y - d.size / 2 - 1, w: d.size + 2, h: d.size + 2 });
    this.covRect = this.covRect ? { x: Math.min(this.covRect.x, r.x), y: Math.min(this.covRect.y, r.y), w: Math.max(this.covRect.x + this.covRect.w, r.x + r.w) - Math.min(this.covRect.x, r.x), h: Math.max(this.covRect.y + this.covRect.h, r.y + r.h) - Math.min(this.covRect.y, r.y) } : r;
  }
  protected flush() { app.doc && app.doc.invalidate(null); return null; }
  protected end() {
    const t = this.target, doc = this.doc, cov = this.cov;
    this.cov = null;
    if (!t || !doc || !cov || !this.covRect) return;
    const rr = rectIntersect(rectOut(this.covRect, 2), { x: 0, y: 0, w: t.canvas.width, h: t.canvas.height });
    if (!rr) return;
    const original = cloneCanvas(t.canvas);
    const cd = ctx2d(cov).getImageData(rr.x, rr.y, rr.w, rr.h).data;
    const mask = new Float32Array(rr.w * rr.h);
    for (let i = 0; i < mask.length; i++) mask[i] = cd[i * 4 + 3] / 255;
    applySelectionWeights(doc, t, rr, mask);
    const out = spotHeal(ctx2d(t.canvas), t.canvas.width, t.canvas.height, rr, mask);
    ctx2d(t.canvas).putImageData(out, rr.x, rr.y);
    t.layer?.touch();
    commitPatch(doc, t, original, rr, 'Spot Healing Brush', this.before!);
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    if (this.cov && this.target && v.doc) {
      const d = v.doc;
      ctx.save();
      ctx.setTransform(d.zoom * v.dpr, 0, 0, d.zoom * v.dpr, d.panX * v.dpr, d.panY * v.dpr);
      ctx.globalAlpha = 0.45;
      const tmp = createCanvas(this.cov.width, this.cov.height);
      const tx = ctx2d(tmp);
      tx.drawImage(this.cov, 0, 0);
      tx.globalCompositeOperation = 'source-in';
      tx.fillStyle = '#222';
      tx.fillRect(0, 0, tmp.width, tmp.height);
      ctx.drawImage(tmp, this.target.x, this.target.y);
      ctx.restore();
    }
    super.overlay(ctx, v);
  }
}

export class RedEyeTool extends Tool {
  id = 'red-eye'; name = 'Red Eye Tool'; icon = 'red-eye'; key = 'J'; group = 'heal';
  pupil = 0.5; darken = 0.5;
  cursor() { return 'crosshair'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      pct('Pupil Size:', () => this.pupil, (v) => { this.pupil = v; }),
      pct('Darken Amount:', () => this.darken, (v) => { this.darken = v; }));
  }
  async down(p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    const t = await editableTarget(doc, 'use the Red Eye tool');
    if (!t || t.alphaOnly) return;
    const R = Math.max(6, Math.round(Math.min(doc.width, doc.height) * 0.04 * (0.5 + this.pupil)));
    const r = rectIntersect({ x: Math.round(p.x - t.x - R), y: Math.round(p.y - t.y - R), w: R * 2, h: R * 2 }, { x: 0, y: 0, w: t.canvas.width, h: t.canvas.height });
    if (!r) return;
    const before = doc.captureState();
    const original = cloneCanvas(t.canvas);
    const id = ctx2d(t.canvas).getImageData(r.x, r.y, r.w, r.h);
    const d = id.data;
    let changed = false;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const dist = Math.hypot(x - r.w / 2, y - r.h / 2) / R;
      if (dist > 1) continue;
      const i = (y * r.w + x) * 4;
      const rr = d[i], g = d[i + 1], b = d[i + 2];
      const redness = rr - Math.max(g, b);
      if (redness > 30 && rr > 60) {
        const k = Math.min(1, redness / 80) * (1 - Math.max(0, dist - 0.8) / 0.2);
        const target = ((g + b) / 2) * (1 - this.darken * 0.8);
        d[i] = rr + (target - rr) * k;
        d[i + 1] = g + (g * (1 - this.darken * 0.6) - g) * k;
        d[i + 2] = b + (b * (1 - this.darken * 0.6) - b) * k;
        changed = true;
      }
    }
    if (!changed) { toast('No red eye found there'); return; }
    ctx2d(t.canvas).putImageData(id, r.x, r.y);
    t.layer?.touch();
    commitPatch(doc, t, original, r, 'Red Eye', before);
  }
}

// ---------- direct (per-dab) tools ----------
export abstract class DirectBase extends BrushBase {
  protected stroke: DirectStroke | null = null;
  protected pending: Rect | null = null;
  strength = 0.5;
  protected begin(doc: Doc, t: PixelTarget, _p?: PointerInfo) { this.stroke = new DirectStroke(doc, t); return true; }
  protected abstract modify(img: ImageData, w: Float32Array, r: Rect, d: Dab): void;
  protected dab(d: Dab) {
    if (!this.stroke) return;
    const tip = getTip(this.opts.tip, d.size, this.opts.hardness, this.opts.roundness);
    const r = this.stroke.dab({ ...d, alpha: d.alpha * this.strength }, tip, (img, w, rr) => this.modify(img, w, rr, d));
    if (r) this.pending = this.pending ? { x: Math.min(this.pending.x, r.x), y: Math.min(this.pending.y, r.y), w: Math.max(this.pending.x + this.pending.w, r.x + r.w) - Math.min(this.pending.x, r.x), h: Math.max(this.pending.y + this.pending.h, r.y + r.h) - Math.min(this.pending.y, r.y) } : r;
  }
  protected flush() { const r = this.pending; this.pending = null; return r; }
  protected end() { this.stroke?.finish(this.strokeName); this.stroke = null; }
}

function boxBlurRGBA(img: ImageData): Uint8ClampedArray {
  const { width: w, height: h, data: s } = img;
  const out = new Uint8ClampedArray(s.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
      const i = (yy * w + xx) * 4;
      r += s[i]; g += s[i + 1]; b += s[i + 2]; a += s[i + 3]; n++;
    }
    const o = (y * w + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
  }
  return out;
}

export class BlurTool extends DirectBase {
  id = 'blur'; name = 'Blur Tool'; icon = 'blur'; group = 'blur';
  constructor() { super({ size: 50, hardness: 0, spacing: 0.15 }); this.strokeName = 'Blur'; this.altPicks = false; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      pct('Strength:', () => this.strength, (v) => { this.strength = v; }));
  }
  protected modify(img: ImageData, w: Float32Array) {
    const b = boxBlurRGBA(img), d = img.data;
    for (let i = 0; i < w.length; i++) { const k = w[i]; if (!k) continue; for (let c = 0; c < 4; c++) d[i * 4 + c] += (b[i * 4 + c] - d[i * 4 + c]) * k; }
  }
}
export class SharpenTool extends DirectBase {
  id = 'sharpen'; name = 'Sharpen Tool'; icon = 'sharpen'; group = 'blur';
  constructor() { super({ size: 50, hardness: 0, spacing: 0.25 }); this.strokeName = 'Sharpen'; this.altPicks = false; this.strength = 0.3; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      pct('Strength:', () => this.strength, (v) => { this.strength = v; }));
  }
  protected modify(img: ImageData, w: Float32Array) {
    const b = boxBlurRGBA(img), d = img.data;
    for (let i = 0; i < w.length; i++) { const k = w[i] * 0.8; if (!k) continue; for (let c = 0; c < 3; c++) d[i * 4 + c] += (d[i * 4 + c] - b[i * 4 + c]) * k; }
  }
}
export class SmudgeTool extends DirectBase {
  id = 'smudge'; name = 'Smudge Tool'; icon = 'smudge'; group = 'blur';
  finger = false;
  private carry: Float32Array | null = null;
  private carryW = 0; private carryH = 0;
  constructor() { super({ size: 40, hardness: 0.2, spacing: 0.08, smoothing: 0 }); this.strokeName = 'Smudge'; this.altPicks = false; this.strength = 0.5; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      pct('Strength:', () => this.strength, (v) => { this.strength = v; }),
      check('Finger Painting', () => this.finger, (v) => { this.finger = v; }));
  }
  protected begin(doc: Doc, t: PixelTarget, p?: PointerInfo) { this.carry = null; return super.begin(doc, t, p); }
  protected dab(d: Dab) {
    if (!this.stroke) return;
    const tip = getTip(this.opts.tip, d.size, this.opts.hardness, this.opts.roundness);
    const r = this.stroke.dab({ ...d, alpha: 1 }, tip, (img, w) => this.smudge(img, w));
    if (r) this.pending = r;
  }
  private smudge(img: ImageData, w: Float32Array) {
    const d = img.data, n = w.length;
    if (!this.carry || this.carryW !== img.width || this.carryH !== img.height) {
      const c = new Float32Array(n * 4);
      for (let i = 0; i < n * 4; i++) c[i] = d[i];
      if (this.finger && !this.carry) for (let i = 0; i < n; i++) { c[i * 4] = app.fg.r; c[i * 4 + 1] = app.fg.g; c[i * 4 + 2] = app.fg.b; c[i * 4 + 3] = 255; }
      this.carry = c; this.carryW = img.width; this.carryH = img.height;
      return;
    }
    const c = this.carry, s = this.strength;
    for (let i = 0; i < n; i++) {
      const k = w[i] * s;
      for (let ch = 0; ch < 4; ch++) {
        const o = i * 4 + ch;
        const v = d[o] + (c[o] - d[o]) * k;
        d[o] = v;
        c[o] = c[o] + (v - c[o]) * (1 - s * 0.9) * (w[i] > 0 ? 1 : 0);
      }
    }
  }
  protected modify() {}
}

export class DodgeBurnTool extends DirectBase {
  key = 'O'; group = 'dodge';
  range: 'shadows' | 'midtones' | 'highlights' = 'midtones';
  constructor(public id: string, public name: string, public icon: string, private burn: boolean) {
    super({ size: 65, hardness: 0, spacing: 0.15 });
    this.strokeName = burn ? 'Burn' : 'Dodge';
    this.altPicks = false;
    this.strength = 0.5;
  }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      sel('Range:', [{ value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Midtones' }, { value: 'highlights', label: 'Highlights' }], () => this.range, (v) => { this.range = v as any; }),
      pct('Exposure:', () => this.strength, (v) => { this.strength = v; }));
  }
  protected modify(img: ImageData, w: Float32Array) {
    const d = img.data;
    for (let i = 0; i < w.length; i++) {
      const k = w[i] * 0.35;
      if (!k) continue;
      const o = i * 4;
      const l = luminance(d[o], d[o + 1], d[o + 2]) / 255;
      const rw = this.range === 'shadows' ? Math.pow(1 - l, 2) : this.range === 'highlights' ? l * l : 1 - Math.pow(2 * l - 1, 2);
      const amt = k * rw;
      for (let c = 0; c < 3; c++) {
        const v = d[o + c];
        d[o + c] = this.burn ? v - v * amt * (1 - v / 512) : v + (255 - v) * amt * (0.5 + v / 512);
      }
    }
  }
}
export class SpongeTool extends DirectBase {
  id = 'sponge'; name = 'Sponge Tool'; icon = 'sponge'; key = 'O'; group = 'dodge';
  saturate = false;
  constructor() { super({ size: 65, hardness: 0, spacing: 0.15 }); this.strokeName = 'Sponge'; this.altPicks = false; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      sel('Mode:', [{ value: 'desat', label: 'Desaturate' }, { value: 'sat', label: 'Saturate' }], () => (this.saturate ? 'sat' : 'desat'), (v) => { this.saturate = v === 'sat'; }),
      pct('Flow:', () => this.strength, (v) => { this.strength = v; }));
  }
  protected modify(img: ImageData, w: Float32Array) {
    const d = img.data;
    for (let i = 0; i < w.length; i++) {
      const k = w[i] * 0.3;
      if (!k) continue;
      const o = i * 4;
      const [hh, s, l] = rgbToHsl(d[o], d[o + 1], d[o + 2]);
      const ns = this.saturate ? s + (1 - s) * k : s * (1 - k);
      const [r, g, b] = hslToRgb(hh, ns, l);
      d[o] = r; d[o + 1] = g; d[o + 2] = b;
    }
  }
}
export class ColorReplaceTool extends DirectBase {
  id = 'color-replace'; name = 'Color Replacement Tool'; icon = 'color-replace'; key = 'B'; group = 'brush';
  tolerance = 30;
  private sample: [number, number, number] | null = null;
  constructor() { super({ size: 30, hardness: 1, spacing: 0.15 }); this.strokeName = 'Color Replacement'; this.strength = 1; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      h('span', { class: 'opt-label' }, 'Mode: Color'), sep(),
      num('Tolerance:', () => this.tolerance, (v) => { this.tolerance = v; }, { min: 1, max: 100, unit: '%', width: 44 }));
  }
  protected begin(doc: Doc, t: PixelTarget, p: PointerInfo) {
    const c = sampleColor(doc, p.x, p.y, 1, false);
    this.sample = c ? rgbToHsl(c.r, c.g, c.b) : null;
    return super.begin(doc, t);
  }
  protected modify(img: ImageData, w: Float32Array) {
    if (!this.sample) return;
    const d = img.data;
    const [fh, fs] = rgbToHsl(app.fg.r, app.fg.g, app.fg.b);
    const [sh, ss] = this.sample;
    const tol = this.tolerance / 100;
    for (let i = 0; i < w.length; i++) {
      const k = w[i];
      if (!k) continue;
      const o = i * 4;
      const [hh, s, l] = rgbToHsl(d[o], d[o + 1], d[o + 2]);
      const dh = Math.min(Math.abs(hh - sh), 360 - Math.abs(hh - sh)) / 180;
      const diff = Math.max(dh * Math.min(s, ss) * 2, Math.abs(s - ss) * 0.5);
      if (diff > tol) continue;
      const [r, g, b] = hslToRgb(fh, fs, l);
      const kk = k * (1 - Math.max(0, diff - tol * 0.7) / (tol * 0.3 + 1e-6));
      d[o] += (r - d[o]) * kk; d[o + 1] += (g - d[o + 1]) * kk; d[o + 2] += (b - d[o + 2]) * kk;
    }
  }
}

// ---------- Magic eraser ----------
export class MagicEraserTool extends Tool {
  id = 'magic-eraser'; name = 'Magic Eraser Tool'; icon = 'magic-eraser'; key = 'E'; group = 'eraser';
  tolerance = 32; contiguous = true; antialias = true; sampleAll = false; opacity = 1;
  cursor() { return 'crosshair'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      num('Tolerance:', () => this.tolerance, (v) => { this.tolerance = v; }, { min: 0, max: 255, width: 44 }),
      check('Anti-alias', () => this.antialias, (v) => { this.antialias = v; }),
      check('Contiguous', () => this.contiguous, (v) => { this.contiguous = v; }),
      check('Sample All Layers', () => this.sampleAll, (v) => { this.sampleAll = v; }),
      pct('Opacity:', () => this.opacity, (v) => { this.opacity = v; }));
  }
  async down(p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    const before = doc.captureState();
    const L = doc.active;
    if (L?.isBackground) {
      // Photoshop converts the Background into a normal layer first
      L.isBackground = false; L.lockAlpha = false; L.lockPosition = false; L.name = 'Layer 0';
    }
    const t = await editableTarget(doc, 'use the Magic Eraser');
    if (!t || t.kind !== 'layer') return;
    const img = this.sampleAll ? getImageData(doc.composite) : (() => { const c = createCanvas(doc.width, doc.height); ctx2d(c).drawImage(t.canvas, t.x, t.y); return getImageData(c); })();
    const region = colorRegion(img, p.x, p.y, this.tolerance, this.contiguous, this.antialias);
    const out = cloneCanvas(t.canvas);
    const ox = ctx2d(out);
    if (doc.selection) {
      const rx = ctx2d(region);
      rx.globalCompositeOperation = 'destination-in';
      rx.drawImage(doc.selection, 0, 0);
    }
    ox.globalAlpha = this.opacity;
    ox.globalCompositeOperation = 'destination-out';
    ox.drawImage(region, -t.x, -t.y);
    t.replace(out);
    doc.commit('Magic Eraser', before);
  }
}

void selOpts;
