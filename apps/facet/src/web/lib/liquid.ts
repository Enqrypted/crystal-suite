// Liquid glass. Every glass surface gets a canvas showing what is behind it (the wallpaper, as Windows
// draws it on this display) as if seen through a slab of glass with rounded edges: lightly blurred,
// bent inwards at the rim (with a little colour fringing), tinted, and lit along its edge. Surfaces are
// repainted only when they move, change size or the wallpaper changes, so they cost nothing at rest.

export interface GlassOpts {
  /** Dark glass (menus, dark clock) instead of clear glass. */
  dark?: boolean;
  /** A colour to tint the glass with ('' for none). */
  tint?: string;
  /** Strength of the tint or darkening, 0..1. */
  tintAlpha?: number;
  /** How strongly the rim bends the background (1 = normal). */
  bend?: number;
}

interface Source { data: Uint8ClampedArray; w: number; h: number; k: number; ox: number; oy: number }
interface Surface { canvas: HTMLCanvasElement; opts: GlassOpts; key: string; painted: number }

let source: Source | null = null;
/** Paint counters (read by tests). */
export const stats = { paints: 0, lastMs: 0, maxMs: 0 };
(window as unknown as { facetLiquid: typeof stats }).facetLiquid = stats;
let version = 0;
const surfaces = new Map<HTMLElement, Surface>();
const dirty = new Set<HTMLElement>();
let frame = 0;

/** What lies behind the glass: pixels covering the page from (ox, oy), `k` pixels per CSS pixel. */
export function setSource(img: ImageData | null, k = 1, ox = 0, oy = 0) {
  source = img ? { data: img.data, w: img.width, h: img.height, k, ox, oy } : null;
  version++;
  refresh();
}

export function hasSource() { return !!source; }

/** Makes `el` a liquid glass surface (or updates its options). */
export function glass(el: HTMLElement, opts: GlassOpts = {}) {
  let s = surfaces.get(el);
  if (!s) {
    const canvas = document.createElement('canvas');
    canvas.className = 'lg';
    s = { canvas, opts, key: '', painted: 0 };
    surfaces.set(el, s);
  } else if (JSON.stringify(s.opts) !== JSON.stringify(opts)) s.opts = opts;
  refresh(el);
}

export function unglass(el: HTMLElement) {
  const s = surfaces.get(el);
  if (!s) return;
  s.canvas.remove();
  surfaces.delete(el);
  el.classList.remove('liquid');
}

/** Repaints `el` (or every surface) on the next frame if it moved, resized or the backdrop changed. */
export function refresh(el?: HTMLElement) {
  if (el) dirty.add(el);
  else for (const e of surfaces.keys()) dirty.add(e);
  if (!frame) frame = requestAnimationFrame(flush);
}

/** Repaints the surfaces inside `root` (after it moved). */
export function refreshWithin(root: HTMLElement) {
  for (const e of surfaces.keys()) if (root.contains(e)) dirty.add(e);
  if (!frame) frame = requestAnimationFrame(flush);
}

function flush() {
  frame = 0;
  const now = performance.now();
  for (const el of [...dirty]) {
    dirty.delete(el);
    const s = surfaces.get(el);
    if (!s) continue;
    if (!el.isConnected) { surfaces.delete(el); continue; }
    // while being dragged, big surfaces repaint at most ~25 times a second
    if (el.closest('.moving') && now - s.painted < 40 && el.offsetWidth * el.offsetHeight > 20000) { dirty.add(el); continue; }
    paint(el, s);
    s.painted = now;
  }
  if (dirty.size && !frame) frame = requestAnimationFrame(flush);
}

function radiusOf(el: HTMLElement, w: number, h: number) {
  const v = getComputedStyle(el).borderTopLeftRadius;
  const n = parseFloat(v) || 0;
  const r = v.endsWith('%') ? (Math.min(w, h) * n) / 100 : n;
  return Math.min(r, Math.min(w, h) / 2);
}

function paint(el: HTMLElement, s: Surface) {
  if (s.canvas.parentElement !== el) el.prepend(s.canvas);
  const src = source;
  if (!src) return;
  const w = el.offsetWidth, h = el.offsetHeight;
  if (!w || !h) return;
  // layout position (transforms such as the open/close animation are ignored on purpose)
  let x = 0, y = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) { x += e.offsetLeft; y += e.offsetTop; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = radiusOf(el, w, h);
  const key = `${x},${y},${w},${h},${r},${dpr},${JSON.stringify(s.opts)},${version}`;
  if (key === s.key) { el.classList.add('liquid'); return; } // (the owner may have reset its classes)
  s.key = key;
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (s.canvas.width !== W || s.canvas.height !== H) { s.canvas.width = W; s.canvas.height = H; }
  const ctx = s.canvas.getContext('2d')!;
  const out = ctx.createImageData(W, H);
  const t0 = performance.now();
  render(out.data, W, H, dpr, x - src.ox, y - src.oy, w, h, r, s.opts, src);
  ctx.putImageData(out, 0, 0);
  stats.paints++;
  stats.lastMs = performance.now() - t0;
  stats.maxMs = Math.max(stats.maxMs, stats.lastMs);
  el.classList.add('liquid');
}

const hex = (c: string): [number, number, number] => {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * The glass itself. For every pixel inside the rounded rectangle: its depth from the edge gives the
 * curvature of the rim (a bevel a fifth of the smaller side wide); the background is sampled further out
 * along the edge normal there, so things just outside the glass appear bent into its rim (red a bit more
 * than blue). Then the tint, a soft inner glow and the specular rim: bright where the edge faces the
 * light (top left), a fainter internal reflection on the opposite side.
 */
function render(o: Uint8ClampedArray, W: number, H: number, dpr: number, x: number, y: number, w: number, h: number, r: number, opts: GlassOpts, src: Source) {
  const sd = src.data, sw = src.w, sh = src.h, k = src.k;
  const hw = w / 2, hh = h / 2;
  const bevel = Math.max(6, Math.min(Math.min(w, h) * 0.22, Math.max(r, 10) * 1.1, 30));
  const bend = (opts.bend ?? 1) * bevel * 1.05;
  const dark = !!opts.dark;
  const [tr, tg, tb] = opts.tint ? hex(opts.tint) : dark ? [14, 14, 18] : [255, 255, 255];
  const ta = opts.tintAlpha ?? (opts.tint ? 0.34 : dark ? 0.5 : 0.14);
  const lift = dark ? 0.55 : 1; // highlights are softer on dark glass
  const lx = -0.55, ly = -0.83; // light from the top, slightly left

  // bilinear sample of one channel at CSS position (u, v) on the page
  const sample = (u: number, v: number, c: number) => {
    let fx = u * k - 0.5, fy = v * k - 0.5;
    if (fx < 0) fx = 0; else if (fx > sw - 1.001) fx = sw - 1.001;
    if (fy < 0) fy = 0; else if (fy > sh - 1.001) fy = sh - 1.001;
    const ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy;
    const i = (iy * sw + ix) * 4 + c, j = i + sw * 4;
    const top = sd[i] + (sd[i + 4] - sd[i]) * ax;
    const bot = sd[j] + (sd[j + 4] - sd[j]) * ax;
    return top + (bot - top) * ay;
  };

  for (let py = 0; py < H; py++) {
    const v = (py + 0.5) / dpr;
    const qy = Math.abs(v - hh) - (hh - r);
    const sy = v - hh < 0 ? -1 : 1;
    for (let px = 0; px < W; px++) {
      const u = (px + 0.5) / dpr;
      const qx = Math.abs(u - hw) - (hw - r);
      const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
      const len = Math.sqrt(ox * ox + oy * oy);
      const dist = len + Math.min(Math.max(qx, qy), 0) - r; // < 0 inside
      const i = (py * W + px) * 4;
      let a = 0.5 - dist * dpr;
      if (a <= 0) { o[i + 3] = 0; continue; }
      if (a > 1) a = 1;
      const d = -dist; // depth from the edge
      // outward normal of the edge
      let nx: number, ny: number;
      if (ox > 0 && oy > 0) { nx = ox / len; ny = oy / len; } else if (qx > qy) { nx = 1; ny = 0; } else { nx = 0; ny = 1; }
      nx *= u - hw < 0 ? -1 : 1;
      ny *= sy;
      const t = d >= bevel ? 1 : d / bevel;
      const f = 1 - t;
      const b = f * f * f * bend; // the rim bends, the middle doesn't
      const gx = x + u, gy = y + v;
      let R: number, G: number, B: number;
      if (b > 0.05) {
        R = sample(gx + nx * b * 1.12, gy + ny * b * 1.12, 0);
        G = sample(gx + nx * b, gy + ny * b, 1);
        B = sample(gx + nx * b * 0.88, gy + ny * b * 0.88, 2);
      } else {
        R = sample(gx, gy, 0); G = sample(gx, gy, 1); B = sample(gx, gy, 2);
      }
      // tint
      R += (tr - R) * ta; G += (tg - G) * ta; B += (tb - B) * ta;
      // light: specular rim facing the light, internal reflection opposite, glow along the bevel
      const facing = -(nx * lx + ny * ly); // 1 where the edge faces the light
      const rim = Math.exp(-d * 1.5);
      const inner = Math.exp(-d * 0.4);
      const lit = facing > 0 ? facing : 0, back = facing < 0 ? -facing : 0;
      // a crisp line all round, brightest facing the light and again on the far corner, like thick glass
      const spec = (rim * (0.3 + 0.6 * lit * lit + 0.4 * back * back) + inner * 0.14 * (lit + back * 0.8) + f * f * 0.1) * lift;
      R += (255 - R) * spec; G += (255 - G) * spec; B += (255 - B) * spec;
      o[i] = R; o[i + 1] = G; o[i + 2] = B; o[i + 3] = a * 255;
    }
  }
}
