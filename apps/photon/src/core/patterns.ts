// Patterns: the built-in set plus the ones you make with Edit > Define Pattern. Used by Edit > Fill,
// Pattern fill layers, the Pattern Overlay layer style and the Pattern Stamp tool.
//
// A pattern travels inside the document that uses it (layer fills and styles store the whole Pattern value),
// so files open the same everywhere. Pixels are kept as a PNG data URL; decoding is asynchronous, so the
// first render after opening a file may lack a pattern for a moment — `onPatternReady` repaints then.
import { createCanvas, ctx2d } from './util';

export interface Pattern { id: string; name: string; w: number; h: number; data: string }

const STORE_KEY = 'photon.patterns.v1';
/** Patterns bigger than this are scaled down when defined (they live in the browser's storage). */
export const MAX_PATTERN = 1024;

// ---------- built-ins (drawn once, on first use) ----------
type Painter = (x: CanvasRenderingContext2D, s: number) => void;
const BUILT_IN: [id: string, name: string, size: number, paint: Painter][] = [
  ['b-checker', 'Checkerboard', 32, (x, s) => { x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.fillStyle = '#c8c8c8'; x.fillRect(0, 0, s / 2, s / 2); x.fillRect(s / 2, s / 2, s / 2, s / 2); }],
  ['b-dots', 'Polka Dots', 24, (x, s) => { x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.fillStyle = '#2b2b2b'; x.beginPath(); x.arc(s / 4, s / 4, s / 8, 0, 7); x.arc((3 * s) / 4, (3 * s) / 4, s / 8, 0, 7); x.fill(); }],
  ['b-stripes', 'Stripes', 16, (x, s) => { x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.fillStyle = '#3a3a3a'; x.fillRect(0, 0, s, s / 2); }],
  ['b-diagonal', 'Diagonal Lines', 16, (x, s) => {
    x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.strokeStyle = '#3a3a3a'; x.lineWidth = s / 5;
    x.beginPath(); for (let k = -1; k <= 1; k++) { x.moveTo(k * s, s); x.lineTo(k * s + s, 0); } x.stroke();
  }],
  ['b-grid', 'Grid', 32, (x, s) => { x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.fillStyle = '#9a9a9a'; x.fillRect(0, 0, s, 1); x.fillRect(0, 0, 1, s); }],
  ['b-bricks', 'Bricks', 48, (x, s) => {
    x.fillStyle = '#d8d3cc'; x.fillRect(0, 0, s, s); x.fillStyle = '#a5523a';
    const bh = s / 2 - 2;
    x.fillRect(1, 1, s - 2, bh); x.fillRect(-s / 2 + 1, s / 2 + 1, s - 2, bh); x.fillRect(s / 2 + 1, s / 2 + 1, s - 2, bh);
  }],
  ['b-weave', 'Weave', 32, (x, s) => {
    x.fillStyle = '#e9e2d4'; x.fillRect(0, 0, s, s); x.fillStyle = '#b9a98a';
    x.fillRect(0, 0, s / 2, s / 4); x.fillRect(s / 2, s / 4, s / 2, s / 4); x.fillRect(0, s / 2, s / 2, s / 4); x.fillRect(s / 2, (3 * s) / 4, s / 2, s / 4);
    x.fillStyle = '#8a7a5d'; x.fillRect(s / 4, 0, s / 4, s / 2); x.fillRect((3 * s) / 4, s / 2, s / 4, s / 2);
  }],
  ['b-noise', 'Noise', 64, (x, s) => {
    const id = x.createImageData(s, s);
    let seed = 7;
    for (let i = 0; i < id.data.length; i += 4) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const v = 96 + (seed % 128); id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    x.putImageData(id, 0, 0);
  }],
  ['b-canvas', 'Canvas', 64, (x, s) => {
    x.fillStyle = '#ece6da'; x.fillRect(0, 0, s, s);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < s; i += 2) {
      x.fillStyle = `rgba(120,105,80,${0.08 + rnd() * 0.12})`; x.fillRect(0, i, s, 1);
      x.fillStyle = `rgba(120,105,80,${0.06 + rnd() * 0.1})`; x.fillRect(i, 0, 1, s);
    }
  }],
];

let builtIns: Pattern[] | null = null;
function builtInPatterns(): Pattern[] {
  if (builtIns) return builtIns;
  builtIns = BUILT_IN.map(([id, name, s, paint]) => {
    const c = createCanvas(s, s);
    paint(ctx2d(c), s);
    const data = c.toDataURL('image/png');
    cache.set(data, c);
    return { id, name, w: s, h: s, data };
  });
  return builtIns;
}

// ---------- your patterns ----------
function loadUser(): Pattern[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(list) ? list.filter((p) => p && typeof p.data === 'string' && p.data.startsWith('data:image/')) : [];
  } catch { return []; }
}
function saveUser(list: Pattern[]): boolean {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

export function allPatterns(): Pattern[] { return [...builtInPatterns(), ...loadUser()]; }
let lastUsed: Pattern | null = null;
/** The pattern new pickers start on: the one picked or defined last (like Photoshop), else the first built-in. */
export const defaultPattern = (): Pattern => lastUsed ?? builtInPatterns()[0];
export function usePattern(p: Pattern) { lastUsed = p; }

/** Edit > Define Pattern: keeps `c` (scaled down if huge). Returns null when storage is full. */
export function addPattern(name: string, c: HTMLCanvasElement): Pattern | null {
  let src = c;
  const k = Math.min(1, MAX_PATTERN / Math.max(c.width, c.height));
  if (k < 1) {
    src = createCanvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
    const x = ctx2d(src);
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, 0, 0, src.width, src.height);
  }
  const data = src.toDataURL('image/png');
  const p: Pattern = { id: `u-${Date.now().toString(36)}`, name: name || 'Pattern', w: src.width, h: src.height, data };
  cache.set(data, src);
  const list = loadUser();
  list.push(p);
  return saveUser(list) ? p : null;
}
export function deletePattern(id: string) {
  saveUser(loadUser().filter((p) => p.id !== id));
  if (lastUsed?.id === id) lastUsed = null;
}
export const isUserPattern = (p: Pattern) => p.id.startsWith('u-');

// ---------- pixels ----------
const cache = new Map<string, HTMLCanvasElement>();
const loading = new Map<string, Promise<HTMLCanvasElement | null>>();
const readyListeners = new Set<() => void>();

/** Called when a pattern used by an open document finishes decoding (the document repaints). */
export function onPatternReady(fn: () => void) { readyListeners.add(fn); }

function decode(p: Pattern): Promise<HTMLCanvasElement | null> {
  let pr = loading.get(p.data);
  if (pr) return pr;
  pr = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = createCanvas(img.naturalWidth || p.w, img.naturalHeight || p.h);
      ctx2d(c).drawImage(img, 0, 0);
      cache.set(p.data, c);
      resolve(c);
      readyListeners.forEach((f) => f());
    };
    img.onerror = () => resolve(null);
    img.src = p.data;
  });
  loading.set(p.data, pr);
  return pr;
}

/** The pattern's pixels, or null while they decode (a repaint follows). */
export function patternCanvas(p: Pattern | null | undefined): HTMLCanvasElement | null {
  if (!p?.data) return null;
  const c = cache.get(p.data);
  if (c) return c;
  void decode(p);
  return null;
}
export function loadPattern(p: Pattern): Promise<HTMLCanvasElement | null> {
  const c = cache.get(p.data);
  return c ? Promise.resolve(c) : decode(p);
}

/**
 * `w`×`h` canvas tiled with the pattern at `scale` (1 = 100%), the tile origin at (ox, oy) in the canvas.
 * Null while the pattern decodes.
 */
export function tiledPattern(p: Pattern, w: number, h: number, scale = 1, ox = 0, oy = 0): HTMLCanvasElement | null {
  const tile = patternCanvas(p);
  if (!tile) return null;
  const c = createCanvas(Math.max(1, w), Math.max(1, h));
  const x = ctx2d(c);
  const fill = x.createPattern(tile, 'repeat');
  if (!fill) return c;
  const s = Math.max(0.01, scale);
  fill.setTransform(new DOMMatrix().translate(ox, oy).scale(s));
  x.fillStyle = fill;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Small preview of a pattern for pickers. */
export function patternSwatch(p: Pattern, size = 32): HTMLCanvasElement {
  const c = createCanvas(size, size);
  const tile = patternCanvas(p);
  const draw = (t: HTMLCanvasElement) => {
    const x = ctx2d(c);
    x.clearRect(0, 0, size, size);
    const s = Math.min(1, (size * 1.5) / Math.max(t.width, t.height));
    const fill = x.createPattern(t, 'repeat');
    if (!fill) return;
    fill.setTransform(new DOMMatrix().scale(s));
    x.fillStyle = fill;
    x.fillRect(0, 0, size, size);
  };
  if (tile) draw(tile); else void loadPattern(p).then((t) => t && draw(t));
  return c;
}
