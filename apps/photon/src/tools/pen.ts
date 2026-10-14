import { Tool, PointerInfo } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { bus } from '../core/bus';
import { h } from '../ui/dom';
import { toolHeader, sep, check } from '../ui/optbits';
import { button, toast } from '../ui/widgets';
import { Doc, DocState } from '../core/document';
import { PathPoint, SubPath, VectorPath, pt, toPath2D } from '../core/paths';
import { Point, createCanvas, ctx2d, cssColor, uid } from '../core/util';
import { maskFromShape, SelectMode } from '../core/selection';
import { applySelectShape } from '../ops/selectops';
import { editableTarget } from '../ops/target';
import { paintOnto } from '../ops/paintops';
import { getTool } from './tool';

export const penOpts = { rubberBand: true, autoAddDelete: true };

/** The path being edited: the active path, creating "Work Path" if needed. */
export function activePath(doc: Doc, create = false): VectorPath | null {
  let p = doc.paths.find((x) => x.id === doc.activePathId) ?? null;
  if (!p && create) {
    p = { id: uid(), name: 'Work Path', subpaths: [] };
    doc.paths.push(p);
    doc.activePathId = p.id;
    bus.emit('paths', doc);
  }
  return p;
}

// ---------- path ops (Paths panel / Pen options) ----------
export function pathToSelection(doc: Doc, vp: VectorPath | null = activePath(doc), mode: SelectMode = 'new', feather = 0) {
  if (!vp || !vp.subpaths.length) { toast('No path'); return; }
  const m = maskFromShape(doc.width, doc.height, (x) => {
    const p = toPath2D(vp);
    // draw with evenodd so inner subpaths make holes
    x.fill(p, 'evenodd');
  });
  void feather;
  applySelectShape(doc, m, mode, 'Make Selection');
}
export async function fillPath(doc: Doc, vp: VectorPath | null = activePath(doc)) {
  if (!vp) return;
  const t = await editableTarget(doc, 'fill the path');
  if (!t) return;
  const before = doc.captureState();
  const c = createCanvas(t.canvas.width, t.canvas.height);
  const x = ctx2d(c);
  x.translate(-t.x, -t.y);
  x.fillStyle = cssColor(app.fg);
  x.fill(toPath2D(vp), 'evenodd');
  t.replace(paintOnto(doc, t, c, 1));
  doc.commit('Fill Path', before);
}
export async function strokePath(doc: Doc, vp: VectorPath | null = activePath(doc)) {
  if (!vp) return;
  const t = await editableTarget(doc, 'stroke the path');
  if (!t) return;
  const brush = getTool('brush') as any;
  const width = Math.max(1, brush?.opts?.size ?? 3);
  const hardness = brush?.opts?.hardness ?? 1;
  const before = doc.captureState();
  const c = createCanvas(t.canvas.width, t.canvas.height);
  const x = ctx2d(c);
  x.translate(-t.x, -t.y);
  x.strokeStyle = cssColor(app.fg);
  x.lineWidth = width;
  x.lineCap = 'round'; x.lineJoin = 'round';
  if (hardness < 0.9) x.filter = `blur(${(width * (1 - hardness)) / 4}px)`;
  x.stroke(toPath2D(vp));
  t.replace(paintOnto(doc, t, c, brush?.opts?.opacity ?? 1));
  doc.commit('Stroke Path', before);
}

// ---------- geometry helpers ----------
function bez(a: PathPoint, b: PathPoint, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * a.x + 3 * mt * mt * t * a.ox + 3 * mt * t * t * b.ix + t * t * t * b.x,
    y: mt * mt * mt * a.y + 3 * mt * mt * t * a.oy + 3 * mt * t * t * b.iy + t * t * t * b.y,
  };
}
interface Hit { sp: SubPath; i: number; part: 'anchor' | 'in' | 'out' | 'segment'; t?: number }
function hitTest(v: Viewport, vp: VectorPath | null, p: PointerInfo, handles = true): Hit | null {
  if (!vp) return null;
  const near = (x: number, y: number, r = 6) => { const s = v.toScreen(x, y); return Math.hypot(s.x - p.sx, s.y - p.sy) <= r; };
  for (const sp of vp.subpaths) for (let i = 0; i < sp.points.length; i++) {
    const q = sp.points[i];
    if (near(q.x, q.y)) return { sp, i, part: 'anchor' };
    if (handles) {
      if ((q.ox !== q.x || q.oy !== q.y) && near(q.ox, q.oy)) return { sp, i, part: 'out' };
      if ((q.ix !== q.x || q.iy !== q.y) && near(q.ix, q.iy)) return { sp, i, part: 'in' };
    }
  }
  for (const sp of vp.subpaths) {
    const n = sp.points.length;
    for (let i = 0; i < (sp.closed ? n : n - 1); i++) {
      const a = sp.points[i], b = sp.points[(i + 1) % n];
      for (let k = 1; k < 24; k++) { const t = k / 24; const q = bez(a, b, t); if (near(q.x, q.y, 5)) return { sp, i, part: 'segment', t }; }
    }
  }
  return null;
}
/** Split segment i of sp at t (de Casteljau), inserting a smooth anchor. */
function splitSegment(sp: SubPath, i: number, t: number) {
  const n = sp.points.length;
  const a = sp.points[i], b = sp.points[(i + 1) % n];
  const L = (p: Point, q: Point) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const p0 = { x: a.x, y: a.y }, p1 = { x: a.ox, y: a.oy }, p2 = { x: b.ix, y: b.iy }, p3 = { x: b.x, y: b.y };
  const p01 = L(p0, p1), p12 = L(p1, p2), p23 = L(p2, p3), p012 = L(p01, p12), p123 = L(p12, p23), m = L(p012, p123);
  a.ox = p01.x; a.oy = p01.y;
  b.ix = p23.x; b.iy = p23.y;
  const np: PathPoint = { x: m.x, y: m.y, ix: p012.x, iy: p012.y, ox: p123.x, oy: p123.y, smooth: true };
  sp.points.splice(i + 1, 0, np);
}

function drawPath(ctx: CanvasRenderingContext2D, v: Viewport, vp: VectorPath | null, showAll: boolean, sel?: { sp: SubPath; i: number } | null, rubber?: Point | null) {
  if (!vp || !v.doc) return;
  const d = v.doc;
  ctx.save();
  ctx.setTransform(d.zoom * v.dpr, 0, 0, d.zoom * v.dpr, d.panX * v.dpr, d.panY * v.dpr);
  ctx.lineWidth = 1 / d.zoom;
  ctx.strokeStyle = '#1473e6';
  ctx.stroke(toPath2D(vp));
  ctx.restore();
  for (const sp of vp.subpaths) {
    sp.points.forEach((q, i) => {
      const s = v.toScreen(q.x, q.y);
      const isSel = sel && sel.sp === sp && sel.i === i;
      if (showAll || isSel) {
        for (const [hx, hy] of [[q.ix, q.iy], [q.ox, q.oy]]) {
          if (hx === q.x && hy === q.y) continue;
          const hs = v.toScreen(hx, hy);
          ctx.strokeStyle = '#1473e6'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(hs.x, hs.y); ctx.stroke();
          ctx.fillStyle = '#1473e6'; ctx.beginPath(); ctx.arc(hs.x, hs.y, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.fillStyle = isSel ? '#1473e6' : '#fff';
      ctx.strokeStyle = '#1473e6';
      ctx.fillRect(Math.round(s.x) - 3, Math.round(s.y) - 3, 6, 6);
      ctx.strokeRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
    });
  }
  if (rubber) {
    const last = vp.subpaths[vp.subpaths.length - 1];
    const q = last && !last.closed ? last.points[last.points.length - 1] : null;
    if (q) {
      ctx.save();
      ctx.setTransform(d.zoom * v.dpr, 0, 0, d.zoom * v.dpr, d.panX * v.dpr, d.panY * v.dpr);
      ctx.lineWidth = 1 / d.zoom; ctx.strokeStyle = 'rgba(20,115,230,.7)';
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.bezierCurveTo(q.ox, q.oy, rubber.x, rubber.y, rubber.x, rubber.y); ctx.stroke();
      ctx.restore();
    }
  }
}

function pathButtons() {
  return [
    h('span', { class: 'opt-label' }, 'Make:'),
    button('Selection...', () => { const d = app.doc; if (d) pathToSelection(d); }, { small: true }),
    button('Fill', () => { const d = app.doc; if (d) fillPath(d); }, { small: true }),
    button('Stroke', () => { const d = app.doc; if (d) strokePath(d); }, { small: true }),
  ];
}

// ---------- Pen ----------
export class PenTool extends Tool {
  id = 'pen'; name = 'Pen Tool'; icon = 'pen'; key = 'P'; group = 'pen';
  private drag: { q: PathPoint; start: Point; before: DocState; isNew: boolean; handle?: 'in' | 'out' } | null = null;
  private hoverP: Point | null = null;
  private before: DocState | null = null;
  cursor() { return 'crosshair'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), h('span', { class: 'opt-label' }, 'Path'), sep(), ...pathButtons(), sep(),
      check('Rubber Band', () => penOpts.rubberBand, (v) => { penOpts.rubberBand = v; }),
      check('Auto Add/Delete', () => penOpts.autoAddDelete, (v) => { penOpts.autoAddDelete = v; }));
  }
  private openSub(vp: VectorPath): SubPath | null {
    const last = vp.subpaths[vp.subpaths.length - 1];
    return last && !last.closed ? last : null;
  }
  down(p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    const before = doc.captureState();
    const vp = activePath(doc, true)!;
    const hit = hitTest(v, vp, p, p.alt || p.ctrl);
    // Ctrl: temporary direct selection
    if (p.ctrl) { (getTool('direct-select') as DirectSelectTool).down(p, v); this.delegated = true; return; }
    const open = this.openSub(vp);
    if (hit && hit.part === 'anchor') {
      // close path by clicking its first point
      if (open && hit.sp === open && hit.i === 0 && open.points.length > 1) {
        open.closed = true;
        this.drag = { q: open.points[0], start: { x: p.x, y: p.y }, before, isNew: false, handle: 'in' };
        return;
      }
      if (p.alt) { const q = hit.sp.points[hit.i]; q.ix = q.ox = q.x; q.iy = q.oy = q.y; q.smooth = false; this.commitPaths(doc, before, 'Convert Point'); return; }
      if (penOpts.autoAddDelete && !open) { hit.sp.points.splice(hit.i, 1); if (!hit.sp.points.length) vp.subpaths.splice(vp.subpaths.indexOf(hit.sp), 1); this.commitPaths(doc, before, 'Delete Anchor Point'); return; }
    }
    if (hit && hit.part === 'segment' && penOpts.autoAddDelete && !open) {
      splitSegment(hit.sp, hit.i, hit.t!);
      this.commitPaths(doc, before, 'Add Anchor Point');
      return;
    }
    let q = pt(p.x, p.y);
    if (p.shift && open) {
      const last = open.points[open.points.length - 1];
      const ang = Math.round(Math.atan2(p.y - last.y, p.x - last.x) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(p.x - last.x, p.y - last.y);
      q = pt(last.x + Math.cos(ang) * len, last.y + Math.sin(ang) * len);
    }
    if (open) open.points.push(q);
    else vp.subpaths.push({ closed: false, points: [q] });
    this.drag = { q, start: { x: q.x, y: q.y }, before, isNew: true, handle: 'out' };
    bus.emit('paths', doc);
  }
  private delegated = false;
  move(p: PointerInfo, v: Viewport) {
    if (this.delegated) { (getTool('direct-select') as DirectSelectTool).move(p, v); return; }
    this.hoverP = { x: p.x, y: p.y };
    const d = this.drag;
    if (!d) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (Math.hypot(dx, dy) < 1) return;
    const q = d.q;
    // drag pulls out symmetric handles (Alt breaks the "in" handle)
    if (d.handle === 'in') { q.ix = q.x - dx; q.iy = q.y - dy; if (!p.alt) { q.ox = q.x + dx; q.oy = q.y + dy; } }
    else { q.ox = q.x + dx; q.oy = q.y + dy; if (!p.alt) { q.ix = q.x - dx; q.iy = q.y - dy; } }
    q.smooth = !p.alt;
  }
  hover(p: PointerInfo) { this.hoverP = { x: p.x, y: p.y }; }
  up(p: PointerInfo, v: Viewport) {
    if (this.delegated) { (getTool('direct-select') as DirectSelectTool).up(p, v); this.delegated = false; return; }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.commitPaths(v.doc!, d.before, d.isNew ? 'Add Anchor Point' : 'Close Path');
  }
  private commitPaths(doc: Doc, before: DocState, name: string) {
    doc.commit(name, before);
    bus.emit('paths', doc);
  }
  keydown(e: KeyboardEvent, v: Viewport) {
    const doc = v.doc;
    if (!doc) return false;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { pathToSelection(doc); return true; }
    if (e.key === 'Enter' || e.key === 'Escape') {
      // finish the open subpath
      const vp = activePath(doc);
      const open = vp && this.openSub(vp);
      if (open) { const before = doc.captureState(); open.closed = false; vp!.subpaths.push({ closed: true, points: [] }); vp!.subpaths.pop(); doc.commit('Finish Path', before); }
      this.hoverP = null;
      return !!open;
    }
    return false;
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    const doc = v.doc;
    if (!doc) return;
    const vp = activePath(doc);
    const open = vp && this.openSub(vp);
    drawPath(ctx, v, vp, false, open ? { sp: open, i: open.points.length - 1 } : null, penOpts.rubberBand && open && !this.drag ? this.hoverP : null);
  }
}

// ---------- Freeform pen ----------
export class FreeformPenTool extends Tool {
  id = 'freeform-pen'; name = 'Freeform Pen Tool'; icon = 'freeform-pen'; key = 'P'; group = 'pen';
  private pts: Point[] = [];
  private before: DocState | null = null;
  cursor() { return 'crosshair'; }
  buildOptions() { return h('div', { class: 'opt-group' }, toolHeader(this.icon), ...pathButtons()); }
  down(p: PointerInfo, v: Viewport) { this.pts = [{ x: p.x, y: p.y }]; this.before = v.doc!.captureState(); }
  move(p: PointerInfo) { if (this.pts.length) this.pts.push({ x: p.x, y: p.y }); }
  up(_p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    if (this.pts.length < 3) { this.pts = []; return; }
    const simple = rdp(this.pts, 2 / doc.zoom);
    const vp = activePath(doc, true)!;
    vp.subpaths.push({ closed: false, points: smoothPoints(simple) });
    this.pts = [];
    doc.commit('Freeform Pen', this.before!);
    bus.emit('paths', doc);
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    const doc = v.doc;
    if (!doc) return;
    drawPath(ctx, v, activePath(doc), false);
    if (this.pts.length > 1) {
      ctx.strokeStyle = '#1473e6';
      ctx.beginPath();
      this.pts.forEach((q, i) => { const s = v.toScreen(q.x, q.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.stroke();
    }
  }
}
function rdp(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let idx = 0, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x) / (Math.hypot(b.x - a.x, b.y - a.y) || 1);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}
/** Catmull-Rom → Bezier handles. */
function smoothPoints(pts: Point[]): PathPoint[] {
  return pts.map((p, i) => {
    const prev = pts[i - 1] ?? p, next = pts[i + 1] ?? p;
    const tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6;
    return { x: p.x, y: p.y, ix: p.x - tx, iy: p.y - ty, ox: p.x + tx, oy: p.y + ty, smooth: true };
  });
}

// ---------- Add / Delete / Convert anchor ----------
export class AnchorTool extends Tool {
  key = 'P'; group = 'pen';
  constructor(public id: string, public name: string, public icon: string, private kind: 'add' | 'delete' | 'convert') { super(); }
  private drag: { q: PathPoint; start: Point; before: DocState } | null = null;
  cursor() { return 'crosshair'; }
  buildOptions() { return h('div', { class: 'opt-group' }, toolHeader(this.icon), ...pathButtons()); }
  down(p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    const vp = activePath(doc);
    const hit = hitTest(v, vp, p, false);
    if (!hit || !vp) return;
    const before = doc.captureState();
    if (this.kind === 'add' && hit.part === 'segment') { splitSegment(hit.sp, hit.i, hit.t!); doc.commit('Add Anchor Point', before); }
    else if (this.kind === 'delete' && hit.part === 'anchor') {
      hit.sp.points.splice(hit.i, 1);
      if (!hit.sp.points.length) vp.subpaths.splice(vp.subpaths.indexOf(hit.sp), 1);
      doc.commit('Delete Anchor Point', before);
    } else if (this.kind === 'convert' && hit.part === 'anchor') {
      const q = hit.sp.points[hit.i];
      if (q.ix !== q.x || q.ox !== q.x || q.iy !== q.y || q.oy !== q.y) { q.ix = q.ox = q.x; q.iy = q.oy = q.y; q.smooth = false; doc.commit('Convert Point', before); }
      else this.drag = { q, start: { x: p.x, y: p.y }, before };
    }
    bus.emit('paths', doc);
  }
  move(p: PointerInfo) {
    const d = this.drag;
    if (!d) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    d.q.ox = d.q.x + dx; d.q.oy = d.q.y + dy; d.q.ix = d.q.x - dx; d.q.iy = d.q.y - dy; d.q.smooth = true;
  }
  up(_p: PointerInfo, v: Viewport) { if (this.drag) { v.doc!.commit('Convert Point', this.drag.before); this.drag = null; } }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) { if (v.doc) drawPath(ctx, v, activePath(v.doc), true); }
}

// ---------- Path / Direct selection ----------
export class DirectSelectTool extends Tool {
  key = 'A'; group = 'path-select';
  id = 'direct-select'; name = 'Direct Selection Tool'; icon = 'direct-select';
  private drag: { hit: Hit; start: Point; before: DocState; orig: PathPoint[][] } | null = null;
  private sel: { sp: SubPath; i: number } | null = null;
  constructor(private whole = false) { super(); if (whole) { this.id = 'path-select'; this.name = 'Path Selection Tool'; this.icon = 'path-select'; } }
  cursor() { return 'default'; }
  buildOptions() { return h('div', { class: 'opt-group' }, toolHeader(this.icon), ...pathButtons()); }
  down(p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    const vp = activePath(doc);
    const hit = hitTest(v, vp, p, !this.whole);
    if (!hit || !vp) { this.sel = null; return; }
    this.sel = { sp: hit.sp, i: hit.i };
    this.drag = { hit, start: { x: p.x, y: p.y }, before: doc.captureState(), orig: vp.subpaths.map((s) => s.points.map((q) => ({ ...q }))) };
  }
  move(p: PointerInfo, v: Viewport) {
    const d = this.drag;
    const vp = v.doc && activePath(v.doc);
    if (!d || !vp) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const si = vp.subpaths.indexOf(d.hit.sp);
    const orig = d.orig[si];
    const mv = (k: number) => { const o = orig[k], q = d.hit.sp.points[k]; Object.assign(q, { x: o.x + dx, y: o.y + dy, ix: o.ix + dx, iy: o.iy + dy, ox: o.ox + dx, oy: o.oy + dy }); };
    if (this.whole || d.hit.part === 'segment') d.hit.sp.points.forEach((_q, k) => mv(k));
    else if (d.hit.part === 'anchor') mv(d.hit.i);
    else {
      const q = d.hit.sp.points[d.hit.i], o = orig[d.hit.i];
      if (d.hit.part === 'out') {
        q.ox = o.ox + dx; q.oy = o.oy + dy;
        if (q.smooth && !p.alt) { const len = Math.hypot(o.ix - o.x, o.iy - o.y), a = Math.atan2(q.oy - q.y, q.ox - q.x) + Math.PI; q.ix = q.x + Math.cos(a) * len; q.iy = q.y + Math.sin(a) * len; }
      } else {
        q.ix = o.ix + dx; q.iy = o.iy + dy;
        if (q.smooth && !p.alt) { const len = Math.hypot(o.ox - o.x, o.oy - o.y), a = Math.atan2(q.iy - q.y, q.ix - q.x) + Math.PI; q.ox = q.x + Math.cos(a) * len; q.oy = q.y + Math.sin(a) * len; }
      }
      if (p.alt) q.smooth = false;
    }
  }
  up(_p: PointerInfo, v: Viewport) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    v.doc!.commit(this.whole ? 'Drag Path' : 'Drag Anchor', d.before);
    bus.emit('paths', v.doc);
  }
  keydown(e: KeyboardEvent, v: Viewport) {
    const doc = v.doc;
    if (!doc || !this.sel || (e.key !== 'Delete' && e.key !== 'Backspace')) return false;
    const vp = activePath(doc);
    if (!vp) return false;
    const before = doc.captureState();
    if (this.whole) vp.subpaths.splice(vp.subpaths.indexOf(this.sel.sp), 1);
    else { this.sel.sp.points.splice(this.sel.i, 1); if (!this.sel.sp.points.length) vp.subpaths.splice(vp.subpaths.indexOf(this.sel.sp), 1); }
    this.sel = null;
    doc.commit('Delete Anchor Point', before);
    bus.emit('paths', doc);
    return true;
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) { if (v.doc) drawPath(ctx, v, activePath(v.doc), !this.whole, this.sel); }
}
