// Layer styles (fx): Drop Shadow, Outer Glow, overlays, Inner Glow / Shadow and Stroke.
// GPU canvas ops (blur filter, compositing) do the heavy lifting; an exact Euclidean distance
// transform provides the spread / choke / stroke morphology.
//
// Value conventions (LayerStyle): opacity 0..1, spread / choke 0..100 (% of size), size / distance px,
// angle in degrees (Photoshop light angle), gradient overlay scale in % (100 = 100%).
import { BlendMode, Gradient, GradientStyle, Layer, LayerStyle } from './layer';
import { NATIVE_BLEND, blendPixels } from './blend';
import { clamp, createCanvas, ctx2d, cssColor, RGB } from './util';
import { renderGradient } from './gradient';

export function hasActiveStyle(L: Layer): boolean {
  const s = L.style;
  if (!s) return false;
  return Object.values(s).some((e: any) => e && e.enabled);
}

interface Box { x: number; y: number; w: number; h: number }
type GradientOverlay = NonNullable<LayerStyle['gradientOverlay']>;

/**
 * Render layer content `base` (positioned at bx,by in doc space, mask already applied)
 * with its layer style. Returns a canvas positioned in doc space (it may be larger than base).
 * Fill opacity applies to the content (and interior effects), not to shadows/glows/stroke.
 */
export function renderStyled(L: Layer, base: HTMLCanvasElement, bx: number, by: number): { canvas: HTMLCanvasElement; x: number; y: number } {
  const s = L.style;
  if (!s) return { canvas: base, x: bx, y: by };
  const ds = live(s.dropShadow), og = live(s.outerGlow), go = live(s.gradientOverlay), co = live(s.colorOverlay);
  const ig = live(s.innerGlow), is = live(s.innerShadow);
  const st = s.stroke && s.stroke.size > 0 ? live(s.stroke) : null;
  const fill = clamp(L.fillOpacity ?? 1, 0, 1);

  // Content bounds (all effect work happens around them, not over the whole layer canvas)
  const bw = base.width, bh = base.height;
  const img = ctx2d(base).getImageData(0, 0, bw, bh);
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, bw * bh);
  const bb = alphaBox(src, bw, bh);
  if (!bb) return { canvas: base, x: bx, y: by };

  // Margins for effects reaching outside the content
  let ml = 0, mt = 0, mr = 0, mb = 0;
  const grow = (l: number, t: number, r: number, b: number) => {
    ml = Math.max(ml, l); mt = Math.max(mt, t); mr = Math.max(mr, r); mb = Math.max(mb, b);
  };
  if (ds) { const [dx, dy] = lightOffset(ds.angle, ds.distance), e = ds.size * 1.5; grow(e - dx, e - dy, e + dx, e + dy); }
  if (og) { const e = og.size * 1.5; grow(e, e, e, e); }
  if (st && st.position !== 'inside') { const e = st.position === 'outside' ? st.size : st.size / 2; grow(e, e, e, e); }
  ml = Math.ceil(ml) + 2; mt = Math.ceil(mt) + 2; mr = Math.ceil(mr) + 2; mb = Math.ceil(mb) + 2;
  // Effect space W: content bbox + margins (base-local coords). The content bbox sits at (ml, mt).
  const W: Box = { x: bb.x - ml, y: bb.y - mt, w: bb.w + ml + mr, h: bb.h + mt + mb };
  const ww = W.w, wh = W.h;
  const docX = bx + W.x, docY = by + W.y;

  const shape = scratch('shape', ww, wh);
  ctx2d(shape).drawImage(base, -W.x, -W.y);

  // Signed distance field, only when spread / choke / stroke need morphology
  const needOut = !!((ds && ds.spread > 0) || (og && og.spread > 0) || (st && st.position !== 'inside'));
  const needIn = !!((ig && ig.choke > 0) || (is && is.choke > 0) || (st && st.position !== 'outside'));
  const sd = needOut || needIn ? signedDistance(src, bw, bb, W, needOut, needIn) : null;
  /** Shape grown (r > 0) or shrunk (r < 0) by r px, anti-aliased. */
  const morph = (r: number) => coverageCanvas(sd!, ww, wh, r);

  const out = createCanvas(ww, wh);
  const oc = ctx2d(out);

  // ---- Drop Shadow (bottom). Spread hardens the matte (dilation), the rest of Size is blur.
  if (ds) {
    const r = (ds.size * clamp(ds.spread, 0, 100)) / 100;
    const [dx, dy] = lightOffset(ds.angle, ds.distance);
    const E = blurred(r > 0 ? morph(r) : shape, ds.size - r, dx, dy, ww, wh);
    tint(E, ds.color);
    // Layer knocks out drop shadow (matters with reduced fill / soft content)
    const ex = ctx2d(E);
    ex.globalCompositeOperation = 'destination-out';
    ex.drawImage(shape, 0, 0);
    resetCtx(ex);
    blendOnto(oc, E, ds.blend, ds.opacity, 0, 0, docX, docY);
  }

  // ---- Outer Glow
  if (og) {
    const r = (og.size * clamp(og.spread, 0, 100)) / 100;
    const E = blurred(r > 0 ? morph(r) : shape, og.size - r, 0, 0, ww, wh);
    tint(E, og.color);
    blendOnto(oc, E, og.blend, og.opacity, 0, 0, docX, docY);
  }

  // ---- Interior: content + overlays + inner effects, composed on an opaque copy of the content
  // colors so blend modes act exactly like "clipped to the layer", then masked by content alpha.
  let opq: HTMLCanvasElement | null = null;
  const opaque = () => opq ?? (opq = makeOpaque(src, bw, bb, ww, wh, ml, mt));
  /** Inverted matte (outside of the shape), choked, offset and blurred — source for inner effects. */
  const innerMatte = (choke: number, size: number, dx: number, dy: number) => {
    const r = (size * clamp(choke, 0, 100)) / 100, blur = Math.max(0, size - r);
    const m = Math.ceil(blur * 1.5 + Math.abs(dx) + Math.abs(dy)) + 2;
    const P = scratch('matte', bb.w + 2 * m, bb.h + 2 * m), px = ctx2d(P);
    px.fillStyle = '#fff';
    px.fillRect(0, 0, P.width, P.height);
    px.globalCompositeOperation = 'destination-out';
    px.drawImage(r > 0 ? morph(-r) : shape, m - ml + dx, m - mt + dy);
    resetCtx(px);
    return blurred(P, blur, ml - m, mt - m, ww, wh);
  };
  let content = shape;
  if (go || co || ig || is) {
    const O = opaque(), ox = ctx2d(O);
    if (go) blendOnto(ox, gradientFill(go, bb.w, bb.h), go.blend, go.opacity, ml, mt, docX, docY);
    if (co) blendOnto(ox, solid(co.color, bb.w, bb.h), co.blend, co.opacity, ml, mt, docX, docY);
    if (ig) {
      const E = innerMatte(ig.choke, ig.size, 0, 0);
      tint(E, ig.color);
      blendOnto(ox, E, ig.blend, ig.opacity, 0, 0, docX, docY);
    }
    if (is) {
      const [dx, dy] = lightOffset(is.angle, is.distance);
      const E = innerMatte(is.choke, is.size, dx, dy);
      tint(E, is.color);
      blendOnto(ox, E, is.blend, is.opacity, 0, 0, docX, docY);
    }
    const I = scratch('interior', ww, wh), ix = ctx2d(I);
    ix.drawImage(O, 0, 0);
    ix.globalCompositeOperation = 'destination-in';
    ix.drawImage(shape, 0, 0);
    resetCtx(ix);
    content = I;
  }

  if (!st) {
    oc.globalAlpha = fill;
    oc.drawImage(content, 0, 0);
    oc.globalAlpha = 1;
    return { canvas: out, x: docX, y: docY };
  }

  // ---- Stroke (top, not affected by fill). Content and stroke share the same coverage geometry,
  // so they are summed with 'lighter' (exact, seamless anti-aliased edges).
  const T = scratch('stroke-t', ww, wh), tx = ctx2d(T);
  tx.globalAlpha = fill;
  tx.drawImage(content, 0, 0);
  tx.globalAlpha = 1;
  const op = clamp(st.opacity, 0, 1), size = st.size;
  const rin = st.position === 'inside' ? size : st.position === 'center' ? size / 2 : 0;
  const rout = st.position === 'outside' ? size : st.position === 'center' ? size / 2 : 0;
  if (rin > 0) {
    // Fraction of each pixel of the shape covered by the inner ring = 1 - eroded shape
    const M = scratch('stroke-m', ww, wh), mx = ctx2d(M);
    mx.fillStyle = '#fff';
    mx.fillRect(0, 0, ww, wh);
    mx.globalCompositeOperation = 'destination-out';
    mx.drawImage(morph(-rin), 0, 0);
    resetCtx(mx);
    tx.globalCompositeOperation = 'destination-out';
    tx.globalAlpha = op;
    tx.drawImage(M, 0, 0);
    resetCtx(tx);
    const S = scratch('stroke-s', ww, wh), sx = ctx2d(S);
    if (st.blend === 'normal') {
      sx.fillStyle = cssColor(st.color);
      sx.fillRect(0, 0, ww, wh);
    } else {
      sx.drawImage(opaque(), 0, 0);
      blendOnto(sx, solid(st.color, ww, wh), st.blend, 1, 0, 0, docX, docY);
    }
    sx.globalCompositeOperation = 'destination-in';
    sx.drawImage(M, 0, 0);
    sx.drawImage(shape, 0, 0);
    resetCtx(sx);
    tx.globalCompositeOperation = 'lighter';
    tx.globalAlpha = op;
    tx.drawImage(S, 0, 0);
    resetCtx(tx);
  }
  if (rout > 0) {
    // Outer ring = grown shape minus the shape (nothing of the layer lies below it to blend with)
    const S = scratch('stroke-s', ww, wh), sx = ctx2d(S);
    sx.drawImage(morph(rout), 0, 0);
    sx.globalCompositeOperation = 'source-in';
    sx.fillStyle = cssColor(st.color);
    sx.fillRect(0, 0, ww, wh);
    sx.globalCompositeOperation = 'destination-out';
    sx.drawImage(shape, 0, 0);
    resetCtx(sx);
    tx.globalCompositeOperation = 'lighter';
    tx.globalAlpha = op;
    tx.drawImage(S, 0, 0);
    resetCtx(tx);
  }
  oc.drawImage(T, 0, 0);
  return { canvas: out, x: docX, y: docY };
}

// ---------------------------------------------------------------------------------------------
// Helpers

function live<T extends { enabled: boolean; opacity: number }>(e: T | undefined): T | null {
  return e && e.enabled && e.opacity > 0 ? e : null;
}

/** Photoshop light angle: 120° => the shadow falls down-right. */
function lightOffset(angle: number, distance: number): [number, number] {
  const a = (angle * Math.PI) / 180;
  return [-Math.cos(a) * distance, Math.sin(a) * distance];
}

// Exact-size scratch canvases reused while a styled layer re-renders every frame; freed when idle.
const pool = new Map<string, HTMLCanvasElement>();
let poolTimer = 0;
function scratch(key: string, w: number, h: number): HTMLCanvasElement {
  let c = pool.get(key);
  if (!c || c.width !== w || c.height !== h) {
    c = createCanvas(w, h);
    pool.set(key, c);
  } else {
    const x = ctx2d(c);
    resetCtx(x);
    x.clearRect(0, 0, w, h);
  }
  clearTimeout(poolTimer);
  poolTimer = window.setTimeout(() => {
    pool.forEach((p) => { p.width = 0; p.height = 0; });
    pool.clear();
  }, 3000);
  return c;
}

function resetCtx(x: CanvasRenderingContext2D) {
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.filter = 'none';
}

/** `src` drawn at (dx, dy) with a gaussian blur matching Photoshop's Size (σ = size / 2). */
function blurred(src: HTMLCanvasElement, size: number, dx: number, dy: number, w: number, h: number): HTMLCanvasElement {
  const E = scratch('fx', w, h), ex = ctx2d(E);
  if (size > 0.01) ex.filter = `blur(${size / 2}px)`;
  ex.drawImage(src, dx, dy);
  ex.filter = 'none';
  return E;
}

function tint(c: HTMLCanvasElement, color: RGB) {
  const x = ctx2d(c);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = cssColor(color);
  x.fillRect(0, 0, c.width, c.height);
  resetCtx(x);
}

function solid(color: RGB, w: number, h: number): HTMLCanvasElement {
  const c = scratch('solid', w, h), x = ctx2d(c);
  x.fillStyle = cssColor(color);
  x.fillRect(0, 0, w, h);
  return c;
}

/** Draw `srcC` onto dst at (x, y) with an effect blend mode (software fallback for non-native modes). */
function blendOnto(dst: CanvasRenderingContext2D, srcC: HTMLCanvasElement, mode: BlendMode, opacity: number, x: number, y: number, docX: number, docY: number) {
  const a = clamp(opacity, 0, 1);
  if (a <= 0) return;
  const native = NATIVE_BLEND[mode];
  if (native) {
    dst.globalCompositeOperation = native;
    dst.globalAlpha = a;
    dst.drawImage(srcC, x, y);
    resetCtx(dst);
    return;
  }
  const w = srcC.width, h = srcC.height;
  const d = dst.getImageData(x, y, w, h);
  blendPixels(d.data, ctx2d(srcC).getImageData(0, 0, w, h).data, mode, a, w, docX + x, docY + y);
  dst.putImageData(d, x, y);
}

/** Bounding box of pixels with alpha > 0 (src = RGBA pixels as little-endian uint32). */
function alphaBox(d: Uint32Array, w: number, h: number): Box | null {
  const T = 0xffffff;
  let y0 = 0;
  top: for (; y0 < h; y0++) {
    const o = y0 * w;
    for (let x = 0; x < w; x++) if (d[o + x] > T) break top;
  }
  if (y0 >= h) return null;
  let y1 = h - 1;
  bottom: for (; y1 > y0; y1--) {
    const o = y1 * w;
    for (let x = 0; x < w; x++) if (d[o + x] > T) break bottom;
  }
  let x0 = w, x1 = -1;
  for (let y = y0; y <= y1; y++) {
    const o = y * w;
    for (let x = 0; x < x0; x++) if (d[o + x] > T) { x0 = x; break; }
    for (let x = w - 1; x > x1; x--) if (d[o + x] > T) { x1 = x; break; }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Content colors made fully opaque inside the bbox (backdrop for exact clipped blending). */
function makeOpaque(src: Uint32Array, bw: number, bb: Box, ww: number, wh: number, ml: number, mt: number): HTMLCanvasElement {
  const c = scratch('opaque', ww, wh);
  const id = new ImageData(bb.w, bb.h), d = new Uint32Array(id.data.buffer);
  for (let y = 0; y < bb.h; y++) {
    const so = (bb.y + y) * bw + bb.x, dof = y * bb.w;
    for (let x = 0; x < bb.w; x++) d[dof + x] = src[so + x] | 0xff000000;
  }
  ctx2d(c).putImageData(id, ml, mt);
  return c;
}

// ---- Distance field ----
const BIG = 1e20;

/**
 * Signed distance (px) from each pixel of W to the content edge: negative inside, positive outside.
 * The 50% alpha contour is the edge; anti-aliased edge pixels place it with sub-pixel accuracy
 * (distance to the nearest seed minus that seed's own edge offset).
 */
function signedDistance(src: Uint32Array, bw: number, bb: Box, W: Box, needOut: boolean, needIn: boolean): Float32Array {
  const w = W.w, h = W.h, n = w * h;
  const a = new Uint8Array(n);
  for (let y = 0; y < bb.h; y++) {
    const so = (bb.y + y) * bw + bb.x, dof = (bb.y + y - W.y) * w + (bb.x - W.x);
    for (let x = 0; x < bb.w; x++) a[dof + x] = src[so + x] >>> 24;
  }
  // Is pixel i next to a pixel on the other side of the 50% contour? (W has a transparent rim)
  const edge = (i: number, inside: boolean) => {
    const t = (j: number) => (a[j] >= 128) !== inside;
    return t(i - 1) || t(i + 1) || t(i - w) || t(i + w);
  };
  const sd = new Float32Array(n);
  for (let i = 0; i < n; i++) sd[i] = 0.5 - a[i] / 255;
  const interior = (i: number) => { const x = i % w, y = (i / w) | 0; return x > 0 && y > 0 && x < w - 1 && y < h - 1; };
  if (needOut) {
    // Seeds: inside pixels + anti-aliased pixels just outside the contour
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = a[i] >= 128 || (a[i] > 0 && interior(i) && edge(i, false)) ? 0 : BIG;
    const near = edt(g, w, h);
    for (let i = 0; i < n; i++) if (a[i] < 128 && g[i] > 0) sd[i] = near[i] < 0 ? BIG : Math.sqrt(g[i]) + 0.5 - a[near[i]] / 255;
  }
  if (needIn) {
    // Seeds: outside pixels + anti-aliased pixels just inside the contour
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = a[i] < 128 || (a[i] < 255 && interior(i) && edge(i, true)) ? 0 : BIG;
    const near = edt(g, w, h);
    for (let i = 0; i < n; i++) if (a[i] >= 128 && g[i] > 0) sd[i] = near[i] < 0 ? -BIG : 0.5 - a[near[i]] / 255 - Math.sqrt(g[i]);
  }
  return sd;
}

/** White canvas whose alpha is the coverage of {sd <= r} (r > 0 grows, r < 0 shrinks). */
function coverageCanvas(sd: Float32Array, w: number, h: number, r: number): HTMLCanvasElement {
  const c = scratch('morph', w, h);
  const id = new ImageData(w, h), d = new Uint32Array(id.data.buffer);
  const k = r + 0.5;
  for (let i = 0; i < d.length; i++) {
    const v = k - sd[i];
    d[i] = v <= 0 ? 0 : v >= 1 ? 0xffffffff : ((((v * 255) | 0) << 24) | 0xffffff) >>> 0;
  }
  ctx2d(c).putImageData(id, 0, 0);
  return c;
}

/**
 * In-place squared Euclidean distance transform (Felzenszwalb & Huttenlocher) of `g` (seeds 0, others BIG).
 * Returns the flat index of each pixel's nearest seed (-1 when there is none).
 */
function edt(g: Float32Array, w: number, h: number): Int32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), arg = new Int32Array(n);
  const rowOf = new Int32Array(w * h).fill(-1); // column pass: nearest seed row
  for (let x = 0; x < w; x++) {
    let seed = false;
    for (let y = 0, i = x; y < h; y++, i += w) { f[y] = g[i]; if (f[y] === 0) seed = true; }
    if (!seed) continue; // column stays at BIG
    edt1d(f, d, v, z, arg, h);
    for (let y = 0, i = x; y < h; y++, i += w) { g[i] = d[y]; rowOf[i] = arg[y]; }
  }
  const near = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = g[o + x];
    edt1d(f, d, v, z, arg, w);
    for (let x = 0; x < w; x++) {
      g[o + x] = d[x];
      const ry = rowOf[o + arg[x]];
      near[o + x] = ry < 0 ? -1 : ry * w + arg[x];
    }
  }
  return near;
}
function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, arg: Int32Array, n: number) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let p = v[k];
    let s = (fq - (f[p] + p * p)) / (2 * (q - p));
    while (s <= z[k]) {
      k--;
      p = v[k];
      s = (fq - (f[p] + p * p)) / (2 * (q - p));
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k], dq = q - p;
    d[q] = dq * dq + f[p];
    arg[q] = p;
  }
}

// ---- Gradient overlay ----

/** Gradient spanning the content bbox (w×h) like Photoshop's "Align with Layer". */
function gradientFill(go: GradientOverlay, w: number, h: number): HTMLCanvasElement {
  const th = (go.angle * Math.PI) / 180, ux = Math.cos(th), uy = -Math.sin(th);
  const half = ((Math.abs(w * ux) + Math.abs(h * uy)) / 2) * Math.max(0.01, go.scale / 100);
  const cx = w / 2, cy = h / 2;
  const lin = go.style === 'linear';
  const x0 = lin ? cx - ux * half : cx, y0 = lin ? cy - uy * half : cy;
  const x1 = cx + ux * half, y1 = cy + uy * half;
  const c = scratch('grad', w, h), x = ctx2d(c);
  const g = canvasGradient(x, go.gradient, go.style, x0, y0, x1, y1, go.reverse);
  if (g) {
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
  } else {
    x.drawImage(renderGradient(go.gradient, go.style, x0, y0, x1, y1, w, h, go.reverse), 0, 0);
  }
  return c;
}

/** GPU gradient for linear / radial / reflected styles (null for styles that need the software renderer). */
function canvasGradient(x: CanvasRenderingContext2D, gr: Gradient, style: GradientStyle, x0: number, y0: number, x1: number, y1: number, reverse: boolean): CanvasGradient | null {
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  let g: CanvasGradient;
  if (style === 'linear') g = x.createLinearGradient(x0, y0, x1, y1);
  else if (style === 'radial') g = x.createRadialGradient(x0, y0, 0, x0, y0, len);
  else if (style === 'reflected') g = x.createLinearGradient(2 * x0 - x1, 2 * y0 - y1, x1, y1);
  else return null;
  if (!gr.stops.length) return g;
  // Stops in ascending offset order (ties keep their order, so hard edges survive reversing)
  const sorted = [...gr.stops].sort((a, b) => a.pos - b.pos);
  if (reverse) sorted.reverse();
  const ts = sorted.map((s) => ({ t: clamp(reverse ? 1 - s.pos : s.pos, 0, 1), c: cssColor(s.color, s.opacity) }));
  if (style === 'reflected') {
    for (let i = ts.length - 1; i >= 0; i--) g.addColorStop(0.5 - ts[i].t / 2, ts[i].c);
    for (const s of ts) g.addColorStop(0.5 + s.t / 2, s.c);
  } else {
    for (const s of ts) g.addColorStop(s.t, s.c);
  }
  return g;
}
