// Warp (Edit > Transform > Warp): the lifted pixels are mapped through a cubic Bézier patch — a 4×4 grid of
// control points — or one of Photoshop's preset shapes (Arc, Flag, Bulge, ...). Interactive previews draw a
// coarse triangle mesh on the GPU; the final render rasterizes a fine mesh in software (bilinear, seamless).
import { createCanvas, ctx2d, Point, Rect } from '../core/util';
import { tri } from './transform';

export type WarpPreset =
  | 'custom' | 'arc' | 'arc-lower' | 'arc-upper' | 'arch' | 'bulge' | 'flag' | 'wave' | 'fish' | 'rise'
  | 'fisheye' | 'inflate' | 'squeeze' | 'twist';

export const WARP_PRESETS: { value: WarpPreset; label: string }[] = [
  { value: 'custom', label: 'Custom' }, { value: 'arc', label: 'Arc' }, { value: 'arc-lower', label: 'Arc Lower' },
  { value: 'arc-upper', label: 'Arc Upper' }, { value: 'arch', label: 'Arch' }, { value: 'bulge', label: 'Bulge' },
  { value: 'flag', label: 'Flag' }, { value: 'wave', label: 'Wave' }, { value: 'fish', label: 'Fish' },
  { value: 'rise', label: 'Rise' }, { value: 'fisheye', label: 'Fisheye' }, { value: 'inflate', label: 'Inflate' },
  { value: 'squeeze', label: 'Squeeze' }, { value: 'twist', label: 'Twist' },
];

/** 16 control points, row-major: index = j * 4 + i (i along u / x, j along v / y). */
export type Grid = Point[];

const B = (i: number, t: number) => {
  const s = 1 - t;
  return i === 0 ? s * s * s : i === 1 ? 3 * t * s * s : i === 2 ? 3 * t * t * s : t * t * t;
};
/** Weight of control point k at (u, v). */
export const weight = (k: number, u: number, v: number) => B(k % 4, u) * B((k / 4) | 0, v);

export function gridFromRect(r: Rect): Grid {
  const g: Grid = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) g.push({ x: r.x + (i / 3) * r.w, y: r.y + (j / 3) * r.h });
  return g;
}

export function patchPoint(g: Grid, u: number, v: number): Point {
  let x = 0, y = 0;
  for (let k = 0; k < 16; k++) { const w = weight(k, u, v); x += w * g[k].x; y += w * g[k].y; }
  return { x, y };
}

/** A preset's shape over rect `r` at `bend` (-1..1): maps (u, v) in 0..1 to a document point. */
export function presetMap(p: WarpPreset, r: Rect, bend: number): (u: number, v: number) => Point {
  const { x, y, w, h } = r, b = bend;
  return (u, v) => {
    const nx = 2 * u - 1, ny = 2 * v - 1;
    let dx = 0, dy = 0;
    switch (p) {
      case 'arc': dy = -b * h * 0.5 * (1 - nx * nx); break;
      case 'arc-lower': dy = b * h * 0.5 * (1 - nx * nx) * v; break;
      case 'arc-upper': dy = -b * h * 0.5 * (1 - nx * nx) * (1 - v); break;
      case 'arch': dy = -b * h * 0.5 * (1 - nx * nx); dx = -b * w * 0.12 * nx * (1 - v); break;
      case 'bulge': dy = b * h * 0.4 * (1 - nx * nx) * ny; break;
      case 'flag': dy = b * h * 0.25 * Math.sin(2 * Math.PI * u); break;
      case 'wave': dy = b * h * 0.22 * Math.sin(2 * Math.PI * u + Math.PI * v * 0.5) * (0.6 + 0.4 * Math.abs(ny)); break;
      case 'fish': dy = b * h * 0.45 * ny * Math.sin(Math.PI * Math.min(1, u * 1.15)) * (1 - 0.5 * u); break;
      case 'rise': dy = -b * h * 0.35 * Math.sin(nx * Math.PI / 2); break;
      case 'fisheye': { const k = 1 - Math.min(1, nx * nx + ny * ny); dx = b * w * 0.25 * nx * k; dy = b * h * 0.25 * ny * k; break; }
      case 'inflate': dx = b * w * 0.25 * nx * (1 - ny * ny); dy = b * h * 0.25 * ny * (1 - nx * nx); break;
      case 'squeeze': dx = -b * w * 0.25 * nx * (1 - ny * ny); dy = b * h * 0.2 * ny * (1 - nx * nx); break;
      case 'twist': {
        const cx = x + w / 2, cy = y + h / 2, px = x + u * w - cx, py = y + v * h - cy;
        const rr = Math.min(1, Math.hypot(nx, ny) / Math.SQRT2), a = b * (Math.PI / 2) * (1 - rr);
        return { x: cx + px * Math.cos(a) - py * Math.sin(a), y: cy + px * Math.sin(a) + py * Math.cos(a) };
      }
    }
    return { x: x + u * w + dx, y: y + v * h + dy };
  };
}

/** Least-squares Bézier grid for any mapping (a preset becomes editable as a custom warp). */
export function fitGrid(map: (u: number, v: number) => Point): Grid {
  const S = 9, N = 16;
  const A = Array.from({ length: N }, () => new Float64Array(N));
  const bx = new Float64Array(N), by = new Float64Array(N);
  for (let sj = 0; sj < S; sj++) for (let si = 0; si < S; si++) {
    const u = si / (S - 1), v = sj / (S - 1), p = map(u, v);
    const w = Array.from({ length: N }, (_, k) => weight(k, u, v));
    for (let a = 0; a < N; a++) {
      if (!w[a]) continue;
      bx[a] += w[a] * p.x; by[a] += w[a] * p.y;
      for (let c = 0; c < N; c++) A[a][c] += w[a] * w[c];
    }
  }
  const xs = solve(A.map((r) => Float64Array.from(r)), bx), ys = solve(A, by);
  return Array.from({ length: N }, (_, k) => ({ x: xs[k], y: ys[k] }));
}

/** Gaussian elimination with partial pivoting (small dense systems). */
function solve(A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length, M = A.map((r, i) => { const row = new Float64Array(n + 1); row.set(r); row[n] = b[i]; return row; });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return Float64Array.from({ length: n }, (_, i) => M[i][n] / (M[i][i] || 1e-12));
}

/** Mesh vertices: (n+1)² mapped points, over u in u0..u1 and v in v0..v1. */
function mesh(map: (u: number, v: number) => Point, n: number, u0 = 0, u1 = 1, v0 = 0, v1 = 1): Point[] {
  const pts: Point[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pts.push(map(u0 + ((u1 - u0) * i) / n, v0 + ((v1 - v0) * j) / n));
  return pts;
}

function meshBounds(pts: Point[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const x = Math.floor(x0), y = Math.floor(y0);
  return { x, y, w: Math.max(1, Math.ceil(x1) - x), h: Math.max(1, Math.ceil(y1) - y) };
}

/** Quick GPU preview: `src` drawn through the mapping as an n×n triangle mesh. Canvas positioned in doc space. */
export function warpPreview(src: HTMLCanvasElement, map: (u: number, v: number) => Point, n = 14): { canvas: HTMLCanvasElement; x: number; y: number } {
  const pts = mesh(map, n);
  const R = meshBounds(pts);
  const out = createCanvas(R.w, R.h);
  const ctx = ctx2d(out);
  const sw = src.width, sh = src.height, row = n + 1;
  const at = (i: number, j: number) => { const p = pts[j * row + i]; return { x: p.x - R.x, y: p.y - R.y }; };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u0 = (i / n) * sw, u1 = ((i + 1) / n) * sw, v0 = (j / n) * sh, v1 = ((j + 1) / n) * sh;
    tri(ctx, src, [u0, v0, u1, v0, u0, v1], [at(i, j), at(i + 1, j), at(i, j + 1)]);
    tri(ctx, src, [u1, v0, u1, v1, u0, v1], [at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  }
  return { canvas: out, x: R.x, y: R.y };
}

/**
 * Final render: rasterize every mesh triangle, interpolating source coordinates barycentrically and sampling
 * bilinearly (premultiplied). No seams between triangles. The mesh reaches one source pixel past the edges,
 * where the source is transparent, so the warped outline comes out anti-aliased.
 */
export function warpRender(src: HTMLCanvasElement, map: (u: number, v: number) => Point, n = 48, smooth = true): { canvas: HTMLCanvasElement; x: number; y: number } {
  const sw = src.width, sh = src.height;
  const pu = 1 / sw, pv = 1 / sh;
  const pts = mesh(map, n, -pu, 1 + pu, -pv, 1 + pv);
  const R = meshBounds(pts);
  const W = R.w, H = R.h, row = n + 1;
  const sd = ctx2d(src).getImageData(0, 0, sw, sh).data;
  const outImg = new ImageData(W, H), o = outImg.data;
  /** Alpha of source pixel (x, y), 0 outside. */
  const alphaAt = (x: number, y: number) => (x < 0 || y < 0 || x >= sw || y >= sh ? 0 : sd[(y * sw + x) * 4 + 3]);
  const sample = (fx: number, fy: number, oi: number) => {
    if (!smooth) {
      const ix = Math.round(fx), iy = Math.round(fy);
      if (ix < 0 || iy < 0 || ix >= sw || iy >= sh) return;
      const si = (iy * sw + ix) * 4;
      o[oi] = sd[si]; o[oi + 1] = sd[si + 1]; o[oi + 2] = sd[si + 2]; o[oi + 3] = sd[si + 3];
      return;
    }
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const cx0 = Math.min(sw - 1, Math.max(0, x0)), cx1 = Math.min(sw - 1, Math.max(0, x0 + 1));
    const cy0 = Math.min(sh - 1, Math.max(0, y0)), cy1 = Math.min(sh - 1, Math.max(0, y0 + 1));
    const i00 = (cy0 * sw + cx0) * 4, i10 = (cy0 * sw + cx1) * 4, i01 = (cy1 * sw + cx0) * 4, i11 = (cy1 * sw + cx1) * 4;
    const a00 = alphaAt(x0, y0) * (1 - tx) * (1 - ty), a10 = alphaAt(x0 + 1, y0) * tx * (1 - ty);
    const a01 = alphaAt(x0, y0 + 1) * (1 - tx) * ty, a11 = alphaAt(x0 + 1, y0 + 1) * tx * ty;
    const al = a00 + a10 + a01 + a11;
    if (al <= 0) return;
    for (let k = 0; k < 3; k++) o[oi + k] = (sd[i00 + k] * a00 + sd[i10 + k] * a10 + sd[i01 + k] * a01 + sd[i11 + k] * a11) / al;
    o[oi + 3] = al;
  };
  // one triangle: destination points P (doc, minus R) with source coords S
  const raster = (P: Point[], S: Point[]) => {
    const [a, b, c] = P;
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-9) return;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), maxX = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), maxY = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    const eps = -1e-6;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / den;
        const w1 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / den;
        const w2 = 1 - w0 - w1;
        if (w0 < eps || w1 < eps || w2 < eps) continue;
        sample(w0 * S[0].x + w1 * S[1].x + w2 * S[2].x - 0.5, w0 * S[0].y + w1 * S[1].y + w2 * S[2].y - 0.5, (y * W + x) * 4);
      }
    }
  };
  const at = (i: number, j: number) => { const p = pts[j * row + i]; return { x: p.x - R.x, y: p.y - R.y }; };
  const sp = (i: number, j: number) => ({ x: (-pu + ((1 + 2 * pu) * i) / n) * sw, y: (-pv + ((1 + 2 * pv) * j) / n) * sh });
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    raster([at(i, j), at(i + 1, j), at(i, j + 1)], [sp(i, j), sp(i + 1, j), sp(i, j + 1)]);
    raster([at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)], [sp(i + 1, j), sp(i + 1, j + 1), sp(i, j + 1)]);
  }
  const out = createCanvas(W, H);
  ctx2d(out).putImageData(outImg, 0, 0);
  return { canvas: out, x: R.x, y: R.y };
}
