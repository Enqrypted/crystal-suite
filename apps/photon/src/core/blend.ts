import { BlendMode } from './layer';

/** Blend modes the canvas implements natively (fast GPU path). */
export const NATIVE_BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: 'source-over',
  darken: 'darken', multiply: 'multiply', 'color-burn': 'color-burn',
  lighten: 'lighten', screen: 'screen', 'color-dodge': 'color-dodge', 'linear-dodge': 'lighter',
  overlay: 'overlay', 'soft-light': 'soft-light', 'hard-light': 'hard-light',
  difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

type Sep = (b: number, s: number) => number; // channel values 0..1

const SEPARABLE: Partial<Record<BlendMode, Sep>> = {
  'linear-burn': (b, s) => Math.max(0, b + s - 1),
  'vivid-light': (b, s) => (s <= 0.5 ? (s <= 0 ? 0 : Math.max(0, 1 - (1 - b) / (2 * s))) : s >= 1 ? 1 : Math.min(1, b / (2 * (1 - s)))),
  'linear-light': (b, s) => Math.min(1, Math.max(0, b + 2 * s - 1)),
  'pin-light': (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  'hard-mix': (b, s) => (b + s >= 1 ? 1 : 0),
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s)),
  // fallbacks for completeness if ever needed in software
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  normal: (_b, s) => s,
};

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Software blend of `src` onto `dst` (both RGBA, unpremultiplied, same size).
 * Used for Photoshop modes the canvas lacks. Follows the W3C compositing model.
 */
export function blendPixels(dst: Uint8ClampedArray, src: Uint8ClampedArray, mode: BlendMode, opacity: number, w: number, ox = 0, oy = 0) {
  const sep = SEPARABLE[mode];
  const n = dst.length;
  for (let i = 0; i < n; i += 4) {
    let as = (src[i + 3] / 255) * opacity;
    if (as <= 0) continue;
    if (mode === 'dissolve') {
      const p = i >> 2;
      as = hash(ox + (p % w), oy + ((p / w) | 0)) < as ? 1 : 0;
      if (!as) continue;
    }
    const ab = dst[i + 3] / 255;
    const sr = src[i] / 255, sg = src[i + 1] / 255, sb = src[i + 2] / 255;
    const br = dst[i] / 255, bg = dst[i + 1] / 255, bb = dst[i + 2] / 255;
    let rr: number, rg: number, rb: number;
    if (sep) {
      rr = sep(br, sr); rg = sep(bg, sg); rb = sep(bb, sb);
    } else if (mode === 'darker-color') {
      if (lum(sr, sg, sb) < lum(br, bg, bb)) { rr = sr; rg = sg; rb = sb; } else { rr = br; rg = bg; rb = bb; }
    } else if (mode === 'lighter-color') {
      if (lum(sr, sg, sb) > lum(br, bg, bb)) { rr = sr; rg = sg; rb = sb; } else { rr = br; rg = bg; rb = bb; }
    } else { rr = sr; rg = sg; rb = sb; } // dissolve / normal
    const ao = as + ab * (1 - as);
    const k1 = as * (1 - ab), k2 = ab * (1 - as), k3 = as * ab;
    dst[i] = ((sr * k1 + br * k2 + rr * k3) / ao) * 255;
    dst[i + 1] = ((sg * k1 + bg * k2 + rg * k3) / ao) * 255;
    dst[i + 2] = ((sb * k1 + bb * k2 + rb * k3) / ao) * 255;
    dst[i + 3] = ao * 255;
  }
}
