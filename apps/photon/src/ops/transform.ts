// Lifting layer content into a floating canvas and warping it (affine or perspective).
import { Doc } from '../core/document';
import { Layer } from '../core/layer';
import { alphaBounds, createCanvas, ctx2d, Point, Rect, cloneCanvas, cssColor, RGB } from '../core/util';
import { maskBounds } from '../core/selection';

export interface Lifted {
  layer: Layer;
  float: HTMLCanvasElement;
  /** float canvas origin in doc coords */
  fx: number; fy: number;
  /** layer canvas with the lifted pixels removed */
  base: HTMLCanvasElement;
  original: HTMLCanvasElement;
  /** selection mask (doc-sized) that was lifted, if any */
  selection: HTMLCanvasElement | null;
}

/** Cut the selected pixels (or the whole layer content) out of a raster layer. */
export function liftContent(doc: Doc, L: Layer, copy = false, fillColor: RGB | null = null): Lifted | null {
  const original = L.canvas;
  let r: Rect | null;
  const sel = doc.selection;
  if (sel) {
    const b = maskBounds(sel);
    if (!b) return null;
    r = { x: b.x - L.x, y: b.y - L.y, w: b.w, h: b.h };
  } else {
    r = alphaBounds(L.canvas);
    if (!r) return null;
  }
  const float = createCanvas(r.w, r.h);
  const fx = ctx2d(float);
  fx.drawImage(L.canvas, -r.x, -r.y);
  if (sel) {
    fx.globalCompositeOperation = 'destination-in';
    fx.drawImage(sel, -(r.x + L.x), -(r.y + L.y));
  }
  const base = cloneCanvas(L.canvas);
  if (!copy) {
    const bx = ctx2d(base);
    if (fillColor) {
      // Background layer: fill hole with the background color
      const hole = createCanvas(base.width, base.height);
      const hx = ctx2d(hole);
      hx.fillStyle = cssColor(fillColor);
      if (sel) { hx.drawImage(sel, -L.x, -L.y); hx.globalCompositeOperation = 'source-in'; hx.fillRect(0, 0, base.width, base.height); }
      else hx.fillRect(r.x, r.y, r.w, r.h);
      bx.globalCompositeOperation = sel ? 'destination-out' : 'source-over';
      if (sel) bx.drawImage(sel, -L.x, -L.y);
      else bx.clearRect(r.x, r.y, r.w, r.h);
      bx.globalCompositeOperation = 'source-over';
      bx.drawImage(hole, 0, 0);
    } else if (sel) {
      bx.globalCompositeOperation = 'destination-out';
      bx.drawImage(sel, -L.x, -L.y);
      bx.globalCompositeOperation = 'source-over';
    } else bx.clearRect(r.x, r.y, r.w, r.h);
  }
  return { layer: L, float, fx: r.x + L.x, fy: r.y + L.y, base, original, selection: sel };
}

/** Corners order: tl, tr, br, bl. */
export type Quad = [Point, Point, Point, Point];
export const quadFromRect = (x: number, y: number, w: number, h: number): Quad => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

/** Affine matrix mapping (0,0)-(w,h) onto the quad if it is a parallelogram, else null. */
export function affineFor(w: number, h: number, q: Quad): DOMMatrix | null {
  const [a, b, c, d] = q;
  // parallelogram test: a + c == b + d
  if (Math.abs(a.x + c.x - b.x - d.x) > 0.01 || Math.abs(a.y + c.y - b.y - d.y) > 0.01) return null;
  return new DOMMatrix([(b.x - a.x) / w, (b.y - a.y) / w, (d.x - a.x) / h, (d.y - a.y) / h, a.x, a.y]);
}

export function quadBounds(q: Quad): Rect {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
}

/** Homography mapping unit square (u,v in 0..1) to quad. Returns function and its inverse coefficients. */
function squareToQuad(q: Quad) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + hh * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + hh * p3.y, f = p0.y;
  return [a, b, c, d, e, f, g, hh] as const;
}

/** Exact perspective render of src into the quad (bilinear), returns canvas covering quadBounds. */
export function perspectiveWarp(src: HTMLCanvasElement, q: Quad, smooth = true): { canvas: HTMLCanvasElement; x: number; y: number } {
  const B = quadBounds(q);
  const out = createCanvas(Math.max(1, B.w), Math.max(1, B.h));
  const [a, b, c, d, e, f, g, hh] = squareToQuad(q);
  // inverse of 3x3 [a b c; d e f; g h 1]
  const A = e - f * hh, Bc = c * hh - b, C = b * f - c * e;
  const D = f * g - d, E = a - c * g, F = c * d - a * f;
  const G = d * hh - e * g, H = b * g - a * hh, I = a * e - b * d;
  const sw = src.width, sh = src.height;
  const sd = ctx2d(src).getImageData(0, 0, sw, sh).data;
  const od = ctx2d(out).createImageData(out.width, out.height);
  const o = od.data;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const X = x + B.x + 0.5, Y = y + B.y + 0.5;
      const w = G * X + H * Y + I;
      const u = (A * X + Bc * Y + C) / w, v = (D * X + E * Y + F) / w;
      if (u < 0 || v < 0 || u > 1 || v > 1) continue;
      const fx = u * sw - 0.5, fy = v * sh - 0.5;
      const oi = (y * out.width + x) * 4;
      if (!smooth) {
        const ix = Math.min(sw - 1, Math.max(0, Math.round(fx))), iy = Math.min(sh - 1, Math.max(0, Math.round(fy)));
        const si = (iy * sw + ix) * 4;
        o[oi] = sd[si]; o[oi + 1] = sd[si + 1]; o[oi + 2] = sd[si + 2]; o[oi + 3] = sd[si + 3];
        continue;
      }
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const cx0 = Math.min(sw - 1, Math.max(0, x0)), cx1 = Math.min(sw - 1, Math.max(0, x0 + 1));
      const cy0 = Math.min(sh - 1, Math.max(0, y0)), cy1 = Math.min(sh - 1, Math.max(0, y0 + 1));
      const i00 = (cy0 * sw + cx0) * 4, i10 = (cy0 * sw + cx1) * 4, i01 = (cy1 * sw + cx0) * 4, i11 = (cy1 * sw + cx1) * 4;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      // premultiplied bilinear
      const a00 = sd[i00 + 3] * w00, a10 = sd[i10 + 3] * w10, a01 = sd[i01 + 3] * w01, a11 = sd[i11 + 3] * w11;
      const al = a00 + a10 + a01 + a11;
      if (al <= 0) continue;
      for (let k = 0; k < 3; k++) o[oi + k] = (sd[i00 + k] * a00 + sd[i10 + k] * a10 + sd[i01 + k] * a01 + sd[i11 + k] * a11) / al;
      o[oi + 3] = al;
    }
  }
  ctx2d(out).putImageData(od, 0, 0);
  return { canvas: out, x: B.x, y: B.y };
}

/** Fast approximate perspective preview by triangle mesh (for interactive dragging). */
export function meshWarpPreview(src: HTMLCanvasElement, q: Quad, n = 10): { canvas: HTMLCanvasElement; x: number; y: number } {
  const B = quadBounds(q);
  const out = createCanvas(Math.max(1, B.w), Math.max(1, B.h));
  const ctx = ctx2d(out);
  const [a, b, c, d, e, f, g, hh] = squareToQuad(q);
  const map = (u: number, v: number): Point => {
    const w = g * u + hh * v + 1;
    return { x: (a * u + b * v + c) / w - B.x, y: (d * u + e * v + f) / w - B.y };
  };
  const sw = src.width, sh = src.height;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u0 = i / n, u1 = (i + 1) / n, v0 = j / n, v1 = (j + 1) / n;
    const P00 = map(u0, v0), P10 = map(u1, v0), P01 = map(u0, v1), P11 = map(u1, v1);
    tri(ctx, src, [u0 * sw, v0 * sh, u1 * sw, v0 * sh, u0 * sw, v1 * sh], [P00, P10, P01]);
    tri(ctx, src, [u1 * sw, v0 * sh, u1 * sw, v1 * sh, u0 * sw, v1 * sh], [P10, P11, P01]);
  }
  return { canvas: out, x: B.x, y: B.y };
}
/** Draw one source triangle `s` (x0,y0,x1,y1,x2,y2) of `img` onto the destination triangle `d` (affine, clipped). */
export function tri(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, s: number[], d: Point[]) {
  const [x0, y0, x1, y1, x2, y2] = s;
  const den = x0 * (y2 - y1) - x1 * y2 + x2 * y1 + (x1 - x2) * y0;
  if (Math.abs(den) < 1e-9) return;
  const m11 = -(y0 * (d[2].x - d[1].x) - y1 * d[2].x + y2 * d[1].x + (y1 - y2) * d[0].x) / den;
  const m12 = (y1 * d[2].y + y0 * (d[1].y - d[2].y) - y2 * d[1].y + (y2 - y1) * d[0].y) / den;
  const m21 = (x0 * (d[2].x - d[1].x) - x1 * d[2].x + x2 * d[1].x + (x1 - x2) * d[0].x) / den;
  const m22 = -(x1 * d[2].y + x0 * (d[1].y - d[2].y) - x2 * d[1].y + (x2 - x1) * d[0].y) / den;
  const dx = (x0 * (y2 * d[1].x - y1 * d[2].x) + y0 * (x1 * d[2].x - x2 * d[1].x) + (x2 * y1 - x1 * y2) * d[0].x) / den;
  const dy = (x0 * (y2 * d[1].y - y1 * d[2].y) + y0 * (x1 * d[2].y - x2 * d[1].y) + (x2 * y1 - x1 * y2) * d[0].y) / den;
  ctx.save();
  ctx.beginPath();
  // grow the triangle ~0.6px on every side (diagonal edges too) so neighbours overlap and no seams show
  const E = 0.6, cx = (d[0].x + d[1].x + d[2].x) / 3, cy = (d[0].y + d[1].y + d[2].y) / 3;
  const normal = (a: Point, b: Point) => {
    const ex = b.x - a.x, ey = b.y - a.y, l = Math.hypot(ex, ey) || 1;
    const nx = ey / l, ny = -ex / l;
    return nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0 ? { x: -nx, y: -ny } : { x: nx, y: ny };
  };
  d.forEach((p, i) => {
    const n1 = normal(d[(i + 2) % 3], p), n2 = normal(p, d[(i + 1) % 3]);
    let ox = n1.x + n2.x, oy = n1.y + n2.y;
    const k = E / Math.max(0.2, 1 + n1.x * n2.x + n1.y * n2.y); // miter, capped for very sharp corners
    ox *= k; oy *= k;
    i ? ctx.lineTo(p.x + ox, p.y + oy) : ctx.moveTo(p.x + ox, p.y + oy);
  });
  ctx.closePath();
  ctx.clip();
  ctx.transform(m11, m12, m21, m22, dx, dy);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** Render the float into a canvas positioned in doc space using either path. */
export function renderQuad(src: HTMLCanvasElement, q: Quad, quality: 'nearest' | 'bilinear' | 'bicubic' = 'bicubic'): { canvas: HTMLCanvasElement; x: number; y: number } {
  const m = affineFor(src.width, src.height, q);
  if (!m) return perspectiveWarp(src, q, quality !== 'nearest');
  const B = quadBounds(q);
  const out = createCanvas(Math.max(1, B.w), Math.max(1, B.h));
  const x = ctx2d(out);
  const identity = Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
  x.imageSmoothingEnabled = quality !== 'nearest' && !identity;
  x.imageSmoothingQuality = quality === 'bicubic' ? 'high' : 'medium';
  x.setTransform(m.a, m.b, m.c, m.d, m.e - B.x, m.f - B.y);
  x.drawImage(src, 0, 0);
  return { canvas: out, x: B.x, y: B.y };
}

/** Put transformed pixels back onto base: returns a new canvas + origin covering doc and content. */
export function composeOnto(doc: Doc, base: HTMLCanvasElement, bx: number, by: number, piece: { canvas: HTMLCanvasElement; x: number; y: number }, clipToDoc = false) {
  let x0 = Math.min(bx, piece.x, 0), y0 = Math.min(by, piece.y, 0);
  let x1 = Math.max(bx + base.width, piece.x + piece.canvas.width, doc.width), y1 = Math.max(by + base.height, piece.y + piece.canvas.height, doc.height);
  if (clipToDoc) { x0 = 0; y0 = 0; x1 = doc.width; y1 = doc.height; }
  const c = createCanvas(x1 - x0, y1 - y0);
  const cx = ctx2d(c);
  cx.drawImage(base, bx - x0, by - y0);
  cx.drawImage(piece.canvas, piece.x - x0, piece.y - y0);
  return { canvas: c, x: x0, y: y0 };
}

/** Transform the selection mask with the same quad mapping as the lifted pixels. */
export function transformMask(doc: Doc, mask: HTMLCanvasElement, from: Rect, q: Quad): HTMLCanvasElement {
  const piece = createCanvas(from.w, from.h);
  ctx2d(piece).drawImage(mask, -from.x, -from.y);
  const r = renderQuad(piece, q, 'bilinear');
  const out = createCanvas(doc.width, doc.height);
  ctx2d(out).drawImage(r.canvas, r.x, r.y);
  return out;
}
