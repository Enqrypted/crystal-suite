// Healing: texture from a source area + smooth color correction interpolated from the
// boundary (pull-push membrane), the same idea Photoshop's healing brush is built on.
import { Rect } from './util';

/** Fill unknown samples (weight 0) by pyramid pull-push interpolation. `vals` has `ch` channels. */
export function pullPush(vals: Float32Array, weight: Float32Array, w: number, h: number, ch = 3): Float32Array {
  const levels: { v: Float32Array; wt: Float32Array; w: number; h: number }[] = [];
  let cv = new Float32Array(vals.length), cw = new Float32Array(weight);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < ch; c++) cv[i * ch + c] = vals[i * ch + c] * weight[i];
  let cwid = w, chei = h;
  levels.push({ v: cv, wt: cw, w, h });
  // pull: downsample sums
  while (cwid > 1 || chei > 1) {
    const nw = Math.max(1, Math.ceil(cwid / 2)), nh = Math.max(1, Math.ceil(chei / 2));
    const nv = new Float32Array(nw * nh * ch), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < chei; y++) for (let x = 0; x < cwid; x++) {
      const i = y * cwid + x, j = (y >> 1) * nw + (x >> 1);
      nwt[j] += cw[i];
      for (let c = 0; c < ch; c++) nv[j * ch + c] += cv[i * ch + c];
    }
    // normalise so weights saturate at 1 (premultiplied values)
    for (let j = 0; j < nw * nh; j++) {
      const s = nwt[j];
      if (s > 1) { for (let c = 0; c < ch; c++) nv[j * ch + c] /= s; nwt[j] = 1; }
    }
    levels.push({ v: nv, wt: nwt, w: nw, h: nh });
    cv = nv; cw = nwt; cwid = nw; chei = nh;
  }
  // push: fill from coarse to fine
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], P = levels[l + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x;
      const wv = L.wt[i];
      if (wv >= 1) continue;
      // bilinear sample of parent (premultiplied)
      const fx = Math.min(P.w - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(P.h - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(P.w - 1, x0 + 1), y1 = Math.min(P.h - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      const k00 = (1 - ax) * (1 - ay), k10 = ax * (1 - ay), k01 = (1 - ax) * ay, k11 = ax * ay;
      const pw = P.wt[y0 * P.w + x0] * k00 + P.wt[y0 * P.w + x1] * k10 + P.wt[y1 * P.w + x0] * k01 + P.wt[y1 * P.w + x1] * k11;
      if (pw <= 0) continue;
      for (let c = 0; c < ch; c++) {
        const pv = P.v[(y0 * P.w + x0) * ch + c] * k00 + P.v[(y0 * P.w + x1) * ch + c] * k10 + P.v[(y1 * P.w + x0) * ch + c] * k01 + P.v[(y1 * P.w + x1) * ch + c] * k11;
        L.v[i * ch + c] = L.v[i * ch + c] + (1 - wv) * (pv / pw);
      }
      L.wt[i] = 1;
    }
  }
  const out = new Float32Array(w * h * ch);
  const L0 = levels[0];
  for (let i = 0; i < w * h; i++) {
    const wt = L0.wt[i] || 1;
    for (let c = 0; c < ch; c++) out[i * ch + c] = L0.v[i * ch + c] / wt;
  }
  return out;
}

/**
 * Heal: result = src + membrane(dst - src) inside mask, blended by mask.
 * dst/src are same-size RGBA regions, mask 0..1 per pixel.
 */
export function healRegion(dst: ImageData, src: ImageData, mask: Float32Array): ImageData {
  const w = dst.width, h = dst.height, n = w * h;
  const diff = new Float32Array(n * 4), known = new Float32Array(n);
  const dd = dst.data, sd = src.data;
  for (let i = 0; i < n; i++) {
    const k = mask[i] > 0.02 ? 0 : 1;
    known[i] = k;
    if (k) for (let c = 0; c < 4; c++) diff[i * 4 + c] = dd[i * 4 + c] - sd[i * 4 + c];
  }
  const corr = pullPush(diff, known, w, h, 4);
  const out = new ImageData(w, h);
  const od = out.data;
  for (let i = 0; i < n; i++) {
    const m = mask[i];
    for (let c = 0; c < 4; c++) {
      const healed = sd[i * 4 + c] + corr[i * 4 + c];
      od[i * 4 + c] = dd[i * 4 + c] * (1 - m) + healed * m;
    }
  }
  return out;
}

/**
 * Choose the best source offset for spot healing: compare a ring of pixels around the mask
 * with the same ring displaced in 16 directions at a few distances.
 * img covers `area` (region+margin), mask is in region coords at (rx, ry) inside img.
 */
export function findHealOffset(img: ImageData, rx: number, ry: number, rw: number, rh: number, mask: Float32Array): { dx: number; dy: number } {
  const W = img.width, H = img.height, d = img.data;
  // ring = unmasked pixels within the region whose neighbour is masked
  const ring: number[] = [];
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = y * rw + x;
    if (mask[i] > 0.02) continue;
    const nb = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < rw && yy < rh && mask[yy * rw + xx] > 0.02;
    if (nb(x - 2, y) || nb(x + 2, y) || nb(x, y - 2) || nb(x, y + 2)) ring.push(x, y);
  }
  if (!ring.length) return { dx: rw, dy: 0 };
  const step = Math.max(1, Math.floor(ring.length / 2 / 400)) * 2;
  const base = Math.max(rw, rh);
  let best = { dx: base, dy: 0 }, bestErr = Infinity;
  for (const dist of [1.05, 1.4, 2]) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const dx = Math.round(Math.cos(ang) * base * dist), dy = Math.round(Math.sin(ang) * base * dist);
      // whole source region must be inside the image
      if (rx + dx < 0 || ry + dy < 0 || rx + dx + rw > W || ry + dy + rh > H) continue;
      let err = 0;
      for (let k = 0; k < ring.length; k += step) {
        const x = ring[k] + rx, y = ring[k + 1] + ry;
        const i = (y * W + x) * 4, j = ((y + dy) * W + x + dx) * 4;
        const e0 = d[i] - d[j], e1 = d[i + 1] - d[j + 1], e2 = d[i + 2] - d[j + 2];
        err += e0 * e0 + e1 * e1 + e2 * e2;
      }
      // prefer texture similarity inside too: variance of source interior close to ring variance
      err *= 1 + dist * 0.08;
      if (err < bestErr) { bestErr = err; best = { dx, dy }; }
    }
  }
  return best;
}

/** Spot-heal `mask` (region coords) inside canvas pixels. Returns healed ImageData for region r. */
export function spotHeal(ctx: CanvasRenderingContext2D, cw: number, ch: number, r: Rect, mask: Float32Array): ImageData {
  const margin = Math.max(r.w, r.h) * 2 + 8;
  const ax = Math.max(0, Math.floor(r.x - margin)), ay = Math.max(0, Math.floor(r.y - margin));
  const ax2 = Math.min(cw, Math.ceil(r.x + r.w + margin)), ay2 = Math.min(ch, Math.ceil(r.y + r.h + margin));
  const area = ctx.getImageData(ax, ay, ax2 - ax, ay2 - ay);
  const rx = r.x - ax, ry = r.y - ay;
  const { dx, dy } = findHealOffset(area, rx, ry, r.w, r.h, mask);
  const dst = ctx.getImageData(r.x, r.y, r.w, r.h);
  const sx = Math.max(0, Math.min(cw - r.w, r.x + dx)), sy = Math.max(0, Math.min(ch - r.h, r.y + dy));
  const src = ctx.getImageData(sx, sy, r.w, r.h);
  return healRegion(dst, src, mask);
}
