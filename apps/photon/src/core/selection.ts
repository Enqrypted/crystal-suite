// Selections are alpha canvases the size of the document: alpha = how selected a pixel is.
import { createCanvas, ctx2d, getImageData, Rect, RGB, blurCanvas, clamp } from './util';

export type SelectMode = 'new' | 'add' | 'subtract' | 'intersect';

export function emptyMask(w: number, h: number) { return createCanvas(w, h); }

export function maskFromShape(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, antialias = true): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const x = ctx2d(c);
  x.imageSmoothingEnabled = antialias;
  x.fillStyle = '#000';
  x.beginPath();
  draw(x);
  x.fill('nonzero');
  if (!antialias) hardenMask(c);
  return c;
}
export function maskFromRect(w: number, h: number, r: Rect) {
  return maskFromShape(w, h, (x) => x.rect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)), false);
}
export function maskFromEllipse(w: number, h: number, r: Rect, antialias = true) {
  return maskFromShape(w, h, (x) => x.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2), antialias);
}
export function maskFromPolygon(w: number, h: number, pts: { x: number; y: number }[], antialias = true) {
  return maskFromShape(w, h, (x) => { pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.closePath(); }, antialias);
}
/** Threshold alpha at 50% (non-antialiased edges). */
export function hardenMask(c: HTMLCanvasElement) {
  const id = getImageData(c);
  const d = id.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  ctx2d(c).putImageData(id, 0, 0);
}

/** Combine `shape` into the existing selection according to mode. Returns a new canvas (or null if empty). */
export function combineMask(existing: HTMLCanvasElement | null, shape: HTMLCanvasElement, mode: SelectMode): HTMLCanvasElement {
  const w = shape.width, h = shape.height;
  if (mode === 'new' || !existing) {
    if (mode === 'subtract' || mode === 'intersect') return existing ? copyMask(existing) : createCanvas(w, h);
    return shape;
  }
  const c = copyMask(existing);
  const x = ctx2d(c);
  x.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
  x.drawImage(shape, 0, 0);
  return c;
}
export function copyMask(m: HTMLCanvasElement) {
  const c = createCanvas(m.width, m.height);
  ctx2d(c).drawImage(m, 0, 0);
  return c;
}
export function invertMask(m: HTMLCanvasElement | null, w: number, h: number) {
  const c = createCanvas(w, h);
  const x = ctx2d(c);
  x.fillStyle = '#000';
  x.fillRect(0, 0, w, h);
  if (m) { x.globalCompositeOperation = 'destination-out'; x.drawImage(m, 0, 0); }
  return c;
}
export function featherMask(m: HTMLCanvasElement, radius: number) {
  if (radius <= 0) return copyMask(m);
  return blurCanvas(m, radius / 2, 'transparent');
}
/** Grow (positive) or shrink (negative) the selection by `px` using a distance-like morphology. */
export function expandMask(m: HTMLCanvasElement, px: number) {
  const w = m.width, h = m.height;
  const id = getImageData(m);
  const a = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = id.data[i * 4 + 3] >= 128 ? 1 : 0;
  const grow = px > 0;
  const r = Math.abs(Math.round(px));
  const out = morph(a, w, h, r, grow);
  const od = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) od.data[i * 4 + 3] = out[i] ? 255 : 0;
  const c = createCanvas(w, h);
  ctx2d(c).putImageData(od, 0, 0);
  return c;
}
/** Circular dilation/erosion via two-pass distance transform (fast for any radius). */
function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean) {
  // Distance from each pixel to nearest "target" pixel (selected for dilate, unselected for erode).
  const INF = 1e9;
  const target = dilate ? 1 : 0;
  const f = new Float64Array(Math.max(w, h));
  const dist = new Float64Array(w * h);
  // Column pass (1D squared EDT)
  const col = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = src[y * w + x] === target ? 0 : INF;
    edt1d(col, h, f);
    for (let y = 0; y < h; y++) dist[y * w + x] = col[y];
  }
  const row = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = dist[y * w + x];
    edt1d(row, w, f);
    for (let x = 0; x < w; x++) dist[y * w + x] = row[x];
  }
  const out = new Uint8Array(w * h);
  const r2 = r * r;
  for (let i = 0; i < w * h; i++) {
    if (dilate) out[i] = dist[i] <= r2 ? 1 : 0;
    else out[i] = dist[i] <= r2 ? 0 : 1;
  }
  return out;
}
// Felzenszwalb & Huttenlocher 1D distance transform (in place on `g`).
function edt1d(g: Float64Array, n: number, f: Float64Array) {
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) f[i] = g[i];
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    g[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
export function borderMask(m: HTMLCanvasElement, width: number) {
  const outer = expandMask(m, width / 2), inner = expandMask(m, -width / 2);
  const x = ctx2d(outer);
  x.globalCompositeOperation = 'destination-out';
  x.drawImage(inner, 0, 0);
  return featherMask(outer, 1);
}
export function smoothMask(m: HTMLCanvasElement, radius: number) {
  const b = blurCanvas(m, radius, 'transparent');
  hardenMask(b);
  return b;
}

export function maskBounds(m: HTMLCanvasElement): Rect | null {
  const { width: w, height: h } = m;
  const d = getImageData(m).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    let rowHas = false;
    const o = y * w * 4 + 3;
    for (let x = 0; x < w; x++) {
      if (d[o + x * 4]) { rowHas = true; if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
    if (rowHas) { if (y < minY) minY = y; maxY = y; }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
export function isMaskEmpty(m: HTMLCanvasElement) { return !maskBounds(m); }

/** Outline (pixel edges where alpha crosses 50%) as a Path2D, merged into long runs. */
export function maskOutline(m: HTMLCanvasElement): Path2D {
  const w = m.width, h = m.height;
  const d = getImageData(m).data;
  const sel = new Uint8Array((w + 2) * (h + 2));
  const W = w + 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sel[(y + 1) * W + x + 1] = d[(y * w + x) * 4 + 3] >= 128 ? 1 : 0;
  const p = new Path2D();
  // Horizontal edges: between row y-1 and y
  for (let y = 0; y <= h; y++) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && sel[y * W + x + 1] !== sel[(y + 1) * W + x + 1];
      if (edge && run < 0) run = x;
      else if (!edge && run >= 0) { p.moveTo(run, y); p.lineTo(x, y); run = -1; }
    }
  }
  for (let x = 0; x <= w; x++) {
    let run = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && sel[(y + 1) * W + x] !== sel[(y + 1) * W + x + 1];
      if (edge && run < 0) run = y;
      else if (!edge && run >= 0) { p.moveTo(x, run); p.lineTo(x, y); run = -1; }
    }
  }
  return p;
}

/** Flood/global color selection (Magic Wand, Paint Bucket, Magic Eraser). */
export function colorRegion(
  img: ImageData, sx: number, sy: number,
  tolerance: number, contiguous: boolean, antialias = true,
): HTMLCanvasElement {
  const { width: w, height: h, data } = img;
  sx = Math.floor(sx); sy = Math.floor(sy);
  const out = new ImageData(w, h);
  const od = out.data;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) { return createCanvas(w, h); }
  const i0 = (sy * w + sx) * 4;
  const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
  const tol = tolerance;
  const match = (i: number) => {
    const dr = Math.abs(data[i] - r0), dg = Math.abs(data[i + 1] - g0), db = Math.abs(data[i + 2] - b0), da = Math.abs(data[i + 3] - a0);
    return Math.max(dr, dg, db, da) <= tol;
  };
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) if (match(i * 4)) od[i * 4 + 3] = 255;
  } else {
    const visited = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    stack[sp++] = sy * w + sx;
    visited[sy * w + sx] = 1;
    while (sp) {
      const idx = stack[--sp];
      // scanline fill
      let x = idx % w;
      const y = (idx - x) / w;
      let lx = x;
      while (lx > 0 && !visited[y * w + lx - 1] && match((y * w + lx - 1) * 4)) { lx--; visited[y * w + lx] = 1; }
      let rx = x;
      while (rx < w - 1 && !visited[y * w + rx + 1] && match((y * w + rx + 1) * 4)) { rx++; visited[y * w + rx] = 1; }
      for (x = lx; x <= rx; x++) {
        od[(y * w + x) * 4 + 3] = 255;
        if (y > 0) { const n = (y - 1) * w + x; if (!visited[n] && match(n * 4)) { visited[n] = 1; stack[sp++] = n; } }
        if (y < h - 1) { const n = (y + 1) * w + x; if (!visited[n] && match(n * 4)) { visited[n] = 1; stack[sp++] = n; } }
      }
    }
  }
  const c = createCanvas(w, h);
  ctx2d(c).putImageData(out, 0, 0);
  if (antialias) return softenEdges(c);
  return c;
}
/** Light 1px anti-aliasing on a hard mask edge. */
export function softenEdges(m: HTMLCanvasElement) {
  const b = blurCanvas(m, 0.5, 'transparent');
  return b;
}

/** Select pixels by color similarity (Select > Color Range). */
export function colorRangeMask(img: ImageData, color: RGB, fuzziness: number): HTMLCanvasElement {
  const { width: w, height: h, data } = img;
  const out = new ImageData(w, h);
  const od = out.data;
  const f = Math.max(1, fuzziness);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(data[o] - color.r), Math.abs(data[o + 1] - color.g), Math.abs(data[o + 2] - color.b));
    const v = d <= f ? 1 - (d / f) * (d / f) * 0.5 : Math.max(0, 1 - d / (f * 1.5)) * 0.5;
    od[o + 3] = clamp(Math.round(v * 255 * (data[o + 3] / 255)), 0, 255);
  }
  const c = createCanvas(w, h);
  ctx2d(c).putImageData(out, 0, 0);
  return c;
}

/** Selection from a canvas's alpha (Ctrl+click layer thumbnail). */
export function maskFromAlpha(src: HTMLCanvasElement, ox: number, oy: number, w: number, h: number) {
  const c = createCanvas(w, h);
  const x = ctx2d(c);
  x.drawImage(src, ox, oy);
  return c;
}
/** Luminosity-based selection (Ctrl+Alt+2). */
export function maskFromLuminosity(img: ImageData) {
  const { width: w, height: h, data } = img;
  const out = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    out.data[o + 3] = Math.round((0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) * (data[o + 3] / 255));
  }
  const c = createCanvas(w, h);
  ctx2d(c).putImageData(out, 0, 0);
  return c;
}
