import { Tool, PointerInfo } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { h } from '../ui/dom';
import { toolHeader, sep, num, check, sel, selectModes, label } from '../ui/optbits';
import { button } from '../ui/widgets';
import { Doc } from '../core/document';
import {
  SelectMode, maskFromRect, maskFromEllipse, maskFromPolygon, featherMask, colorRegion, combineMask, copyMask,
} from '../core/selection';
import { createCanvas, ctx2d, getImageData, Point, Rect, rectFromPoints } from '../core/util';
import { applySelectShape, commitSelection, deselect, sampleImage, selectSubject, selectAndMaskDialog } from '../ops/selectops';
import { bus } from '../core/bus';

/** Options shared by all selection tools (like Photoshop each tool keeps its own; we share mode/feather). */
export const selOpts = {
  mode: 'new' as SelectMode,
  feather: 0,
  antialias: true,
  style: 'normal' as 'normal' | 'ratio' | 'size',
  fixW: 1, fixH: 1,
  tolerance: 32,
  contiguous: true,
  sampleAll: false,
  qsSize: 30,
  magWidth: 10, magContrast: 10, magFreq: 57,
};

function modeFor(p: PointerInfo): SelectMode {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return selOpts.mode;
}
function finishMask(m: HTMLCanvasElement) {
  return selOpts.feather > 0 ? featherMask(m, selOpts.feather) : m;
}
function insideSelection(doc: Doc, x: number, y: number) {
  if (!doc.selection || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return false;
  return ctx2d(doc.selection).getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 127;
}
const modeCursor = (p?: PointerInfo | null) => 'crosshair';

function selectButtons() {
  return [button('Select Subject', () => selectSubject(), { small: true }), button('Select and Mask...', () => selectAndMaskDialog(), { small: true })];
}

/** Dragging an existing selection outline with a selection tool. */
class SelectionMover {
  start: Point | null = null;
  dx = 0; dy = 0;
  begin(p: PointerInfo) { this.start = { x: p.x, y: p.y }; this.dx = 0; this.dy = 0; }
  move(p: PointerInfo, v: Viewport) {
    if (!this.start) return;
    this.dx = Math.round(p.x - this.start.x); this.dy = Math.round(p.y - this.start.y);
    v.requestRender();
  }
  end(doc: Doc) {
    if (!this.start || !doc.selection) { this.start = null; return; }
    this.start = null;
    if (!this.dx && !this.dy) return;
    const m = createCanvas(doc.width, doc.height);
    ctx2d(m).drawImage(doc.selection, this.dx, this.dy);
    commitSelection(doc, m, 'Move Selection');
  }
  overlay(v: Viewport) {
    const d = v.doc;
    if (!this.start || !d) return;
    const o = d.selectionOutline();
    if (!o) return;
    const p = new Path2D();
    p.addPath(o, new DOMMatrix().translate(this.dx, this.dy));
    v.strokeAnts(p);
  }
}

// ---------- Marquee ----------
export class MarqueeTool extends Tool {
  key = 'M'; group = 'marquee';
  private start: Point | null = null;
  private cur: Point | null = null;
  private mode: SelectMode = 'new';
  private mover = new SelectionMover();
  constructor(public id: string, public name: string, public icon: string, private shape: 'rect' | 'ellipse' | 'row' | 'col') { super(); }
  cursor = modeCursor;
  buildOptions() {
    const isRow = this.shape === 'row' || this.shape === 'col';
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      selectModes(() => selOpts.mode, (v) => { selOpts.mode = v as SelectMode; }), sep(),
      num('Feather:', () => selOpts.feather, (v) => { selOpts.feather = v; }, { min: 0, max: 1000, unit: 'px', step: 1 }),
      this.shape === 'ellipse' ? check('Anti-alias', () => selOpts.antialias, (v) => { selOpts.antialias = v; }) : null,
      isRow ? null : sep(),
      isRow ? null : sel('Style:', [{ value: 'normal', label: 'Normal' }, { value: 'ratio', label: 'Fixed Ratio' }, { value: 'size', label: 'Fixed Size' }], () => selOpts.style, (v) => { selOpts.style = v as any; }),
      isRow ? null : num('Width:', () => selOpts.fixW, (v) => { selOpts.fixW = v; }, { min: 1, max: 30000, width: 50 }),
      isRow ? null : num('Height:', () => selOpts.fixH, (v) => { selOpts.fixH = v; }, { min: 1, max: 30000, width: 50 }),
      sep(), ...selectButtons());
  }
  down(p: PointerInfo, v: Viewport) {
    const d = v.doc!;
    this.mode = modeFor(p);
    if (this.shape === 'row' || this.shape === 'col') {
      const r: Rect = this.shape === 'row' ? { x: 0, y: Math.floor(p.y), w: d.width, h: 1 } : { x: Math.floor(p.x), y: 0, w: 1, h: d.height };
      applySelectShape(d, maskFromRect(d.width, d.height, r), this.mode, this.name.replace(' Tool', ''));
      return;
    }
    if (this.mode === 'new' && !p.shift && !p.alt && insideSelection(d, p.x, p.y)) { this.mover.begin(p); return; }
    const s = v.snap(p.x, p.y);
    this.start = { x: Math.round(s.x), y: Math.round(s.y) };
    this.cur = this.start;
  }
  private rect(p: PointerInfo): Rect {
    const s = this.start!;
    let x2 = p.x, y2 = p.y;
    if (selOpts.style === 'size') return p.alt && this.mode !== 'subtract' ? { x: s.x - selOpts.fixW / 2, y: s.y - selOpts.fixH / 2, w: selOpts.fixW, h: selOpts.fixH } : { x: s.x, y: s.y, w: selOpts.fixW, h: selOpts.fixH };
    let w = x2 - s.x, hh = y2 - s.y;
    const constrain = (p.shift && this.mode !== 'add' && this.mode !== 'intersect') || selOpts.style === 'ratio';
    if (constrain) {
      const ratio = selOpts.style === 'ratio' ? selOpts.fixW / selOpts.fixH : 1;
      const m = Math.max(Math.abs(w), Math.abs(hh) * ratio);
      w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * (m / ratio);
    }
    x2 = s.x + w; y2 = s.y + hh;
    const fromCenter = p.alt && this.mode !== 'subtract' && this.mode !== 'intersect';
    if (fromCenter) return rectFromPoints(s.x - w, s.y - hh, x2, y2);
    return rectFromPoints(s.x, s.y, x2, y2);
  }
  private last: PointerInfo | null = null;
  move(p: PointerInfo, v: Viewport) {
    if (this.mover.start) { this.mover.move(p, v); return; }
    if (!this.start) return;
    const s = v.snap(p.x, p.y);
    this.last = { ...p, x: Math.round(s.x), y: Math.round(s.y) };
    this.cur = this.last;
  }
  up(p: PointerInfo, v: Viewport) {
    const d = v.doc!;
    if (this.mover.start) { this.mover.end(d); return; }
    if (!this.start) return;
    const r = this.last ? this.rect(this.last) : null;
    this.start = null; this.cur = null; this.last = null;
    if (!r || (r.w < 1 || r.h < 1)) {
      if (selOpts.style === 'size') return;
      if (this.mode === 'new' && d.selection) deselect();
      return;
    }
    const m = this.shape === 'ellipse' ? maskFromEllipse(d.width, d.height, r, selOpts.antialias) : maskFromRect(d.width, d.height, r);
    applySelectShape(d, finishMask(m), this.mode, this.shape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
  }
  overlay(_ctx: CanvasRenderingContext2D, v: Viewport) {
    this.mover.overlay(v);
    if (!this.start || !this.last) return;
    const r = this.rect(this.last);
    const path = new Path2D();
    if (this.shape === 'ellipse') path.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else path.rect(r.x, r.y, r.w, r.h);
    v.strokeAnts(path);
    // size readout
    const ctx = v.ctx;
    const sp = v.toScreen(r.x + r.w, r.y + r.h);
    ctx.font = '11px Segoe UI, sans-serif';
    const txt = `W: ${Math.round(r.w)} px   H: ${Math.round(r.h)} px`;
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(30,30,30,.85)';
    ctx.fillRect(sp.x + 12, sp.y + 12, tw + 12, 20);
    ctx.fillStyle = '#eee';
    ctx.fillText(txt, sp.x + 18, sp.y + 26);
  }
}

// ---------- Lasso (freehand / polygonal / magnetic) ----------
export class LassoTool extends Tool {
  key = 'L'; group = 'lasso';
  private pts: Point[] = [];
  private active = false;
  private mode: SelectMode = 'new';
  private hoverPt: Point | null = null;
  private edges: Float32Array | null = null;
  private lastAnchor: Point | null = null;
  constructor(public id: string, public name: string, public icon: string, private kind: 'free' | 'poly' | 'magnetic') { super(); }
  cursor = modeCursor;
  get busy() { return this.active && this.kind !== 'free'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      selectModes(() => selOpts.mode, (v) => { selOpts.mode = v as SelectMode; }), sep(),
      num('Feather:', () => selOpts.feather, (v) => { selOpts.feather = v; }, { min: 0, max: 1000, unit: 'px' }),
      check('Anti-alias', () => selOpts.antialias, (v) => { selOpts.antialias = v; }),
      this.kind === 'magnetic' ? sep() : null,
      this.kind === 'magnetic' ? num('Width:', () => selOpts.magWidth, (v) => { selOpts.magWidth = v; }, { min: 1, max: 256, unit: 'px', width: 44 }) : null,
      this.kind === 'magnetic' ? num('Contrast:', () => selOpts.magContrast, (v) => { selOpts.magContrast = v; }, { min: 1, max: 100, unit: '%', width: 44 }) : null,
      this.kind === 'magnetic' ? num('Frequency:', () => selOpts.magFreq, (v) => { selOpts.magFreq = v; }, { min: 0, max: 100, width: 44 }) : null,
      sep(), ...selectButtons());
  }
  down(p: PointerInfo, v: Viewport) {
    const d = v.doc!;
    if (this.kind === 'free') {
      this.mode = modeFor(p);
      this.pts = [{ x: p.x, y: p.y }];
      this.active = true;
      return;
    }
    if (!this.active) {
      this.mode = modeFor(p);
      this.active = true;
      this.pts = [{ x: p.x, y: p.y }];
      if (this.kind === 'magnetic') { this.computeEdges(d); this.lastAnchor = this.snapEdge(d, p.x, p.y); this.pts = [this.lastAnchor]; }
      return;
    }
    // close when clicking near the start
    const s = v.toScreen(this.pts[0].x, this.pts[0].y);
    if (Math.hypot(s.x - p.sx, s.y - p.sy) < 8 && this.pts.length > 2) { this.finish(d); return; }
    let q = { x: p.x, y: p.y };
    if (p.shift && this.pts.length) q = constrain45(this.pts[this.pts.length - 1], q);
    if (this.kind === 'magnetic') { q = this.snapEdge(d, q.x, q.y); this.lastAnchor = q; }
    this.pts.push(q);
  }
  move(p: PointerInfo, v: Viewport) {
    if (this.kind === 'free' && this.active) { this.pts.push({ x: p.x, y: p.y }); return; }
    this.hover(p, v);
  }
  hover(p: PointerInfo, v: Viewport) {
    this.hoverPt = { x: p.x, y: p.y };
    if (this.kind === 'magnetic' && this.active && this.lastAnchor) {
      const d = v.doc!;
      const sp = this.snapEdge(d, p.x, p.y);
      this.hoverPt = sp;
      const freq = Math.max(4, 60 - selOpts.magFreq * 0.5);
      if (Math.hypot(sp.x - this.lastAnchor.x, sp.y - this.lastAnchor.y) > freq) { this.pts.push(sp); this.lastAnchor = sp; }
    }
  }
  up(_p: PointerInfo, v: Viewport) {
    if (this.kind === 'free' && this.active) this.finish(v.doc!);
  }
  dblclick(_p: PointerInfo, v: Viewport) { if (this.active && this.kind !== 'free') this.finish(v.doc!); }
  keydown(e: KeyboardEvent, v: Viewport) {
    if (!this.active || this.kind === 'free') return false;
    if (e.key === 'Enter') { this.finish(v.doc!); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { this.pts.pop(); if (!this.pts.length) this.cancel(); this.lastAnchor = this.pts[this.pts.length - 1] ?? null; return true; }
    return false;
  }
  commit() { if (this.active && this.pts.length > 2 && this.docRef) this.finish(this.docRef); }
  private get docRef() { return app.doc; }
  cancel() { this.active = false; this.pts = []; bus.emit('render', app.doc); }
  deactivate() { this.cancel(); }
  private finish(d: Doc) {
    const pts = this.pts;
    this.active = false; this.pts = [];
    if (pts.length < 3) { if (this.mode === 'new' && d.selection && this.kind === 'free') deselect(); return; }
    const m = maskFromPolygon(d.width, d.height, pts, selOpts.antialias);
    applySelectShape(d, finishMask(m), this.mode, this.kind === 'free' ? 'Lasso' : this.kind === 'poly' ? 'Polygonal Lasso' : 'Magnetic Lasso');
  }
  overlay(_ctx: CanvasRenderingContext2D, v: Viewport) {
    if (!this.active || !this.pts.length) return;
    const p = new Path2D();
    this.pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
    if (this.kind !== 'free' && this.hoverPt) p.lineTo(this.hoverPt.x, this.hoverPt.y);
    v.strokeAnts(p);
    if (this.kind === 'magnetic') {
      const ctx = v.ctx;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
      for (const q of this.pts) { const s = v.toScreen(q.x, q.y); ctx.fillRect(s.x - 2, s.y - 2, 4, 4); ctx.strokeRect(s.x - 2.5, s.y - 2.5, 5, 5); }
    }
  }
  private computeEdges(d: Doc) {
    const img = getImageData(d.composite);
    const w = img.width, hh = img.height, s = img.data;
    const lum = new Float32Array(w * hh);
    for (let i = 0; i < w * hh; i++) lum[i] = s[i * 4] * 0.299 + s[i * 4 + 1] * 0.587 + s[i * 4 + 2] * 0.114;
    const e = new Float32Array(w * hh);
    for (let y = 1; y < hh - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1];
      const gy = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1];
      e[i] = Math.hypot(gx, gy);
    }
    this.edges = e;
  }
  private snapEdge(d: Doc, x: number, y: number): Point {
    const e = this.edges;
    if (!e) return { x, y };
    const r = selOpts.magWidth, w = d.width, hh = d.height;
    let best = -1, bx = x, by = y;
    const minE = selOpts.magContrast * 4;
    for (let yy = Math.max(1, Math.floor(y - r)); yy <= Math.min(hh - 2, Math.ceil(y + r)); yy++) {
      for (let xx = Math.max(1, Math.floor(x - r)); xx <= Math.min(w - 2, Math.ceil(x + r)); xx++) {
        const dd = Math.hypot(xx - x, yy - y);
        if (dd > r) continue;
        const v = e[yy * w + xx] * (1 - (dd / r) * 0.35);
        if (v > best) { best = v; bx = xx + 0.5; by = yy + 0.5; }
      }
    }
    return best >= minE ? { x: bx, y: by } : { x, y };
  }
}
function constrain45(a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

// ---------- Magic Wand ----------
export class MagicWandTool extends Tool {
  id = 'magic-wand'; name = 'Magic Wand Tool'; icon = 'magic-wand'; key = 'W'; group = 'wand';
  cursor = modeCursor;
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      selectModes(() => selOpts.mode, (v) => { selOpts.mode = v as SelectMode; }), sep(),
      num('Tolerance:', () => selOpts.tolerance, (v) => { selOpts.tolerance = v; app.wandTolerance = v; }, { min: 0, max: 255, width: 44 }),
      check('Anti-alias', () => selOpts.antialias, (v) => { selOpts.antialias = v; }),
      check('Contiguous', () => selOpts.contiguous, (v) => { selOpts.contiguous = v; }),
      check('Sample All Layers', () => selOpts.sampleAll, (v) => { selOpts.sampleAll = v; }),
      sep(), ...selectButtons());
  }
  down(p: PointerInfo, v: Viewport) {
    const d = v.doc!;
    if (p.x < 0 || p.y < 0 || p.x >= d.width || p.y >= d.height) return;
    const img = sampleImage(d, selOpts.sampleAll);
    const m = colorRegion(img, p.x, p.y, selOpts.tolerance, selOpts.contiguous, selOpts.antialias);
    applySelectShape(d, finishMask(m), modeFor(p), 'Magic Wand');
  }
}

// ---------- Quick Selection ----------
export class QuickSelectTool extends Tool {
  id = 'quick-select'; name = 'Quick Selection Tool'; icon = 'quick-select'; key = 'W'; group = 'wand';
  private img: ImageData | null = null;
  private acc: HTMLCanvasElement | null = null;
  private mode: SelectMode = 'add';
  private base: HTMLCanvasElement | null = null;
  private last: Point | null = null;
  private hoverP: Point | null = null;
  cursor() { return 'none'; }
  get size() { return selOpts.qsSize; }
  set size(v: number | null) { if (v) { selOpts.qsSize = Math.max(1, Math.min(500, v)); bus.emit('options'); } }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      selectModes(() => selOpts.mode, (v) => { selOpts.mode = v as SelectMode; }), sep(),
      num('Size:', () => selOpts.qsSize, (v) => { selOpts.qsSize = v; }, { min: 1, max: 500, unit: 'px' }),
      check('Sample All Layers', () => selOpts.sampleAll, (v) => { selOpts.sampleAll = v; }),
      sep(), ...selectButtons());
  }
  down(p: PointerInfo, v: Viewport) {
    const d = v.doc!;
    this.img = sampleImage(d, selOpts.sampleAll);
    // first stroke without a selection is "new"; afterwards it adds (Alt subtracts)
    this.mode = p.alt ? 'subtract' : (d.selection ? 'add' : 'new');
    if (selOpts.mode === 'subtract') this.mode = 'subtract';
    this.base = d.selection;
    this.acc = createCanvas(d.width, d.height);
    this.last = null;
    this.paint(p, v);
  }
  move(p: PointerInfo, v: Viewport) { this.hoverP = { x: p.x, y: p.y }; if (this.acc) this.paint(p, v); }
  hover(p: PointerInfo) { this.hoverP = { x: p.x, y: p.y }; }
  private paint(p: PointerInfo, v: Viewport) {
    if (this.last && Math.hypot(p.x - this.last.x, p.y - this.last.y) < selOpts.qsSize / 4) return;
    this.last = { x: p.x, y: p.y };
    const d = v.doc!;
    const region = growRegion(this.img!, p.x, p.y, selOpts.qsSize);
    if (!region) return;
    ctx2d(this.acc!).drawImage(region.canvas, region.x, region.y);
    // live preview as the selection (not yet committed)
    d.selection = combineMask(this.base, this.acc!, this.mode === 'new' ? 'add' : this.mode);
    d.setSelection(d.selection);
  }
  up(_p: PointerInfo, v: Viewport) {
    const d = v.doc!;
    if (!this.acc) return;
    const result = d.selection;
    d.selection = this.base;
    commitSelection(d, result ? copyMask(result) : null, 'Quick Selection');
    this.acc = null; this.img = null; this.base = null;
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    if (!this.hoverP || !v.doc) return;
    const s = v.toScreen(this.hoverP.x, this.hoverP.y);
    const r = (selOpts.qsSize / 2) * v.doc.zoom;
    ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(s.x, s.y, r + 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(s.x, s.y, r - 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.x - 3, s.y); ctx.lineTo(s.x + 3, s.y); ctx.moveTo(s.x, s.y - 3); ctx.lineTo(s.x, s.y + 3); ctx.stroke();
  }
}

/** Region growing for quick selection: flood from the brush area with a tolerance adapted to local color spread. */
function growRegion(img: ImageData, cx: number, cy: number, size: number): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  const W = img.width, H = img.height, d = img.data;
  const R = Math.max(8, size * 2.2);
  const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
  const x1 = Math.min(W, Math.ceil(cx + R)), y1 = Math.min(H, Math.ceil(cy + R));
  const w = x1 - x0, h0 = y1 - y0;
  if (w <= 0 || h0 <= 0) return null;
  // seed stats inside the brush
  const br = size / 2;
  let r = 0, g = 0, b = 0, n = 0;
  const samples: number[] = [];
  for (let y = Math.max(0, Math.floor(cy - br)); y < Math.min(H, cy + br); y++) for (let x = Math.max(0, Math.floor(cx - br)); x < Math.min(W, cx + br); x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 > br * br) continue;
    const i = (y * W + x) * 4;
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    samples.push(i);
  }
  if (!n) return null;
  r /= n; g /= n; b /= n;
  let spread = 0;
  for (const i of samples) spread = Math.max(spread, Math.abs(d[i] - r), Math.abs(d[i + 1] - g), Math.abs(d[i + 2] - b));
  const tol = Math.min(80, Math.max(18, spread * 1.15 + 10));
  const out = new ImageData(w, h0);
  const vis = new Uint8Array(w * h0);
  const stack: number[] = [];
  for (const i of samples) {
    const p = i / 4, x = p % W, y = (p - x) / W;
    const li = (y - y0) * w + (x - x0);
    if (!vis[li]) { vis[li] = 1; stack.push(li); }
  }
  const ok = (li: number) => {
    const x = (li % w) + x0, y = ((li / w) | 0) + y0;
    const i = (y * W + x) * 4;
    return Math.max(Math.abs(d[i] - r), Math.abs(d[i + 1] - g), Math.abs(d[i + 2] - b)) <= tol;
  };
  while (stack.length) {
    const li = stack.pop()!;
    out.data[li * 4 + 3] = 255;
    const x = li % w, y = (li / w) | 0;
    if (x > 0 && !vis[li - 1]) { vis[li - 1] = 1; if (ok(li - 1)) stack.push(li - 1); }
    if (x < w - 1 && !vis[li + 1]) { vis[li + 1] = 1; if (ok(li + 1)) stack.push(li + 1); }
    if (y > 0 && !vis[li - w]) { vis[li - w] = 1; if (ok(li - w)) stack.push(li - w); }
    if (y < h0 - 1 && !vis[li + w]) { vis[li + w] = 1; if (ok(li + w)) stack.push(li + w); }
  }
  const c = createCanvas(w, h0);
  ctx2d(c).putImageData(out, 0, 0);
  return { canvas: c, x: x0, y: y0 };
}

void label;
