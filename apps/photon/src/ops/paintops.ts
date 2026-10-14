import { Doc } from '../core/document';
import { BlendMode } from '../core/layer';
import { NATIVE_BLEND, blendPixels } from '../core/blend';
import { createCanvas, ctx2d, RGB, luminance } from '../core/util';
import { PixelTarget } from './target';

/** Average color around (x,y) in doc coords. size = 1 (point), 3, 5, 11, 31, 51, 101. */
export function sampleColor(doc: Doc, x: number, y: number, size = 1, allLayers = true): RGB | null {
  const px = Math.floor(x), py = Math.floor(y);
  if (px < 0 || py < 0 || px >= doc.width || py >= doc.height) return null;
  const r = Math.floor(size / 2);
  const x0 = Math.max(0, px - r), y0 = Math.max(0, py - r);
  const w = Math.min(doc.width, px + r + 1) - x0, h = Math.min(doc.height, py + r + 1) - y0;
  let src: HTMLCanvasElement = doc.composite;
  let ox = 0, oy = 0;
  if (!allLayers) {
    const L = doc.active;
    if (!L || L.kind === 'adjustment') return null;
    src = L.canvas; ox = L.x; oy = L.y;
  }
  const d = ctx2d(src).getImageData(x0 - ox, y0 - oy, w, h).data;
  let R = 0, G = 0, B = 0, A = 0;
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; R += d[i] * a; G += d[i + 1] * a; B += d[i + 2] * a; A += a; }
  if (A <= 0) return allLayers ? { r: 255, g: 255, b: 255 } : null;
  return { r: Math.round(R / A), g: Math.round(G / A), b: Math.round(B / A) };
}

/**
 * Composite `src` (same size/coords as the target canvas) into a copy of the target,
 * through the selection, honoring lock transparency and mask (alpha) targets.
 */
export function paintOnto(doc: Doc, t: PixelTarget, src: HTMLCanvasElement, opacity = 1, blend: BlendMode | 'behind' | 'clear' = 'normal'): HTMLCanvasElement {
  const out = createCanvas(t.canvas.width, t.canvas.height);
  const ox = ctx2d(out);
  ox.drawImage(t.canvas, 0, 0);
  let paint = src;
  if (doc.selection && t.kind !== 'quickmask') {
    paint = createCanvas(src.width, src.height);
    const px = ctx2d(paint);
    px.drawImage(src, 0, 0);
    px.globalCompositeOperation = 'destination-in';
    px.drawImage(doc.selection, -t.x, -t.y);
  }
  if (t.alphaOnly) {
    // src luminance*alpha is the gray value to paint
    const g = toGrayAlpha(paint);
    ox.globalAlpha = opacity;
    ox.globalCompositeOperation = 'destination-out';
    ox.drawImage(g.cover, 0, 0);
    ox.globalCompositeOperation = 'lighter';
    ox.drawImage(g.value, 0, 0);
    return out;
  }
  ox.globalAlpha = opacity;
  if (t.lockAlpha) ox.globalCompositeOperation = 'source-atop';
  else if (blend === 'behind') ox.globalCompositeOperation = 'destination-over';
  else if (blend === 'clear') ox.globalCompositeOperation = 'destination-out';
  else if (NATIVE_BLEND[blend]) ox.globalCompositeOperation = NATIVE_BLEND[blend]!;
  else {
    const dst = ox.getImageData(0, 0, out.width, out.height);
    blendPixels(dst.data, ctx2d(paint).getImageData(0, 0, out.width, out.height).data, blend, opacity, out.width);
    ox.putImageData(dst, 0, 0);
    return out;
  }
  ox.drawImage(paint, 0, 0);
  return out;
}

/** Split a colored canvas into coverage (alpha) and luminance-weighted value canvases for mask painting. */
function toGrayAlpha(c: HTMLCanvasElement) {
  const id = ctx2d(c).getImageData(0, 0, c.width, c.height);
  const cov = new ImageData(c.width, c.height), val = new ImageData(c.width, c.height);
  for (let i = 0; i < id.data.length; i += 4) {
    const a = id.data[i + 3];
    cov.data[i + 3] = a;
    val.data[i + 3] = (luminance(id.data[i], id.data[i + 1], id.data[i + 2]) / 255) * a;
  }
  const cover = createCanvas(c.width, c.height), value = createCanvas(c.width, c.height);
  ctx2d(cover).putImageData(cov, 0, 0);
  ctx2d(value).putImageData(val, 0, 0);
  return { cover, value };
}

/** Solid-color canvas the size of the target. */
export function solidFor(t: PixelTarget, color: RGB): HTMLCanvasElement {
  const c = createCanvas(t.canvas.width, t.canvas.height);
  const x = ctx2d(c);
  x.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}
