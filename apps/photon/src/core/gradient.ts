import { Gradient, GradientStyle } from './layer';
import { createCanvas, ctx2d, RGB, cssColor, clamp } from './util';

const g = (name: string, stops: [number, string, number?][]): Gradient => ({
  name,
  stops: stops.map(([pos, hex, opacity]) => ({ pos, color: hexRGB(hex), opacity: opacity ?? 1 })),
});
function hexRGB(h: string): RGB { const n = parseInt(h.replace('#', ''), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }

/** Built-in presets; 'Foreground to Background' etc. are generated from current colors. */
export const GRADIENT_PRESETS: Gradient[] = [
  g('Black, White', [[0, '#000000'], [1, '#ffffff']]),
  g('Spectrum', [[0, '#ff0000'], [0.17, '#ffff00'], [0.33, '#00ff00'], [0.5, '#00ffff'], [0.67, '#0000ff'], [0.83, '#ff00ff'], [1, '#ff0000']]),
  g('Sunset', [[0, '#2b1055'], [0.5, '#d53369'], [1, '#ffcc70']]),
  g('Ocean', [[0, '#003973'], [1, '#e5e5be']]),
  g('Copper', [[0, '#7a3b14'], [0.4, '#e8a46a'], [0.6, '#f6d1a6'], [1, '#5e2a0f']]),
  g('Chrome', [[0, '#2a2a2a'], [0.45, '#f2f2f2'], [0.5, '#585858'], [0.75, '#c8c8c8'], [1, '#3a3a3a']]),
  g('Violet, Orange', [[0, '#5b247a'], [1, '#ff8a00']]),
  g('Blue, Red, Yellow', [[0, '#0a2bff'], [0.5, '#ff1d1d'], [1, '#fff200']]),
  g('Teal, Pink', [[0, '#12c2e9'], [0.5, '#c471ed'], [1, '#f64f59']]),
  g('Green, Lime', [[0, '#134e5e'], [1, '#71b280']]),
  g('Gold', [[0, '#8a6e2f'], [0.5, '#f8e08e'], [1, '#8a6e2f']]),
  g('Transparent Rainbow', [[0, '#ff0000', 0], [0.2, '#ff0000'], [0.4, '#ffff00'], [0.6, '#00ff00'], [0.8, '#0000ff'], [1, '#ff00ff', 0]]),
];

export function fgBgGradient(fg: RGB, bg: RGB): Gradient {
  return { name: 'Foreground to Background', stops: [{ pos: 0, color: fg, opacity: 1 }, { pos: 1, color: bg, opacity: 1 }] };
}
export function fgTransparentGradient(fg: RGB): Gradient {
  return { name: 'Foreground to Transparent', stops: [{ pos: 0, color: fg, opacity: 1 }, { pos: 1, color: fg, opacity: 0 }] };
}

/** 256-entry RGBA lookup table. */
export function gradientLUT(gr: Gradient, reverse = false, n = 256): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(n * 4);
  const stops = [...gr.stops].sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < n; i++) {
    let t = i / (n - 1);
    if (reverse) t = 1 - t;
    let a = stops[0], b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) if (t >= stops[k].pos && t <= stops[k + 1].pos) { a = stops[k]; b = stops[k + 1]; break; }
    if (t <= stops[0].pos) { a = b = stops[0]; }
    if (t >= stops[stops.length - 1].pos) { a = b = stops[stops.length - 1]; }
    const f = b.pos > a.pos ? (t - a.pos) / (b.pos - a.pos) : 0;
    lut[i * 4] = a.color.r + (b.color.r - a.color.r) * f;
    lut[i * 4 + 1] = a.color.g + (b.color.g - a.color.g) * f;
    lut[i * 4 + 2] = a.color.b + (b.color.b - a.color.b) * f;
    lut[i * 4 + 3] = (a.opacity + (b.opacity - a.opacity) * f) * 255;
  }
  return lut;
}

export function gradientCss(gr: Gradient, angle = 90): string {
  const stops = [...gr.stops].sort((a, b) => a.pos - b.pos).map((s) => `${cssColor(s.color, s.opacity)} ${(s.pos * 100).toFixed(1)}%`);
  return `linear-gradient(${angle}deg, ${stops.join(', ')})`;
}

export function gradientSwatch(gr: Gradient, w = 120, h = 20): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const x = ctx2d(c);
  for (let yy = 0; yy < h; yy += 5) for (let xx = 0; xx < w; xx += 5) { x.fillStyle = ((xx + yy) / 5) % 2 ? '#ccc' : '#fff'; x.fillRect(xx, yy, 5, 5); }
  const lg = x.createLinearGradient(0, 0, w, 0);
  for (const s of gr.stops) lg.addColorStop(clamp(s.pos, 0, 1), cssColor(s.color, s.opacity));
  x.fillStyle = lg;
  x.fillRect(0, 0, w, h);
  return c;
}

/**
 * Render a gradient into a w×h canvas from (x0,y0) to (x1,y1) — the Gradient tool drag line.
 * Supports Photoshop's five styles. Dithered to avoid banding.
 */
export function renderGradient(gr: Gradient, style: GradientStyle, x0: number, y0: number, x1: number, y1: number, w: number, h: number, reverse = false, dither = true): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const x = ctx2d(c);
  const lut = gradientLUT(gr, reverse, 1024);
  const img = x.createImageData(w, h);
  const d = img.data;
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1, len = Math.sqrt(len2);
  const ang0 = Math.atan2(dy, dx);
  const cos = dx / len, sin = dy / len;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const rx = px + 0.5 - x0, ry = py + 0.5 - y0;
      let t: number;
      switch (style) {
        case 'linear': t = (rx * dx + ry * dy) / len2; break;
        case 'radial': t = Math.sqrt(rx * rx + ry * ry) / len; break;
        case 'angle': { let a = Math.atan2(ry, rx) - ang0; a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); t = 1 - a / (2 * Math.PI); break; }
        case 'reflected': t = Math.abs((rx * dx + ry * dy) / len2); break;
        case 'diamond': { const u = Math.abs(rx * cos + ry * sin), v = Math.abs(-rx * sin + ry * cos); t = Math.max(u, v) / len; break; }
        default: t = 0;
      }
      if (dither) t += (((px * 7 + py * 13) % 16) / 16 - 0.5) / 1024;
      const i = Math.round(clamp(t, 0, 1) * 1023) * 4, o = (py * w + px) * 4;
      d[o] = lut[i]; d[o + 1] = lut[i + 1]; d[o + 2] = lut[i + 2]; d[o + 3] = lut[i + 3];
    }
  }
  x.putImageData(img, 0, 0);
  return c;
}
