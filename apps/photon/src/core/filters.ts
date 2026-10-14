// Pure filter algorithms used by the Filter menu, Liquify and Camera Raw.
// Every function takes a source canvas and returns a NEW canvas of the same size (src is never mutated).
// Heavy work uses separable passes, running sums, sliding histograms, GPU blurs and typed arrays so
// 12-megapixel images stay usable.
import { blurCanvas, canvasFromImageData, clamp, createCanvas, ctx2d, edgePadded, getImageData, RGB } from './util';

type C = HTMLCanvasElement;
export type EdgeMode = 'clamp' | 'wrap' | 'transparent';

// =====================================================================
// Helpers
// =====================================================================
export function copyCanvas(src: C): C {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}
/** Run fn on a copy of the pixels and return them as a new canvas. */
function withPixels(src: C, fn: (d: Uint8ClampedArray, w: number, h: number) => void): C {
  const id = getImageData(src);
  fn(id.data, id.width, id.height);
  return canvasFromImageData(id);
}
function smooth(a: number, b: number, x: number): number {
  if (b <= a) return x >= a ? 1 : 0;
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const isOpaque = (d: Uint8ClampedArray) => { for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false; return true; };

/** Seeded PRNG (mulberry32) returning [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const newSeed = () => (Math.random() * 4294967296) >>> 0;
/** Stateless hash of integer coordinates -> [0, 1). */
function hash3(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------- single-channel float planes ----------
/**
 * Mean over the window [x-l, x+r] x [y-u, y+d] (edges extended), in place, O(1) per pixel.
 * tmp is a scratch plane of the same size.
 */
function boxPlane(p: Float32Array, w: number, h: number, l: number, r: number, u: number, d: number, tmp: Float32Array) {
  if (l + r > 0) {
    const inv = 1 / (l + r + 1);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let s = 0;
      for (let k = -l; k <= r; k++) s += p[o + (k < 0 ? 0 : k >= w ? w - 1 : k)];
      for (let x = 0; x < w; x++) {
        tmp[o + x] = s * inv;
        const a = x + r + 1, b = x - l;
        s += p[o + (a >= w ? w - 1 : a)] - p[o + (b < 0 ? 0 : b)];
      }
    }
  } else tmp.set(p);
  if (u + d > 0) {
    const inv = 1 / (u + d + 1);
    const s = new Float64Array(w);
    for (let k = -u; k <= d; k++) {
      const o = (k < 0 ? 0 : k >= h ? h - 1 : k) * w;
      for (let x = 0; x < w; x++) s[x] += tmp[o + x];
    }
    for (let y = 0; y < h; y++) {
      const o = y * w, a = y + d + 1, b = y - u;
      const ao = (a >= h ? h - 1 : a) * w, bo = (b < 0 ? 0 : b) * w;
      for (let x = 0; x < w; x++) { p[o + x] = s[x] * inv; s[x] += tmp[ao + x] - tmp[bo + x]; }
    }
  } else p.set(tmp);
}

/** Apply a linear plane operation to RGBA data with premultiplied alpha (correct blurs over transparency). */
function filterPremul(id: ImageData, op: (p: Float32Array) => void) {
  const d = id.data, n = id.width * id.height;
  const P = new Float32Array(n);
  if (isOpaque(d)) {
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) P[i] = d[i * 4 + c];
      op(P);
      for (let i = 0; i < n; i++) d[i * 4 + c] = P[i];
    }
    return;
  }
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) A[i] = d[i * 4 + 3];
  op(A);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) P[i] = d[i * 4 + c] * d[i * 4 + 3];
    op(P);
    for (let i = 0; i < n; i++) d[i * 4 + c] = A[i] > 0.01 ? P[i] / A[i] : 0;
  }
  for (let i = 0; i < n; i++) d[i * 4 + 3] = A[i];
}

/** Self-guided filter (He et al.): edge-preserving smoothing of one plane in place. O(1) per pixel. */
function guidedPlane(I: Float32Array, w: number, h: number, r: number, eps: number, m: Float32Array, s: Float32Array, tmp: Float32Array) {
  const n = w * h;
  m.set(I);
  boxPlane(m, w, h, r, r, r, r, tmp);
  for (let i = 0; i < n; i++) s[i] = I[i] * I[i];
  boxPlane(s, w, h, r, r, r, r, tmp);
  for (let i = 0; i < n; i++) {
    const mi = m[i];
    let v = s[i] - mi * mi;
    if (v < 0) v = 0;
    const a = v / (v + eps);
    s[i] = a;
    m[i] = mi - a * mi;
  }
  boxPlane(s, w, h, r, r, r, r, tmp);
  boxPlane(m, w, h, r, r, r, r, tmp);
  for (let i = 0; i < n; i++) I[i] = s[i] * I[i] + m[i];
}
/** Guided filter on the RGB channels of d (in place). eps is in 0-255 units squared. */
function guidedRGB(d: Uint8ClampedArray, w: number, h: number, r: number, eps: number) {
  const n = w * h, I = new Float32Array(n), m = new Float32Array(n), s = new Float32Array(n), tmp = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) I[i] = d[i * 4 + c];
    guidedPlane(I, w, h, r, eps, m, s, tmp);
    for (let i = 0; i < n; i++) d[i * 4 + c] = I[i];
  }
}

// ---------- order statistics ----------
/** Max (or min) over a (2r+1)^2 square per channel — van Herk/Gil-Werman, O(1) per pixel. */
function minMaxData(d: Uint8ClampedArray, w: number, h: number, r: number, isMax: boolean): Uint8ClampedArray {
  const t = new Uint8ClampedArray(d.length), out = new Uint8ClampedArray(d.length);
  const size = 2 * r + 1, L = Math.max(w, h) + 2 * r;
  const v = new Uint8Array(L), g = new Uint8Array(L), hh = new Uint8Array(L);
  const line = (src: Uint8ClampedArray, dst: Uint8ClampedArray, len: number, base: number, step: number) => {
    const n = len + 2 * r;
    for (let k = 0; k < n; k++) { const j = k - r; v[k] = src[base + (j < 0 ? 0 : j >= len ? len - 1 : j) * step]; }
    for (let k = 0, b = 0; k < n; k++, b++) {
      if (b === size) b = 0;
      g[k] = b === 0 ? v[k] : isMax ? (g[k - 1] > v[k] ? g[k - 1] : v[k]) : (g[k - 1] < v[k] ? g[k - 1] : v[k]);
    }
    for (let k = n - 1; k >= 0; k--) {
      const blockEnd = k === n - 1 || (k + 1) % size === 0;
      hh[k] = blockEnd ? v[k] : isMax ? (hh[k + 1] > v[k] ? hh[k + 1] : v[k]) : (hh[k + 1] < v[k] ? hh[k + 1] : v[k]);
    }
    for (let x = 0; x < len; x++) {
      const a = hh[x], b = g[x + size - 1];
      dst[base + x * step] = isMax ? (a > b ? a : b) : (a < b ? a : b);
    }
  };
  for (let y = 0; y < h; y++) for (let c = 0; c < 4; c++) line(d, t, w, y * w * 4 + c, 4);
  for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) line(t, out, h, x * 4 + c, w * 4);
  return out;
}

/** 1-D sliding-window median along a line (histogram tracking). */
function median1D(src: Uint8ClampedArray, dst: Uint8ClampedArray, len: number, base: number, step: number, r: number, hist: Int32Array) {
  const half = (2 * r + 2) >> 1;
  hist.fill(0);
  for (let k = -r; k <= r; k++) hist[src[base + (k < 0 ? 0 : k >= len ? len - 1 : k) * step]]++;
  let med = 0, lt = 0;
  while (lt + hist[med] < half) { lt += hist[med]; med++; }
  dst[base] = med;
  for (let x = 1; x < len; x++) {
    const ko = x - 1 - r, ki = x + r;
    const vo = src[base + (ko < 0 ? 0 : ko) * step];
    hist[vo]--; if (vo < med) lt--;
    const vi = src[base + (ki >= len ? len - 1 : ki) * step];
    hist[vi]++; if (vi < med) lt++;
    if (lt >= half) { do { med--; lt -= hist[med]; } while (lt >= half); }
    else while (lt + hist[med] < half) { lt += hist[med]; med++; }
    dst[base + x * step] = med;
  }
}
/**
 * Per-channel median over a (2r+1)^2 window (edges extended). Exact (Huang's sliding histogram) for
 * small radii; separable (row median then column median) approximation beyond, which stays O(1).
 */
function medianData(d: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(d);
  if (r <= 0) return out;
  const nch = isOpaque(d) ? 3 : 4;
  const hist = new Int32Array(256);
  if (r <= 3) {
    const size = 2 * r + 1, half = (size * size + 1) >> 1;
    const rows = new Int32Array(size), cols = new Int32Array(w + 2 * r);
    for (let i = 0; i < cols.length; i++) cols[i] = clamp(i - r, 0, w - 1);
    for (let c = 0; c < nch; c++) {
      for (let y = 0; y < h; y++) {
        for (let k = 0; k < size; k++) rows[k] = clamp(y + k - r, 0, h - 1) * w;
        hist.fill(0);
        for (let k = 0; k < size; k++) for (let j = 0; j < size; j++) hist[d[(rows[k] + cols[j]) * 4 + c]]++;
        let med = 0, lt = 0;
        while (lt + hist[med] < half) { lt += hist[med]; med++; }
        out[y * w * 4 + c] = med;
        for (let x = 1; x < w; x++) {
          const xo = cols[x - 1], xi = cols[x + 2 * r];
          for (let k = 0; k < size; k++) {
            const ro = rows[k];
            const vo = d[(ro + xo) * 4 + c]; hist[vo]--; if (vo < med) lt--;
            const vi = d[(ro + xi) * 4 + c]; hist[vi]++; if (vi < med) lt++;
          }
          if (lt >= half) { do { med--; lt -= hist[med]; } while (lt >= half); }
          else while (lt + hist[med] < half) { lt += hist[med]; med++; }
          out[(y * w + x) * 4 + c] = med;
        }
      }
    }
    return out;
  }
  const t = new Uint8ClampedArray(d);
  for (let c = 0; c < nch; c++) {
    for (let y = 0; y < h; y++) median1D(d, t, w, y * w * 4 + c, 4, r, hist);
    for (let x = 0; x < w; x++) median1D(t, out, h, x * 4 + c, w * 4, r, hist);
  }
  return out;
}

// ---------- resampling ----------
/**
 * Bilinear sample at (x, y) (pixel-center coordinates) with premultiplied weighting.
 * Writes RGBA into od at oi.
 */
export function sampleBilinear(sd: Uint8ClampedArray, w: number, h: number, x: number, y: number, edge: EdgeMode, od: Uint8ClampedArray, oi: number) {
  if (edge === 'wrap') { x = ((x % w) + w) % w; y = ((y % h) + h) % h; }
  else if (edge === 'clamp') { x = x < 0 ? 0 : x > w - 1 ? w - 1 : x; y = y < 0 ? 0 : y > h - 1 ? h - 1 : y; }
  else if (x <= -1 || y <= -1 || x >= w || y >= h || x !== x || y !== y) { od[oi] = od[oi + 1] = od[oi + 2] = od[oi + 3] = 0; return; }
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  let wx0 = 1 - fx, wx1 = fx, wy0 = 1 - fy, wy1 = fy;
  if (edge === 'wrap') { if (x1 >= w) x1 -= w; if (y1 >= h) y1 -= h; }
  else {
    if (x0 < 0) { x0 = 0; wx0 = edge === 'clamp' ? wx0 : 0; }
    if (y0 < 0) { y0 = 0; wy0 = edge === 'clamp' ? wy0 : 0; }
    if (x1 > w - 1) { x1 = w - 1; if (edge === 'transparent') wx1 = 0; }
    if (y1 > h - 1) { y1 = h - 1; if (edge === 'transparent') wy1 = 0; }
  }
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const a00 = sd[i00 + 3] * wx0 * wy0, a10 = sd[i10 + 3] * wx1 * wy0, a01 = sd[i01 + 3] * wx0 * wy1, a11 = sd[i11 + 3] * wx1 * wy1;
  const a = a00 + a10 + a01 + a11;
  if (a < 1e-3) { od[oi] = od[oi + 1] = od[oi + 2] = od[oi + 3] = 0; return; }
  const inv = 1 / a;
  od[oi] = (sd[i00] * a00 + sd[i10] * a10 + sd[i01] * a01 + sd[i11] * a11) * inv;
  od[oi + 1] = (sd[i00 + 1] * a00 + sd[i10 + 1] * a10 + sd[i01 + 1] * a01 + sd[i11 + 1] * a11) * inv;
  od[oi + 2] = (sd[i00 + 2] * a00 + sd[i10 + 2] * a10 + sd[i01 + 2] * a01 + sd[i11 + 2] * a11) * inv;
  od[oi + 3] = a;
}

type MapFn = (x: number, y: number, o: Float64Array) => void;
/** Inverse-map every output pixel to a source position (o[0], o[1]) and resample. */
function remap(src: C, edge: EdgeMode, map: MapFn): C {
  const sid = getImageData(src), sd = sid.data, w = sid.width, h = sid.height;
  const out = new ImageData(w, h), od = out.data, o = new Float64Array(2);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      map(x, y, o);
      if (o[0] === x && o[1] === y) { od[i] = sd[i]; od[i + 1] = sd[i + 1]; od[i + 2] = sd[i + 2]; od[i + 3] = sd[i + 3]; continue; }
      sampleBilinear(sd, w, h, o[0], o[1], edge, od, i);
    }
  }
  return canvasFromImageData(out);
}

/** Generic convolution of the RGB channels (alpha kept), edges extended. */
export function convolve(src: C, kernel: ArrayLike<number>, size: number, scale = 1, offset = 0): C {
  const id = getImageData(src), d = id.data, w = id.width, h = id.height;
  const out = new ImageData(w, h), od = out.data, r = size >> 1;
  const tx: number[] = [], ty: number[] = [], tk: number[] = [];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = kernel[j * size + i];
    if (k) { tx.push(i - r); ty.push(j - r); tk.push(k / (scale || 1)); }
  }
  const n = tk.length, lin = tx.map((x, k) => (ty[k] * w + x) * 4);
  for (let y = 0, i = 0; y < h; y++) {
    const inY = y >= r && y < h - r;
    for (let x = 0; x < w; x++, i += 4) {
      let sr = 0, sg = 0, sb = 0;
      if (inY && x >= r && x < w - r) {
        for (let k = 0; k < n; k++) { const j = i + lin[k], kk = tk[k]; sr += d[j] * kk; sg += d[j + 1] * kk; sb += d[j + 2] * kk; }
      } else {
        for (let k = 0; k < n; k++) {
          const xx = clamp(x + tx[k], 0, w - 1), yy = clamp(y + ty[k], 0, h - 1), j = (yy * w + xx) * 4, kk = tk[k];
          sr += d[j] * kk; sg += d[j + 1] * kk; sb += d[j + 2] * kk;
        }
      }
      od[i] = sr + offset; od[i + 1] = sg + offset; od[i + 2] = sb + offset; od[i + 3] = d[i + 3];
    }
  }
  return canvasFromImageData(out);
}

// =====================================================================
// Blur
// =====================================================================
/** Fills with the average color (alpha-weighted); per-pixel alpha is kept. */
export function average(src: C): C {
  return withPixels(src, (d) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < d.length; i += 4) { const al = d[i + 3]; r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; }
    if (a <= 0) return;
    r /= a; g /= a; b /= a;
    for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; }
  });
}
export const gaussianBlur = (src: C, radius: number): C => blurCanvas(src, radius);
export const blur = (src: C) => blurCanvas(src, 0.75);
export const blurMore = (src: C) => blurCanvas(src, 1.7);

export function boxBlur(src: C, radius: number): C {
  const r = Math.round(radius);
  if (r < 1) return copyCanvas(src);
  const id = getImageData(src), w = id.width, h = id.height, tmp = new Float32Array(w * h);
  filterPremul(id, (p) => boxPlane(p, w, h, r, r, r, r, tmp));
  return canvasFromImageData(id);
}

/** Linear blur of length `distance` along `angle` (degrees, counter-clockwise). */
export function motionBlur(src: C, angle: number, distance: number): C {
  const r = Math.round(distance / 2);
  if (r < 1) return copyCanvas(src);
  const dirBlur = (c: C, horizontal: boolean) => {
    const id = getImageData(c), w = id.width, h = id.height, tmp = new Float32Array(w * h);
    filterPremul(id, (p) => (horizontal ? boxPlane(p, w, h, r, r, 0, 0, tmp) : boxPlane(p, w, h, 0, 0, r, r, tmp)));
    return canvasFromImageData(id);
  };
  const a = ((angle % 180) + 180) % 180;
  if (a === 0) return dirBlur(src, true);
  if (a === 90) return dirBlur(src, false);
  // rotate so the motion is horizontal, blur rows, rotate back
  const rad = angle * DEG, pad = r + 2;
  const p = edgePadded(src, pad), pw = p.width, ph = p.height;
  const ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
  const rw = Math.ceil(pw * ca + ph * sa), rh = Math.ceil(pw * sa + ph * ca);
  const rc = createCanvas(rw, rh), rx = ctx2d(rc);
  rx.translate(rw / 2, rh / 2);
  rx.rotate(rad);
  rx.drawImage(p, -pw / 2, -ph / 2);
  const blurred = dirBlur(rc, true);
  const out = createCanvas(src.width, src.height), ox = ctx2d(out);
  ox.translate(src.width / 2, src.height / 2);
  ox.rotate(-rad);
  ox.drawImage(blurred, -rw / 2, -rh / 2);
  return out;
}

function radialPass(src: ImageData, cx: number, cy: number, cs: Float64Array, sn: Float64Array): ImageData {
  const w = src.width, h = src.height, sd = src.data, out = new ImageData(w, h), od = out.data, n = cs.length;
  for (let y = 0, i = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++, i += 4) {
      const dx = x - cx;
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < n; k++) {
        let sx = cx + dx * cs[k] - dy * sn[k], sy = cy + dx * sn[k] + dy * cs[k];
        sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
        sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0;
        const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
        const w00 = (1 - fx) * (1 - fy) * sd[i00 + 3], w10 = fx * (1 - fy) * sd[i10 + 3];
        const w01 = (1 - fx) * fy * sd[i01 + 3], w11 = fx * fy * sd[i11 + 3];
        r += sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        g += sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        b += sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        a += w00 + w10 + w01 + w11;
      }
      if (a > 0) { od[i] = r / a; od[i + 1] = g / a; od[i + 2] = b / a; }
      od[i + 3] = a / n;
    }
  }
  return out;
}
/**
 * Spin / zoom blur around (cx, cy) given as fractions of the canvas. Uses 2-3 cascaded passes of
 * n samples (each pass fills the gaps of the previous one) instead of hundreds of samples per pixel.
 */
export function radialBlur(src: C, method: 'spin' | 'zoom', amount: number, cxf: number, cyf: number, quality: 'draft' | 'good' | 'best'): C {
  if (amount <= 0) return copyCanvas(src);
  const w = src.width, h = src.height, cx = cxf * (w - 1), cy = cyf * (h - 1);
  const passes = quality === 'draft' ? 2 : 3, n = quality === 'best' ? 10 : 6;
  let ext = method === 'spin' ? amount * 0.6 * DEG : (amount / 100) * 0.6;
  let cur = getImageData(src);
  for (let pass = 0; pass < passes; pass++) {
    const cs = new Float64Array(n), sn = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const t = (k / (n - 1) - 0.5) * ext;
      if (method === 'spin') { cs[k] = Math.cos(t); sn[k] = Math.sin(t); } else { cs[k] = 1 - t; sn[k] = 0; }
    }
    cur = radialPass(cur, cx, cy, cs, sn);
    ext /= n;
  }
  return canvasFromImageData(cur);
}

/** Edge-preserving blur (guided filter approximation of Photoshop's Surface Blur). */
export function surfaceBlur(src: C, radius: number, threshold: number): C {
  const r = Math.max(1, Math.round(radius));
  return withPixels(src, (d, w, h) => guidedRGB(d, w, h, r, Math.max(1, threshold * threshold * 0.6)));
}

/**
 * Spatially varying gaussian blur: weightAt(x, y) in 0..1 picks the blur amount (0 = sharp, 1 = maxSigma).
 * Interpolates between a handful of GPU-blurred levels, keeping only two levels in memory.
 */
function variableBlur(src: C, maxSigma: number, weightAt: (x: number, y: number) => number): C {
  if (maxSigma < 0.2) return copyCanvas(src);
  const w = src.width, h = src.height, N = w * h;
  const n = Math.max(2, Math.min(5, Math.ceil(maxSigma / 5)));
  const t = new Float32Array(N);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) t[i] = clamp(weightAt(x, y), 0, 1) * n;
  const out = getImageData(src), od = out.data;
  let prev = new Uint8ClampedArray(od);
  for (let k = 0; k < n; k++) {
    const cur = getImageData(blurCanvas(src, (maxSigma * (k + 1)) / n)).data;
    for (let i = 0; i < N; i++) {
      const ti = t[i];
      if (ti <= k || ti > k + 1) continue;
      const f = ti - k, j = i * 4;
      od[j] = prev[j] + (cur[j] - prev[j]) * f;
      od[j + 1] = prev[j + 1] + (cur[j + 1] - prev[j + 1]) * f;
      od[j + 2] = prev[j + 2] + (cur[j + 2] - prev[j + 2]) * f;
      od[j + 3] = prev[j + 3] + (cur[j + 3] - prev[j + 3]) * f;
    }
    prev = cur;
  }
  return canvasFromImageData(out);
}
/** Tilt-shift: sharp band through centerY (%) at `angle`, blur ramps in over `transition` (% of height). */
export function tiltShift(src: C, blurAmt: number, centerY: number, focus: number, transition: number, angle: number): C {
  const w = src.width, h = src.height, y0 = (centerY / 100) * h, x0 = w / 2, a = angle * DEG;
  const sn = Math.sin(a), cs = Math.cos(a), half = (focus / 200) * h, tr = Math.max(1, (transition / 100) * h);
  return variableBlur(src, blurAmt / 2, (x, y) => smooth(half, half + tr, Math.abs((x - x0) * sn + (y - y0) * cs)));
}
/** Iris blur: sharp inside an ellipse (radii as fractions of width/height), blurred outside. */
export function irisBlur(src: C, blurAmt: number, cxf: number, cyf: number, rxf: number, ryf: number, feather: number): C {
  const w = src.width, h = src.height, cx = cxf * w, cy = cyf * h;
  const irx = 1 / Math.max(1, rxf * w), iry = 1 / Math.max(1, ryf * h), inner = 1 - clamp(feather / 100, 0.01, 1);
  return variableBlur(src, blurAmt / 2, (x, y) => {
    const dx = (x - cx) * irx, dy = (y - cy) * iry;
    return smooth(inner, 1, Math.sqrt(dx * dx + dy * dy));
  });
}

// =====================================================================
// Distort (centered on the region passed in = selection bounds or layer)
// =====================================================================
export function pinch(src: C, amount: number): C {
  const w = src.width, h = src.height, cx = (w - 1) / 2, cy = (h - 1) / 2, rx = w / 2, ry = h / 2;
  const p = clamp(amount / 100, -1, 0.97);
  return remap(src, 'clamp', (x, y, o) => {
    const dx = (x - cx) / rx, dy = (y - cy) / ry, d2 = dx * dx + dy * dy;
    if (d2 >= 1 || d2 === 0 || p === 0) { o[0] = x; o[1] = y; return; }
    const f = Math.pow(Math.sin((Math.PI / 2) * Math.sqrt(d2)), -p);
    o[0] = cx + dx * f * rx; o[1] = cy + dy * f * ry;
  });
}
/** Twirl: rotation (degrees, positive = clockwise) strongest at the center, fading to 0 at the edge. */
export function twirl(src: C, angle: number): C {
  const w = src.width, h = src.height, cx = (w - 1) / 2, cy = (h - 1) / 2, rx = w / 2, ry = h / 2, a = angle * DEG;
  return remap(src, 'clamp', (x, y, o) => {
    const dx = (x - cx) / rx, dy = (y - cy) / ry, d2 = dx * dx + dy * dy;
    if (d2 >= 1 || a === 0) { o[0] = x; o[1] = y; return; }
    const f = 1 - Math.sqrt(d2), t = -a * f * f, c = Math.cos(t), s = Math.sin(t);
    o[0] = cx + (dx * c - dy * s) * rx; o[1] = cy + (dx * s + dy * c) * ry;
  });
}
export function spherize(src: C, amount: number, mode: 'normal' | 'horizontal' | 'vertical'): C {
  const w = src.width, h = src.height, cx = (w - 1) / 2, cy = (h - 1) / 2, rx = w / 2, ry = h / 2, a = amount / 100;
  // source radius for an output radius d (0..1)
  const f = (d: number) => (a >= 0 ? d + ((Math.asin(d) * 2) / Math.PI - d) * a : d + (Math.sin((d * Math.PI) / 2) - d) * -a);
  return remap(src, 'clamp', (x, y, o) => {
    o[0] = x; o[1] = y;
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    if (mode === 'horizontal') { const d = Math.abs(dx); if (d < 1) o[0] = cx + Math.sign(dx) * f(d) * rx; return; }
    if (mode === 'vertical') { const d = Math.abs(dy); if (d < 1) o[1] = cy + Math.sign(dy) * f(d) * ry; return; }
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= 1 || d === 0) return;
    const s = f(d) / d;
    o[0] = cx + dx * s * rx; o[1] = cy + dy * s * ry;
  });
}
export function polarCoordinates(src: C, mode: 'toPolar' | 'toRect'): C {
  const w = src.width, h = src.height, cx = w / 2, cy = h / 2;
  if (mode === 'toPolar') {
    return remap(src, 'clamp', (x, y, o) => {
      const dx = (x + 0.5 - cx) / cx, dy = (y + 0.5 - cy) / cy;
      let th = Math.atan2(dx, -dy);
      if (th < 0) th += TAU;
      o[0] = (th / TAU) * w - 0.5;
      o[1] = Math.sqrt(dx * dx + dy * dy) * h - 0.5;
    });
  }
  return remap(src, 'clamp', (x, y, o) => {
    const th = ((x + 0.5) / w) * TAU, r = (y + 0.5) / h;
    o[0] = cx + r * Math.sin(th) * cx - 0.5;
    o[1] = cy - r * Math.cos(th) * cy - 0.5;
  });
}
export function ripple(src: C, amount: number, size: 'small' | 'medium' | 'large'): C {
  const wl = size === 'small' ? 10 : size === 'large' ? 40 : 20, amp = (amount / 100) * wl * 0.12, k = TAU / wl;
  return remap(src, 'clamp', (x, y, o) => {
    // low-frequency phase wobble keeps the ripples irregular like Photoshop's
    const wob = Math.sin(x * 0.021 + y * 0.013) * 1.7 + Math.sin(y * 0.031 - x * 0.007) * 1.3;
    o[0] = x + amp * Math.sin(y * k + wob);
    o[1] = y + amp * Math.sin(x * k + wob * 0.8);
  });
}
export interface WaveParams {
  generators: number; wlMin: number; wlMax: number; ampMin: number; ampMax: number;
  scaleH: number; scaleV: number; type: 'sine' | 'triangle' | 'square'; undef: 'wrap' | 'repeat'; seed: number;
}
/** Sum of random waves; separable (x displacement depends on y and vice versa) so it is cheap. */
export function wave(src: C, p: WaveParams): C {
  const w = src.width, h = src.height, R = rng(p.seed), n = Math.max(1, Math.round(p.generators));
  const shape = (t: number) => {
    if (p.type === 'sine') return Math.sin(t);
    const u = (((t / TAU) % 1) + 1) % 1;
    return p.type === 'square' ? (u < 0.5 ? 1 : -1) : 1 - 4 * Math.abs(u - 0.5);
  };
  const dxRow = new Float32Array(h), dyCol = new Float32Array(w), norm = 1 / Math.sqrt(n);
  const lo = Math.min(p.wlMin, p.wlMax), hi = Math.max(p.wlMin, p.wlMax), alo = Math.min(p.ampMin, p.ampMax), ahi = Math.max(p.ampMin, p.ampMax);
  for (let g = 0; g < n; g++) {
    const wl1 = lo + R() * (hi - lo), a1 = alo + R() * (ahi - alo), ph1 = R() * TAU;
    const wl2 = lo + R() * (hi - lo), a2 = alo + R() * (ahi - alo), ph2 = R() * TAU;
    for (let y = 0; y < h; y++) dxRow[y] += a1 * shape((y / wl1) * TAU + ph1) * norm * (p.scaleH / 100);
    for (let x = 0; x < w; x++) dyCol[x] += a2 * shape((x / wl2) * TAU + ph2) * norm * (p.scaleV / 100);
  }
  return remap(src, p.undef === 'wrap' ? 'wrap' : 'clamp', (x, y, o) => { o[0] = x + dxRow[y]; o[1] = y + dyCol[x]; });
}
export function zigzag(src: C, amount: number, ridges: number, style: 'pond' | 'out' | 'around'): C {
  const w = src.width, h = src.height, cx = (w - 1) / 2, cy = (h - 1) / 2, rx = w / 2, ry = h / 2;
  const a = amount / 100, nr = Math.max(1, ridges);
  return remap(src, 'clamp', (x, y, o) => {
    const dx = (x - cx) / rx, dy = (y - cy) / ry, d = Math.sqrt(dx * dx + dy * dy);
    if (d >= 1 || d === 0 || a === 0) { o[0] = x; o[1] = y; return; }
    const env = 1 - d, wv = Math.sin(d * nr * TAU);
    let nd = d, ang = 0;
    if (style !== 'around') nd = d + ((a * 0.5) / nr) * wv * env * (style === 'pond' ? 0.8 : 1);
    if (style !== 'out') ang = a * 0.35 * wv * env * (style === 'pond' ? 0.6 : 1);
    const s = nd / d, c = Math.cos(ang), sn = Math.sin(ang);
    const ux = dx * s, uy = dy * s;
    o[0] = cx + (ux * c - uy * sn) * rx; o[1] = cy + (ux * sn + uy * c) * ry;
  });
}

// =====================================================================
// Lens Correction
// =====================================================================
export interface LensCorrectionParams {
  distortion: number; caRed: number; caBlue: number; vignette: number; midpoint: number; scale: number;
  edge: 'transparent' | 'extend';
}
export function lensCorrection(src: C, p: LensCorrectionParams): C {
  const sid = getImageData(src), sd = sid.data, w = sid.width, h = sid.height;
  const out = new ImageData(w, h), od = out.data, tmp = new Uint8ClampedArray(4);
  const cx = (w - 1) / 2, cy = (h - 1) / 2, R = Math.hypot(w, h) / 2, iR2 = 1 / (R * R);
  const k = (p.distortion / 100) * 0.35, sc = 100 / Math.max(1, p.scale);
  const fr = 1 + (p.caRed / 100) * 0.004, fb = 1 + (p.caBlue / 100) * 0.004;
  const edge: EdgeMode = p.edge === 'extend' ? 'clamp' : 'transparent';
  const vig = p.vignette / 100, start = (p.midpoint / 100) * 0.85;
  const ca = fr !== 1 || fb !== 1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const dx = x - cx, dy = y - cy, r2 = (dx * dx + dy * dy) * iR2;
      const f = (1 - k * r2) * sc, gx = cx + dx * f, gy = cy + dy * f;
      sampleBilinear(sd, w, h, gx, gy, edge, od, i);
      if (ca) {
        sampleBilinear(sd, w, h, cx + (gx - cx) * fr, cy + (gy - cy) * fr, edge, tmp, 0);
        od[i] = tmp[0];
        sampleBilinear(sd, w, h, cx + (gx - cx) * fb, cy + (gy - cy) * fb, edge, tmp, 0);
        od[i + 2] = tmp[2];
      }
      if (vig) {
        const t = smooth(start, 1.05, Math.sqrt(r2)) * 0.9;
        if (vig < 0) { const m = 1 + vig * t; od[i] *= m; od[i + 1] *= m; od[i + 2] *= m; }
        else { const m = vig * t; od[i] += (255 - od[i]) * m; od[i + 1] += (255 - od[i + 1]) * m; od[i + 2] += (255 - od[i + 2]) * m; }
      }
    }
  }
  return canvasFromImageData(out);
}

// =====================================================================
// Noise
// =====================================================================
let gaussTable: Float32Array | null = null;
export function addNoise(src: C, amount: number, gaussian: boolean, mono: boolean, seed: number): C {
  const R = rng(seed), k = (amount / 100) * 255;
  if (gaussian && !gaussTable) {
    // table of normal samples (Box-Muller once), indexed by the seeded PRNG: much faster than per-sample logs
    const G = rng(12345);
    gaussTable = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) gaussTable[i] = Math.sqrt(-2 * Math.log(G() || 1e-9)) * Math.cos(TAU * G());
  }
  const gt = gaussTable!, gk = k * 0.4, uk = k;
  return withPixels(src, (d) => {
    for (let i = 0; i < d.length; i += 4) {
      if (gaussian) {
        if (mono) { const n = gt[(R() * 65536) | 0] * gk; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
        else { d[i] += gt[(R() * 65536) | 0] * gk; d[i + 1] += gt[(R() * 65536) | 0] * gk; d[i + 2] += gt[(R() * 65536) | 0] * gk; }
      } else if (mono) { const n = (R() - 0.5) * uk; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
      else { d[i] += (R() - 0.5) * uk; d[i + 1] += (R() - 0.5) * uk; d[i + 2] += (R() - 0.5) * uk; }
    }
  });
}
export const despeckle = (src: C): C => withPixels(src, (d, w, h) => guidedRGB(d, w, h, 2, 120));
export function median(src: C, radius: number): C {
  const r = Math.round(radius);
  return withPixels(src, (d, w, h) => { d.set(medianData(d, w, h, r)); });
}
/** Replace pixels that differ from the local median by more than threshold. */
export function dustAndScratches(src: C, radius: number, threshold: number): C {
  const r = Math.round(radius);
  return withPixels(src, (d, w, h) => {
    const m = medianData(d, w, h, r);
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) if (Math.abs(d[i + c] - m[i + c]) > threshold) d[i + c] = m[i + c];
    }
  });
}
/** Luminance denoise (guided filter) + chroma blur + optional detail sharpening, in YCbCr. */
export function reduceNoise(src: C, strength: number, preserve: number, colorNoise: number, sharpenDetails: number): C {
  return withPixels(src, (d, w, h) => {
    const n = w * h, Y = new Float32Array(n), O = new Float32Array(n), m = new Float32Array(n), s = new Float32Array(n), tmp = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) Y[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    O.set(Y);
    if (strength > 0) {
      guidedPlane(Y, w, h, 2, Math.pow(strength * 5, 2), m, s, tmp);
      const keep = (preserve / 100) * 0.7;
      if (keep > 0) for (let i = 0; i < n; i++) Y[i] += (O[i] - Y[i]) * keep;
    }
    if (sharpenDetails > 0) {
      m.set(Y);
      boxPlane(m, w, h, 1, 1, 1, 1, tmp);
      const k = (sharpenDetails / 100) * 1.2;
      for (let i = 0; i < n; i++) Y[i] += (Y[i] - m[i]) * k;
    }
    // chroma: Cr -> m, Cb -> s (relative to the original luma O)
    for (let i = 0, j = 0; i < n; i++, j += 4) { m[i] = d[j] - O[i]; s[i] = d[j + 2] - O[i]; }
    const cr = Math.round((colorNoise / 100) * 6);
    if (cr > 0) for (let pass = 0; pass < 2; pass++) { boxPlane(m, w, h, cr, cr, cr, cr, tmp); boxPlane(s, w, h, cr, cr, cr, cr, tmp); }
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = Y[i] + m[i], b = Y[i] + s[i];
      d[j] = r; d[j + 2] = b; d[j + 1] = (Y[i] - 0.299 * r - 0.114 * b) / 0.587;
    }
  });
}

// =====================================================================
// Pixelate
// =====================================================================
export function mosaic(src: C, cellSize: number): C {
  const cell = Math.max(1, Math.round(cellSize));
  if (cell === 1) return copyCanvas(src);
  return withPixels(src, (d, w, h) => {
    for (let by = 0; by < h; by += cell) {
      const ey = Math.min(h, by + cell);
      for (let bx = 0; bx < w; bx += cell) {
        const ex = Math.min(w, bx + cell);
        let r = 0, g = 0, b = 0, a = 0, cnt = 0;
        for (let y = by; y < ey; y++) for (let x = bx, i = (y * w + bx) * 4; x < ex; x++, i += 4) {
          const al = d[i + 3]; r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; cnt++;
        }
        if (a > 0) { r /= a; g /= a; b /= a; }
        a /= cnt;
        for (let y = by; y < ey; y++) for (let x = bx, i = (y * w + bx) * 4; x < ex; x++, i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
      }
    }
  });
}
/** Jittered grid of seed points (one per cell). */
function jitterGrid(w: number, h: number, cell: number, seed: number) {
  const gx = Math.ceil(w / cell), gy = Math.ceil(h / cell), R = rng(seed);
  const px = new Float32Array(gx * gy), py = new Float32Array(gx * gy), pr = new Float32Array(gx * gy);
  for (let j = 0, k = 0; j < gy; j++) for (let i = 0; i < gx; i++, k++) { px[k] = (i + 0.1 + R() * 0.8) * cell; py[k] = (j + 0.1 + R() * 0.8) * cell; pr[k] = R(); }
  /** Index of the nearest point to (x, y) (searches the 3x3 neighbouring cells); dist2 in out[0]. */
  const nearest = (x: number, y: number, out: Float64Array) => {
    const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
    let best = -1, bd = Infinity;
    for (let j = Math.max(0, cj - 1); j <= Math.min(gy - 1, cj + 1); j++) {
      for (let i = Math.max(0, ci - 1); i <= Math.min(gx - 1, ci + 1); i++) {
        const k = j * gx + i, dx = px[k] - x, dy = py[k] - y, dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = k; }
      }
    }
    out[0] = bd;
    return best;
  };
  return { gx, gy, px, py, pr, nearest, count: gx * gy };
}
/** Voronoi cells filled with their average color. */
export function crystallize(src: C, cellSize: number, seed: number): C {
  const cell = Math.max(2, cellSize);
  return withPixels(src, (d, w, h) => {
    const G = jitterGrid(w, h, cell, seed), lab = new Int32Array(w * h), tmp = new Float64Array(1);
    const sum = new Float64Array(G.count * 5);
    for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p++) {
      const k = G.nearest(x + 0.5, y + 0.5, tmp), i = p * 4, a = d[i + 3], o = k * 5;
      lab[p] = k;
      sum[o] += d[i] * a; sum[o + 1] += d[i + 1] * a; sum[o + 2] += d[i + 2] * a; sum[o + 3] += a; sum[o + 4]++;
    }
    for (let k = 0; k < G.count; k++) {
      const o = k * 5, a = sum[o + 3];
      if (a > 0) { sum[o] /= a; sum[o + 1] /= a; sum[o + 2] /= a; }
      if (sum[o + 4] > 0) sum[o + 3] = a / sum[o + 4];
    }
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const o = lab[p] * 5;
      d[i] = sum[o]; d[i + 1] = sum[o + 1]; d[i + 2] = sum[o + 2]; d[i + 3] = sum[o + 3];
    }
  });
}
/** Randomly placed dots of the image's colors on the background color. */
export function pointillize(src: C, cellSize: number, bg: RGB, seed: number): C {
  const cell = Math.max(3, cellSize);
  const blurred = getImageData(blurCanvas(src, cell * 0.25)).data;
  return withPixels(src, (d, w, h) => {
    const G = jitterGrid(w, h, cell * 0.8, seed), tmp = new Float64Array(1);
    // per-dot color (sampled at the dot center, slightly randomized)
    const col = new Float32Array(G.count * 3), R = rng(seed ^ 0x5bd1e995);
    for (let k = 0; k < G.count; k++) {
      const x = clamp(Math.round(G.px[k]), 0, w - 1), y = clamp(Math.round(G.py[k]), 0, h - 1), i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) col[k * 3 + c] = blurred[i + c] + (R() - 0.5) * 50;
    }
    const rad = cell * 0.5;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      const k = G.nearest(x + 0.5, y + 0.5, tmp);
      const rr = rad * (0.75 + G.pr[k] * 0.4), t = clamp(rr - Math.sqrt(tmp[0]) + 0.5, 0, 1);
      d[i] = bg.r + (col[k * 3] - bg.r) * t;
      d[i + 1] = bg.g + (col[k * 3 + 1] - bg.g) * t;
      d[i + 2] = bg.b + (col[k * 3 + 2] - bg.b) * t;
    }
  });
}
/** Per-channel rotated halftone screens; dot area follows channel intensity. */
export function colorHalftone(src: C, maxRadius: number, angles: number[]): C {
  const R = Math.max(2, maxRadius), cell = R * Math.SQRT2;
  const bd = getImageData(blurCanvas(src, cell * 0.35)).data;
  return withPixels(src, (d, w, h) => {
    for (let c = 0; c < 3; c++) {
      const a = (angles[c] ?? 45) * DEG, cs = Math.cos(a), sn = Math.sin(a);
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
        const u = x * cs + y * sn, v = -x * sn + y * cs;
        const cu = (Math.floor(u / cell) + 0.5) * cell, cv = (Math.floor(v / cell) + 0.5) * cell;
        const px = clamp(Math.round(cu * cs - cv * sn), 0, w - 1), py = clamp(Math.round(cu * sn + cv * cs), 0, h - 1);
        const val = bd[(py * w + px) * 4 + c] / 255, rd = R * Math.sqrt(val);
        const dist = Math.sqrt((u - cu) * (u - cu) + (v - cv) * (v - cv));
        d[i + c] = clamp(rd - dist + 0.5, 0, 1) * 255;
      }
    }
  });
}
/** Four offset copies averaged (double-vision effect). */
export function fragment(src: C): C {
  const sd = getImageData(src).data;
  return withPixels(src, (d, w, h) => {
    const off = [[4, 0], [-4, 0], [0, 4], [0, -4]];
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [ox, oy] of off) {
        const j = (clamp(y + oy, 0, h - 1) * w + clamp(x + ox, 0, w - 1)) * 4, al = sd[j + 3];
        r += sd[j] * al; g += sd[j + 1] * al; b += sd[j + 2] * al; a += al;
      }
      if (a > 0) { d[i] = r / a; d[i + 1] = g / a; d[i + 2] = b / a; }
      d[i + 3] = a / 4;
    }
  });
}
export type MezzotintType = 'fine-dots' | 'medium-dots' | 'grainy-dots' | 'coarse-dots' | 'short-lines' | 'medium-lines' | 'long-lines' | 'short-strokes' | 'medium-strokes' | 'long-strokes';
/** Threshold every channel against a random pattern (dots, lines or strokes). */
export function mezzotint(src: C, type: MezzotintType, seed: number): C {
  const L = type.startsWith('short') ? 4 : type.startsWith('medium') ? 8 : 16;
  return withPixels(src, (d, w, h) => {
    for (let y = 0, i = 0; y < h; y++) {
      const rowOff = hash3(0, y, seed) * L;
      for (let x = 0; x < w; x++, i += 4) {
        if (type === 'grainy-dots') {
          for (let c = 0; c < 3; c++) d[i + c] = d[i + c] + (hash3(x * 3 + c, y, seed) - 0.5) * 255 > 127 ? 255 : 0;
          continue;
        }
        let t: number;
        if (type === 'fine-dots') t = hash3(x, y, seed);
        else if (type === 'medium-dots') t = hash3(x >> 1, y >> 1, seed);
        else if (type === 'coarse-dots') t = hash3(Math.floor(x / 3), Math.floor(y / 3), seed);
        else if (type.endsWith('lines')) t = hash3(Math.floor((x + rowOff) / L), y, seed + 1);
        else { const u = x - y; t = hash3(Math.floor((x + hash3(u, 7, seed) * L) / L), u, seed + 2); }
        const thr = t * 255;
        d[i] = d[i] > thr ? 255 : 0; d[i + 1] = d[i + 1] > thr ? 255 : 0; d[i + 2] = d[i + 2] > thr ? 255 : 0;
      }
    }
  });
}

// =====================================================================
// Render
// =====================================================================
function perlin2(seed: number): (x: number, y: number) => number {
  const R = rng(seed), p = new Uint8Array(256), perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(R() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const GX = new Float32Array([1, -1, 1, -1, 1.4142, -1.4142, 0, 0]), GY = new Float32Array([1, 1, -1, -1, 0, 0, 1.4142, -1.4142]);
  return (x, y) => {
    const fx0 = Math.floor(x), fy0 = Math.floor(y), X = fx0 & 255, Y = fy0 & 255, xf = x - fx0, yf = y - fy0;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = perm[X] + Y, b = perm[X + 1] + Y;
    const g00 = perm[a] & 7, g01 = perm[a + 1] & 7, g10 = perm[b] & 7, g11 = perm[b + 1] & 7;
    const n00 = GX[g00] * xf + GY[g00] * yf, n10 = GX[g10] * (xf - 1) + GY[g10] * yf;
    const n01 = GX[g01] * xf + GY[g01] * (yf - 1), n11 = GX[g11] * (xf - 1) + GY[g11] * (yf - 1);
    const nx0 = n00 + u * (n10 - n00), nx1 = n01 + u * (n11 - n01);
    return nx0 + v * (nx1 - nx0);
  };
}
/** Fractal (fBm) noise normalized to 0..1; computed at reduced resolution for big images then upsampled. */
function fbmField(w: number, h: number, seed: number, period: number, stretchY = 1, maxSamples = 2.5e6): Float32Array {
  const sc = Math.max(1, Math.sqrt((w * h) / maxSamples));
  const lw = Math.ceil(w / sc) + 1, lh = Math.ceil(h / sc) + 1;
  const low = new Float32Array(lw * lh), noise = perlin2(seed);
  let amp = 1, p = period, o = 0;
  const minP = Math.max(2, sc * 2);
  do {
    const f = 1 / p, fy = f / stretchY, ox = o * 37.17, oy = o * 91.31;
    for (let j = 0, k = 0; j < lh; j++) {
      const Y = j * sc * fy + oy;
      for (let i = 0; i < lw; i++, k++) low[k] += amp * noise(i * sc * f + ox, Y);
    }
    amp *= 0.5; p /= 2; o++;
  } while (p >= minP && o < 12);
  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < low.length; k++) { const v = low[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const s = mx > mn ? 1 / (mx - mn) : 0;
  const out = new Float32Array(w * h);
  for (let y = 0, k = 0; y < h; y++) {
    const v = y / sc, j0 = Math.min(lh - 2, Math.floor(v)), fv = v - j0;
    for (let x = 0; x < w; x++, k++) {
      const u = x / sc, i0 = Math.min(lw - 2, Math.floor(u)), fu = u - i0, b = j0 * lw + i0;
      const top = low[b] + (low[b + 1] - low[b]) * fu, bot = low[b + lw] + (low[b + lw + 1] - low[b + lw]) * fu;
      out[k] = (top + (bot - top) * fv - mn) * s;
    }
  }
  return out;
}
const cloudPeriod = (w: number, h: number) => clamp(Math.max(w, h) / 3, 64, 512);
/** Soft cloud pattern between the foreground and background colors (opaque). */
export function clouds(src: C, fg: RGB, bg: RGB, seed: number): C {
  const w = src.width, h = src.height, f = fbmField(w, h, seed, cloudPeriod(w, h));
  const out = new ImageData(w, h), d = out.data;
  for (let k = 0, i = 0; k < f.length; k++, i += 4) {
    const t = f[k];
    d[i] = fg.r + (bg.r - fg.r) * t; d[i + 1] = fg.g + (bg.g - fg.g) * t; d[i + 2] = fg.b + (bg.b - fg.b) * t; d[i + 3] = 255;
  }
  return canvasFromImageData(out);
}
/** Clouds blended with Difference onto the existing pixels. */
export function differenceClouds(src: C, fg: RGB, bg: RGB, seed: number): C {
  const w = src.width, h = src.height, f = fbmField(w, h, seed, cloudPeriod(w, h));
  return withPixels(src, (d) => {
    for (let k = 0, i = 0; k < f.length; k++, i += 4) {
      const t = f[k];
      d[i] = Math.abs(d[i] - (fg.r + (bg.r - fg.r) * t));
      d[i + 1] = Math.abs(d[i + 1] - (fg.g + (bg.g - fg.g) * t));
      d[i + 2] = Math.abs(d[i + 2] - (fg.b + (bg.b - fg.b) * t));
    }
  });
}
/** Woven-fiber look: noise stretched vertically, colored fg..bg (opaque). */
export function fibers(src: C, variance: number, strength: number, fg: RGB, bg: RGB, seed: number): C {
  const w = src.width, h = src.height;
  const period = 4 + 48 / Math.sqrt(Math.max(1, strength)), stretch = 1 + 160 / Math.max(1, variance);
  const f = fbmField(w, h, seed, period, stretch, Infinity);
  const out = new ImageData(w, h), d = out.data;
  for (let k = 0, i = 0; k < f.length; k++, i += 4) {
    const t = smooth(0.15, 0.85, f[k]);
    d[i] = fg.r + (bg.r - fg.r) * t; d[i + 1] = fg.g + (bg.g - fg.g) * t; d[i + 2] = fg.b + (bg.b - fg.b) * t; d[i + 3] = 255;
  }
  return canvasFromImageData(out);
}
export type FlareLens = 'zoom' | 'prime35' | 'prime105' | 'movie';
/** Lens flare composited with Screen at (cx, cy) in canvas pixels. brightness 10..300 (%). */
export function lensFlare(src: C, cx: number, cy: number, brightness: number, lens: FlareLens): C {
  const w = src.width, h = src.height, out = copyCanvas(src), x = ctx2d(out);
  const b = brightness / 100, diag = Math.hypot(w, h);
  const size = lens === 'prime35' ? 0.8 : lens === 'prime105' ? 1.25 : lens === 'movie' ? 0.9 : 1;
  const a = (v: number) => Math.min(1, v * b).toFixed(3);
  const R = diag * 0.035 * size * Math.sqrt(b);
  x.globalCompositeOperation = 'screen';
  const disc = (px: number, py: number, r: number, stops: [number, string][]) => {
    if (!(r > 0)) return;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    for (const [o, c] of stops) g.addColorStop(o, c);
    x.fillStyle = g;
    x.beginPath(); x.arc(px, py, r, 0, TAU); x.fill();
  };
  const poly = (px: number, py: number, r: number, sides: number, rot: number, color: string) => {
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, color); g.addColorStop(0.8, color); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g;
    x.beginPath();
    for (let k = 0; k < sides; k++) { const t = rot + (k / sides) * TAU; x.lineTo(px + Math.cos(t) * r, py + Math.sin(t) * r); }
    x.closePath(); x.fill();
  };
  // broad warm glow + hot core
  disc(cx, cy, R * 5, [[0, `rgba(255,236,210,${a(0.55)})`], [0.2, `rgba(255,180,110,${a(0.25)})`], [1, 'rgba(255,120,40,0)']]);
  disc(cx, cy, R * 1.1, [[0, `rgba(255,255,255,${a(1)})`], [0.35, `rgba(255,250,235,${a(0.85)})`], [1, 'rgba(255,240,220,0)']]);
  // rays / anamorphic streak
  const RR = rng(lens.length * 7919 + 13);
  if (lens === 'movie') {
    x.save(); x.translate(cx, cy); x.scale(1, 0.025);
    disc(0, 0, diag * 0.5 * size, [[0, `rgba(210,225,255,${a(0.8)})`], [0.4, `rgba(140,170,255,${a(0.3)})`], [1, 'rgba(100,140,255,0)']]);
    x.restore();
  } else {
    const rays = lens === 'zoom' ? 56 : lens === 'prime105' ? 16 : 10;
    for (let k = 0; k < rays; k++) {
      const ang = RR() * TAU, len = R * (3 + RR() * (lens === 'zoom' ? 7 : 4)), wd = R * (0.015 + RR() * 0.03);
      x.save(); x.translate(cx, cy); x.rotate(ang);
      const g = x.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, `rgba(255,245,230,${a(0.45)})`); g.addColorStop(1, 'rgba(255,200,150,0)');
      x.fillStyle = g;
      x.beginPath(); x.moveTo(0, -wd); x.lineTo(len, 0); x.lineTo(0, wd); x.closePath(); x.fill();
      x.restore();
    }
  }
  // halo ring
  const hr = R * (lens === 'prime105' ? 5.5 : 4.2);
  disc(cx, cy, hr, [[0, 'rgba(0,0,0,0)'], [0.8, 'rgba(0,0,0,0)'], [0.88, `rgba(255,170,120,${a(0.14)})`], [0.94, `rgba(140,200,255,${a(0.12)})`], [1, 'rgba(0,0,0,0)']]);
  // ghosts along the axis through the image center
  const vx = w / 2 - cx, vy = h / 2 - cy;
  const ghosts: [number, number, string][] = lens === 'movie'
    ? [[0.5, 0.5, '120,160,255'], [1.2, 0.9, '100,140,255'], [1.6, 0.4, '160,190,255']]
    : [[0.25, 0.35, '255,210,120'], [0.5, 0.9, '120,255,160'], [0.72, 0.5, '140,180,255'], [1.15, 1.6, '255,140,90'], [1.4, 0.7, '170,120,255'], [1.8, 2.2, '120,200,255']];
  const sides = lens === 'prime35' ? 5 : lens === 'prime105' ? 6 : 0;
  for (const [t, s, c] of ghosts) {
    const gx = cx + vx * t, gy = cy + vy * t, gr = R * s;
    if (sides) poly(gx, gy, gr, sides, 0.3, `rgba(${c},${a(0.16)})`);
    else disc(gx, gy, gr, [[0, `rgba(${c},${a(0.1)})`], [0.75, `rgba(${c},${a(0.2)})`], [1, `rgba(${c},0)`]]);
  }
  return out;
}

// =====================================================================
// Sharpen
// =====================================================================
export const sharpen = (src: C) => convolve(src, [0, -0.3, 0, -0.3, 2.2, -0.3, 0, -0.3, 0], 3);
export const sharpenMore = (src: C) => convolve(src, [-0.25, -0.5, -0.25, -0.5, 4, -0.5, -0.25, -0.5, -0.25], 3);
export const sharpenEdges = (src: C) => unsharpMask(src, 120, 1, 6);
/** Classic unsharp mask; threshold compares the luminance difference (0..255). */
export function unsharpMask(src: C, amount: number, radius: number, threshold: number): C {
  const bd = getImageData(blurCanvas(src, radius)).data, k = amount / 100;
  return withPixels(src, (d) => {
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - bd[i], dg = d[i + 1] - bd[i + 1], db = d[i + 2] - bd[i + 2];
      if (threshold > 0 && Math.abs(0.299 * dr + 0.587 * dg + 0.114 * db) * 2 < threshold) continue;
      d[i] += dr * k; d[i + 1] += dg * k; d[i + 2] += db * k;
    }
  });
}
/** Smart Sharpen: optional pre-denoise, gaussian/lens/motion deconvolution approximation, halo clamping. */
export function smartSharpen(src: C, amount: number, radius: number, reduceNoisePct: number, remove: 'gaussian' | 'lens' | 'motion', angle = 0): C {
  const id = getImageData(src), d = id.data, w = id.width, h = id.height;
  if (reduceNoisePct > 0) guidedRGB(d, w, h, 2, Math.pow((reduceNoisePct / 100) * 25, 2));
  const base = canvasFromImageData(id);
  const bl = remove === 'lens' ? boxBlur(base, radius) : remove === 'motion' ? motionBlur(base, angle, radius * 2) : blurCanvas(base, radius);
  const bd = getImageData(bl).data, k = amount / 100;
  const r = Math.max(1, Math.round(radius));
  const lmax = minMaxData(d, w, h, r, true), lmin = minMaxData(d, w, h, r, false);
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[i + c] + (d[i + c] - bd[i + c]) * k;
      d[i + c] = clamp(v, lmin[i + c] - 12, lmax[i + c] + 12);
    }
  }
  return canvasFromImageData(id);
}

// =====================================================================
// Stylize
// =====================================================================
export function diffuse(src: C, mode: 'normal' | 'darken' | 'lighten' | 'anisotropic', seed: number): C {
  const sid = getImageData(src), w = sid.width, h = sid.height, s32 = new Uint32Array(sid.data.buffer), sd = sid.data;
  const out = new ImageData(w, h), o32 = new Uint32Array(out.data.buffer);
  const lum = (j: number) => 0.299 * sd[j * 4] + 0.587 * sd[j * 4 + 1] + 0.114 * sd[j * 4 + 2];
  for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p++) {
    if (mode === 'anisotropic') {
      const L = lum(p);
      let best = p, bd = Infinity;
      for (let k = 0; k < 4; k++) {
        const r = hash3(x * 4 + k, y, seed);
        const nx = clamp(x + Math.floor(r * 5) - 2, 0, w - 1), ny = clamp(y + Math.floor(hash3(y * 4 + k, x, seed) * 5) - 2, 0, h - 1);
        const q = ny * w + nx;
        if (q === p) continue;
        const dd = Math.abs(lum(q) - L);
        if (dd < bd) { bd = dd; best = q; }
      }
      o32[p] = s32[best];
      continue;
    }
    const nx = clamp(x + Math.floor(hash3(x, y, seed) * 5) - 2, 0, w - 1), ny = clamp(y + Math.floor(hash3(y, x, seed + 1) * 5) - 2, 0, h - 1);
    const q = ny * w + nx;
    if (mode === 'normal') o32[p] = s32[q];
    else if (mode === 'darken') o32[p] = lum(q) < lum(p) ? s32[q] : s32[p];
    else o32[p] = lum(q) > lum(p) ? s32[q] : s32[p];
  }
  return canvasFromImageData(out);
}
/** Gray relief lit from `angle`, colored edges kept. height in px, amount in %. */
export function emboss(src: C, angle: number, height: number, amount: number): C {
  const sd = getImageData(src).data, a = angle * DEG, k = amount / 100;
  let ox = Math.round(Math.cos(a) * height), oy = Math.round(-Math.sin(a) * height);
  if (!ox && !oy) ox = 1;
  return withPixels(src, (d, w, h) => {
    for (let y = 0, i = 0; y < h; y++) {
      const ya = clamp(y - oy, 0, h - 1) * w, yb = clamp(y + oy, 0, h - 1) * w;
      for (let x = 0; x < w; x++, i += 4) {
        const ia = (ya + clamp(x - ox, 0, w - 1)) * 4, ib = (yb + clamp(x + ox, 0, w - 1)) * 4;
        d[i] = 128 + (sd[ia] - sd[ib]) * k; d[i + 1] = 128 + (sd[ia + 1] - sd[ib + 1]) * k; d[i + 2] = 128 + (sd[ia + 2] - sd[ib + 2]) * k;
      }
    }
  });
}
/** Sobel edges per channel, dark lines on white. */
export function findEdges(src: C): C {
  const sd = getImageData(src).data;
  return withPixels(src, (d, w, h) => {
    for (let y = 0, i = 0; y < h; y++) {
      const ym = Math.max(0, y - 1) * w, y0 = y * w, yp = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++, i += 4) {
        const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
        for (let c = 0; c < 3; c++) {
          const tl = sd[(ym + xm) * 4 + c], tc = sd[(ym + x) * 4 + c], tr = sd[(ym + xp) * 4 + c];
          const ml = sd[(y0 + xm) * 4 + c], mr = sd[(y0 + xp) * 4 + c];
          const bl = sd[(yp + xm) * 4 + c], bc = sd[(yp + x) * 4 + c], br = sd[(yp + xp) * 4 + c];
          const gx = tr + 2 * mr + br - tl - 2 * ml - bl, gy = bl + 2 * bc + br - tl - 2 * tc - tr;
          d[i + c] = 255 - Math.sqrt(gx * gx + gy * gy) * 0.5;
        }
      }
    }
  });
}
/**
 * Oil paint: Kuwahara filter (pick the flattest of four quadrant means) computed from box means
 * (O(1) per pixel), optional pre-smoothing, and a bristle relief lit from `angle`.
 */
export function oilPaint(src: C, stylization: number, cleanliness: number, shine: number, angle: number): C {
  const id = getImageData(src), d = id.data, w = id.width, h = id.height, n = w * h;
  if (cleanliness > 0) guidedRGB(d, w, h, 2, Math.pow(cleanliness * 6, 2));
  const r = Math.max(1, Math.round(stylization * 0.9 + 1));
  const tmp = new Float32Array(n), P = new Float32Array(n), Q = new Float32Array(n);
  // anchored means over [x-r, x] x [y-r, y]
  const mean = (fill: (i: number) => number, into: Float32Array) => { for (let i = 0; i < n; i++) into[i] = fill(i); boxPlane(into, w, h, r, 0, r, 0, tmp); };
  const mR = new Uint8ClampedArray(n), mG = new Uint8ClampedArray(n), mB = new Uint8ClampedArray(n);
  mean((i) => d[i * 4], P); mR.set(P);
  mean((i) => d[i * 4 + 1], P); mG.set(P);
  mean((i) => d[i * 4 + 2], P); mB.set(P);
  const lum = (i: number) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  mean(lum, P);
  mean((i) => { const l = lum(i); return l * l; }, Q);
  for (let i = 0; i < n; i++) Q[i] -= P[i] * P[i]; // variance
  for (let y = 0, p = 0; y < h; y++) {
    const y2 = Math.min(h - 1, y + r) * w, y1 = y * w;
    for (let x = 0; x < w; x++, p++) {
      const x2 = Math.min(w - 1, x + r);
      let best = y1 + x, bv = Q[best];
      const c2 = y1 + x2, c3 = y2 + x, c4 = y2 + x2;
      if (Q[c2] < bv) { bv = Q[c2]; best = c2; }
      if (Q[c3] < bv) { bv = Q[c3]; best = c3; }
      if (Q[c4] < bv) { best = c4; }
      const i = p * 4;
      d[i] = mR[best]; d[i + 1] = mG[best]; d[i + 2] = mB[best];
    }
  }
  if (shine > 0) {
    // relief from the painted luminance gradient
    for (let i = 0; i < n; i++) P[i] = lum(i);
    boxPlane(P, w, h, 1, 1, 1, 1, tmp);
    const a = angle * DEG, lx = Math.cos(a), ly = -Math.sin(a), k = shine * 0.6;
    for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p++) {
      const gx = P[y * w + Math.min(w - 1, x + 1)] - P[y * w + Math.max(0, x - 1)];
      const gy = P[Math.min(h - 1, y + 1) * w + x] - P[Math.max(0, y - 1) * w + x];
      const s = (gx * lx + gy * ly) * k, i = p * 4;
      d[i] += s; d[i + 1] += s; d[i + 2] += s;
    }
  }
  return canvasFromImageData(id);
}
export const solarize = (src: C): C => withPixels(src, (d) => {
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) if (d[i + c] > 127) d[i + c] = 255 - d[i + c];
});
export type TilesFill = 'background' | 'foreground' | 'inverse' | 'unaltered';
export function tiles(src: C, count: number, maxOffset: number, fill: TilesFill, fg: RGB, bg: RGB, seed: number): C {
  const w = src.width, h = src.height, ts = Math.max(1, Math.round(Math.min(w, h) / Math.max(1, count)));
  let out: C;
  if (fill === 'inverse') out = withPixels(src, (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } });
  else if (fill === 'unaltered') out = copyCanvas(src);
  else {
    out = createCanvas(w, h);
    const c = fill === 'background' ? bg : fg, x = ctx2d(out);
    x.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
    x.fillRect(0, 0, w, h);
  }
  const x = ctx2d(out), R = rng(seed), mo = (ts * maxOffset) / 100;
  x.imageSmoothingEnabled = false;
  for (let ty = 0; ty < h; ty += ts) for (let tx = 0; tx < w; tx += ts) {
    const tw = Math.min(ts, w - tx), th = Math.min(ts, h - ty);
    const dx = Math.round((R() * 2 - 1) * mo), dy = Math.round((R() * 2 - 1) * mo);
    x.clearRect(tx + dx, ty + dy, tw, th);
    x.drawImage(src, tx, ty, tw, th, tx + dx, ty + dy, tw, th);
  }
  return out;
}
/** Thin per-channel contour lines where a channel crosses `level`. */
export function traceContour(src: C, level: number, edge: 'lower' | 'upper'): C {
  const sd = getImageData(src).data;
  return withPixels(src, (d, w, h) => {
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      const ir = (y * w + Math.min(w - 1, x + 1)) * 4, ib = (Math.min(h - 1, y + 1) * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const below = sd[i + c] < level;
        const cross = below !== (sd[ir + c] < level) || below !== (sd[ib + c] < level);
        d[i + c] = cross && (edge === 'lower' ? below : !below) ? 0 : 255;
      }
    }
  });
}
/** Horizontal streaks trailing from bright edges. 'right' = wind from the right. */
export function wind(src: C, method: 'wind' | 'blast' | 'stagger', dir: 'right' | 'left', seed: number): C {
  const sd = getImageData(src).data;
  const len = method === 'blast' ? 70 : 26, prob = method === 'blast' ? 0.6 : 0.35;
  return withPixels(src, (d, w, h) => {
    for (let y = 0; y < h; y++) {
      let tr = 0, tg = 0, tb = 0, tl = -1, life = 0, maxLife = 1;
      const shift = method === 'stagger' ? Math.floor(hash3(y >> 2, 3, seed) * 12) : 0;
      for (let k = 0; k < w; k++) {
        const x = dir === 'right' ? w - 1 - k : k;
        const sx = clamp(dir === 'right' ? x + shift : x - shift, 0, w - 1), j = (y * w + sx) * 4, i = (y * w + x) * 4;
        const r = sd[j], g = sd[j + 1], b = sd[j + 2], L = 0.299 * r + 0.587 * g + 0.114 * b;
        if (life > 0) {
          life--;
          const f = life / maxLife;
          if (tl * f + L * (1 - f) > L) { d[i] = r + (tr - r) * f; d[i + 1] = g + (tg - g) * f; d[i + 2] = b + (tb - b) * f; }
          else { d[i] = r; d[i + 1] = g; d[i + 2] = b; }
        } else { d[i] = r; d[i + 1] = g; d[i + 2] = b; tl = -1; }
        if (L > (life > 0 ? tl * (life / maxLife) : tl) + 20 && hash3(x, y, seed) < prob) {
          tr = r; tg = g; tb = b; tl = L;
          maxLife = life = Math.max(2, Math.round(len * (0.3 + 0.7 * hash3(y, x, seed + 5))));
        }
      }
    }
  });
}

// =====================================================================
// Other
// =====================================================================
export function highPass(src: C, radius: number): C {
  const bd = getImageData(blurCanvas(src, radius)).data;
  return withPixels(src, (d) => {
    for (let i = 0; i < d.length; i += 4) { d[i] = 128 + d[i] - bd[i]; d[i + 1] = 128 + d[i + 1] - bd[i + 1]; d[i + 2] = 128 + d[i + 2] - bd[i + 2]; }
  });
}
export function maximum(src: C, radius: number): C {
  const r = Math.round(radius);
  if (r < 1) return copyCanvas(src);
  return withPixels(src, (d, w, h) => d.set(minMaxData(d, w, h, r, true)));
}
export function minimum(src: C, radius: number): C {
  const r = Math.round(radius);
  if (r < 1) return copyCanvas(src);
  return withPixels(src, (d, w, h) => d.set(minMaxData(d, w, h, r, false)));
}
export function offset(src: C, dx: number, dy: number, mode: 'transparent' | 'repeat' | 'wrap'): C {
  const sid = getImageData(src), w = sid.width, h = sid.height, s32 = new Uint32Array(sid.data.buffer);
  const out = new ImageData(w, h), o32 = new Uint32Array(out.data.buffer);
  dx = Math.round(dx); dy = Math.round(dy);
  for (let y = 0, p = 0; y < h; y++) {
    let sy = y - dy;
    if (mode === 'wrap') sy = ((sy % h) + h) % h;
    else if (mode === 'repeat') sy = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
    else if (sy < 0 || sy >= h) { p += w; continue; }
    for (let x = 0; x < w; x++, p++) {
      let sx = x - dx;
      if (mode === 'wrap') sx = ((sx % w) + w) % w;
      else if (mode === 'repeat') sx = sx < 0 ? 0 : sx >= w ? w - 1 : sx;
      else if (sx < 0 || sx >= w) continue;
      o32[p] = s32[sy * w + sx];
    }
  }
  return canvasFromImageData(out);
}

// =====================================================================
// Liquify: displacement field rendering
// =====================================================================
/**
 * Backward displacement field sampled on a grid of nodes (spacing cs image pixels) for an image W x H.
 * Output pixel p shows the source at p + D(p).
 */
export interface WarpField { fx: Float32Array; fy: Float32Array; gw: number; gh: number; cs: number; W: number; H: number }

/** Render src through a warp field (field scaled if src size differs from the field's W x H). */
export function warpByField(src: C, f: WarpField): C {
  const sid = getImageData(src), sd = sid.data, w = sid.width, h = sid.height;
  const out = new ImageData(w, h), od = out.data;
  const kx = f.W / w, ky = f.H / h, gw = f.gw, gh = f.gh, fx = f.fx, fy = f.fy;
  for (let y = 0, i = 0; y < h; y++) {
    const v = (y * ky) / f.cs, j0 = Math.min(gh - 2, Math.floor(v)), fv = v - j0;
    for (let x = 0; x < w; x++, i += 4) {
      const u = (x * kx) / f.cs, i0 = Math.min(gw - 2, Math.floor(u)), fu = u - i0, k = j0 * gw + i0;
      const a = fx[k], b = fx[k + 1], c = fx[k + gw], e = fx[k + gw + 1];
      const p = fy[k], q = fy[k + 1], r = fy[k + gw], s = fy[k + gw + 1];
      if (a === 0 && b === 0 && c === 0 && e === 0 && p === 0 && q === 0 && r === 0 && s === 0) {
        od[i] = sd[i]; od[i + 1] = sd[i + 1]; od[i + 2] = sd[i + 2]; od[i + 3] = sd[i + 3];
        continue;
      }
      const t1 = a + (b - a) * fu, t2 = c + (e - c) * fu, dx = t1 + (t2 - t1) * fv;
      const s1 = p + (q - p) * fu, s2 = r + (s - r) * fu, dy = s1 + (s2 - s1) * fv;
      sampleBilinear(sd, w, h, x + dx / kx, y + dy / ky, 'clamp', od, i);
    }
  }
  return canvasFromImageData(out);
}

// =====================================================================
// Camera Raw
// =====================================================================
export interface CameraRawParams {
  temperature: number; tint: number; exposure: number; contrast: number;
  highlights: number; shadows: number; whites: number; blacks: number;
  texture: number; clarity: number; dehaze: number; vibrance: number; saturation: number;
  sharpening: number; noiseReduction: number;
  vignette: number; vignetteMidpoint: number; grain: number;
}
export const CAMERA_RAW_DEFAULTS: CameraRawParams = {
  temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0, sharpening: 0, noiseReduction: 0,
  vignette: 0, vignetteMidpoint: 50, grain: 0,
};
/** Blurred luminance / dark-channel maps keyed by radius; reuse across preview renders of the same source. */
export interface CameraRawCache { maps: Map<string, Uint8ClampedArray> }

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = Math.pow(i / 255, 2.2);
const GAM = new Float32Array(4097);
for (let i = 0; i <= 4096; i++) GAM[i] = Math.pow(i / 4096, 1 / 2.2);
const toGamma = (v: number) => (v <= 0 ? 0 : v >= 1 ? Math.pow(v, 1 / 2.2) : GAM[(v * 4096) | 0]);

/**
 * Camera Raw-style develop pipeline. fullDim = longest side of the full-resolution image, scale =
 * (this canvas' pixels) / (full-res pixels) so local effects look the same on previews and at 100%.
 */
export function cameraRaw(src: C, p: CameraRawParams, fullDim: number, scale: number, cache?: CameraRawCache): C {
  const id = getImageData(src), d = id.data, w = id.width, h = id.height, n = w * h;
  const maps = cache?.maps ?? new Map<string, Uint8ClampedArray>();
  const rel = fullDim * scale;
  const grayMap = (key: string, sigma: number, val: (i: number) => number): Uint8ClampedArray => {
    const k = key + sigma.toFixed(2);
    let m = maps.get(k);
    if (!m) {
      const g = new ImageData(w, h), gd = g.data;
      for (let i = 0, j = 0; i < n; i++, j += 4) { const v = val(j); gd[j] = gd[j + 1] = gd[j + 2] = v; gd[j + 3] = 255; }
      const b = getImageData(blurCanvas(canvasFromImageData(g), sigma)).data;
      m = new Uint8ClampedArray(n);
      for (let i = 0; i < n; i++) m[i] = b[i * 4];
      maps.set(k, m);
    }
    return m;
  };
  const lumMap = (sigma: number) => grayMap('L', sigma, (j) => 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]);
  const darkMap = (sigma: number) => grayMap('D', sigma, (j) => Math.min(d[j], d[j + 1], d[j + 2]));

  const t = p.temperature / 100, ti = p.tint / 100;
  const mr0 = 1 + 0.3 * t, mg0 = 1 - 0.25 * ti, mb0 = 1 - 0.3 * t;
  const norm = 0.2126 * mr0 + 0.7152 * mg0 + 0.0722 * mb0, ex = Math.pow(2, p.exposure);
  const kr = (mr0 / norm) * ex, kg = (mg0 / norm) * ex, kb = (mb0 / norm) * ex;
  const exG = Math.pow(ex, 1 / 2.2);
  const con = p.contrast / 100, hi = p.highlights / 100, sh = p.shadows / 100, wh = p.whites / 100, bl = p.blacks / 100;
  const tex = p.texture / 100, cla = p.clarity / 100, dh = p.dehaze / 100, vib = p.vibrance / 100, sat = p.saturation / 100;
  const shp = (p.sharpening / 150) * 2.5, nr = p.noiseReduction / 100;
  const vig = p.vignette / 100, vStart = (p.vignetteMidpoint / 100) * 0.85, grain = p.grain / 100;
  const wp = 1 - 0.3 * wh, bp = -0.15 * bl, iwb = 1 / (wp - bp);
  const mT = tex ? lumMap(Math.max(0.8, rel * 0.002)) : null;
  const mC = cla ? lumMap(Math.max(2, rel * 0.02)) : null;
  const mM = hi || sh ? lumMap(Math.max(2, rel * 0.012)) : null;
  const mS = shp ? lumMap(Math.max(0.5, scale)) : null;
  const mN = nr ? lumMap(Math.max(0.6, 2 * scale)) : null;
  const mD = dh > 0 ? darkMap(Math.max(2, rel * 0.03)) : null;
  const cx = (w - 1) / 2, cy = (h - 1) / 2, ivx = 1 / Math.max(1, cx), ivy = 1 / Math.max(1, cy);
  const satBoost = 1 + sat + (dh > 0 ? dh * 0.25 : 0);

  for (let y = 0, i = 0, j = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4, j++) {
      let r = toGamma(LIN[d[i]] * kr), g = toGamma(LIN[d[i + 1]] * kg), b = toGamma(LIN[d[i + 2]] * kb);
      const Ys = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      // dehaze: haze model I = J t + A (1 - t) with A = 1, t from the blurred dark channel
      if (mD) {
        const it = 1 / Math.max(0.2, 1 - 0.75 * dh * (mD[j] / 255));
        r = 1 - (1 - r) * it; g = 1 - (1 - g) * it; b = 1 - (1 - b) * it;
      } else if (dh < 0) {
        const k = -dh * 0.6;
        r += (0.85 - r) * k; g += (0.85 - g) * k; b += (0.85 - b) * k;
      }
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let Yn = Y;
      if (mM) {
        const m = Math.min(1, (mM[j] / 255) * exG), ws = (1 - m) * (1 - m), whl = m * m;
        if (sh) Yn += sh * ws * 0.5 * (sh > 0 ? (1 - Yn) * Math.min(1, Yn * 6 + 0.15) : Yn);
        if (hi) Yn += hi * whl * 0.5 * (hi > 0 ? 1 - Yn : Yn);
      }
      if (mT) Yn += tex * (Ys - mT[j] / 255) * 1.5;
      if (mC) { const c = 2 * Yn - 1; Yn += cla * (Ys - mC[j] / 255) * 1.2 * Math.max(0.15, 1 - c * c); }
      Yn = (Yn - bp) * iwb;
      if (con) {
        if (con > 0) { const c = Yn < 0 ? 0 : Yn > 1 ? 1 : Yn; Yn += (c * c * (3 - 2 * c) - c) * con; }
        else Yn = 0.5 + (Yn - 0.5) * (1 + con * 0.5);
      }
      const dY = Yn - Y;
      if (dY) {
        const k = Y > 1e-4 ? Yn / Y : 1, wr = Math.min(1, Y * 8);
        r = (r + dY) * (1 - wr) + r * k * wr; g = (g + dY) * (1 - wr) + g * k * wr; b = (b + dY) * (1 - wr) + b * k * wr;
      }
      if (mS) { const det = (Ys - mS[j] / 255) * shp; r += det; g += det; b += det; }
      if (mN) {
        const dn = mN[j] / 255 - Ys, wgt = nr * Math.max(0, 1 - Math.abs(dn) * 12), v = dn * wgt;
        r += v; g += v; b += v;
      }
      if (satBoost !== 1 || vib) {
        const mx = r > g ? (r > b ? r : b) : g > b ? g : b, mn = r < g ? (r < b ? r : b) : g < b ? g : b;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b, sNow = mx > 1e-4 ? (mx - mn) / mx : 0;
        const f = satBoost * (1 + vib * (1 - sNow));
        r = L + (r - L) * f; g = L + (g - L) * f; b = L + (b - L) * f;
      }
      if (vig) {
        const vx = (x - cx) * ivx, vy = (y - cy) * ivy, tv = smooth(vStart, 1, Math.sqrt((vx * vx + vy * vy) / 2));
        if (vig < 0) { const m = 1 + vig * tv; r *= m; g *= m; b *= m; }
        else { const m = vig * tv; r += (1 - r) * m; g += (1 - g) * m; b += (1 - b) * m; }
      }
      if (grain) {
        const nz = (hash3((x / scale) | 0, (y / scale) | 0, 991) + hash3((x / scale) | 0, (y / scale) | 0, 17) - 1) * grain * 0.25;
        r += nz; g += nz; b += nz;
      }
      d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
    }
  }
  return canvasFromImageData(id);
}
