import { Tool, PointerInfo, setTool, currentTool, getTool } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { bus } from '../core/bus';
import { h } from '../ui/dom';
import { toolHeader, sep, check, sel, num } from '../ui/optbits';
import { iconButton, numberInput, toast, button, select } from '../ui/widgets';
import { alertDialog } from '../dialogs/dialog';
import { Doc, DocState } from '../core/document';
import { Layer } from '../core/layer';
import { alphaBounds, createCanvas, ctx2d, Point, Rect, clamp } from '../core/util';
import { liftContent, Lifted, Quad, quadFromRect, affineFor, renderQuad, meshWarpPreview, composeOnto, transformMask } from '../ops/transform';
import { editableTarget } from '../ops/target';
import { hasActiveStyle } from '../core/effects';
import { block } from '../core/groups';
import { maskBounds } from '../core/selection';
import { renderedLayer } from '../core/compositor';

const boundsCache = new WeakMap<Layer, { v: number; r: Rect | null }>();
export function layerBounds(L: Layer): Rect | null {
  if (L.kind === 'adjustment') return null;
  const c = boundsCache.get(L);
  if (c && c.v === L.version) return c.r ? { x: c.r.x + L.x, y: c.r.y + L.y, w: c.r.w, h: c.r.h } : null;
  const r = alphaBounds(L.canvas, 8);
  boundsCache.set(L, { v: L.version, r });
  return r ? { x: r.x + L.x, y: r.y + L.y, w: r.w, h: r.h } : null;
}

/** Topmost visible layer with a visible pixel at (x,y). */
export function pickLayer(doc: Doc, x: number, y: number): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const L = doc.layers[i];
    if (!L.visible || L.kind === 'adjustment') continue;
    const lx = Math.floor(x - L.x), ly = Math.floor(y - L.y);
    if (lx < 0 || ly < 0 || lx >= L.canvas.width || ly >= L.canvas.height) continue;
    if (ctx2d(L.canvas).getImageData(lx, ly, 1, 1).data[3] > 10) return L;
  }
  return null;
}

// ---------- Move ----------
export class MoveTool extends Tool {
  id = 'move'; name = 'Move Tool'; icon = 'move'; key = 'V'; group = 'move';
  autoSelect = false;
  showTransform = false;
  private drag: {
    start: Point; before: DocState; moved: boolean;
    layers: { L: Layer; x: number; y: number; mx: number; my: number }[];
    lifted: Lifted | null; sel: HTMLCanvasElement | null; dx: number; dy: number;
  } | null = null;
  cursor(p?: PointerInfo | null) { return p?.alt ? 'copy' : 'move'; }
  buildOptions() {
    const align = (kind: string, title: string, svg: string) => {
      const b = h('button', { class: 'icon-btn', title, html: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${svg}</svg>` });
      b.addEventListener('click', () => alignLayers(kind));
      return b;
    };
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      check('Auto-Select:', () => this.autoSelect, (v) => { this.autoSelect = v; }),
      sel(null, [{ value: 'layer', label: 'Layer' }], () => 'layer', () => {}, 70), sep(),
      check('Show Transform Controls', () => this.showTransform, (v) => { this.showTransform = v; bus.emit('render', app.doc); }), sep(),
      align('left', 'Align left edges', '<path d="M4 3v18"/><rect x="7" y="6" width="10" height="4"/><rect x="7" y="14" width="6" height="4"/>'),
      align('hcenter', 'Align horizontal centers', '<path d="M12 3v18"/><rect x="6" y="6" width="12" height="4"/><rect x="8" y="14" width="8" height="4"/>'),
      align('right', 'Align right edges', '<path d="M20 3v18"/><rect x="7" y="6" width="10" height="4"/><rect x="11" y="14" width="6" height="4"/>'),
      align('top', 'Align top edges', '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="10"/><rect x="14" y="7" width="4" height="6"/>'),
      align('vcenter', 'Align vertical centers', '<path d="M3 12h18"/><rect x="6" y="6" width="4" height="12"/><rect x="14" y="8" width="4" height="8"/>'),
      align('bottom', 'Align bottom edges', '<path d="M3 20h18"/><rect x="6" y="7" width="4" height="10"/><rect x="14" y="11" width="4" height="6"/>'));
  }
  down(p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    if (this.autoSelect || p.ctrl) {
      const L = pickLayer(doc, p.x, p.y);
      if (L) doc.setActive(L, p.shift && !this.autoSelect);
    }
    const L = doc.active;
    if (!L) return;
    if (this.showTransform && !doc.selection && L.kind === 'raster') {
      const b = layerBounds(L);
      if (b && handleAt(v, quadFromRect(b.x, b.y, b.w, b.h), p) !== null) {
        setTool('transform');
        (currentTool() as TransformTool).down(p, v);
        return;
      }
    }
    const movingPixels = !!doc.selection && L.kind === 'raster';
    if (!movingPixels && (!L.movable || L.isBackground)) {
      alertDialog('Photon', 'Could not complete the move because the layer is locked.');
      return;
    }
    const before = doc.captureState();
    let lifted: Lifted | null = null;
    let selMask: HTMLCanvasElement | null = null;
    if (doc.selection && L.kind === 'raster') {
      if (!L.editable) { alertDialog('Photon', 'Could not move the selection because the layer is locked.'); return; }
      lifted = liftContent(doc, L, p.alt, L.isBackground ? app.bg : null);
      if (!lifted) { toast('Selected area is empty.'); return; }
      L.canvas = lifted.base;
      selMask = doc.selection;
      doc.selection = null; // drawn by our overlay while dragging
      doc.floating = { layer: L, canvas: lifted.float, matrix: new DOMMatrix().translate(lifted.fx, lifted.fy) };
    } else if (p.alt && L.kind !== 'adjustment' && L.kind !== 'group') {
      // Alt-drag duplicates the layer
      const copy = duplicateLayerObject(doc, L);
      copy.parentId = L.parentId;
      doc.insertLayer(copy, doc.indexOf(L) + 1);
    }
    // a selected group moves with everything inside it
    const moving = new Set<Layer>();
    if (!lifted) for (const s of doc.selectedLayers) for (const l of block(doc, s)) if (l.movable && !l.isBackground) moving.add(l);
    const layers = [...moving].map((l) => ({ L: l, x: l.x, y: l.y, mx: l.maskX, my: l.maskY }));
    this.drag = { start: { x: p.x, y: p.y }, before, moved: false, layers, lifted, sel: selMask, dx: 0, dy: 0 };
  }
  move(p: PointerInfo, v: Viewport) {
    const d = this.drag;
    if (!d) return;
    let dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    dx = Math.round(dx); dy = Math.round(dy);
    this.apply(v.doc!, dx, dy);
  }
  private apply(doc: Doc, dx: number, dy: number) {
    const d = this.drag!;
    d.dx = dx; d.dy = dy;
    if (dx || dy) d.moved = true;
    if (d.lifted) {
      doc.floating = { layer: d.lifted.layer, canvas: d.lifted.float, matrix: new DOMMatrix().translate(d.lifted.fx + dx, d.lifted.fy + dy) };
      d.lifted.layer.touch();
    } else {
      for (const l of d.layers) {
        l.L.x = l.x + dx; l.L.y = l.y + dy;
        l.L.maskX = l.mx + dx; l.L.maskY = l.my + dy;
        l.L.touch();
      }
    }
    doc.invalidate();
  }
  up(_p: PointerInfo, v: Viewport) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.finish(v.doc!, d);
  }
  private finish(doc: Doc, d: NonNullable<MoveTool['drag']>) {
    if (d.lifted) {
      const L = d.lifted.layer;
      doc.floating = null;
      if (!d.moved) {
        // a click without dragging changes nothing
        L.canvas = d.lifted.original;
        L.touch();
        doc.selection = d.sel;
        doc.invalidate();
        return;
      }
      const res = composeOnto(doc, d.lifted.base, L.x, L.y, { canvas: d.lifted.float, x: d.lifted.fx + d.dx, y: d.lifted.fy + d.dy });
      L.canvas = res.canvas; L.x = res.x; L.y = res.y;
      if (L.mask) doc.ensureCoverage(L);
      const m = createCanvas(doc.width, doc.height);
      ctx2d(m).drawImage(d.sel!, d.dx, d.dy);
      doc.selection = d.sel; // so setSelection resets caches properly
      doc.setSelection(m);
      L.touch();
      doc.commit('Move', d.before);
      return;
    }
    if (!d.moved) {
      if (d.before.layers.length !== doc.layers.length) doc.commit('Duplicate Layer', d.before);
      return;
    }
    for (const l of d.layers) doc.ensureCoverage(l.L);
    doc.commit('Move', d.before);
  }
  keydown(e: KeyboardEvent, v: Viewport) {
    const doc = v.doc;
    if (!doc || !e.key.startsWith('Arrow') || e.ctrlKey || e.metaKey) return false;
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const fake = { x: 0, y: 0, sx: 0, sy: 0, pressure: 1, button: 0, shift: false, alt: e.altKey, ctrl: false, e: new MouseEvent('x') } as PointerInfo;
    this.down(fake, v);
    if (!this.drag) return true;
    this.apply(doc, dx, dy);
    const d = this.drag;
    this.drag = null;
    this.finish(doc, d);
    return true;
  }
  overlay(_ctx: CanvasRenderingContext2D, v: Viewport) {
    const doc = v.doc!;
    const d = this.drag;
    if (d?.sel) {
      const o = (() => { doc.selection = d.sel; const out = doc.selectionOutline(); doc.selection = null; return out; })();
      if (o) { const p = new Path2D(); p.addPath(o, new DOMMatrix().translate(d.dx, d.dy)); v.strokeAnts(p); }
    }
    if (this.showTransform && !d?.lifted && doc.active) {
      const b = layerBounds(doc.active);
      if (b) drawHandles(v, quadFromRect(b.x, b.y, b.w, b.h));
    }
  }
}

export function duplicateLayerObject(doc: Doc, L: Layer, name?: string): Layer {
  const c = new Layer(name ?? `${L.name} copy`, 1, 1);
  const cv = createCanvas(L.canvas.width, L.canvas.height);
  ctx2d(cv).drawImage(L.canvas, 0, 0);
  c.canvas = cv; c.x = L.x; c.y = L.y; c.kind = L.kind;
  c.opacity = L.opacity; c.fillOpacity = L.fillOpacity; c.blend = L.blend; c.visible = L.visible;
  c.clipped = L.clipped; c.style = L.style; c.text = L.text; c.shape = L.shape; c.fill = L.fill; c.adjustment = L.adjustment;
  if (L.mask) { const m = createCanvas(L.mask.width, L.mask.height); ctx2d(m).drawImage(L.mask, 0, 0); c.mask = m; c.maskX = L.maskX; c.maskY = L.maskY; c.maskEnabled = L.maskEnabled; }
  c.color = L.color;
  void doc;
  return c;
}

export function alignLayers(kind: string) {
  const doc = app.doc;
  if (!doc) return;
  const layers = doc.selectedLayers.filter((l) => l.movable && !l.isBackground && l.kind !== 'adjustment');
  if (!layers.length) return;
  const sel = doc.selectionBounds();
  const boxes = layers.map((l) => ({ l, b: layerBounds(l) })).filter((x) => x.b) as { l: Layer; b: Rect }[];
  if (!boxes.length) return;
  let ref: Rect;
  if (sel) ref = sel;
  else if (boxes.length === 1) ref = { x: 0, y: 0, w: doc.width, h: doc.height };
  else {
    const x0 = Math.min(...boxes.map((b) => b.b.x)), y0 = Math.min(...boxes.map((b) => b.b.y));
    const x1 = Math.max(...boxes.map((b) => b.b.x + b.b.w)), y1 = Math.max(...boxes.map((b) => b.b.y + b.b.h));
    ref = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const before = doc.captureState();
  for (const { l, b } of boxes) {
    let dx = 0, dy = 0;
    if (kind === 'left') dx = ref.x - b.x;
    if (kind === 'right') dx = ref.x + ref.w - (b.x + b.w);
    if (kind === 'hcenter') dx = Math.round(ref.x + ref.w / 2 - (b.x + b.w / 2));
    if (kind === 'top') dy = ref.y - b.y;
    if (kind === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
    if (kind === 'vcenter') dy = Math.round(ref.y + ref.h / 2 - (b.y + b.h / 2));
    l.x += dx; l.y += dy; l.maskX += dx; l.maskY += dy;
    doc.ensureCoverage(l);
    l.touch();
  }
  doc.commit('Align', before);
}

/**
 * Layer > Distribute: spread 3 or more selected layers evenly — by their edges or centers (the outermost two
 * stay put), or with equal gaps between them (Horizontal / Vertical Spacing).
 */
export function distributeLayers(kind: 'top' | 'vcenter' | 'bottom' | 'left' | 'hcenter' | 'right' | 'hspace' | 'vspace') {
  const doc = app.doc;
  if (!doc) return;
  const layers = doc.selectedLayers.filter((l) => l.movable && !l.isBackground && l.kind !== 'adjustment');
  const boxes = layers.map((l) => ({ l, b: layerBounds(l) })).filter((x) => x.b) as { l: Layer; b: Rect }[];
  if (boxes.length < 3) { toast('Select three or more layers to distribute (Ctrl+click them in the Layers panel)'); return; }
  const horiz = kind === 'left' || kind === 'hcenter' || kind === 'right' || kind === 'hspace';
  const key = (b: Rect) => {
    switch (kind) {
      case 'left': case 'hspace': return b.x;
      case 'hcenter': return b.x + b.w / 2;
      case 'right': return b.x + b.w;
      case 'top': case 'vspace': return b.y;
      case 'vcenter': return b.y + b.h / 2;
      default: return b.y + b.h;
    }
  };
  boxes.sort((a, c) => key(a.b) - key(c.b));
  const n = boxes.length, first = boxes[0].b, last = boxes[n - 1].b;
  const target: number[] = [];
  if (kind === 'hspace' || kind === 'vspace') {
    const size = (b: Rect) => (horiz ? b.w : b.h);
    const start = horiz ? first.x : first.y, end = horiz ? last.x + last.w : last.y + last.h;
    const gap = (end - start - boxes.reduce((s, x) => s + size(x.b), 0)) / (n - 1);
    let at = start;
    for (const { b } of boxes) { target.push(at); at += size(b) + gap; }
  } else {
    const k0 = key(first), k1 = key(last);
    for (let i = 0; i < n; i++) target.push(k0 + ((k1 - k0) * i) / (n - 1));
  }
  const before = doc.captureState();
  boxes.forEach(({ l, b }, i) => {
    const now = kind === 'hspace' ? b.x : kind === 'vspace' ? b.y : key(b);
    const d = Math.round(target[i] - now);
    if (!d) return;
    const dx = horiz ? d : 0, dy = horiz ? 0 : d;
    l.x += dx; l.y += dy; l.maskX += dx; l.maskY += dy;
    doc.ensureCoverage(l);
    l.touch();
  });
  doc.commit('Distribute', before);
}

// ---------- shared handle geometry ----------
function quadScreen(v: Viewport, q: Quad) { return q.map((p) => v.toScreen(p.x, p.y)) as Quad; }
function handlePoints(q: Quad): Point[] {
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return [q[0], mid(q[0], q[1]), q[1], mid(q[1], q[2]), q[2], mid(q[2], q[3]), q[3], mid(q[3], q[0])];
}
/** Index 0..7 (corners even, edges odd), 8 = inside, 9 = outside-rotate, null none. */
function handleAt(v: Viewport, q: Quad, p: PointerInfo): number | null {
  const sq = quadScreen(v, q);
  const hp = handlePoints(sq);
  for (let i = 0; i < 8; i++) if (Math.hypot(hp[i].x - p.sx, hp[i].y - p.sy) <= 7) return i;
  if (pointInQuad(sq, { x: p.sx, y: p.sy })) return 8;
  return null;
}
function pointInQuad(q: Quad, p: Point) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i], b = q[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function drawHandles(v: Viewport, q: Quad, center?: Point) {
  const ctx = v.ctx;
  const sq = quadScreen(v, q);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1473e6';
  ctx.beginPath();
  sq.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  for (const hp of handlePoints(sq)) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.round(hp.x) - 3.5, Math.round(hp.y) - 3.5, 7, 7);
    ctx.strokeRect(Math.round(hp.x) - 3.5, Math.round(hp.y) - 3.5, 7, 7);
  }
  if (center) {
    const c = v.toScreen(center.x, center.y);
    ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.moveTo(c.x - 7, c.y); ctx.lineTo(c.x + 7, c.y); ctx.moveTo(c.x, c.y - 7); ctx.lineTo(c.x, c.y + 7);
    ctx.strokeStyle = '#000'; ctx.stroke();
  }
  ctx.restore();
}

// ---------- Free Transform ----------
interface Affine { cx: number; cy: number; w: number; h: number; angle: number; skew: number }
const SIGNS: Point[] = [{ x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }];

export class TransformTool extends Tool {
  id = 'transform'; name = 'Free Transform'; icon = 'move'; group = 'transform-hidden';
  private lifted: Lifted | null = null;
  private before: DocState | null = null;
  private A: Affine = { cx: 0, cy: 0, w: 1, h: 1, angle: 0, skew: 0 };
  private free: Quad | null = null;
  private srcRect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private drag: { mode: number | 'move' | 'rotate'; start: Point; A0: Affine; free0: Quad | null; a0: number; corner?: boolean } | null = null;
  private prevTool = 'move';
  private savedSel: HTMLCanvasElement | null = null;
  interp: 'nearest' | 'bilinear' | 'bicubic' = 'bicubic';
  private fields: Record<string, ReturnType<typeof numberInput>> = {};
  private mode: 'free' | 'scale' | 'rotate' | 'skew' | 'distort' | 'perspective' = 'free';
  get busy() { return !!this.lifted; }

  /** Start transforming the active layer / selection. Optional preset op: 'scale' etc. */
  static async start(mode: TransformTool['mode'] = 'free') {
    const doc = app.doc;
    if (!doc) return;
    if (currentTool().id === 'transform' && currentTool().busy) return;
    const L = doc.active;
    if (!L) return;
    if (L.kind === 'adjustment') { toast('Adjustment layers cannot be transformed'); return; }
    if (L.kind === 'group') { toast('Select a layer inside the group to transform it'); return; }
    if (!L.movable && !doc.selection) { await alertDialog('Photon', 'Could not transform because the layer is locked.'); return; }
    const t = await editableTarget(doc, 'transform');
    if (!t || t.kind !== 'layer') return;
    const tool = currentTool();
    const tt = getTool('transform') as TransformTool;
    tt.prevTool = tool.id === 'transform' ? tt.prevTool : tool.id;
    tt.mode = mode;
    tt.selOnly = false;
    if (!tt.begin(doc)) return;
    setTool('transform');
  }
  /** Select > Transform Selection: transform the selection outline only. */
  static startSelection() {
    const doc = app.doc;
    if (!doc || !doc.selection) { toast('Make a selection first'); return; }
    if (currentTool().id === 'transform' && currentTool().busy) return;
    const tt = getTool('transform') as TransformTool;
    tt.prevTool = currentTool().id === 'transform' ? tt.prevTool : currentTool().id;
    tt.mode = 'free';
    tt.selOnly = true;
    const sel = doc.selection;
    const b = maskBounds(sel);
    if (!b) return;
    tt.before = doc.captureState();
    const float = createCanvas(b.w, b.h);
    ctx2d(float).drawImage(sel, -b.x, -b.y);
    const L = doc.active ?? doc.layers[0];
    tt.selOutline = doc.selectionOutline();
    tt.lifted = { layer: L, float, fx: b.x, fy: b.y, base: L.canvas, original: L.canvas, selection: sel };
    tt.savedSel = sel;
    doc.selection = null;
    tt.srcRect = { ...b };
    tt.A = { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, angle: 0, skew: 0 };
    tt.free = null;
    tt.preview(doc);
    setTool('transform');
  }
  selOnly = false;
  private selOutline: Path2D | null = null;
  private begin(doc: Doc): boolean {
    const L = doc.active!;
    this.before = doc.captureState();
    const lifted = liftContent(doc, L, false, L.isBackground && doc.selection ? app.bg : null);
    if (!lifted) { toast('Could not transform: the layer or selection is empty.'); return false; }
    if (L.isBackground && !doc.selection) { L.isBackground = false; L.lockPosition = false; L.lockAlpha = false; L.name = 'Layer 0'; }
    this.lifted = lifted;
    L.canvas = lifted.base;
    this.savedSel = doc.selection;
    doc.selection = null;
    this.srcRect = { x: lifted.fx, y: lifted.fy, w: lifted.float.width, h: lifted.float.height };
    this.A = { cx: lifted.fx + lifted.float.width / 2, cy: lifted.fy + lifted.float.height / 2, w: lifted.float.width, h: lifted.float.height, angle: 0, skew: 0 };
    this.free = null;
    this.preview(doc);
    return true;
  }
  quad(): Quad {
    if (this.free) return this.free;
    const { cx, cy, w, h, angle, skew } = this.A;
    const c = Math.cos(angle), s = Math.sin(angle);
    return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
      let x = (sx * w) / 2, y = (sy * h) / 2;
      x += skew * y;
      return { x: cx + x * c - y * s, y: cy + x * s + y * c };
    }) as Quad;
  }
  private preview(doc: Doc) {
    const L = this.lifted!;
    if (this.selOnly) { doc.invalidate(); this.syncFields(); return; }
    const q = this.quad();
    const m = affineFor(L.float.width, L.float.height, q);
    if (m) doc.floating = { layer: L.layer, canvas: L.float, matrix: m };
    else {
      const p = meshWarpPreview(L.float, q, 12);
      doc.floating = { layer: L.layer, canvas: p.canvas, matrix: new DOMMatrix().translate(p.x, p.y) };
    }
    L.layer.touch();
    doc.invalidate();
    this.syncFields();
  }
  cursor(p?: PointerInfo | null) {
    if (!p || !app.doc || !this.lifted) return 'default';
    return 'default';
  }
  buildOptions() {
    const f = (key: string, label: string, unit: string, get: () => number, set: (v: number) => void, step = 1) => {
      const n = numberInput({ value: get(), unit, width: 54, step, onChange: (v) => { set(v); if (app.doc) this.preview(app.doc); } });
      this.fields[key] = n;
      (n as any).getter = get;
      return h('div', { class: 'opt-group' }, h('span', { class: 'opt-label' }, label), n.el);
    };
    const interp = select({ options: [{ value: 'nearest', label: 'Nearest Neighbor' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'bicubic', label: 'Bicubic' }], value: this.interp, onChange: (v) => { this.interp = v as any; } });
    return h('div', { class: 'opt-group' }, toolHeader('move'),
      f('x', 'X:', 'px', () => Math.round(this.A.cx), (v) => { this.A.cx = v; }),
      f('y', 'Y:', 'px', () => Math.round(this.A.cy), (v) => { this.A.cy = v; }), sep(),
      f('w', 'W:', '%', () => Math.round((this.A.w / this.srcRect.w) * 1000) / 10, (v) => { this.A.w = (this.srcRect.w * v) / 100; }, 0.1),
      f('h', 'H:', '%', () => Math.round((this.A.h / this.srcRect.h) * 1000) / 10, (v) => { this.A.h = (this.srcRect.h * v) / 100; }, 0.1), sep(),
      f('a', '∠', '°', () => Math.round((this.A.angle * 180) / Math.PI * 10) / 10, (v) => { this.A.angle = (v * Math.PI) / 180; }, 0.1),
      f('k', 'H skew:', '°', () => Math.round((Math.atan(this.A.skew) * 180) / Math.PI * 10) / 10, (v) => { this.A.skew = Math.tan((clamp(v, -89, 89) * Math.PI) / 180); }, 0.1), sep(),
      h('span', { class: 'opt-label' }, 'Interpolation:'), interp.el, sep(),
      iconButton('close', 'Cancel transform (Esc)', () => this.cancel()),
      iconButton('check', 'Commit transform (Enter)', () => this.commit()),
      h('span', { class: 'opt-label', style: { marginLeft: '10px' } }, 'Drag handles to scale (Shift: free), outside to rotate, Ctrl+drag to distort/skew'));
  }
  private syncFields() {
    for (const n of Object.values(this.fields)) n.set((n as any).getter());
  }
  down(p: PointerInfo, v: Viewport) {
    if (!this.lifted) return;
    const q = this.quad();
    let hi = handleAt(v, q, p);
    const c = this.center();
    if (hi === null) hi = 9;
    this.drag = { mode: hi === 8 ? 'move' : hi === 9 ? 'rotate' : hi, start: { x: p.x, y: p.y }, A0: { ...this.A }, free0: this.free ? (this.free.map((pt) => ({ ...pt })) as Quad) : null, a0: Math.atan2(p.y - c.y, p.x - c.x) };
    if ((p.ctrl || this.mode === 'distort' || this.mode === 'perspective') && typeof hi === 'number' && hi < 8 && !this.free) {
      this.free = q.map((pt) => ({ ...pt })) as Quad;
      this.drag.free0 = this.free.map((pt) => ({ ...pt })) as Quad;
    }
  }
  private center(): Point {
    if (!this.free) return { x: this.A.cx, y: this.A.cy };
    const q = this.free;
    return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
  }
  move(p: PointerInfo, v: Viewport) {
    const d = this.drag;
    if (!d || !this.lifted) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (d.mode === 'move') {
      if (d.free0) this.free = d.free0.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) as Quad;
      else { this.A.cx = d.A0.cx + dx; this.A.cy = d.A0.cy + dy; }
    } else if (d.mode === 'rotate') {
      const c = this.center();
      let da = Math.atan2(p.y - c.y, p.x - c.x) - d.a0;
      if (p.shift) da = Math.round((d.A0.angle + da) / (Math.PI / 12)) * (Math.PI / 12) - d.A0.angle;
      if (d.free0) {
        const cs = Math.cos(da), sn = Math.sin(da);
        this.free = d.free0.map((pt) => ({ x: c.x + (pt.x - c.x) * cs - (pt.y - c.y) * sn, y: c.y + (pt.x - c.x) * sn + (pt.y - c.y) * cs })) as Quad;
      } else this.A.angle = d.A0.angle + da;
    } else if (typeof d.mode === 'number') {
      const hi = d.mode;
      if (this.free && d.free0) {
        // distort: corners move freely; edges move both endpoints (skew with Ctrl)
        const q = d.free0.map((pt) => ({ ...pt })) as Quad;
        if (hi % 2 === 0) { const ci = hi / 2; q[ci] = { x: q[ci].x + dx, y: q[ci].y + dy }; }
        else { const a = (hi - 1) / 2, b = (a + 1) % 4; q[a] = { x: q[a].x + dx, y: q[a].y + dy }; q[b] = { x: q[b].x + dx, y: q[b].y + dy }; }
        this.free = q;
      } else if (p.ctrl && hi % 2 === 1) {
        // skew by dragging an edge
        const A0 = d.A0, c = Math.cos(-A0.angle), s = Math.sin(-A0.angle);
        const lx = dx * c - dy * s;
        if (hi === 1 || hi === 5) this.A.skew = A0.skew + ((hi === 5 ? 1 : -1) * lx * 2) / A0.h;
      } else this.scaleDrag(hi, p, d.A0);
    }
    this.preview(v.doc!);
  }
  private scaleDrag(hi: number, p: PointerInfo, A0: Affine) {
    const sg = SIGNS[hi];
    const c = Math.cos(-A0.angle), s = Math.sin(-A0.angle);
    const rx = p.x - A0.cx, ry = p.y - A0.cy;
    const lp = { x: rx * c - ry * s, y: rx * s + ry * c };
    lp.x -= A0.skew * lp.y; // undo skew
    const proportional = hi % 2 === 0 && !p.shift;
    let w = A0.w, hh = A0.h, cxL = 0, cyL = 0;
    if (p.alt) {
      if (sg.x) w = 2 * lp.x * sg.x;
      if (sg.y) hh = 2 * lp.y * sg.y;
    } else {
      const ax = (-sg.x * A0.w) / 2, ay = (-sg.y * A0.h) / 2;
      if (sg.x) w = (lp.x - ax) * sg.x;
      if (sg.y) hh = (lp.y - ay) * sg.y;
      if (proportional) {
        const k = Math.max(w / A0.w, hh / A0.h);
        w = A0.w * k; hh = A0.h * k;
      }
      cxL = sg.x ? ax + (sg.x * w) / 2 : 0;
      cyL = sg.y ? ay + (sg.y * hh) / 2 : 0;
    }
    if (p.alt && proportional) { const k = Math.max(w / A0.w, hh / A0.h); w = A0.w * k; hh = A0.h * k; }
    if (Math.abs(w) < 1) w = Math.sign(w || 1);
    if (Math.abs(hh) < 1) hh = Math.sign(hh || 1);
    cxL += A0.skew * cyL;
    const cc = Math.cos(A0.angle), ss = Math.sin(A0.angle);
    this.A = { ...A0, w, h: hh, cx: A0.cx + cxL * cc - cyL * ss, cy: A0.cy + cxL * ss + cyL * cc };
  }
  up() { this.drag = null; }
  dblclick() { this.commit(); }
  keydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { this.commit(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    return false;
  }
  overlay(_ctx: CanvasRenderingContext2D, v: Viewport) {
    if (!this.lifted) return;
    if (this.selOnly && this.selOutline && this.lifted) {
      const m = affineFor(this.lifted.float.width, this.lifted.float.height, this.quad());
      if (m) { const p = new Path2D(); p.addPath(this.selOutline, m.multiply(new DOMMatrix().translate(-this.lifted.fx, -this.lifted.fy))); v.strokeAnts(p); }
    }
    drawHandles(v, this.quad(), this.center());
  }
  /** Programmatic flips/rotations inside an active transform (Edit > Transform submenu). */
  flip(horizontal: boolean) { if (this.free) return; if (horizontal) this.A.w = -this.A.w; else this.A.h = -this.A.h; if (app.doc) this.preview(app.doc); }
  rotateBy(deg: number) {
    const c = this.center(), da = (deg * Math.PI) / 180;
    if (this.free) { const cs = Math.cos(da), sn = Math.sin(da); this.free = this.free.map((pt) => ({ x: c.x + (pt.x - c.x) * cs - (pt.y - c.y) * sn, y: c.y + (pt.x - c.x) * sn + (pt.y - c.y) * cs })) as Quad; }
    else this.A.angle += da;
    if (app.doc) this.preview(app.doc);
  }
  commit() {
    const doc = app.doc;
    const L = this.lifted;
    if (!doc || !L) return;
    const q = this.quad();
    if (this.selOnly) {
      doc.selection = null;
      doc.setSelection(transformMask(doc, this.savedSel!, this.srcRect, q));
      this.lifted = null;
      doc.commit('Transform Selection', this.before!);
      this.exit();
      return;
    }
    const piece = renderQuad(L.float, q, this.interp);
    doc.floating = null;
    const res = composeOnto(doc, L.base, L.layer.x, L.layer.y, piece);
    L.layer.canvas = res.canvas; L.layer.x = res.x; L.layer.y = res.y;
    if (L.layer.mask) doc.ensureCoverage(L.layer);
    L.layer.touch();
    doc.selection = null;
    doc.setSelection(this.savedSel ? transformMask(doc, this.savedSel, this.srcRect, q) : null);
    this.lifted = null;
    doc.commit('Free Transform', this.before!);
    this.exit();
  }
  cancel() {
    const doc = app.doc;
    const L = this.lifted;
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
    this.free = null;
    this.drag = null;
    const prev = this.prevTool;
    setTimeout(() => setTool(prev === 'transform' ? 'move' : prev));
  }
  deactivate() { if (this.lifted) this.commit(); }
}

// ---------- Crop ----------
export class CropTool extends Tool {
  id = 'crop'; name = 'Crop Tool'; icon = 'crop'; key = 'C'; group = 'crop';
  private box: Rect | null = null;
  private drag: { mode: number | 'move' | 'new'; start: Point; box0: Rect } | null = null;
  ratio: 'free' | 'original' | '1:1' | '4:5' | '5:7' | '2:3' | '16:9' = 'free';
  deleteCropped = true;
  overlayKind: 'thirds' | 'grid' | 'none' = 'thirds';
  get busy() { return !!this.box; }
  cursor() { return 'crosshair'; }
  activate() { const d = app.doc; if (d) { this.box = { x: 0, y: 0, w: d.width, h: d.height }; bus.emit('render', d); } }
  deactivate() { this.box = null; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      sel(null, [
        { value: 'free', label: 'Ratio' }, { value: 'original', label: 'Original Ratio' }, '-',
        { value: '1:1', label: '1 : 1 (Square)' }, { value: '4:5', label: '4 : 5 (8 : 10)' }, { value: '5:7', label: '5 : 7' },
        { value: '2:3', label: '2 : 3 (4 : 6)' }, { value: '16:9', label: '16 : 9' },
      ], () => this.ratio, (v) => { this.ratio = v as any; this.applyRatio(); }, 150),
      button('Clear', () => { this.ratio = 'free'; bus.emit('options'); }, { small: true }), sep(),
      sel('Overlay:', [{ value: 'thirds', label: 'Rule of Thirds' }, { value: 'grid', label: 'Grid' }, { value: 'none', label: 'None' }], () => this.overlayKind, (v) => { this.overlayKind = v as any; bus.emit('render', app.doc); }),
      check('Delete Cropped Pixels', () => this.deleteCropped, (v) => { this.deleteCropped = v; }), sep(),
      iconButton('close', 'Cancel crop (Esc)', () => this.cancel()),
      iconButton('check', 'Commit crop (Enter)', () => this.commit()));
  }
  private ratioValue(): number | null {
    const d = app.doc;
    if (this.ratio === 'free') return null;
    if (this.ratio === 'original') return d ? d.width / d.height : null;
    const [a, b] = this.ratio.split(':').map(Number);
    const r = a / b;
    // match orientation of the current box
    return this.box && this.box.h > this.box.w ? Math.min(r, 1 / r) : Math.max(r, 1 / r);
  }
  private applyRatio() {
    const r = this.ratioValue();
    if (!r || !this.box) return;
    const b = this.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let w = b.w, hh = w / r;
    if (hh > b.h) { hh = b.h; w = hh * r; }
    this.box = { x: cx - w / 2, y: cy - hh / 2, w, h: hh };
    bus.emit('render', app.doc);
  }
  down(p: PointerInfo, v: Viewport) {
    if (!this.box) this.activate();
    const b = this.box!;
    const hi = handleAt(v, quadFromRect(b.x, b.y, b.w, b.h), p);
    this.drag = { mode: hi === null ? 'new' : hi === 8 ? 'move' : hi, start: { x: p.x, y: p.y }, box0: { ...b } };
  }
  move(p: PointerInfo, v: Viewport) {
    const d = this.drag;
    if (!d) return;
    const s = v.snap(p.x, p.y);
    const x = Math.round(s.x), y = Math.round(s.y);
    const r = this.ratioValue() ?? (p.shift ? d.box0.w / d.box0.h : null);
    const b0 = d.box0;
    if (d.mode === 'new') {
      let w = x - d.start.x, hh = y - d.start.y;
      if (r) hh = Math.sign(hh || 1) * Math.abs(w) / r;
      this.box = { x: Math.min(d.start.x, d.start.x + w), y: Math.min(d.start.y, d.start.y + hh), w: Math.abs(w), h: Math.abs(hh) };
    } else if (d.mode === 'move') {
      this.box = { ...b0, x: b0.x + Math.round(p.x - d.start.x), y: b0.y + Math.round(p.y - d.start.y) };
    } else {
      const sg = SIGNS[d.mode];
      let x0 = b0.x, y0 = b0.y, x1 = b0.x + b0.w, y1 = b0.y + b0.h;
      if (sg.x < 0) x0 = Math.min(x, x1 - 1); if (sg.x > 0) x1 = Math.max(x, x0 + 1);
      if (sg.y < 0) y0 = Math.min(y, y1 - 1); if (sg.y > 0) y1 = Math.max(y, y0 + 1);
      if (r) {
        const w = x1 - x0, hh = y1 - y0;
        if (sg.x && sg.y) { const nh = w / r; if (sg.y < 0) y0 = y1 - nh; else y1 = y0 + nh; }
        else if (sg.x) { const nh = w / r, cy = (y0 + y1) / 2; y0 = cy - nh / 2; y1 = cy + nh / 2; }
        else { const nw = hh * r, cx = (x0 + x1) / 2; x0 = cx - nw / 2; x1 = cx + nw / 2; }
      }
      this.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    v.requestRender();
  }
  up() {
    this.drag = null;
    if (this.box && (this.box.w < 2 || this.box.h < 2)) this.activate();
  }
  dblclick() { this.commit(); }
  keydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { this.commit(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    return false;
  }
  cancel() { this.activate(); }
  commit() {
    const doc = app.doc;
    if (!doc || !this.box) return;
    const r = { x: Math.round(this.box.x), y: Math.round(this.box.y), w: Math.max(1, Math.round(this.box.w)), h: Math.max(1, Math.round(this.box.h)) };
    if (r.x === 0 && r.y === 0 && r.w === doc.width && r.h === doc.height) return;
    cropDocument(doc, r, this.deleteCropped);
    this.activate();
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    const d = v.doc;
    if (!d || !this.box) return;
    const b = this.box;
    const a = v.toScreen(b.x, b.y), c = v.toScreen(b.x + b.w, b.y + b.h);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, v.w, v.h);
    ctx.rect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    if (this.overlayKind !== 'none') {
      const n = this.overlayKind === 'thirds' ? 3 : 6;
      ctx.beginPath();
      for (let i = 1; i < n; i++) {
        const x = a.x + ((c.x - a.x) * i) / n, y = a.y + ((c.y - a.y) * i) / n;
        ctx.moveTo(Math.round(x) + 0.5, a.y); ctx.lineTo(Math.round(x) + 0.5, c.y);
        ctx.moveTo(a.x, Math.round(y) + 0.5); ctx.lineTo(c.x, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
    // PS-style corner brackets
    ctx.lineWidth = 3;
    const L = 14;
    const corners: [number, number, number, number][] = [[a.x, a.y, 1, 1], [c.x, a.y, -1, 1], [c.x, c.y, -1, -1], [a.x, c.y, 1, -1]];
    ctx.beginPath();
    for (const [x, y, sx, sy] of corners) { ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L); }
    for (const [x, y] of [[(a.x + c.x) / 2, a.y], [(a.x + c.x) / 2, c.y]]) { ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); }
    for (const [x, y] of [[a.x, (a.y + c.y) / 2], [c.x, (a.y + c.y) / 2]]) { ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); }
    ctx.stroke();
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(30,30,30,.85)';
    const txt = `${Math.round(b.w)} × ${Math.round(b.h)} px`;
    ctx.fillRect(c.x + 8, c.y + 8, ctx.measureText(txt).width + 12, 20);
    ctx.fillStyle = '#eee';
    ctx.fillText(txt, c.x + 14, c.y + 22);
    ctx.restore();
  }
}

/** Crop (or extend) the canvas to rect r in doc coordinates. */
export function cropDocument(doc: Doc, r: Rect, deletePixels = true) {
  const before = doc.captureState();
  for (const L of doc.layers) {
    L.x -= r.x; L.y -= r.y; L.maskX -= r.x; L.maskY -= r.y;
  }
  doc.width = r.w; doc.height = r.h;
  for (const L of doc.layers) {
    if (L.kind === 'raster') {
      if (deletePixels || L.isBackground) {
        const c = createCanvas(r.w, r.h);
        const cx = ctx2d(c);
        if (L.isBackground) { cx.fillStyle = `rgb(${app.bg.r},${app.bg.g},${app.bg.b})`; cx.fillRect(0, 0, r.w, r.h); }
        cx.drawImage(L.canvas, L.x, L.y);
        L.canvas = c; L.x = 0; L.y = 0;
      } else doc.ensureCoverage(L);
    } else if (L.kind === 'fill' || L.kind === 'adjustment') {
      if (L.kind === 'fill') { const c = createCanvas(r.w, r.h); ctx2d(c).drawImage(L.canvas, L.x, L.y); L.canvas = c; L.x = 0; L.y = 0; }
    }
    if (L.mask) {
      const m = createCanvas(r.w, r.h);
      const mx = ctx2d(m);
      mx.fillStyle = '#000'; mx.fillRect(0, 0, r.w, r.h);
      mx.clearRect(L.maskX, L.maskY, L.mask.width, L.mask.height);
      mx.drawImage(L.mask, L.maskX, L.maskY);
      L.mask = m; L.maskX = 0; L.maskY = 0;
    }
    L.touch();
  }
  if (doc.selection) {
    const s = createCanvas(r.w, r.h);
    ctx2d(s).drawImage(doc.selection, -r.x, -r.y);
    doc.selection = null;
    doc.setSelection(s);
  }
  doc.guides = doc.guides.map((g) => ({ ...g, pos: g.pos - (g.dir === 'v' ? r.x : r.y) }));
  doc.composite = createCanvas(r.w, r.h);
  doc.commit('Crop', before);
  doc.viewInit = false;
  bus.emit('view', doc);
}

void hasActiveStyle; void renderedLayer; void num;
