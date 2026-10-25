// Patch Tool, Background Eraser Tool, Pattern Stamp Tool and Color Sampler Tool.
import { Tool, PointerInfo } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { Dab, PaintStroke } from '../core/brush';
import { createCanvas, ctx2d, getImageData, Point, Rect, rectIntersect, cloneCanvas } from '../core/util';
import { healRegion } from '../core/heal';
import { maskFromPolygon } from '../core/selection';
import { defaultPattern, loadPattern, Pattern, patternCanvas, tiledPattern } from '../core/patterns';
import { h } from '../ui/dom';
import { toolHeader, sep, num, pct, check, sel, blendSel, brushPicker } from '../ui/optbits';
import { button, toast } from '../ui/widgets';
import { patternPicker } from '../ui/patternpicker';
import { currentTarget, editableTarget, PixelTarget } from '../ops/target';
import { applySelectShape } from '../ops/selectops';
import { drawSamplers, MAX_SAMPLERS, samplerSettings } from '../ops/samplers';
import { BrushBase, DirectBase, PaintBase, commitPatch } from './paint';
import { showPanel } from '../ui/dock';

// ---------- Patch ----------
/**
 * Draw around an area (like the Lasso), then drag the selection: in Source mode the area is replaced by what's
 * under the spot you drag to, blended in like the Healing Brush; in Destination mode the area is copied there.
 */
export class PatchTool extends Tool {
  id = 'patch'; name = 'Patch Tool'; icon = 'patch'; key = 'J'; group = 'heal';
  mode: 'source' | 'destination' = 'source';
  private lasso: Point[] | null = null;
  private drag: { start: Point; offset: Point; outline: Path2D | null } | null = null;
  cursor(p?: PointerInfo | null) { return p && this.insideSelection(p) ? 'move' : 'crosshair'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      sel('Patch:', [{ value: 'source', label: 'Source' }, { value: 'destination', label: 'Destination' }], () => this.mode, (v) => { this.mode = v as any; }), sep(),
      h('span', { class: 'opt-label' }, 'Draw around an area, then drag it to the spot to patch from (Source) or to (Destination)'));
  }
  private insideSelection(p: PointerInfo) {
    const d = app.doc;
    if (!d?.selection) return false;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return false;
    return ctx2d(d.selection).getImageData(x, y, 1, 1).data[3] > 127;
  }
  down(p: PointerInfo, v: Viewport) {
    if (this.insideSelection(p)) { this.drag = { start: { x: p.x, y: p.y }, offset: { x: 0, y: 0 }, outline: v.doc!.selectionOutline() }; return; }
    this.lasso = [{ x: p.x, y: p.y }];
  }
  move(p: PointerInfo, v: Viewport) {
    if (this.lasso) { this.lasso.push({ x: p.x, y: p.y }); v.requestRender(); }
    if (this.drag) { this.drag.offset = { x: Math.round(p.x - this.drag.start.x), y: Math.round(p.y - this.drag.start.y) }; v.requestRender(); }
  }
  async up(_p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    if (this.lasso) {
      const pts = this.lasso;
      this.lasso = null;
      if (pts.length > 2) applySelectShape(doc, maskFromPolygon(doc.width, doc.height, pts), 'new', 'Patch Selection');
      else v.requestRender();
      return;
    }
    const d = this.drag;
    this.drag = null;
    v.requestRender();
    if (!d || (!d.offset.x && !d.offset.y)) return;
    const t = await editableTarget(doc, 'use the Patch tool');
    if (!t || t.alphaOnly) return;
    patch(doc, t, d.offset, this.mode);
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    if (this.lasso && this.lasso.length > 1) {
      ctx.save();
      ctx.beginPath();
      this.lasso.forEach((q, i) => { const s = v.toScreen(q.x, q.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
      ctx.setLineDash([4, 4]); ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.restore();
    }
    if (this.drag?.outline && v.doc) {
      const p = new Path2D();
      p.addPath(this.drag.outline, new DOMMatrix().translate(this.drag.offset.x, this.drag.offset.y));
      v.strokeAnts(p);
    }
  }
}

function patch(doc: Doc, t: PixelTarget, off: Point, mode: 'source' | 'destination') {
  const sel = doc.selection, sb = doc.selectionBounds();
  if (!sel || !sb) return;
  // the area that changes, and where its new content comes from (target-canvas coords)
  const dest = mode === 'source' ? sb : { ...sb, x: sb.x + off.x, y: sb.y + off.y };
  const srcShift = mode === 'source' ? off : { x: -off.x, y: -off.y };
  const pad = 3;
  const r = rectIntersect({ x: dest.x - t.x - pad, y: dest.y - t.y - pad, w: dest.w + 2 * pad, h: dest.h + 2 * pad }, { x: 0, y: 0, w: t.canvas.width, h: t.canvas.height });
  if (!r) return;
  const before = doc.captureState();
  const original = cloneCanvas(t.canvas);
  const dst = ctx2d(t.canvas).getImageData(r.x, r.y, r.w, r.h);
  const srcC = createCanvas(r.w, r.h);
  ctx2d(srcC).drawImage(original, -(r.x + srcShift.x), -(r.y + srcShift.y));
  const src = getImageData(srcC);
  // the selection's shape at the destination
  const mC = createCanvas(r.w, r.h);
  const mo = mode === 'source' ? { x: 0, y: 0 } : off;
  ctx2d(mC).drawImage(sel, -(r.x + t.x - mo.x), -(r.y + t.y - mo.y));
  const md = getImageData(mC).data;
  const mask = new Float32Array(r.w * r.h);
  for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4 + 3] / 255;
  ctx2d(t.canvas).putImageData(healRegion(dst, src, mask), r.x, r.y);
  t.layer?.touch();
  commitPatch(doc, t, original, r, 'Patch Tool', before);
}

// ---------- Background Eraser ----------
type Sampling = 'continuous' | 'once' | 'swatch';
/**
 * Erases pixels that match the color under the brush's center (the hot spot), so a background disappears while
 * the subject's edge stays. Contiguous keeps to the area connected to the center.
 */
export class BackgroundEraserTool extends DirectBase {
  id = 'bg-eraser'; name = 'Background Eraser Tool'; icon = 'bg-eraser'; key = 'E'; group = 'eraser';
  sampling: Sampling = 'continuous';
  limits: 'contiguous' | 'discontiguous' = 'contiguous';
  tolerance = 50;
  protectFg = false;
  private sample: [number, number, number] | null = null;
  constructor() { super({ size: 60, hardness: 1, spacing: 0.15 }); this.strokeName = 'Background Eraser'; this.altPicks = false; this.strength = 1; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      sel('Sampling:', [{ value: 'continuous', label: 'Continuous' }, { value: 'once', label: 'Once' }, { value: 'swatch', label: 'Background Swatch' }], () => this.sampling, (v) => { this.sampling = v as Sampling; }),
      sel('Limits:', [{ value: 'contiguous', label: 'Contiguous' }, { value: 'discontiguous', label: 'Discontiguous' }], () => this.limits, (v) => { this.limits = v as any; }),
      num('Tolerance:', () => this.tolerance, (v) => { this.tolerance = v; }, { min: 1, max: 100, unit: '%', width: 44 }),
      check('Protect Foreground Color', () => this.protectFg, (v) => { this.protectFg = v; }));
  }
  protected begin(doc: Doc, t: PixelTarget, p?: PointerInfo) {
    if (t.kind !== 'layer' || !t.layer) { toast('The Background Eraser works on pixel layers'); return false; }
    const before = doc.captureState();
    const L = t.layer;
    if (L.isBackground) {
      // Photoshop turns the Background into a normal layer first
      L.isBackground = false; L.lockAlpha = false; L.lockPosition = false; L.name = 'Layer 0';
      bus.emit('layers', doc);
      t = currentTarget(doc)!;
      this.target = t;
    }
    if (t.lockAlpha) { toast('Transparency is locked on this layer'); return false; }
    super.begin(doc, t, p);
    (this.stroke as any).before = before; // undo restores the Background too
    this.sample = null;
    if (this.sampling === 'swatch') this.sample = [app.bg.r, app.bg.g, app.bg.b];
    else if (p) this.sample = this.colorAt(t, p.x, p.y);
    return true;
  }
  /** Color at a document point in the layer as it was when the stroke began. */
  private colorAt(t: PixelTarget, x: number, y: number): [number, number, number] | null {
    const src = (this.stroke?.original ?? t.canvas);
    const px = Math.floor(x - t.x), py = Math.floor(y - t.y);
    if (px < 0 || py < 0 || px >= src.width || py >= src.height) return null;
    const d = ctx2d(src).getImageData(px, py, 1, 1).data;
    return d[3] ? [d[0], d[1], d[2]] : null;
  }
  protected modify(img: ImageData, w: Float32Array, r: Rect, dab: Dab) {
    const t = this.target!;
    if (this.sampling === 'continuous') this.sample = this.colorAt(t, dab.x, dab.y) ?? this.sample;
    const s = this.sample;
    if (!s) return;
    const d = img.data, W = img.width, H = img.height;
    const tol = (this.tolerance / 100) * 255 * 1.2;
    const fg = app.fg, ftol = Math.max(12, tol * 0.35);
    const diff = new Float32Array(W * H);
    for (let i = 0, o = 0; i < diff.length; i++, o += 4) diff[i] = Math.max(Math.abs(d[o] - s[0]), Math.abs(d[o + 1] - s[1]), Math.abs(d[o + 2] - s[2]));
    let keep: Uint8Array | null = null;
    if (this.limits === 'contiguous') {
      // flood from the hot spot through matching pixels
      keep = new Uint8Array(W * H);
      const cx = Math.min(W - 1, Math.max(0, Math.floor(dab.x - t.x - r.x))), cy = Math.min(H - 1, Math.max(0, Math.floor(dab.y - t.y - r.y)));
      const stack = [cy * W + cx];
      while (stack.length) {
        const i = stack.pop()!;
        if (keep[i] || diff[i] > tol || !w[i]) continue;
        keep[i] = 1;
        const x = i % W, y = (i / W) | 0;
        if (x > 0) stack.push(i - 1); if (x < W - 1) stack.push(i + 1);
        if (y > 0) stack.push(i - W); if (y < H - 1) stack.push(i + W);
      }
    }
    for (let i = 0, o = 0; i < diff.length; i++, o += 4) {
      const k = w[i];
      if (!k || !d[o + 3] || diff[i] > tol || (keep && !keep[i])) continue;
      if (this.protectFg && Math.max(Math.abs(d[o] - fg.r), Math.abs(d[o + 1] - fg.g), Math.abs(d[o + 2] - fg.b)) <= ftol) continue;
      // full strength well inside the tolerance, fading out towards its edge (soft, clean edges)
      const soft = diff[i] < tol * 0.6 ? 1 : 1 - (diff[i] - tol * 0.6) / (tol * 0.4);
      d[o + 3] = d[o + 3] * (1 - Math.min(1, k * soft));
    }
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    super.overlay(ctx, v);
    // the hot spot
    if (!this.hoverP) return;
    const s = v.toScreen(this.hoverP.x, this.hoverP.y);
    ctx.save();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(s.x - 4, s.y); ctx.lineTo(s.x + 4, s.y); ctx.moveTo(s.x, s.y - 4); ctx.lineTo(s.x, s.y + 4); ctx.stroke();
    ctx.restore();
  }
}

// ---------- Pattern Stamp ----------
export class PatternStampTool extends PaintBase {
  id = 'pattern-stamp'; name = 'Pattern Stamp Tool'; icon = 'pattern-stamp'; key = 'S'; group = 'clone';
  pattern: Pattern = defaultPattern();
  aligned = true;
  constructor() { super({ size: 60, hardness: 0.3 }); this.strokeName = 'Pattern Stamp'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      brushPicker(() => this.opts, (o) => this.setOpts(o)), sep(),
      blendSel(() => this.opts.mode, (v) => { this.opts.mode = v as any; }),
      pct('Opacity:', () => this.opts.opacity, (v) => { this.opts.opacity = v; }),
      pct('Flow:', () => this.opts.flow, (v) => { this.opts.flow = v; }), sep(),
      patternPicker({ value: this.pattern, onChange: (p) => { this.pattern = p; void loadPattern(p); } }).el,
      check('Aligned', () => this.aligned, (v) => { this.aligned = v; }));
  }
  protected begin(doc: Doc, t: PixelTarget, p: PointerInfo) {
    if (!patternCanvas(this.pattern)) { void loadPattern(this.pattern); toast('Loading the pattern — try again'); return false; }
    // Aligned: tiles anchored to the document; otherwise each stroke starts a fresh tile at the pointer
    const ox = this.aligned ? -t.x : Math.round(p.x - t.x), oy = this.aligned ? -t.y : Math.round(p.y - t.y);
    const tiled = tiledPattern(this.pattern, t.canvas.width, t.canvas.height, 1, ox, oy)!;
    this.stroke = new PaintStroke(doc, t, { mode: 'paint', source: { kind: 'canvas', canvas: tiled, dx: 0, dy: 0 }, opacity: this.opts.opacity, blend: this.opts.mode, alphaValue: this.alphaValue() });
    return true;
  }
}

// ---------- Color Sampler ----------
/** Click to place up to 10 color readouts (shown in the Info panel); drag one to move it, Alt-click it to delete it. */
export class ColorSamplerTool extends Tool {
  id = 'color-sampler'; name = 'Color Sampler Tool'; icon = 'color-sampler'; key = 'I'; group = 'eyedropper';
  private dragging = -1;
  private placed = false;
  cursor(p?: PointerInfo | null) { return p?.alt ? 'not-allowed' : 'crosshair'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      sel('Sample Size:', [{ value: '1', label: 'Point Sample' }, { value: '3', label: '3 by 3 Average' }, { value: '5', label: '5 by 5 Average' }, { value: '11', label: '11 by 11 Average' }],
        () => String(samplerSettings.size), (v) => { samplerSettings.size = Number(v); bus.emit('samplers', app.doc); }), sep(),
      button('Clear All', () => { const d = app.doc; if (d) { d.samplers = []; bus.emit('samplers', d); d.invalidate(); } }, { small: true }),
      h('span', { class: 'opt-label', style: { marginLeft: '10px' } }, 'Click to add a sampler (up to 10), drag to move, Alt-click to delete — readouts in the Info panel'));
  }
  private hit(v: Viewport, p: PointerInfo): number {
    const d = v.doc!;
    return d.samplers.findIndex((s) => { const q = v.toScreen(s.x + 0.5, s.y + 0.5); return Math.hypot(q.x - p.sx, q.y - p.sy) <= 8; });
  }
  down(p: PointerInfo, v: Viewport) {
    const d = v.doc!;
    const i = this.hit(v, p);
    if (i >= 0) {
      if (p.alt) { d.samplers.splice(i, 1); bus.emit('samplers', d); v.requestRender(); return; }
      this.dragging = i;
      return;
    }
    if (p.alt) return;
    if (d.samplers.length >= MAX_SAMPLERS) { toast('You can place up to 10 color samplers'); return; }
    if (p.x < 0 || p.y < 0 || p.x >= d.width || p.y >= d.height) return;
    d.samplers.push({ x: Math.floor(p.x), y: Math.floor(p.y) });
    this.dragging = d.samplers.length - 1;
    bus.emit('samplers', d);
    v.requestRender();
    this.placed = true;
  }
  move(p: PointerInfo, v: Viewport) {
    const d = v.doc!;
    if (this.dragging < 0) return;
    d.samplers[this.dragging] = { x: Math.min(d.width - 1, Math.max(0, Math.floor(p.x))), y: Math.min(d.height - 1, Math.max(0, Math.floor(p.y))) };
    bus.emit('samplers', d);
    v.requestRender();
  }
  up() {
    this.dragging = -1;
    // show the readouts (on release: opening during the press would be closed as a click outside the panel)
    if (this.placed) { this.placed = false; showPanel('info'); }
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    const d = v.doc;
    if (!d) return;
    drawSamplers(ctx, (x, y) => v.toScreen(x, y), d);
  }
}

void BrushBase;
