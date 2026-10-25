// Edit > Transform > Warp: bend the layer (or the selected pixels) with a 4×4 Bézier grid, or a preset shape.
// Drag the corner points, their tangent handles, or anywhere inside the grid (that point follows the pointer);
// Enter commits, Esc cancels.
import { Tool, PointerInfo, setTool, currentTool, getTool } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { Doc, DocState } from '../core/document';
import { createCanvas, ctx2d, Point } from '../core/util';
import { h } from '../ui/dom';
import { toolHeader, sep } from '../ui/optbits';
import { iconButton, numberInput, select, toast } from '../ui/widgets';
import { alertDialog } from '../dialogs/dialog';
import { editableTarget } from '../ops/target';
import { liftContent, Lifted, composeOnto } from '../ops/transform';
import { fitGrid, gridFromRect, Grid, patchPoint, presetMap, WARP_PRESETS, WarpPreset, warpPreview, warpRender, weight } from '../ops/warp';

/** Tangent handles and the corner each belongs to (control-point indices, row-major 4×4). */
const CORNERS = [0, 3, 12, 15];
const TANGENTS: [number, number][] = [[1, 0], [4, 0], [2, 3], [7, 3], [8, 12], [13, 12], [11, 15], [14, 15]];

export class WarpTool extends Tool {
  id = 'warp'; name = 'Warp'; icon = 'move'; group = 'transform-hidden';
  private lifted: Lifted | null = null;
  private before: DocState | null = null;
  private savedSel: HTMLCanvasElement | null = null;
  private grid: Grid = [];
  private preset: WarpPreset = 'custom';
  private bend = 50;
  private prevTool = 'move';
  private drag: { kind: 'point'; k: number; start: Point; g0: Grid } | { kind: 'surface'; u: number; v: number; start: Point; g0: Grid } | null = null;
  private presetSel: ReturnType<typeof select> | null = null;
  private bendField: ReturnType<typeof numberInput> | null = null;
  get busy() { return !!this.lifted; }

  static async start() {
    const doc = app.doc;
    if (!doc) return;
    if (currentTool().busy) currentTool().commit();
    const L = doc.active;
    if (!L) return;
    if (L.kind === 'adjustment' || L.kind === 'group') { toast(L.kind === 'group' ? 'Select a layer inside the group to warp it' : 'Adjustment layers cannot be warped'); return; }
    if (!L.movable && !doc.selection) { await alertDialog('Photon', 'Could not warp because the layer is locked.'); return; }
    if (L.kind !== 'raster') { toast('Warp works on pixels: rasterize the layer first (Layer › Rasterize)'); return; }
    const t = await editableTarget(doc, 'warp');
    if (!t || t.kind !== 'layer') return;
    const wt = getTool('warp') as WarpTool;
    wt.prevTool = currentTool().id === 'warp' ? wt.prevTool : currentTool().id;
    if (!wt.begin(doc)) return;
    setTool('warp');
  }

  private begin(doc: Doc): boolean {
    const L = doc.active!;
    this.before = doc.captureState();
    const lifted = liftContent(doc, L, false, L.isBackground && doc.selection ? app.bg : null);
    if (!lifted) { toast('Could not warp: the layer or selection is empty.'); return false; }
    if (L.isBackground && !doc.selection) { L.isBackground = false; L.lockPosition = false; L.lockAlpha = false; L.name = 'Layer 0'; }
    this.lifted = lifted;
    L.canvas = lifted.base;
    this.savedSel = doc.selection;
    doc.selection = null;
    this.preset = 'custom';
    this.grid = gridFromRect(this.rect());
    this.syncFields();
    this.preview(doc);
    return true;
  }

  private rect() { const L = this.lifted!; return { x: L.fx, y: L.fy, w: L.float.width, h: L.float.height }; }
  private map() {
    if (this.preset !== 'custom') return presetMap(this.preset, this.rect(), this.bend / 100);
    const g = this.grid;
    return (u: number, v: number) => patchPoint(g, u, v);
  }
  /** Leave a preset for a free grid shaped like it (the first drag after picking one). */
  private toCustom() {
    if (this.preset === 'custom') return;
    this.grid = fitGrid(this.map());
    this.preset = 'custom';
    this.syncFields();
  }

  private preview(doc: Doc) {
    const L = this.lifted!;
    const p = warpPreview(L.float, this.map());
    doc.floating = { layer: L.layer, canvas: p.canvas, matrix: new DOMMatrix().translate(p.x, p.y) };
    L.layer.touch();
    doc.invalidate();
  }

  buildOptions() {
    this.presetSel = select({
      options: WARP_PRESETS, value: this.preset, width: 120,
      onChange: (v) => { this.preset = v as WarpPreset; if (this.preset === 'custom') this.grid = gridFromRect(this.rect()); if (app.doc && this.lifted) this.preview(app.doc); },
    });
    this.bendField = numberInput({ value: this.bend, min: -100, max: 100, unit: '%', width: 54, onChange: (v) => { this.bend = v; if (app.doc && this.lifted && this.preset !== 'custom') this.preview(app.doc); } });
    return h('div', { class: 'opt-group' }, toolHeader('move'),
      h('span', { class: 'opt-label' }, 'Warp:'), this.presetSel.el, sep(),
      h('span', { class: 'opt-label' }, 'Bend:'), this.bendField.el, sep(),
      iconButton('close', 'Cancel warp (Esc)', () => this.cancel()),
      iconButton('check', 'Commit warp (Enter)', () => this.commit()),
      h('span', { class: 'opt-label', style: { marginLeft: '10px' } }, 'Drag the points, handles, or inside the grid'));
  }
  private syncFields() { this.presetSel?.set(this.preset); this.bendField?.set(this.bend); }
  cursor() { return this.lifted ? 'default' : 'default'; }

  /** Control point under the pointer (screen distance), corners first. */
  private pointAt(v: Viewport, p: PointerInfo): number | null {
    const order = [...CORNERS, ...TANGENTS.map(([t]) => t)];
    for (const k of order) {
      const s = v.toScreen(this.grid[k].x, this.grid[k].y);
      if (Math.hypot(s.x - p.sx, s.y - p.sy) <= 7) return k;
    }
    return null;
  }
  /** (u, v) of the surface point under the pointer, or null outside the grid. */
  private surfaceAt(v: Viewport, p: PointerInfo): { u: number; v: number } | null {
    const map = this.map(), N = 24;
    let best = Infinity, bu = 0, bv = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const m = map(i / N, j / N), q = v.toScreen(m.x, m.y);
      const d = Math.hypot(q.x - p.sx, q.y - p.sy);
      if (d < best) { best = d; bu = i / N; bv = j / N; }
    }
    // refine around the best sample
    let step = 1 / N;
    for (let it = 0; it < 12; it++) {
      step /= 2;
      for (const [du, dv] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const u = Math.min(1, Math.max(0, bu + du)), w = Math.min(1, Math.max(0, bv + dv));
        const pt = map(u, w), q = v.toScreen(pt.x, pt.y);
        const d = Math.hypot(q.x - p.sx, q.y - p.sy);
        if (d < best) { best = d; bu = u; bv = w; }
      }
    }
    const cell = Math.max(6, (Math.max(this.lifted!.float.width, this.lifted!.float.height) * (v.doc?.zoom ?? 1)) / N);
    return best <= cell ? { u: bu, v: bv } : null;
  }

  down(p: PointerInfo, v: Viewport) {
    if (!this.lifted) return;
    const k = this.preset === 'custom' ? this.pointAt(v, p) : null;
    if (k !== null) { this.drag = { kind: 'point', k, start: { x: p.x, y: p.y }, g0: this.grid.map((q) => ({ ...q })) }; return; }
    const s = this.surfaceAt(v, p);
    if (!s) return;
    this.toCustom();
    this.drag = { kind: 'surface', u: s.u, v: s.v, start: { x: p.x, y: p.y }, g0: this.grid.map((q) => ({ ...q })) };
  }
  move(p: PointerInfo, v: Viewport) {
    const d = this.drag;
    if (!d || !this.lifted) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const g = d.g0.map((q) => ({ ...q }));
    if (d.kind === 'point') {
      g[d.k] = { x: g[d.k].x + dx, y: g[d.k].y + dy };
      // a corner carries its tangent handles with it
      if (CORNERS.includes(d.k)) for (const [t, c] of TANGENTS) if (c === d.k) g[t] = { x: g[t].x + dx, y: g[t].y + dy };
    } else {
      // move every control point by its share so the grabbed point lands exactly under the pointer
      let s2 = 0;
      for (let k = 0; k < 16; k++) s2 += weight(k, d.u, d.v) ** 2;
      for (let k = 0; k < 16; k++) { const w = weight(k, d.u, d.v) / s2; g[k] = { x: g[k].x + dx * w, y: g[k].y + dy * w }; }
    }
    this.grid = g;
    this.preview(v.doc!);
  }
  up() { this.drag = null; }
  dblclick() { this.commit(); }
  keydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { this.commit(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    return false;
  }

  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    if (!this.lifted || !v.doc) return;
    const map = this.map();
    const S = (u: number, w: number) => { const q = map(u, w); return v.toScreen(q.x, q.y); };
    const curve = (fixed: number, alongU: boolean) => {
      ctx.beginPath();
      for (let s = 0; s <= 32; s++) { const t = s / 32; const q = alongU ? S(t, fixed) : S(fixed, t); s ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }
      ctx.stroke();
    };
    ctx.save();
    ctx.lineWidth = 1;
    for (const [color, width] of [['rgba(0,0,0,0.55)', 2.5], ['#e8e8e8', 1]] as const) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      for (const f of [0, 1 / 3, 2 / 3, 1]) { curve(f, true); curve(f, false); }
    }
    if (this.preset === 'custom') {
      const g = this.grid;
      ctx.strokeStyle = '#1473e6';
      for (const [t, c] of TANGENTS) {
        const a = v.toScreen(g[t].x, g[t].y), b = v.toScreen(g[c].x, g[c].y);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(a.x, a.y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      for (const k of CORNERS) {
        const a = v.toScreen(g[k].x, g[k].y);
        ctx.fillStyle = '#fff';
        ctx.fillRect(Math.round(a.x) - 3.5, Math.round(a.y) - 3.5, 7, 7);
        ctx.strokeRect(Math.round(a.x) - 3.5, Math.round(a.y) - 3.5, 7, 7);
      }
    }
    ctx.restore();
  }

  commit() {
    const doc = app.doc, L = this.lifted;
    if (!doc || !L) return;
    const map = this.map();
    const piece = warpRender(L.float, map);
    doc.floating = null;
    const res = composeOnto(doc, L.base, L.layer.x, L.layer.y, piece);
    L.layer.canvas = res.canvas; L.layer.x = res.x; L.layer.y = res.y;
    if (L.layer.mask) doc.ensureCoverage(L.layer);
    L.layer.touch();
    // the selection bends with the pixels
    let sel: HTMLCanvasElement | null = null;
    if (this.savedSel) {
      const r = this.rect();
      const part = createCanvas(r.w, r.h);
      ctx2d(part).drawImage(this.savedSel, -r.x, -r.y);
      const m = warpRender(part, map);
      sel = createCanvas(doc.width, doc.height);
      ctx2d(sel).drawImage(m.canvas, m.x, m.y);
    }
    doc.selection = null;
    doc.setSelection(sel);
    this.lifted = null;
    doc.commit('Warp', this.before!);
    this.exit();
  }
  cancel() {
    const doc = app.doc, L = this.lifted;
    if (doc && L) {
      L.layer.canvas = L.original;
      doc.floating = null;
      L.layer.touch();
      doc.restoreState(this.before!);
      doc.invalidate();
    }
    this.lifted = null;
    this.exit();
  }
  private exit() {
    this.drag = null;
    const prev = this.prevTool;
    setTimeout(() => setTool(prev === 'warp' ? 'move' : prev));
  }
  deactivate() { if (this.lifted) this.commit(); }
}
