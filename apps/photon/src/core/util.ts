// Shared helpers: geometry, canvases, colors, events.

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export interface RGB { r: number; g: number; b: number }
export interface RGBA extends RGB { a: number }

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---------- Rects ----------
export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
export const rectEmpty = (r: Rect | null | undefined) => !r || r.w <= 0 || r.h <= 0;
export function rectUnion(a: Rect | null, b: Rect | null): Rect | null {
  if (rectEmpty(a)) return b ? { ...b } : null;
  if (rectEmpty(b)) return a ? { ...a } : null;
  const x = Math.min(a!.x, b!.x), y = Math.min(a!.y, b!.y);
  return { x, y, w: Math.max(a!.x + a!.w, b!.x + b!.w) - x, h: Math.max(a!.y + a!.h, b!.y + b!.h) - y };
}
export function rectIntersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}
export function rectFromPoints(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
/** Expand to integer pixel boundaries. */
export function rectOut(r: Rect, pad = 0): Rect {
  const x = Math.floor(r.x - pad), y = Math.floor(r.y - pad);
  return { x, y, w: Math.ceil(r.x + r.w + pad) - x, h: Math.ceil(r.y + r.h + pad) - y };
}
export const rectContains = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

// ---------- Canvases ----------
export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d')!;
}
export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}
export function canvasFromImageData(id: ImageData): HTMLCanvasElement {
  const c = createCanvas(id.width, id.height);
  ctx2d(c).putImageData(id, 0, 0);
  return c;
}
export function getImageData(c: HTMLCanvasElement, r?: Rect): ImageData {
  const rr = r ?? { x: 0, y: 0, w: c.width, h: c.height };
  return ctx2d(c).getImageData(rr.x, rr.y, Math.max(1, rr.w), Math.max(1, rr.h));
}
/** Temporary canvases reused to avoid allocation churn during rendering. */
const pool: Record<string, HTMLCanvasElement> = {};
export function tempCanvas(key: string, w: number, h: number, clear = true): HTMLCanvasElement {
  let c = pool[key];
  if (!c) { c = pool[key] = createCanvas(w, h); }
  if (c.width < w || c.height < h) {
    c.width = Math.max(c.width, Math.ceil(w));
    c.height = Math.max(c.height, Math.ceil(h));
  } else if (clear) {
    const x = ctx2d(c);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'source-over';
    x.clearRect(0, 0, w, h);
  }
  const x = ctx2d(c);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.filter = 'none';
  return c;
}
/** Bounding rect of non-transparent pixels (alpha > threshold). */
export function alphaBounds(c: HTMLCanvasElement, threshold = 0): Rect | null {
  const { width: w, height: h } = c;
  const d = getImageData(c).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
let checkerPattern: HTMLCanvasElement | null = null;
export function checkerboard(size = 8, a = '#ffffff', b = '#cccccc'): HTMLCanvasElement {
  if (checkerPattern) return checkerPattern;
  const c = createCanvas(size * 2, size * 2);
  const x = ctx2d(c);
  x.fillStyle = a; x.fillRect(0, 0, size * 2, size * 2);
  x.fillStyle = b; x.fillRect(size, 0, size, size); x.fillRect(0, size, size, size);
  checkerPattern = c;
  return c;
}

/** Draw `src` padded with edge-extended pixels so blur filters don't fade at borders. */
export function edgePadded(src: HTMLCanvasElement, pad: number): HTMLCanvasElement {
  const w = src.width, h = src.height, p = Math.ceil(pad);
  const c = createCanvas(w + p * 2, h + p * 2);
  const x = ctx2d(c);
  x.imageSmoothingEnabled = false;
  x.drawImage(src, p, p);
  if (p > 0) {
    x.drawImage(src, 0, 0, w, 1, p, 0, w, p);               // top
    x.drawImage(src, 0, h - 1, w, 1, p, h + p, w, p);       // bottom
    x.drawImage(src, 0, 0, 1, h, 0, p, p, h);               // left
    x.drawImage(src, w - 1, 0, 1, h, w + p, p, p, h);       // right
    x.drawImage(src, 0, 0, 1, 1, 0, 0, p, p);
    x.drawImage(src, w - 1, 0, 1, 1, w + p, 0, p, p);
    x.drawImage(src, 0, h - 1, 1, 1, 0, h + p, p, p);
    x.drawImage(src, w - 1, h - 1, 1, 1, w + p, h + p, p, p);
  }
  return c;
}
/** Fast GPU gaussian blur (CSS filter) with edge extension. */
export function blurCanvas(src: HTMLCanvasElement, radius: number, edgeMode: 'extend' | 'transparent' = 'extend'): HTMLCanvasElement {
  const out = createCanvas(src.width, src.height);
  if (radius <= 0) { ctx2d(out).drawImage(src, 0, 0); return out; }
  const o = ctx2d(out);
  if (edgeMode === 'extend') {
    const pad = Math.ceil(radius * 3);
    const p = edgePadded(src, pad);
    o.filter = `blur(${radius}px)`;
    o.drawImage(p, -pad, -pad);
  } else {
    o.filter = `blur(${radius}px)`;
    o.drawImage(src, 0, 0);
  }
  o.filter = 'none';
  return out;
}

// ---------- Colors ----------
export const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });
export function rgbToHex({ r, g, b }: RGB): string {
  const h = (v: number) => Math.round(clamp255(v)).toString(16).padStart(2, '0');
  return h(r) + h(g) + h(b);
}
export function hexToRgb(hex: string): RGB | null {
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export const cssColor = (c: RGB, a = 1) => (a >= 1 ? `#${rgbToHex(c)}` : `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`);
export function parseCss(s: string): RGB {
  const hx = hexToRgb(s);
  if (hx) return hx;
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) { const [r, g, b] = m[1].split(',').map((v) => parseFloat(v)); return { r, g, b }; }
  return { r: 0, g: 0, b: 0 };
}
/** h 0-360, s/v 0-100 */
export function rgbToHsv({ r, g, b }: RGB) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? (d / max) * 100 : 0, v: max * 100 };
}
export function hsvToRgb(h: number, s: number, v: number): RGB {
  s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  const hh = ((h % 360) + 360) % 360;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
/** h 0-360, s/l 0-1 */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hue2rgb(p: number, q: number, t: number) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, hh = (((h % 360) + 360) % 360) / 360;
  return [hue2rgb(p, q, hh + 1 / 3) * 255, hue2rgb(p, q, hh) * 255, hue2rgb(p, q, hh - 1 / 3) * 255];
}
export function rgbToLab({ r, g, b }: RGB) {
  const f = (c: number) => { c /= 255; return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; };
  const R = f(r), G = f(g), B = f(b);
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const g3 = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = g3(X); Y = g3(Y); Z = g3(Z);
  return { l: 116 * Y - 16, a: 500 * (X - Y), b: 200 * (Y - Z) };
}
export function labToRgb(l: number, a: number, bb: number): RGB {
  let Y = (l + 16) / 116, X = a / 500 + Y, Z = Y - bb / 200;
  const g3 = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  X = g3(X) * 0.95047; Y = g3(Y); Z = g3(Z) * 1.08883;
  let R = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
  let G = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
  let B = X * 0.0557 + Y * -0.204 + Z * 1.057;
  const f = (c: number) => (c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c);
  return { r: Math.round(clamp255(f(R) * 255)), g: Math.round(clamp255(f(G) * 255)), b: Math.round(clamp255(f(B) * 255)) };
}
export function rgbToCmyk({ r, g, b }: RGB) {
  const R = r / 255, G = g / 255, B = b / 255, k = 1 - Math.max(R, G, B);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return { c: ((1 - R - k) / (1 - k)) * 100, m: ((1 - G - k) / (1 - k)) * 100, y: ((1 - B - k) / (1 - k)) * 100, k: k * 100 };
}
export function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  c /= 100; m /= 100; y /= 100; k /= 100;
  return { r: Math.round(255 * (1 - c) * (1 - k)), g: Math.round(255 * (1 - m) * (1 - k)), b: Math.round(255 * (1 - y) * (1 - k)) };
}
export const luminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

// ---------- Events ----------
type Handler = (...args: any[]) => void;
export class Emitter {
  private map = new Map<string, Set<Handler>>();
  on(ev: string, fn: Handler): () => void {
    let s = this.map.get(ev);
    if (!s) this.map.set(ev, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit(ev: string, ...args: any[]) {
    this.map.get(ev)?.forEach((fn) => {
      try { fn(...args); } catch (e) { console.error(`[event ${ev}]`, e); }
    });
  }
}

let _uid = 1;
export const uid = () => _uid++;

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: number | undefined;
  return ((...a: any[]) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); }) as T;
}
/** Run at most once per animation frame. */
export function rafThrottle<T extends (...a: any[]) => void>(fn: T): T {
  let pending = false, lastArgs: any[] = [];
  return ((...a: any[]) => {
    lastArgs = a;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; fn(...lastArgs); });
  }) as T;
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, quality));
}
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not decode image'));
    img.src = src;
  });
}
export const isMac = navigator.platform.toUpperCase().includes('MAC');
export const fmt = (n: number, d = 0) => (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toString();
