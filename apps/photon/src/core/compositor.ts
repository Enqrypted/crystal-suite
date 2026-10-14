import { Doc } from './document';
import { Layer, BlendMode } from './layer';
import { buildTree, LayerNode, block } from './groups';
import { NATIVE_BLEND, blendPixels } from './blend';
import { createCanvas, ctx2d, Rect, rectIntersect, rectOut, tempCanvas } from './util';
import { getAdjustment } from './adjustments';
import { hasActiveStyle, renderStyled } from './effects';

/** Re-render the dirty part of the document composite. */
export function updateComposite(doc: Doc) {
  if (!doc.dirty) return;
  const r0 = rectIntersect(rectOut(doc.dirty), { x: 0, y: 0, w: doc.width, h: doc.height });
  doc.dirty = null;
  if (!r0) return;
  doc.compositeVersion++;
  renderLayersInto(doc, ctx2d(doc.composite), r0, doc.layers);
}

/** Composite `layers` (bottom→top, groups included) into ctx for doc-space rect r. ctx is doc-aligned. */
export function renderLayersInto(doc: Doc, ctx: CanvasRenderingContext2D, r: Rect, layers: Layer[]) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(r.x, r.y, r.w, r.h);
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  renderNodes(doc, ctx, r, buildTree(layers), 0);
  ctx.restore();
}

/** Render sibling nodes; clipped layers are drawn together with the base below them. */
function renderNodes(doc: Doc, ctx: CanvasRenderingContext2D, r: Rect, nodes: LayerNode[], depth: number) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i], L = n.layer;
    if (L.clipped && i > 0) continue;
    const clips: LayerNode[] = [];
    for (let j = i + 1; j < nodes.length && nodes[j].layer.clipped; j++) clips.push(nodes[j]);
    if (!L.visible || L.editing) continue;
    if (L.kind === 'group') renderGroup(doc, ctx, r, n, depth, null);
    else drawLayer(doc, ctx, L, r, null);
    if (clips.length && L.kind !== 'adjustment') {
      const base = tempCanvas('clipbase-' + depth, r.w, r.h);
      const bx = ctx2d(base);
      if (L.kind === 'group') bx.drawImage(groupBuffer(doc, n, r, depth), r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      else layerContent(doc, L, r, bx, false);
      for (const C of clips) {
        if (!C.layer.visible || C.layer.editing) continue;
        if (C.layer.kind === 'group') renderGroup(doc, ctx, r, C, depth, base);
        else drawLayer(doc, ctx, C.layer, r, base);
      }
    }
  }
}

/** A group's contents composited on transparency (isolated), with the group mask applied. Doc-sized buffer. */
function groupBuffer(doc: Doc, n: LayerNode, r: Rect, depth: number): HTMLCanvasElement {
  const L = n.layer;
  const g = tempCanvas('group-' + depth, doc.width, doc.height, false);
  const gx = ctx2d(g);
  gx.save();
  gx.clearRect(r.x, r.y, r.w, r.h);
  gx.beginPath();
  gx.rect(r.x, r.y, r.w, r.h);
  gx.clip();
  renderNodes(doc, gx, r, n.children, depth + 1);
  if (L.mask && L.maskEnabled) {
    gx.globalCompositeOperation = 'destination-in';
    gx.drawImage(L.mask, L.maskX, L.maskY);
  }
  gx.restore();
  return g;
}

function renderGroup(doc: Doc, ctx: CanvasRenderingContext2D, r: Rect, n: LayerNode, depth: number, clip: HTMLCanvasElement | null) {
  const L = n.layer;
  if (L.opacity <= 0) return;
  const masked = !!(L.mask && L.maskEnabled);
  if (L.blend === 'pass-through' && !clip) {
    if (L.opacity >= 1 && !masked) { renderNodes(doc, ctx, r, n.children, depth + 1); return; }
    // pass through with opacity/mask: result = backdrop·(1−m) + (backdrop + contents)·m
    const b = tempCanvas('pt-' + depth, doc.width, doc.height, false);
    const bx = ctx2d(b);
    bx.save();
    bx.clearRect(r.x, r.y, r.w, r.h);
    bx.beginPath(); bx.rect(r.x, r.y, r.w, r.h); bx.clip();
    bx.drawImage(ctx.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    renderNodes(doc, bx, r, n.children, depth + 1);
    if (masked) { bx.globalCompositeOperation = 'destination-in'; bx.drawImage(L.mask!, L.maskX, L.maskY); }
    bx.restore();
    ctx.save();
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = 'destination-out';
    if (masked) ctx.drawImage(L.mask!, L.maskX, L.maskY); else ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(b, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    ctx.restore();
    return;
  }
  const g = groupBuffer(doc, n, r, depth);
  const t = tempCanvas('gsrc-' + depth, r.w, r.h);
  const tx = ctx2d(t);
  tx.drawImage(g, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  if (clip) {
    tx.globalCompositeOperation = 'destination-in';
    tx.drawImage(clip, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
    tx.globalCompositeOperation = 'source-over';
  }
  compositeRect(ctx, t, r, L.blend === 'pass-through' ? 'normal' : L.blend, L.opacity);
}

function drawLayer(doc: Doc, ctx: CanvasRenderingContext2D, L: Layer, r: Rect, clip: HTMLCanvasElement | null) {
  if (L.kind === 'adjustment') { applyAdjustmentLayer(doc, ctx, L, r, clip); return; }
  if (L.opacity <= 0) return;
  const t = tempCanvas('layer', r.w, r.h);
  const tx = ctx2d(t);
  layerContent(doc, L, r, tx, true);
  if (clip) {
    tx.globalCompositeOperation = 'destination-in';
    tx.drawImage(clip, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
    tx.globalCompositeOperation = 'source-over';
  }
  compositeRect(ctx, t, r, L.blend, L.opacity);
}

/** Blend t (rect-sized, origin at r) onto ctx at r with a blend mode and opacity. */
function compositeRect(ctx: CanvasRenderingContext2D, t: HTMLCanvasElement, r: Rect, blend: BlendMode, opacity: number) {
  const native = NATIVE_BLEND[blend];
  if (native) {
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = native;
    ctx.drawImage(t, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  } else {
    const dst = ctx.getImageData(r.x, r.y, r.w, r.h);
    const src = ctx2d(t).getImageData(0, 0, r.w, r.h);
    blendPixels(dst.data, src.data, blend, opacity, r.w, r.x, r.y);
    ctx.putImageData(dst, r.x, r.y);
  }
}

/** Draws the layer's pixels (with floating content, mask and styles) into tx, which maps doc rect r to (0,0). */
function layerContent(doc: Doc, L: Layer, r: Rect, tx: CanvasRenderingContext2D, withStyle: boolean) {
  if (withStyle && hasActiveStyle(L)) {
    const st = styledLayer(doc, L);
    tx.drawImage(st.canvas, st.x - r.x, st.y - r.y);
    return;
  }
  drawBase(doc, L, tx, -r.x, -r.y, withStyle ? L.fillOpacity : 1);
}

/** Raw layer pixels + floating + mask drawn at offset (ox, oy) from document origin. */
function drawBase(doc: Doc, L: Layer, tx: CanvasRenderingContext2D, ox: number, oy: number, alpha = 1) {
  const src = L.preview ?? L.canvas;
  tx.globalAlpha = alpha;
  tx.drawImage(src, L.x + ox, L.y + oy);
  const f = doc.floating;
  if (f && f.layer === L) {
    const m = f.matrix;
    tx.setTransform(m.a, m.b, m.c, m.d, m.e + ox, m.f + oy);
    tx.imageSmoothingEnabled = !(m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1);
    tx.imageSmoothingQuality = 'high';
    tx.drawImage(f.canvas, 0, 0);
    tx.setTransform(1, 0, 0, 1, 0, 0);
    tx.imageSmoothingEnabled = true;
  }
  tx.globalAlpha = 1;
  if (L.mask && L.maskEnabled) {
    tx.globalCompositeOperation = 'destination-in';
    tx.drawImage(L.mask, L.maskX + ox, L.maskY + oy);
    tx.globalCompositeOperation = 'source-over';
  }
}

interface StyleCache { key: string; canvas: HTMLCanvasElement; x: number; y: number }
const styleCache = new WeakMap<Layer, StyleCache>();
let styleKeySeq = 1;
const styleIds = new WeakMap<object, number>();
const objId = (o: object | null) => { if (!o) return 0; let v = styleIds.get(o); if (!v) styleIds.set(o, (v = styleKeySeq++)); return v; };

function styledLayer(doc: Doc, L: Layer) {
  const f = doc.floating && doc.floating.layer === L ? doc.floating : null;
  const key = [L.version, objId(L.style), objId(L.preview), objId(L.mask), L.maskEnabled, L.x, L.y, L.fillOpacity,
    f ? `${objId(f.canvas)}:${f.matrix.toString()}` : ''].join('|');
  const c = styleCache.get(L);
  if (c && c.key === key) return c;
  // Base content in a canvas covering the layer bounds (plus floating extents)
  let bx = L.x, by = L.y, bw = L.canvas.width, bh = L.canvas.height;
  if (f) {
    const m = f.matrix, w = f.canvas.width, h = f.canvas.height;
    const pts = [m.transformPoint(new DOMPoint(0, 0)), m.transformPoint(new DOMPoint(w, 0)), m.transformPoint(new DOMPoint(0, h)), m.transformPoint(new DOMPoint(w, h))];
    const x0 = Math.floor(Math.min(bx, ...pts.map((p) => p.x))), y0 = Math.floor(Math.min(by, ...pts.map((p) => p.y)));
    const x1 = Math.ceil(Math.max(bx + bw, ...pts.map((p) => p.x))), y1 = Math.ceil(Math.max(by + bh, ...pts.map((p) => p.y)));
    bx = x0; by = y0; bw = x1 - x0; bh = y1 - y0;
  }
  const base = createCanvas(bw, bh);
  drawBase(doc, L, ctx2d(base), -bx, -by);
  const out = renderStyled(L, base, bx, by);
  const entry = { key, ...out };
  styleCache.set(L, entry);
  return entry;
}

function applyAdjustmentLayer(doc: Doc, ctx: CanvasRenderingContext2D, L: Layer, r: Rect, clip: HTMLCanvasElement | null) {
  const def = L.adjustment && getAdjustment(L.adjustment.kind);
  if (!def || L.opacity <= 0) return;
  const img = ctx.getImageData(r.x, r.y, r.w, r.h);
  const orig = new Uint8ClampedArray(img.data);
  def.apply(img.data, L.adjustment!.params);
  // weight = opacity * mask * clip-base alpha
  let weights: Uint8ClampedArray | null = null;
  if ((L.mask && L.maskEnabled) || clip) {
    const t = tempCanvas('adjmask', r.w, r.h);
    const tx = ctx2d(t);
    tx.fillStyle = '#000';
    tx.fillRect(0, 0, r.w, r.h);
    if (L.mask && L.maskEnabled) {
      tx.globalCompositeOperation = 'destination-in';
      tx.drawImage(L.mask, L.maskX - r.x, L.maskY - r.y);
    }
    if (clip) {
      tx.globalCompositeOperation = 'destination-in';
      tx.drawImage(clip, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
    }
    tx.globalCompositeOperation = 'source-over';
    weights = tx.getImageData(0, 0, r.w, r.h).data;
  }
  const d = img.data, op = L.opacity;
  if (op < 1 || weights) {
    for (let i = 0; i < d.length; i += 4) {
      const t = op * (weights ? weights[i + 3] / 255 : 1);
      if (t >= 1) continue;
      d[i] = orig[i] + (d[i] - orig[i]) * t;
      d[i + 1] = orig[i + 1] + (d[i + 1] - orig[i + 1]) * t;
      d[i + 2] = orig[i + 2] + (d[i + 2] - orig[i + 2]) * t;
      d[i + 3] = orig[i + 3];
    }
  } else {
    for (let i = 3; i < d.length; i += 4) d[i] = orig[i];
  }
  ctx.putImageData(img, r.x, r.y);
}

/** Merge a set of layers into a single new canvas the size of the document (used by merge/flatten/export). */
export function flattenLayers(doc: Doc, layers: Layer[]): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height);
  renderLayersInto(doc, ctx2d(c), { x: 0, y: 0, w: doc.width, h: doc.height }, layers);
  return c;
}

/** Layer content as it renders (mask + styles), positioned in doc space. Used for merge down / thumbnails. */
export function renderedLayer(doc: Doc, L: Layer): { canvas: HTMLCanvasElement; x: number; y: number } {
  if (L.kind === 'group') return { canvas: flattenLayers(doc, block(doc, L)), x: 0, y: 0 };
  if (hasActiveStyle(L)) { const s = styledLayer(doc, L); return { canvas: s.canvas, x: s.x, y: s.y }; }
  const c = createCanvas(L.canvas.width, L.canvas.height);
  drawBase(doc, L, ctx2d(c), -L.x, -L.y, L.fillOpacity);
  return { canvas: c, x: L.x, y: L.y };
}
