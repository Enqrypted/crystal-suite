// Image > Adjustments implementations (registered on import): pixel math + controls.
// apply() also runs on every re-composite under adjustment layers, so all lookup tables are
// memoized per params object (params are immutable values: a change always makes a new object).
import { registerAdjustment, AdjustUIContext } from './adjustments';
import { clamp, cssColor, ctx2d, hexToRgb, hslToRgb, RGB } from './util';
import { Gradient } from './layer';
import { GRADIENT_PRESETS, fgBgGradient, gradientLUT } from './gradient';
import { app } from '../app';
import { clear, h, injectStyle, onDrag } from '../ui/dom';
import { button, checkbox, colorSwatch, numberInput, Option, segmented, select, sliderField } from '../ui/widgets';

type P = any;
interface Api { get(): P; set(p: P, rebuild?: boolean): void }
type Body = (api: Api, ctx: AdjustUIContext) => HTMLElement;
interface Preset { name: string; p: () => P }
type V3 = [number, number, number];

const nv = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);

function memo<T>(build: (p: P) => T): (p: P) => T {
  const cache = new WeakMap<object, T>();
  return (p) => {
    if (!p || typeof p !== 'object') return build({});
    let v = cache.get(p);
    if (v === undefined) { v = build(p); cache.set(p, v); }
    return v;
  };
}

// ---------- LUT helpers ----------
function lutFrom(f: (v: number) => number): Uint8Array {
  const l = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { const v = Math.round(f(i)); l[i] = v > 0 ? (v > 255 ? 255 : v) : 0; }
  return l;
}
const IDENT = lutFrom((v) => v);
const identOr = (l: Uint8Array) => { for (let i = 0; i < 256; i++) if (l[i] !== i) return l; return IDENT; };

/** Apply per-channel 256-entry LUTs in place (alpha untouched). */
export function applyLuts(d: Uint8ClampedArray, lr: Uint8Array, lg: Uint8Array, lb: Uint8Array) {
  if (lr === IDENT && lg === IDENT && lb === IDENT) return;
  for (let i = 0, n = d.length; i < n; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; }
}
/** LUT mapping [lo, hi] to [0, 255], with gamma (>1 brightens). */
export function stretchLUT(lo: number, hi: number, gamma = 1): Uint8Array {
  const span = Math.max(1, hi - lo), ig = 1 / gamma;
  return identOr(lutFrom((v) => Math.pow(clamp((v - lo) / span, 0, 1), ig) * 255));
}

// ---------- Histograms ----------
export interface Histogram { r: Uint32Array; g: Uint32Array; b: Uint32Array; lum: Uint32Array; count: number }
export type HistChannel = 'r' | 'g' | 'b' | 'lum';

/** Histograms of the non-transparent pixels of RGBA data. */
export function computeHistogram(d: Uint8ClampedArray): Histogram {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), lum = new Uint32Array(256);
  let count = 0;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    const R = d[i], G = d[i + 1], B = d[i + 2];
    r[R]++; g[G]++; b[B]++; lum[(R * 77 + G * 150 + B * 29) >> 8]++;
    count++;
  }
  return { r, g, b, lum, count };
}
const histCache = new WeakMap<ImageData, Histogram>();
export function histogramOf(img: ImageData | null): Histogram | null {
  if (!img) return null;
  let hs = histCache.get(img);
  if (!hs) { hs = computeHistogram(img.data); histCache.set(img, hs); }
  return hs;
}
/** Lowest/highest level after clipping `clip` (fraction) of `total` pixels at each end. */
export function clipRange(hist: Uint32Array, total: number, clip = 0.001): [number, number] {
  const lim = total * clip;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) <= lim) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) <= lim) hi--;
  return hi - lo < 2 ? [0, 255] : [lo, hi];
}
/** Per-channel ranges for auto levels (Photoshop Auto Tone: 0.1% clip each side). */
export function autoRanges(d: Uint8ClampedArray, clip = 0.001) {
  const hs = computeHistogram(d);
  return { r: clipRange(hs.r, hs.count, clip), g: clipRange(hs.g, hs.count, clip), b: clipRange(hs.b, hs.count, clip), hist: hs };
}

const CH_COLOR: Record<string, string> = { r: '#e5484d', g: '#3fb950', b: '#3b82f6' };
const CH_PURE: Record<string, string> = { r: '#ff0000', g: '#00ff00', b: '#0000ff' };
const HUE_TRACK = 'linear-gradient(90deg, #f00, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00)';

function themeVar(el: Element | null, name: string, fb: string): string {
  const v = getComputedStyle(el && el.isConnected ? el : document.body).getPropertyValue(name).trim();
  return v || fb;
}
const histArr = (hs: Histogram | null, ch: HistChannel) => (hs ? hs[ch] : null);
/** Vertical scale ignoring the two tallest spikes (e.g. a flat white background). */
function histScale(a: Uint32Array): number {
  const s = Array.from(a).sort((x, y) => y - x);
  return Math.max(1, s[2] || s[0]);
}
function paintHist(c: HTMLCanvasElement, hs: Histogram | null, ch: HistChannel, w: number, hh: number) {
  if (c.width !== w) c.width = w;
  if (c.height !== hh) c.height = hh;
  const x = ctx2d(c);
  x.fillStyle = themeVar(c, '--input', '#252525');
  x.fillRect(0, 0, w, hh);
  const a = histArr(hs, ch);
  if (!a || !hs!.count) return;
  const mx = histScale(a), bw = w / 256;
  x.fillStyle = CH_COLOR[ch] ?? themeVar(c, '--text-2', '#a8a8a8');
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, a[i] / mx) * (hh - 2);
    if (v > 0) x.fillRect(i * bw, hh - v, bw + 0.6, v);
  }
}
/** Responsive histogram canvas (redraws on resize). */
function histView(hs: Histogram | null, ch: HistChannel) {
  const c = h('canvas', { class: 'adj-hist' });
  let channel = ch;
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    paintHist(c, hs, channel, Math.max(1, Math.round((c.clientWidth || 256) * dpr)), Math.max(1, Math.round((c.clientHeight || 90) * dpr)));
  };
  new ResizeObserver(draw).observe(c);
  draw();
  return { el: c, set(v: HistChannel) { channel = v; draw(); } };
}
/** Fixed-size histogram canvas of an image (class 'histogram'). */
export function histogramCanvas(src: ImageData | null, channel: HistChannel | 'rgb' = 'lum', width = 256, height = 100): HTMLCanvasElement {
  const c = h('canvas', { class: 'histogram' });
  paintHist(c, histogramOf(src), channel === 'rgb' ? 'lum' : channel, width, height);
  return c;
}

// ---------- UI scaffolding ----------
const CSS = `
.adj-ui { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.adj-ui .col { gap: 9px; min-width: 0; }
.adj-ui .row > .ps-select { flex: 1; min-width: 0; }
.adj-ui .check-row, .adj-ui .segmented { align-self: flex-start; }
.adj-preset .field-label, .adj-ui .row > .field-label { flex-shrink: 0; }
.adj-note { color: var(--text-2); padding: 10px 0; text-align: center; }
.adj-lv { display: flex; flex-direction: column; padding: 0 6px; }
.adj-hist { width: 100%; height: 90px; display: block; background: var(--input); border: 1px solid var(--input-border); }
.adj-track { position: relative; height: 12px; touch-action: none; }
.adj-handle { position: absolute; top: 1px; width: 11px; height: 10px; margin-left: -5.5px; line-height: 0; pointer-events: none; }
.adj-handle svg { display: block; overflow: visible; }
.adj-grad { height: 10px; border: 1px solid var(--input-border); }
.adj-nums { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.adj-nums .ps-input.num { width: 48px; }
.adj-curve { width: 100%; max-width: 256px; aspect-ratio: 1 / 1; align-self: center; }
.adj-curve canvas { width: 100%; height: 100%; display: block; cursor: crosshair; touch-action: none; outline: none; }
.adj-io { justify-content: center; gap: 8px; }
.adj-io .ps-input.num { width: 48px; }
.adj-specs { display: flex; flex-direction: column; gap: 3px; }
.adj-spec { width: 100%; height: 10px; display: block; border: 1px solid var(--input-border); }
.adj-range { height: 5px; border-radius: 1px; }
.adj-radio input { margin: 0; accent-color: var(--accent); }
.adj-pair .sf-top .field-label:last-child { text-align: right; }
.adj-total { color: var(--text-2); text-align: right; }
.adj-total.warn { color: var(--text-strong); font-weight: 600; }
.adj-gm { height: 22px; border: 1px solid var(--input-border); border-radius: 2px; }
.adj-pf { display: grid; grid-template-columns: auto 1fr; gap: 8px 8px; align-items: center; }
.adj-pf .ps-select { min-width: 0; width: 100%; }
`;

const uiMem: Record<string, Record<string, any>> = {};
const mem = (kind: string) => (uiMem[kind] ??= {});
let radioSeq = 0;

function deepEq(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]));
}

/** Build an AdjustmentDef.buildUI: optional Preset select on top + a body that can be rebuilt. */
function ui(kind: string, defaults: () => P, presets: Preset[] | null, body: Body) {
  return (params: P, onChange: (p: P) => void, ctx: AdjustUIContext): HTMLElement => {
    injectStyle('adjustments', CSS);
    let cur: P = params ?? defaults();
    const root = h('div', { class: `adj-ui adj-${kind}` });
    let psel: ReturnType<typeof select> | null = null;
    const syncPreset = () => {
      if (psel && presets) psel.set(deepEq(cur, defaults()) ? 'Default' : presets.find((x) => deepEq(cur, x.p()))?.name ?? 'Custom');
    };
    const api: Api = {
      get: () => cur,
      set: (p, rebuild = false) => { cur = p; onChange(p); syncPreset(); if (rebuild) render(); },
    };
    const render = () => {
      clear(root);
      if (presets) {
        psel = select({
          options: ['Default', ...presets.map((x) => x.name), '-', { value: 'Custom', label: 'Custom', disabled: true }],
          value: 'Default',
          onChange: (v) => { const pr = v === 'Default' ? defaults() : presets.find((x) => x.name === v)?.p(); if (pr) api.set(pr, true); },
        });
        root.appendChild(h('div', { class: 'row adj-preset' }, h('label', { class: 'field-label' }, 'Preset:'), psel.el));
        syncPreset();
      }
      root.appendChild(body(api, ctx));
    };
    render();
    return root;
  };
}

const col = (...c: (Node | null | false)[]) => h('div', { class: 'col' }, ...c);
const lbl = (t: string) => h('label', { class: 'field-label' }, t);
const note = (t: string) => () => h('div', { class: 'adj-note' }, t);

function sf(label: string, value: number, min: number, max: number, reset: number, onInput: (v: number) => void,
  o: { step?: number; decimals?: number; unit?: string; track?: string; width?: number } = {}) {
  return sliderField({ label, value, min, max, reset, inline: false, onInput, ...o });
}
/** Patch one key of the current params. */
const setKey = (api: Api, k: string, v: any, rebuild = false) => api.set({ ...api.get(), [k]: v }, rebuild);

function radio(group: string, label: string, checked: boolean, onPick: () => void): HTMLElement {
  const inp = h('input', { type: 'radio', name: group }) as HTMLInputElement;
  inp.checked = checked;
  inp.addEventListener('change', () => { if (inp.checked) onPick(); });
  return h('label', { class: 'check-row adj-radio' }, inp, h('span', null, label));
}

const tri = (fill: string) => `<svg width="11" height="10" viewBox="0 0 11 10"><path d="M5.5 .6L10.4 9.4H.6Z" fill="${fill}" style="stroke: var(--text-3)"/></svg>`;
/** Row of draggable triangle handles over a 0..255 range (Levels / Threshold). */
function handleTrack(fills: string[], onMove: (i: number, v: number) => void) {
  const el = h('div', { class: 'adj-track' });
  const hs = fills.map((f) => el.appendChild(h('span', { class: 'adj-handle', html: tri(f) })));
  let vals = fills.map(() => 0), active = -1;
  const valAt = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return clamp(((e.clientX - r.left) / Math.max(1, r.width)) * 255, 0, 255);
  };
  onDrag(el, {
    down: (e) => {
      const v = valAt(e);
      let bd = Infinity;
      active = -1;
      vals.forEach((hv, i) => {
        const d = Math.abs(hv - v);
        if (d < bd - 0.01 || (Math.abs(d - bd) <= 0.01 && v > hv)) { bd = d; active = i; }
      });
      return (bd / 255) * el.getBoundingClientRect().width <= 9;
    },
    move: (e) => { if (active >= 0) onMove(active, valAt(e)); },
  });
  return {
    el,
    set(v: number[]) { vals = v.slice(); hs.forEach((s, i) => { s.style.left = `${(clamp(vals[i], 0, 255) / 255) * 100}%`; }); },
  };
}

// =====================================================================
// Brightness/Contrast
// =====================================================================
const bcDefaults = () => ({ brightness: 0, contrast: 0, useLegacy: false });
const bcLut = memo((p) => {
  const b = nv(p.brightness, 0), c = nv(p.contrast, 0);
  if (p.useLegacy) {
    const f = c >= 0 ? (c >= 99.9 ? 1000 : 100 / (100 - c)) : (100 + c) / 100;
    return identOr(lutFrom((v) => (v + b - 127.5) * f + 127.5));
  }
  // modern: brightness bends midtones (keeps black/white), contrast is an S-curve
  const a = clamp(b / 150, -1, 1), g = 1 + (Math.max(0, c) / 100) * 1.2, k = 1 + Math.min(0, c) / 100;
  return identOr(lutFrom((v) => {
    let t = v / 255;
    t += a * t * (1 - t);
    if (c > 0) t = t < 0.5 ? 0.5 * Math.pow(2 * t, g) : 1 - 0.5 * Math.pow(2 * (1 - t), g);
    else if (c < 0) t = 0.5 + (t - 0.5) * k;
    return t * 255;
  }));
});
registerAdjustment({
  kind: 'brightness', name: 'Brightness/Contrast', icon: 'a-brightness',
  defaults: bcDefaults,
  apply(d, p) { const l = bcLut(p); applyLuts(d, l, l, l); },
  buildUI: ui('brightness', bcDefaults, null, (api) => {
    const p = api.get();
    return col(
      sf('Brightness', nv(p.brightness, 0), -150, 150, 0, (v) => setKey(api, 'brightness', v)).el,
      sf('Contrast', nv(p.contrast, 0), -50, 100, 0, (v) => setKey(api, 'contrast', v)).el,
      checkbox({ label: 'Use Legacy', checked: !!p.useLegacy, onChange: (v) => setKey(api, 'useLegacy', v) }).el,
    );
  }),
});

// =====================================================================
// Levels
// =====================================================================
interface Lv { inB: number; inW: number; gamma: number; outB: number; outW: number }
const LV0: Lv = { inB: 0, inW: 255, gamma: 1, outB: 0, outW: 255 };
const lvDefaults = () => ({ rgb: { ...LV0 }, r: { ...LV0 }, g: { ...LV0 }, b: { ...LV0 } });
function lvFn(lv: Partial<Lv> | undefined) {
  const l = { ...LV0, ...(lv ?? {}) };
  const span = Math.max(1, l.inW - l.inB), ig = 1 / clamp(l.gamma, 0.01, 9.99);
  return (v: number) => {
    let t = clamp((v - l.inB) / span, 0, 1);
    if (ig !== 1) t = Math.pow(t, ig);
    return l.outB + t * (l.outW - l.outB);
  };
}
const levelsLuts = memo((p) => {
  const m = lvFn(p.rgb);
  return (['r', 'g', 'b'] as const).map((c) => { const f = lvFn(p[c]); return identOr(lutFrom((v) => m(f(v)))); });
});
const lvPreset = (name: string, lv: Partial<Lv>): Preset => ({ name, p: () => ({ ...lvDefaults(), rgb: { ...LV0, ...lv } }) });
const LEVELS_PRESETS: Preset[] = [
  lvPreset('Darker', { inB: 15, gamma: 0.8 }),
  lvPreset('Increase Contrast 1', { inB: 10, inW: 245 }),
  lvPreset('Increase Contrast 2', { inB: 20, inW: 235 }),
  lvPreset('Increase Contrast 3', { inB: 30, inW: 225 }),
  lvPreset('Lighten Shadows', { gamma: 1.15, outB: 20 }),
  lvPreset('Lighter', { inW: 230, gamma: 1.15 }),
  lvPreset('Midtones Brighter', { gamma: 1.25 }),
  lvPreset('Midtones Darker', { gamma: 0.8 }),
];
const CHANNEL_OPTS: Option[] = [{ value: 'rgb', label: 'RGB' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }];
const levelsBody: Body = (api, ctx) => {
  const m = mem('levels');
  let ch: string = m.ch ?? 'rgb';
  const src = ctx.source();
  const hist = histView(histogramOf(src), ch === 'rgb' ? 'lum' : (ch as HistChannel));
  const lv = (): Lv => ({ ...LV0, ...(api.get()[ch] ?? {}) });
  const setLv = (patch: Partial<Lv>) => { const p = api.get(); api.set({ ...p, [ch]: { ...lv(), ...patch } }); sync(); };
  const inTrack = handleTrack(['#000', '#808080', '#fff'], (i, v) => {
    const l = lv();
    v = Math.round(v);
    if (i === 0) setLv({ inB: clamp(v, 0, l.inW - 2) });
    else if (i === 2) setLv({ inW: clamp(v, l.inB + 2, 255) });
    else {
      const t = clamp((v - l.inB) / (l.inW - l.inB), 0.002, 0.998);
      setLv({ gamma: Math.round(clamp(Math.log(t) / Math.log(0.5), 0.01, 9.99) * 100) / 100 });
    }
  });
  const outTrack = handleTrack(['#000', '#fff'], (i, v) => setLv(i === 0 ? { outB: Math.round(v) } : { outW: Math.round(v) }));
  const nInB = numberInput({ value: 0, min: 0, max: 253, width: 48, onInput: (v) => setLv({ inB: Math.min(v, lv().inW - 2) }) });
  const nGam = numberInput({ value: 1, min: 0.01, max: 9.99, step: 0.01, decimals: 2, width: 48, onInput: (v) => setLv({ gamma: v }) });
  const nInW = numberInput({ value: 255, min: 2, max: 255, width: 48, onInput: (v) => setLv({ inW: Math.max(v, lv().inB + 2) }) });
  const nOutB = numberInput({ value: 0, min: 0, max: 255, width: 48, onInput: (v) => setLv({ outB: v }) });
  const nOutW = numberInput({ value: 255, min: 0, max: 255, width: 48, onInput: (v) => setLv({ outW: v }) });
  const outGrad = h('div', { class: 'adj-grad' });
  const sync = () => {
    const l = lv();
    inTrack.set([l.inB, l.inB + (l.inW - l.inB) * Math.pow(0.5, l.gamma), l.inW]);
    outTrack.set([l.outB, l.outW]);
    nInB.set(l.inB); nGam.set(l.gamma); nInW.set(l.inW); nOutB.set(l.outB); nOutW.set(l.outW);
    outGrad.style.background = `linear-gradient(90deg, #000, ${ch === 'rgb' ? '#fff' : CH_PURE[ch]})`;
    hist.set(ch === 'rgb' ? 'lum' : (ch as HistChannel));
  };
  const chSel = select({ options: CHANNEL_OPTS, value: ch, onChange: (v) => { ch = m.ch = v; sync(); } });
  const auto = src ? button('Auto', () => {
    const a = autoRanges(src.data);
    api.set({ ...lvDefaults(), r: { ...LV0, inB: a.r[0], inW: a.r[1] }, g: { ...LV0, inB: a.g[0], inW: a.g[1] }, b: { ...LV0, inB: a.b[0], inW: a.b[1] } });
    sync();
  }, { small: true, title: 'Auto Tone (per-channel contrast)' }) : null;
  sync();
  return col(
    h('div', { class: 'row' }, chSel.el, auto),
    lbl('Input Levels:'),
    h('div', { class: 'adj-lv' }, hist.el, inTrack.el),
    h('div', { class: 'adj-nums' }, nInB.el, nGam.el, nInW.el),
    lbl('Output Levels:'),
    h('div', { class: 'adj-lv' }, outGrad, outTrack.el),
    h('div', { class: 'adj-nums' }, nOutB.el, nOutW.el),
  );
};
registerAdjustment({
  kind: 'levels', name: 'Levels', icon: 'a-levels', shortcut: 'Ctrl+L',
  defaults: lvDefaults,
  apply(d, p) { const [r, g, b] = levelsLuts(p); applyLuts(d, r, g, b); },
  buildUI: ui('levels', lvDefaults, LEVELS_PRESETS, levelsBody),
});

// =====================================================================
// Curves
// =====================================================================
type Pt = [number, number];
const LINE: Pt[] = [[0, 0], [255, 255]];
const cvDefaults = () => ({ rgb: LINE.map((q) => [...q]), r: LINE.map((q) => [...q]), g: LINE.map((q) => [...q]), b: LINE.map((q) => [...q]) });
const isLine = (pts: Pt[] | undefined) => !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255);

/** Monotone cubic (Fritsch-Carlson) interpolation through control points -> 256 floats. */
export function curveTable(pts: Pt[] | undefined): Float32Array {
  const out = new Float32Array(256);
  const p = (pts && pts.length ? pts : LINE).slice().sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n === 1) { out.fill(clamp(p[0][1], 0, 255)); return out; }
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  const d = new Float64Array(n - 1), m = new Float64Array(n);
  for (let k = 0; k < n - 1; k++) d[k] = (ys[k + 1] - ys[k]) / Math.max(1e-6, xs[k + 1] - xs[k]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
    const a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[k] = t * a * d[k]; m[k + 1] = t * b * d[k]; }
  }
  let k = 0;
  for (let x = 0; x < 256; x++) {
    let y: number;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      while (k < n - 2 && x > xs[k + 1]) k++;
      const hh = xs[k + 1] - xs[k], t = (x - xs[k]) / hh, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * hh * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * hh * m[k + 1];
    }
    out[x] = clamp(y, 0, 255);
  }
  return out;
}
const curvesLuts = memo((p) => {
  const m = curveTable(p.rgb);
  const at = (v: number) => { const i = Math.min(254, v | 0), f = v - i; return m[i] + (m[i + 1] - m[i]) * f; };
  return (['r', 'g', 'b'] as const).map((c) => { const t = curveTable(p[c]); return identOr(lutFrom((v) => at(t[v]))); });
});
const cvPreset = (name: string, c: Partial<Record<'rgb' | 'r' | 'g' | 'b', Pt[]>>): Preset => ({ name, p: () => ({ ...cvDefaults(), ...JSON.parse(JSON.stringify(c)) }) });
const CURVES_PRESETS: Preset[] = [
  cvPreset('Color Negative', { r: [[0, 255], [255, 0]], g: [[0, 255], [255, 0]], b: [[0, 255], [255, 0]], rgb: [[0, 0], [64, 40], [192, 216], [255, 255]] }),
  cvPreset('Cross Process', { r: [[0, 0], [64, 46], [192, 214], [255, 255]], g: [[0, 0], [64, 52], [192, 210], [255, 255]], b: [[0, 30], [255, 220]] }),
  cvPreset('Darker', { rgb: [[0, 0], [130, 104], [255, 255]] }),
  cvPreset('Increase Contrast', { rgb: [[0, 0], [64, 52], [192, 204], [255, 255]] }),
  cvPreset('Lighter', { rgb: [[0, 0], [120, 148], [255, 255]] }),
  cvPreset('Linear Contrast', { rgb: [[0, 0], [64, 48], [192, 208], [255, 255]] }),
  cvPreset('Medium Contrast', { rgb: [[0, 0], [64, 44], [192, 212], [255, 255]] }),
  cvPreset('Negative', { rgb: [[0, 255], [255, 0]] }),
  cvPreset('Strong Contrast', { rgb: [[0, 0], [64, 34], [192, 222], [255, 255]] }),
];
const curvesBody: Body = (api, ctx) => {
  const m = mem('curves');
  let ch: string = m.ch ?? 'rgb';
  let sel = -1;
  const src = ctx.source();
  const hs = histogramOf(src);
  const cv = h('canvas', { tabindex: 0, title: 'Click to add a point, drag to move, drag outside to remove' });
  const box = h('div', { class: 'adj-curve' }, cv);
  const PAD = 5;
  let size = 256;
  const pts = (): Pt[] => (api.get()[ch] ?? LINE) as Pt[];
  const inner = () => size - 2 * PAD;
  const toPx = (x: number, y: number): Pt => [PAD + (x / 255) * inner(), PAD + (1 - y / 255) * inner()];
  const fromPx = (px: number, py: number): Pt => [((px - PAD) / inner()) * 255, (1 - (py - PAD) / inner()) * 255];

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    size = cv.clientWidth || 256;
    const W = Math.max(1, Math.round(size * dpr));
    if (cv.width !== W) { cv.width = W; cv.height = W; }
    const x = ctx2d(cv);
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, size, size);
    const s = inner(), txt = themeVar(cv, '--text', '#d7d7d7'), t3 = themeVar(cv, '--text-3', '#7c7c7c');
    x.fillStyle = themeVar(cv, '--input', '#252525');
    x.fillRect(PAD, PAD, s, s);
    const a = histArr(hs, ch === 'rgb' ? 'lum' : (ch as HistChannel));
    if (a && hs!.count) {
      const mx = histScale(a);
      x.fillStyle = t3;
      x.globalAlpha = 0.4;
      for (let i = 0; i < 256; i++) { const v = Math.min(1, a[i] / mx) * s; if (v > 0) x.fillRect(PAD + (i * s) / 256, PAD + s - v, s / 256 + 0.5, v); }
      x.globalAlpha = 1;
    }
    x.strokeStyle = themeVar(cv, '--input-border', '#444');
    x.lineWidth = 1;
    x.beginPath();
    for (let i = 1; i < 4; i++) {
      const g = Math.round(PAD + (s * i) / 4) + 0.5;
      x.moveTo(g, PAD); x.lineTo(g, PAD + s); x.moveTo(PAD, g); x.lineTo(PAD + s, g);
    }
    x.stroke();
    x.strokeRect(PAD + 0.5, PAD + 0.5, s - 1, s - 1);
    x.strokeStyle = t3;
    x.beginPath(); x.moveTo(PAD, PAD + s); x.lineTo(PAD + s, PAD); x.stroke();
    const curve = (c: string, color: string, alpha: number) => {
      const t = curveTable(api.get()[c]);
      x.strokeStyle = color; x.globalAlpha = alpha; x.lineWidth = 1.5;
      x.beginPath();
      for (let i = 0; i < 256; i++) { const [X, Y] = toPx(i, t[i]); if (i) x.lineTo(X, Y); else x.moveTo(X, Y); }
      x.stroke();
      x.globalAlpha = 1; x.lineWidth = 1;
    };
    if (ch === 'rgb') for (const c of ['r', 'g', 'b']) if (!isLine(api.get()[c])) curve(c, CH_PURE[c], 0.55);
    curve(ch, ch === 'rgb' ? txt : CH_PURE[ch], 1);
    pts().forEach(([px, py], i) => {
      const [X, Y] = toPx(px, py);
      x.fillStyle = i === sel ? txt : themeVar(cv, '--input', '#252525');
      x.strokeStyle = txt;
      x.fillRect(X - 3.5, Y - 3.5, 7, 7);
      x.strokeRect(X - 3.5, Y - 3.5, 7, 7);
    });
  };
  new ResizeObserver(draw).observe(cv);

  const nIn = numberInput({ value: 0, min: 0, max: 255, width: 48, onInput: (v) => movePt(v, null) });
  const nOut = numberInput({ value: 0, min: 0, max: 255, width: 48, onInput: (v) => movePt(null, v) });
  const syncFields = () => {
    const p = pts()[sel];
    nIn.set(p ? p[0] : 0); nOut.set(p ? p[1] : 0);
    nIn.input.disabled = nOut.input.disabled = !p;
  };
  const commit = (arr: Pt[]) => {
    if (!deepEq(arr, pts())) api.set({ ...api.get(), [ch]: arr });
    draw();
  };
  const movePt = (x: number | null, y: number | null) => {
    const P = pts().map((q) => [q[0], q[1]] as Pt);
    if (!P[sel]) return;
    const lo = sel > 0 ? P[sel - 1][0] + 1 : 0, hi = sel < P.length - 1 ? P[sel + 1][0] - 1 : 255;
    if (x !== null) P[sel][0] = clamp(Math.round(x), lo, hi);
    if (y !== null) P[sel][1] = clamp(Math.round(y), 0, 255);
    commit(P);
    syncFields();
  };

  let drag: { base: Pt[]; idx: number; end: boolean } | null = null;
  const local = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top, r }; };
  onDrag(cv, {
    down: (e) => {
      cv.focus();
      const { px, py } = local(e);
      const P = pts().map((q) => [q[0], q[1]] as Pt);
      let hit = -1, bd = 81;
      P.forEach(([vx, vy], i) => { const [X, Y] = toPx(vx, vy); const dd = (X - px) ** 2 + (Y - py) ** 2; if (dd < bd) { bd = dd; hit = i; } });
      if (hit < 0) {
        const [fx, fy] = fromPx(px, py);
        const vx = clamp(Math.round(fx), 0, 255);
        let vy = clamp(Math.round(fy), 0, 255);
        let idx = P.findIndex((q) => q[0] > vx);
        if (idx < 0) idx = P.length;
        if ((idx > 0 && vx - P[idx - 1][0] < 2) || (idx < P.length && P[idx][0] - vx < 2)) return false;
        const cy = curveTable(P)[vx];
        if (Math.abs(toPx(vx, cy)[1] - py) < 10) vy = Math.round(cy); // clicked on the curve: keep its shape
        P.splice(idx, 0, [vx, vy]);
        hit = idx;
        commit(P);
      }
      sel = hit;
      drag = { base: P.filter((_, i) => i !== hit), idx: hit, end: hit === 0 || hit === P.length - 1 };
      syncFields(); draw();
    },
    move: (e) => {
      if (!drag) return;
      const { px, py, r } = local(e);
      const { base, idx } = drag;
      if (!drag.end && (px < -16 || py < -16 || px > r.width + 16 || py > r.height + 16)) {
        sel = -1; commit(base); syncFields(); return;
      }
      const lo = idx > 0 ? base[idx - 1][0] + 1 : 0, hi = idx < base.length ? base[idx][0] - 1 : 255;
      const [fx, fy] = fromPx(px, py);
      const arr = base.slice();
      arr.splice(idx, 0, [clamp(Math.round(fx), lo, hi), clamp(Math.round(fy), 0, 255)]);
      sel = idx;
      commit(arr); syncFields();
    },
    up: () => { drag = null; syncFields(); draw(); },
  });
  cv.addEventListener('keydown', (e) => {
    const P = pts();
    if (sel < 0 || !P[sel]) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel > 0 && sel < P.length - 1) {
      commit(P.filter((_, i) => i !== sel)); sel = -1; syncFields();
    } else if (e.key.startsWith('Arrow')) {
      const st = e.shiftKey ? 10 : 1;
      const [x, y] = P[sel];
      if (e.key === 'ArrowLeft') movePt(x - st, null);
      else if (e.key === 'ArrowRight') movePt(x + st, null);
      else if (e.key === 'ArrowUp') movePt(null, y + st);
      else movePt(null, y - st);
    } else return;
    e.preventDefault(); e.stopPropagation();
  });

  const chSel = select({ options: CHANNEL_OPTS, value: ch, onChange: (v) => { ch = m.ch = v; sel = -1; syncFields(); draw(); } });
  const auto = src ? button('Auto', () => {
    const a = autoRanges(src.data);
    const ln = (q: [number, number]): Pt[] => [[q[0], 0], [q[1], 255]];
    api.set({ ...cvDefaults(), r: ln(a.r), g: ln(a.g), b: ln(a.b) });
    sel = -1; syncFields(); draw();
  }, { small: true, title: 'Auto Tone (per-channel contrast)' }) : null;
  syncFields();
  return col(
    h('div', { class: 'row' }, chSel.el, auto),
    box,
    h('div', { class: 'row adj-io' }, lbl('Input:'), nIn.el, lbl('Output:'), nOut.el),
  );
};
registerAdjustment({
  kind: 'curves', name: 'Curves', icon: 'a-curves', shortcut: 'Ctrl+M',
  defaults: cvDefaults,
  apply(d, p) { const [r, g, b] = curvesLuts(p); applyLuts(d, r, g, b); },
  buildUI: ui('curves', cvDefaults, CURVES_PRESETS, curvesBody),
});

// =====================================================================
// Exposure (linear light)
// =====================================================================
const s2l = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const l2s = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const exDefaults = () => ({ exposure: 0, offset: 0, gamma: 1 });
const exLut = memo((p) => {
  const e = Math.pow(2, nv(p.exposure, 0)), o = nv(p.offset, 0), g = 1 / clamp(nv(p.gamma, 1), 0.01, 9.99);
  return identOr(lutFrom((v) => {
    let x = Math.max(0, s2l(v / 255) * e + o);
    if (g !== 1) x = Math.pow(x, g);
    return l2s(Math.min(1, x)) * 255;
  }));
});
const exPreset = (name: string, exposure: number): Preset => ({ name, p: () => ({ ...exDefaults(), exposure }) });
registerAdjustment({
  kind: 'exposure', name: 'Exposure', icon: 'a-exposure',
  defaults: exDefaults,
  apply(d, p) { const l = exLut(p); applyLuts(d, l, l, l); },
  buildUI: ui('exposure', exDefaults, [exPreset('Minus 2.0', -2), exPreset('Minus 1.0', -1), exPreset('Plus 1.0', 1), exPreset('Plus 2.0', 2)], (api) => {
    const p = api.get();
    return col(
      sf('Exposure', nv(p.exposure, 0), -20, 20, 0, (v) => setKey(api, 'exposure', v), { step: 0.01, decimals: 2, width: 52 }).el,
      sf('Offset', nv(p.offset, 0), -0.5, 0.5, 0, (v) => setKey(api, 'offset', v), { step: 0.0001, decimals: 4, width: 60 }).el,
      sf('Gamma Correction', nv(p.gamma, 1), 0.01, 9.99, 1, (v) => setKey(api, 'gamma', v), { step: 0.01, decimals: 2, width: 52 }).el,
    );
  }),
});

// =====================================================================
// Vibrance
// =====================================================================
const vbDefaults = () => ({ vibrance: 0, saturation: 0 });
const vbPrep = memo((p) => {
  const v = clamp(nv(p.vibrance, 0), -100, 100) / 100, s = clamp(nv(p.saturation, 0), -100, 100) / 100;
  const tab = new Float32Array(256); // vibrance amount by chroma: muted colors get the most
  for (let i = 0; i < 256; i++) { const c = i / 255; tab[i] = v * (1 - c) * (1 - c * 0.3); }
  return { v, fs: 1 + s, tab, noop: !v && !s };
});
registerAdjustment({
  kind: 'vibrance', name: 'Vibrance', icon: 'a-vibrance',
  defaults: vbDefaults,
  apply(d, p) {
    const { v, fs, tab, noop } = vbPrep(p);
    if (noop) return;
    for (let i = 0, n = d.length; i < n; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mx === mn) continue;
      let amt = tab[mx - mn];
      if (v > 0 && r >= g && g >= b) { // protect skin tones (orange hues)
        const sw = 1 - Math.abs((g - b) / (r - b) - 0.4) / 0.4;
        if (sw > 0) amt *= 1 - 0.7 * sw;
      }
      const f = (1 + amt) * fs, L = 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = L + (r - L) * f; d[i + 1] = L + (g - L) * f; d[i + 2] = L + (b - L) * f;
    }
  },
  buildUI: ui('vibrance', vbDefaults, null, (api) => {
    const p = api.get();
    return col(
      sf('Vibrance', nv(p.vibrance, 0), -100, 100, 0, (v) => setKey(api, 'vibrance', v)).el,
      sf('Saturation', nv(p.saturation, 0), -100, 100, 0, (v) => setKey(api, 'saturation', v)).el,
    );
  }),
});

// =====================================================================
// Hue/Saturation
// =====================================================================
interface HSL3 { h: number; s: number; l: number }
const HS_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
const HS_LABEL: Record<string, string> = { master: 'Master', reds: 'Reds', yellows: 'Yellows', greens: 'Greens', cyans: 'Cyans', blues: 'Blues', magentas: 'Magentas' };
const Z3 = (): HSL3 => ({ h: 0, s: 0, l: 0 });
const hsDefaults = () => ({
  colorize: false, master: Z3(), reds: Z3(), yellows: Z3(), greens: Z3(), cyans: Z3(), blues: Z3(), magentas: Z3(),
  cz: { h: 0, s: 25, l: 0 },
});
/** Range weight: full within ±15° of the range center, linear falloff to 0 at ±45° (sums to 1). */
function rangeW(deg: number, j: number) {
  let dist = Math.abs(deg - j * 60) % 360;
  if (dist > 180) dist = 360 - dist;
  return dist <= 15 ? 1 : dist >= 45 ? 0 : (45 - dist) / 30;
}
const HN = 1536; // hue table resolution (6 sectors x 256)
interface HsPrep { cz: Uint8ClampedArray | null; H: Float32Array; S: Float32Array; L: Float32Array; Lm: number; noop: boolean }
const lightF = (c: number, lf: number) => (lf > 0 ? c + (255 - c) * lf : c * (1 + lf));
const hsPrep = memo((p): HsPrep => {
  const H = new Float32Array(HN), S = new Float32Array(HN), L = new Float32Array(HN);
  if (p.colorize) {
    const z: HSL3 = { h: 0, s: 25, l: 0, ...(p.cz ?? {}) };
    const t = new Uint8ClampedArray(511 * 3), lf = clamp(z.l / 100, -1, 1);
    for (let i = 0; i < 511; i++) {
      const [r, g, b] = hslToRgb(z.h, clamp(z.s / 100, 0, 1), i / 510);
      t[i * 3] = lightF(r, lf); t[i * 3 + 1] = lightF(g, lf); t[i * 3 + 2] = lightF(b, lf);
    }
    return { cz: t, H, S, L, Lm: 0, noop: false };
  }
  const m: HSL3 = { ...Z3(), ...(p.master ?? {}) };
  const rs = HS_RANGES.map((k) => ({ ...Z3(), ...(p[k] ?? {}) }));
  let noop = !m.h && !m.s && !m.l;
  for (const r of rs) if (r.h || r.s || r.l) noop = false;
  for (let i = 0; i < HN; i++) {
    const deg = (i / HN) * 360;
    let dh = 0, ds = 0, dl = 0;
    rs.forEach((r, j) => {
      if (!r.h && !r.s && !r.l) return;
      const w = rangeW(deg, j);
      dh += w * r.h; ds += w * r.s; dl += w * r.l;
    });
    H[i] = (m.h + dh) / 60;
    S[i] = Math.max(0, 1 + (m.s + ds) / 100);
    L[i] = clamp((m.l + dl) / 100, -1, 1);
  }
  return { cz: null, H, S, L, Lm: clamp(m.l / 100, -1, 1), noop };
});
function applyHueSat(d: Uint8ClampedArray, p: P) {
  const t = hsPrep(p);
  if (t.cz) {
    const z = t.cz;
    for (let i = 0, n = d.length; i < n; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const mx = R > G ? (R > B ? R : B) : (G > B ? G : B), mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
      const o = (mx + mn) * 3;
      d[i] = z[o]; d[i + 1] = z[o + 1]; d[i + 2] = z[o + 2];
    }
    return;
  }
  if (t.noop) return;
  const { H, S, L, Lm } = t;
  for (let i = 0, n = d.length; i < n; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    const mx = R > G ? (R > B ? R : B) : (G > B ? G : B), mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
    let r: number, g: number, b: number, lf = Lm;
    if (mx === mn) { r = g = b = R; }
    else {
      const c = mx - mn, sum = mx + mn;
      let hh: number;
      if (mx === R) { hh = (G - B) / c; if (hh < 0) hh += 6; }
      else if (mx === G) hh = (B - R) / c + 2;
      else hh = (R - G) / c + 4;
      let idx = (hh * 256) | 0;
      if (idx >= HN) idx = HN - 1;
      const l = sum / 510;
      let s = c / (sum <= 255 ? sum : 510 - sum);
      let h2 = hh + H[idx];
      h2 = ((h2 % 6) + 6) % 6;
      s *= S[idx];
      if (s > 1) s = 1;
      const C = (1 - Math.abs(2 * l - 1)) * s * 255, X = C * (1 - Math.abs((h2 % 2) - 1)), m0 = l * 255 - C / 2;
      switch (h2 | 0) {
        case 0: r = C; g = X; b = 0; break;
        case 1: r = X; g = C; b = 0; break;
        case 2: r = 0; g = C; b = X; break;
        case 3: r = 0; g = X; b = C; break;
        case 4: r = X; g = 0; b = C; break;
        default: r = C; g = 0; b = X;
      }
      r += m0; g += m0; b += m0;
      lf = Lm + (L[idx] - Lm) * (c >= 24 ? 1 : c / 24); // near-grays only get the master lightness
    }
    if (lf > 0) { r += (255 - r) * lf; g += (255 - g) * lf; b += (255 - b) * lf; }
    else if (lf < 0) { r *= 1 + lf; g *= 1 + lf; b *= 1 + lf; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
}
const hsPreset = (name: string, o: P): Preset => ({ name, p: () => { const b = hsDefaults() as P; for (const k of Object.keys(o)) b[k] = typeof o[k] === 'object' ? { ...b[k], ...o[k] } : o[k]; return b; } });
const HUESAT_PRESETS: Preset[] = [
  hsPreset('Cyanotype', { colorize: true, cz: { h: 200, s: 25, l: 0 } }),
  hsPreset('Further Increase Saturation', { master: { s: 50 } }),
  hsPreset('Increase Saturation', { master: { s: 25 } }),
  hsPreset('Old Style', { master: { s: -45, l: -5 }, reds: { h: 8 }, yellows: { h: -5, s: -10 } }),
  hsPreset('Red Boost', { reds: { s: 40 } }),
  hsPreset('Sepia', { colorize: true, cz: { h: 35, s: 25, l: 0 } }),
  hsPreset('Strong Saturation', { master: { s: 70 } }),
  hsPreset('Yellow Boost', { yellows: { s: 40 } }),
];
/** CSS gradient marking where a hue range applies (0..360°). */
function rangeGradient(range: string): string {
  const j = HS_RANGES.indexOf(range as typeof HS_RANGES[number]);
  if (j < 0) return 'transparent';
  const keys = new Set([0, 360]);
  for (const o of [-45, -15, 15, 45]) keys.add((((j * 60 + o) % 360) + 360) % 360);
  const stops = [...keys].sort((a, b) => a - b).map((k) => `${rangeW(k, j) > 0.5 ? 'var(--text-2)' : 'transparent'} ${((k / 360) * 100).toFixed(2)}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
const hsBody: Body = (api) => {
  const m = mem('huesat');
  const cz = !!api.get().colorize;
  let range: string = cz ? 'cz' : (m.range ?? 'master');
  const cur = (): HSL3 => ({ ...(cz ? { h: 0, s: 25, l: 0 } : Z3()), ...(api.get()[range] ?? {}) });
  const setK = (k: keyof HSL3, v: number) => { const p = api.get(); api.set({ ...p, [range]: { ...cur(), [k]: v } }); refresh(); };
  const c0 = cur();
  const fH = sf('Hue', c0.h, cz ? 0 : -180, cz ? 360 : 180, 0, (v) => setK('h', v), { track: cz ? HUE_TRACK : undefined });
  const fS = sf('Saturation', c0.s, cz ? 0 : -100, 100, cz ? 25 : 0, (v) => setK('s', v));
  const fL = sf('Lightness', c0.l, -100, 100, 0, (v) => setK('l', v));
  const rsel = select({
    options: ['master', ...HS_RANGES].map((k) => ({ value: k, label: HS_LABEL[k] })), value: cz ? 'master' : range,
    onChange: (v) => { range = m.range = v; const c = cur(); fH.set(c.h); fS.set(c.s); fL.set(c.l); refresh(); },
  });
  (rsel.el as HTMLSelectElement).disabled = cz;
  const czBox = checkbox({ label: 'Colorize', checked: cz, onChange: (v) => setKey(api, 'colorize', v, true) });
  const rangeBar = h('div', { class: 'adj-range' });
  const inBar = h('div', { class: 'adj-spec', style: { background: HUE_TRACK } });
  const outBar = h('canvas', { class: 'adj-spec', width: 360, height: 1 });
  const refresh = () => {
    rangeBar.style.background = cz ? 'transparent' : rangeGradient(range);
    const img = new ImageData(360, 1);
    for (let i = 0; i < 360; i++) { const [r, g, b] = hslToRgb(i, 1, 0.5); img.data.set([r, g, b, 255], i * 4); }
    applyHueSat(img.data, api.get());
    ctx2d(outBar).putImageData(img, 0, 0);
  };
  refresh();
  return col(
    h('div', { class: 'row' }, rsel.el),
    fH.el, fS.el, fL.el, czBox.el,
    h('div', { class: 'adj-specs' }, rangeBar, inBar, outBar),
  );
};
registerAdjustment({
  kind: 'huesat', name: 'Hue/Saturation', icon: 'a-huesat', shortcut: 'Ctrl+U',
  defaults: hsDefaults,
  apply: applyHueSat,
  buildUI: ui('huesat', hsDefaults, HUESAT_PRESETS, hsBody),
});

// =====================================================================
// Color Balance
// =====================================================================
const cbDefaults = () => ({ shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLum: true });
const cbPrep = memo((p) => {
  const sh = (p.shadows ?? [0, 0, 0]) as number[], mi = (p.midtones ?? [0, 0, 0]) as number[], hi = (p.highlights ?? [0, 0, 0]) as number[];
  const A = 0.25, B = 0.333, SC = 0.6; // tonal masks overlap smoothly and sum to SC
  const add = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  let any = false;
  for (let i = 0; i < 256; i++) {
    const l = i / 255;
    const ws = clamp((l - B) / -A + 0.5, 0, 1) * SC;
    const wm = clamp((l - B) / A + 0.5, 0, 1) * clamp((l + B - 1) / -A + 0.5, 0, 1) * SC;
    const wh = clamp((l + B - 1) / A + 0.5, 0, 1) * SC;
    for (let c = 0; c < 3; c++) {
      const v = ((nv(sh[c], 0) * ws + nv(mi[c], 0) * wm + nv(hi[c], 0) * wh) / 100) * 255;
      add[c][i] = v;
      if (v) any = true;
    }
  }
  return { add, any, pl: p.preserveLum !== false };
});
const CB_PAIRS: [string, string, string, string][] = [['Cyan', 'Red', '#00ffff', '#ff0000'], ['Magenta', 'Green', '#ff00ff', '#00ff00'], ['Yellow', 'Blue', '#ffff00', '#0000ff']];
registerAdjustment({
  kind: 'colorbalance', name: 'Color Balance', icon: 'a-colorbalance', shortcut: 'Ctrl+B',
  defaults: cbDefaults,
  apply(d, p) {
    const { add, any, pl } = cbPrep(p);
    if (!any) return;
    const [ar, ag, ab] = add;
    for (let i = 0, n = d.length; i < n; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const mx = R > G ? (R > B ? R : B) : (G > B ? G : B), mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
      const li = (mx + mn) >> 1;
      let r = clamp(R + ar[li], 0, 255), g = clamp(G + ag[li], 0, 255), b = clamp(B + ab[li], 0, 255);
      if (pl) {
        const dl = 0.299 * (R - r) + 0.587 * (G - g) + 0.114 * (B - b);
        r += dl; g += dl; b += dl;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  },
  buildUI: ui('colorbalance', cbDefaults, null, (api) => {
    const m = mem('colorbalance');
    let tone: string = m.tone ?? 'midtones';
    const fields = CB_PAIRS.map(([a, b, ca, cb], k) => {
      const f = sf(a, 0, -100, 100, 0, (v) => {
        const p = api.get();
        const arr = [...((p[tone] ?? [0, 0, 0]) as number[])];
        arr[k] = v;
        api.set({ ...p, [tone]: arr });
      }, { track: `linear-gradient(90deg, ${ca}, ${cb})` });
      f.el.classList.add('adj-pair');
      f.el.querySelector('.sf-top')?.appendChild(lbl(b));
      return f;
    });
    const sync = () => fields.forEach((f, k) => f.set(nv(api.get()[tone]?.[k], 0)));
    const seg = segmented({
      options: [{ value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Midtones' }, { value: 'highlights', label: 'Highlights' }],
      value: tone, onChange: (v) => { tone = m.tone = v; sync(); },
    });
    sync();
    return col(
      h('div', { class: 'row' }, lbl('Tone:'), seg.el),
      ...fields.map((f) => f.el),
      checkbox({ label: 'Preserve Luminosity', checked: api.get().preserveLum !== false, onChange: (v) => setKey(api, 'preserveLum', v) }).el,
    );
  }),
});

// =====================================================================
// Black & White
// =====================================================================
const BW: [string, string, string, number][] = [
  ['reds', 'Reds', '#ff0000', 40], ['yellows', 'Yellows', '#ffff00', 60], ['greens', 'Greens', '#00ff00', 40],
  ['cyans', 'Cyans', '#00ffff', 60], ['blues', 'Blues', '#0000ff', 20], ['magentas', 'Magentas', '#ff00ff', 80],
];
const bwDefaults = () => ({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 42, tintSat: 20 });
const bwPrep = memo((p) => {
  const w = BW.map(([k, , , def]) => nv(p[k], def) / 100);
  let tint: Uint8ClampedArray | null = null;
  if (p.tint) {
    tint = new Uint8ClampedArray(768);
    const hue = nv(p.tintHue, 42), s = clamp(nv(p.tintSat, 20), 0, 100) / 100;
    for (let i = 0; i < 256; i++) { const [r, g, b] = hslToRgb(hue, s, i / 255); tint[i * 3] = r; tint[i * 3 + 1] = g; tint[i * 3 + 2] = b; }
  }
  return { w, tint };
});
/** Spread the six color weights so hue groups land on distinct grays (B&W Auto). */
function bwAuto(d: Uint8ClampedArray): P {
  const sum = new Float64Array(6), wt = new Float64Array(6);
  let total = 0;
  for (let i = 0, n = d.length; i < n; i += 8) {
    if (!d[i + 3]) continue;
    const R = d[i], G = d[i + 1], B = d[i + 2];
    const mx = Math.max(R, G, B), c = mx - Math.min(R, G, B);
    total++;
    if (c < 20) continue;
    let hh = mx === R ? (G - B) / c : mx === G ? (B - R) / c + 2 : (R - G) / c + 4;
    if (hh < 0) hh += 6;
    const s = Math.round(hh) % 6;
    sum[s] += (0.299 * R + 0.587 * G + 0.114 * B) * c;
    wt[s] += c;
  }
  const present = [0, 1, 2, 3, 4, 5].filter((k) => wt[k] > total * 0.5);
  const out: P = {};
  if (present.length < 2) return out;
  present.sort((a, b) => sum[a] / wt[a] - sum[b] / wt[b]);
  present.forEach((k, rank) => { out[BW[k][0]] = Math.round(20 + (rank / (present.length - 1)) * 90); });
  return out;
}
const bwPreset = (name: string, w: number[]): Preset => ({ name, p: () => { const b = bwDefaults() as P; BW.forEach(([k], i) => { b[k] = w[i]; }); return b; } });
const BW_PRESETS: Preset[] = [
  bwPreset('Blue Filter', [0, 0, 0, 100, 150, 100]),
  bwPreset('Darker', [25, 45, 25, 45, 10, 60]),
  bwPreset('Green Filter', [-10, 80, 120, 60, -10, 0]),
  bwPreset('High Contrast Blue Filter', [-50, -40, -20, 120, 150, 100]),
  bwPreset('High Contrast Red Filter', [120, 120, -10, -50, -50, 120]),
  bwPreset('Infrared', [-40, 235, 144, -68, -3, -107]),
  bwPreset('Lighter', [55, 75, 55, 75, 35, 95]),
  bwPreset('Maximum Black', [0, 0, 0, 0, 0, 0]),
  bwPreset('Maximum White', [100, 100, 100, 100, 100, 100]),
  bwPreset('Neutral Density', [30, 50, 30, 50, 10, 70]),
  bwPreset('Red Filter', [120, 110, -10, -50, -50, 120]),
  bwPreset('Yellow Filter', [120, 110, 40, -30, -50, 70]),
];
registerAdjustment({
  kind: 'bw', name: 'Black & White', icon: 'a-bw', shortcut: 'Alt+Shift+Ctrl+B',
  defaults: bwDefaults,
  apply(d, p) {
    const { w, tint } = bwPrep(p);
    const [wR, wY, wG, wC, wB, wM] = w;
    for (let i = 0, n = d.length; i < n; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      let v: number;
      if (R >= G) {
        if (G >= B) v = (R - G) * wR + (G - B) * wY + B;
        else if (R >= B) v = (R - B) * wR + (B - G) * wM + G;
        else v = (B - R) * wB + (R - G) * wM + G;
      } else if (R >= B) v = (G - R) * wG + (R - B) * wY + B;
      else if (G >= B) v = (G - B) * wG + (B - R) * wC + R;
      else v = (B - G) * wB + (G - R) * wC + R;
      const gi = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
      if (tint) { const o = gi * 3; d[i] = tint[o]; d[i + 1] = tint[o + 1]; d[i + 2] = tint[o + 2]; }
      else d[i] = d[i + 1] = d[i + 2] = gi;
    }
  },
  buildUI: ui('bw', bwDefaults, BW_PRESETS, (api, ctx) => {
    const p = api.get();
    const src = ctx.source();
    const auto = src ? button('Auto', () => api.set({ ...api.get(), ...bwAuto(src.data) }, true), { small: true }) : null;
    const fields = BW.map(([k, label, color, def]) =>
      sf(label, nv(p[k], def), -200, 300, def, (v) => setKey(api, k, v), { unit: '%', track: `linear-gradient(90deg, #000, ${color} 50%, #fff)` }).el);
    const tint = checkbox({ label: 'Tint', checked: !!p.tint, onChange: (v) => setKey(api, 'tint', v, true) });
    return col(
      h('div', { class: 'row between' }, tint.el, auto),
      ...fields,
      p.tint ? sf('Tint Hue', nv(p.tintHue, 42), 0, 360, 42, (v) => setKey(api, 'tintHue', v), { unit: '°', track: HUE_TRACK }).el : null,
      p.tint ? sf('Tint Saturation', nv(p.tintSat, 20), 0, 100, 20, (v) => setKey(api, 'tintSat', v), { unit: '%' }).el : null,
    );
  }),
});

// =====================================================================
// Photo Filter
// =====================================================================
const PHOTO_FILTERS: [string, string][] = [
  ['Warming Filter (85)', '#ec8a00'], ['Warming Filter (LBA)', '#fa9600'], ['Warming Filter (81)', '#ebb113'],
  ['Cooling Filter (80)', '#006dff'], ['Cooling Filter (LBB)', '#005dff'], ['Cooling Filter (82)', '#00b5ff'],
  ['Red', '#ea1a1a'], ['Orange', '#f38417'], ['Yellow', '#f9e31c'], ['Green', '#19c919'], ['Cyan', '#1dcbea'],
  ['Blue', '#1d35ea'], ['Violet', '#9b1dea'], ['Magenta', '#e318e3'], ['Sepia', '#ac7a33'], ['Deep Red', '#ff0000'],
  ['Deep Blue', '#0022cd'], ['Deep Emerald', '#008c00'], ['Deep Yellow', '#ffd500'], ['Underwater', '#00c1b1'],
];
const filterColor = (name: string): RGB => hexToRgb(PHOTO_FILTERS.find((f) => f[0] === name)?.[1] ?? '#ec8a00')!;
const pfDefaults = () => ({ filter: 'Warming Filter (85)', useColor: false, color: filterColor('Warming Filter (85)'), density: 25, preserveLum: true });
const pfPrep = memo((p) => {
  const c: RGB = p.useColor && p.color ? p.color : filterColor(p.filter);
  const dd = clamp(nv(p.density, 25), 0, 100) / 100;
  return { mr: 1 - dd + (dd * c.r) / 255, mg: 1 - dd + (dd * c.g) / 255, mb: 1 - dd + (dd * c.b) / 255, pl: p.preserveLum !== false, noop: dd === 0 };
});
registerAdjustment({
  kind: 'photofilter', name: 'Photo Filter', icon: 'a-photofilter',
  defaults: pfDefaults,
  apply(d, p) {
    const { mr, mg, mb, pl, noop } = pfPrep(p);
    if (noop) return;
    for (let i = 0, n = d.length; i < n; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      let r = R * mr, g = G * mg, b = B * mb;
      if (pl) {
        const dl = 0.299 * (R - r) + 0.587 * (G - g) + 0.114 * (B - b);
        r += dl; g += dl; b += dl;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  },
  buildUI: ui('photofilter', pfDefaults, null, (api) => {
    const p = api.get();
    const grp = `pf${++radioSeq}`;
    const fsel = select({ options: PHOTO_FILTERS.map((f) => f[0]), value: p.filter ?? PHOTO_FILTERS[0][0], onChange: (v) => api.set({ ...api.get(), filter: v, useColor: false }, true) });
    const sw = colorSwatch({ color: p.color ?? filterColor(p.filter), title: 'Select filter color', onChange: (c) => api.set({ ...api.get(), color: c, useColor: true }, true) });
    return col(
      h('div', { class: 'adj-pf' },
        radio(grp, 'Filter', !p.useColor, () => setKey(api, 'useColor', false)), fsel.el,
        radio(grp, 'Color', !!p.useColor, () => setKey(api, 'useColor', true)), sw.el),
      sf('Density', nv(p.density, 25), 0, 100, 25, (v) => setKey(api, 'density', v), { unit: '%' }).el,
      checkbox({ label: 'Preserve Luminosity', checked: p.preserveLum !== false, onChange: (v) => setKey(api, 'preserveLum', v) }).el,
    );
  }),
});

// =====================================================================
// Channel Mixer
// =====================================================================
const CM_DEF: Record<string, number[]> = { red: [100, 0, 0, 0], green: [0, 100, 0, 0], blue: [0, 0, 100, 0], gray: [40, 40, 20, 0] };
const cmDefaults = () => ({ mono: false, red: [...CM_DEF.red], green: [...CM_DEF.green], blue: [...CM_DEF.blue], gray: [...CM_DEF.gray] });
const cmPrep = memo((p) => {
  const row = (k: string) => { const a = (p[k] ?? CM_DEF[k]) as number[]; return [0, 1, 2, 3].map((i) => nv(a[i], CM_DEF[k][i]) / 100); };
  const rows = p.mono ? [row('gray'), row('gray'), row('gray')] : [row('red'), row('green'), row('blue')];
  const noop = !p.mono && rows.every((r, i) => r.every((v, j) => v === (j === i ? 1 : 0)));
  return { m: rows.flat(), noop, mono: !!p.mono };
});
const cmPreset = (name: string, gray: number[]): Preset => ({ name, p: () => ({ ...cmDefaults(), mono: true, gray: [...gray, 0] }) });
const CM_PRESETS: Preset[] = [
  cmPreset('Black & White Infrared (RGB)', [-70, 200, -30]),
  cmPreset('Black & White with Blue Filter (RGB)', [0, 0, 100]),
  cmPreset('Black & White with Green Filter (RGB)', [0, 100, 0]),
  cmPreset('Black & White with Orange Filter (RGB)', [50, 50, 0]),
  cmPreset('Black & White with Red Filter (RGB)', [100, 0, 0]),
  cmPreset('Black & White with Yellow Filter (RGB)', [34, 66, 0]),
];
registerAdjustment({
  kind: 'channelmixer', name: 'Channel Mixer', icon: 'a-channelmixer',
  defaults: cmDefaults,
  apply(d, p) {
    const { m, noop, mono } = cmPrep(p);
    if (noop) return;
    const [a0, a1, a2, a3, b0, b1, b2, b3, c0, c1, c2, c3] = m;
    const k0 = a3 * 255, k1 = b3 * 255, k2 = c3 * 255;
    for (let i = 0, n = d.length; i < n; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const r = R * a0 + G * a1 + B * a2 + k0;
      if (mono) { d[i] = d[i + 1] = d[i + 2] = r; continue; }
      d[i] = r; d[i + 1] = R * b0 + G * b1 + B * b2 + k1; d[i + 2] = R * c0 + G * c1 + B * c2 + k2;
    }
  },
  buildUI: ui('channelmixer', cmDefaults, CM_PRESETS, (api) => {
    const m = mem('channelmixer');
    const mono = !!api.get().mono;
    let out: string = mono ? 'gray' : (m.out ?? 'red');
    const wrap = col();
    const row = () => [...((api.get()[out] ?? CM_DEF[out]) as number[])];
    const render = () => {
      clear(wrap);
      const total = h('div', { class: 'adj-total' });
      const updTotal = () => {
        const a = row(), t = Math.round(a[0] + a[1] + a[2]);
        total.textContent = `Total: ${t > 0 ? '+' : ''}${t}%${t > 100 ? ' ⚠' : ''}`;
        total.classList.toggle('warn', t > 100);
        total.title = t > 100 ? 'Total above 100% may clip highlights' : '';
      };
      const setK = (k: number, v: number) => { const a = row(); a[k] = v; api.set({ ...api.get(), [out]: a }); updTotal(); };
      const a = row();
      const osel = select({
        options: mono ? [{ value: 'gray', label: 'Gray' }] : [{ value: 'red', label: 'Red' }, { value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' }],
        value: out, onChange: (v) => { out = m.out = v; render(); },
      });
      (osel.el as HTMLSelectElement).disabled = mono;
      wrap.append(
        h('div', { class: 'row' }, lbl('Output Channel:'), osel.el),
        checkbox({ label: 'Monochrome', checked: mono, onChange: (v) => setKey2(v) }).el,
        ...['Red', 'Green', 'Blue'].map((n, k) => sf(n, nv(a[k], 0), -200, 200, CM_DEF[out][k], (v) => setK(k, v), { unit: '%' }).el),
        total,
        sf('Constant', nv(a[3], 0), -200, 200, 0, (v) => setK(3, v), { unit: '%' }).el,
      );
      updTotal();
    };
    const setKey2 = (v: boolean) => setKey(api, 'mono', v, true);
    render();
    return wrap;
  }),
});

// =====================================================================
// Color Lookup (built-in looks baked into 33^3 3D LUTs)
// =====================================================================
const luma3 = (c: V3) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const sat3 = (c: V3, f: number): V3 => { const l = luma3(c); return [l + (c[0] - l) * f, l + (c[1] - l) * f, l + (c[2] - l) * f]; };
/** Contrast S-curve; k in -1..1 keeps it monotone. */
const sc1 = (x: number, k: number) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t + k * (t * t * (3 - 2 * t) - t); };
const con3 = (c: V3, k: number): V3 => [sc1(c[0], k), sc1(c[1], k), sc1(c[2], k)];
const mul3 = (c: V3, m: V3): V3 => [c[0] * m[0], c[1] * m[1], c[2] * m[2]];
const lift3 = (c: V3, lo: V3, hi: V3): V3 => [lo[0] + c[0] * (hi[0] - lo[0]), lo[1] + c[1] * (hi[1] - lo[1]), lo[2] + c[2] * (hi[2] - lo[2])];
const pow3 = (c: V3, g: number): V3 => [Math.pow(Math.max(0, c[0]), g), Math.pow(Math.max(0, c[1]), g), Math.pow(Math.max(0, c[2]), g)];
const g3 = (v: number): V3 => [v, v, v];
const ONE: V3 = [1, 1, 1];
/** Split toning: push shadows toward `sh` and highlights toward `hi` (0.5 = neutral). */
const split3 = (c: V3, sh: V3, hi: V3, a: number): V3 => {
  const l = clamp(luma3(c), 0, 1), ws = (1 - l) * (1 - l) * a, wh = l * l * a;
  return [c[0] + (sh[0] - 0.5) * ws + (hi[0] - 0.5) * wh, c[1] + (sh[1] - 0.5) * ws + (hi[1] - 0.5) * wh, c[2] + (sh[2] - 0.5) * ws + (hi[2] - 0.5) * wh];
};
const overlay1 = (a: number, b: number) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b));
const LOOKS: Record<string, (c: V3) => V3> = {
  'Teal & Orange': (c) => {
    const w = clamp(c[0] - c[2], -1, 1);
    const o: V3 = w > 0 ? [c[0] + 0.06 * w, c[1] + 0.015 * w, c[2] - 0.06 * w] : [c[0] + 0.08 * w, c[1] - 0.01 * w, c[2] - 0.05 * w];
    return sat3(con3(split3(o, [0.1, 0.55, 0.6], [0.95, 0.65, 0.4], 0.5), 0.3), 1.1);
  },
  'Warm Film': (c) => sat3(lift3(con3(mul3(c, [1.08, 1, 0.86]), 0.2), [0.04, 0.035, 0.03], [0.98, 0.96, 0.92]), 0.9),
  'Cool Film': (c) => sat3(lift3(con3(mul3(c, [0.9, 0.99, 1.1]), 0.2), [0.02, 0.035, 0.06], [0.95, 0.98, 1]), 0.85),
  'Bleach Bypass': (c) => { const l = luma3(c); return con3(sat3([overlay1(c[0], l), overlay1(c[1], l), overlay1(c[2], l)], 0.45), 0.2); },
  'Sepia Tone': (c) => lift3(mul3(g3(sc1(luma3(c), 0.15)), [1.1, 0.95, 0.72]), [0.05, 0.03, 0.02], ONE),
  'Cross Process': (c) => sat3([sc1(c[0], 0.6), sc1(c[1], 0.4) * 0.94 + 0.04, 0.14 + c[2] * 0.7], 1.1),
  'Moonlight': (c) => lift3(mul3(pow3(sat3(c, 0.25), 1.5), [0.72, 0.86, 1.12]), [0, 0.01, 0.04], ONE),
  'Faded Matte': (c) => sat3(lift3(con3(c, -0.1), [0.1, 0.1, 0.11], [0.93, 0.93, 0.92]), 0.82),
  'Vintage': (c) => con3(sat3(lift3(split3(c, [0.55, 0.35, 0.6], [1, 0.9, 0.5], 0.4), [0.08, 0.06, 0.05], [0.97, 0.94, 0.84]), 0.75), 0.1),
  'Kodachrome': (c) => sat3(con3(mul3(c, [1.04, 1, 0.95]), 0.4), 1.35),
  'High Contrast B&W': (c) => g3(sc1(sc1(luma3(c), 1), 0.6)),
  'Candlelight': (c) => sat3(pow3(mul3(c, [1.12, 0.86, 0.55]), 1.15), 0.95),
};
const LN = 33;
const lookCache = new Map<string, Float32Array>();
function lookTable(name: string): Float32Array | null {
  const f = LOOKS[name];
  if (!f) return null;
  let t = lookCache.get(name);
  if (!t) {
    t = new Float32Array(LN * LN * LN * 3);
    let o = 0;
    for (let r = 0; r < LN; r++) for (let g = 0; g < LN; g++) for (let b = 0; b < LN; b++) {
      const v = f([r / (LN - 1), g / (LN - 1), b / (LN - 1)]);
      for (let c = 0; c < 3; c++) t[o++] = (isFinite(v[c]) ? clamp(v[c], 0, 1) : 0) * 255;
    }
    lookCache.set(name, t);
  }
  return t;
}
const clDefaults = () => ({ look: '', intensity: 100 });
registerAdjustment({
  kind: 'colorlookup', name: 'Color Lookup', icon: 'a-colorlookup',
  defaults: clDefaults,
  apply(d, p) {
    const t = lookTable(p.look);
    const k = clamp(nv(p.intensity, 100), 0, 100) / 100;
    if (!t || !k) return;
    const S = (LN - 1) / 255, sR = LN * LN * 3, sG = LN * 3;
    for (let i = 0, n = d.length; i < n; i += 4) {
      const fr = d[i] * S, fg = d[i + 1] * S, fb = d[i + 2] * S;
      let ir = fr | 0, ig = fg | 0, ib = fb | 0;
      if (ir > LN - 2) ir = LN - 2;
      if (ig > LN - 2) ig = LN - 2;
      if (ib > LN - 2) ib = LN - 2;
      const dr = fr - ir, dg = fg - ig, db = fb - ib, o = ir * sR + ig * sG + ib * 3;
      for (let c = 0; c < 3; c++) {
        const q = o + c;
        const c00 = t[q] + (t[q + 3] - t[q]) * db;
        const c01 = t[q + sG] + (t[q + sG + 3] - t[q + sG]) * db;
        const c10 = t[q + sR] + (t[q + sR + 3] - t[q + sR]) * db;
        const c11 = t[q + sR + sG] + (t[q + sR + sG + 3] - t[q + sR + sG]) * db;
        const e0 = c00 + (c01 - c00) * dg, e1 = c10 + (c11 - c10) * dg;
        const s = d[i + c];
        d[i + c] = s + (e0 + (e1 - e0) * dr - s) * k;
      }
    }
  },
  buildUI: ui('colorlookup', clDefaults, null, (api) => {
    const p = api.get();
    return col(
      h('div', { class: 'row' }, lbl('Look:'), select({
        options: [{ value: '', label: 'None' }, '-', ...Object.keys(LOOKS)], value: p.look ?? '',
        onChange: (v) => setKey(api, 'look', v),
      }).el),
      sf('Intensity', nv(p.intensity, 100), 0, 100, 100, (v) => setKey(api, 'intensity', v), { unit: '%' }).el,
    );
  }),
});

// =====================================================================
// Invert / Posterize / Threshold
// =====================================================================
const INVERT = lutFrom((v) => 255 - v);
registerAdjustment({
  kind: 'invert', name: 'Invert', icon: 'a-invert', shortcut: 'Ctrl+I', noDialog: true,
  defaults: () => ({}),
  apply(d) { applyLuts(d, INVERT, INVERT, INVERT); },
  buildUI: ui('invert', () => ({}), null, note('No properties')),
});

const postLut = memo((p) => {
  const n = clamp(Math.round(nv(p.levels, 4)), 2, 255);
  return lutFrom((v) => (Math.floor((v * n) / 256) * 255) / (n - 1));
});
registerAdjustment({
  kind: 'posterize', name: 'Posterize', icon: 'a-posterize',
  defaults: () => ({ levels: 4 }),
  apply(d, p) { const l = postLut(p); applyLuts(d, l, l, l); },
  buildUI: ui('posterize', () => ({ levels: 4 }), null, (api) =>
    col(sf('Levels', nv(api.get().levels, 4), 2, 255, 4, (v) => setKey(api, 'levels', v)).el)),
});

registerAdjustment({
  kind: 'threshold', name: 'Threshold', icon: 'a-threshold',
  defaults: () => ({ level: 128 }),
  apply(d, p) {
    const t = clamp(Math.round(nv(p.level, 128)), 1, 255);
    for (let i = 0, n = d.length; i < n; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) >= t ? 255 : 0;
    }
  },
  buildUI: ui('threshold', () => ({ level: 128 }), null, (api, ctx) => {
    const hist = histView(histogramOf(ctx.source()), 'lum');
    const set = (v: number) => { v = clamp(Math.round(v), 1, 255); setKey(api, 'level', v); track.set([v]); field.set(v); };
    const track = handleTrack(['#000'], (_, v) => set(v));
    const field = numberInput({ value: nv(api.get().level, 128), min: 1, max: 255, width: 48, onInput: set });
    track.set([field.get()]);
    return col(
      h('div', { class: 'adj-lv' }, hist.el, track.el),
      h('div', { class: 'row adj-io' }, lbl('Threshold Level:'), field.el),
    );
  }),
});

// =====================================================================
// Gradient Map
// =====================================================================
const FGBG = 'Foreground to Background';
const copyGradient = (g: Gradient): Gradient => ({ name: g.name, stops: g.stops.map((s) => ({ ...s, color: { ...s.color } })) });
const gmDefaults = () => ({ gradient: fgBgGradient(app.fg, app.bg), reverse: false, dither: false });
const gmLut = memo((p) => {
  const g: Gradient = p.gradient?.stops?.length ? p.gradient : GRADIENT_PRESETS[0];
  return gradientLUT(g, !!p.reverse, 1024);
});
/** Gradient preview as CSS (opacity ignored, like the gradient map itself). */
function opaqueCss(g: Gradient | undefined, reverse: boolean): string {
  if (!g?.stops?.length) return 'transparent';
  const st = [...g.stops].sort((a, b) => a.pos - b.pos).map((s) => `${cssColor(s.color)} ${((reverse ? 1 - s.pos : s.pos) * 100).toFixed(1)}%`);
  if (reverse) st.reverse();
  return `linear-gradient(90deg, ${st.join(', ')})`;
}
registerAdjustment({
  kind: 'gradientmap', name: 'Gradient Map', icon: 'a-gradientmap',
  defaults: gmDefaults,
  apply(d, p) {
    const lut = gmLut(p), dither = !!p.dither, S = 1023 / 255;
    for (let i = 0, n = d.length; i < n; i += 4) {
      let t = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * S;
      let nz = 0;
      if (dither) {
        const hsh = Math.imul((i >> 2) ^ 0x5bd1e995, 0x9e3779b1) >>> 0;
        nz = (hsh & 255) / 255 - 0.5;
        t += nz * 4;
      }
      const o = (t <= 0 ? 0 : t >= 1023 ? 1023 : Math.round(t)) * 4;
      d[i] = lut[o] + nz; d[i + 1] = lut[o + 1] + nz; d[i + 2] = lut[o + 2] + nz;
    }
  },
  buildUI: ui('gradientmap', gmDefaults, null, (api) => {
    const p = api.get();
    const strip = h('div', { class: 'adj-gm', title: 'Gradient used to map shadows (left) to highlights (right)' });
    const paint = () => { strip.style.background = opaqueCss(api.get().gradient, !!api.get().reverse); };
    const names = [FGBG, ...GRADIENT_PRESETS.map((g) => g.name ?? '')];
    const curName: string = p.gradient?.name ?? 'Custom';
    const opts: Option[] = [...names];
    if (!names.includes(curName)) opts.unshift(curName);
    const gsel = select({
      options: opts, value: curName,
      onChange: (v) => {
        const pre = GRADIENT_PRESETS.find((g) => g.name === v);
        const gr = v === FGBG ? fgBgGradient(app.fg, app.bg) : pre ? copyGradient(pre) : null;
        if (gr) { setKey(api, 'gradient', gr); paint(); }
      },
    });
    paint();
    return col(
      strip,
      h('div', { class: 'row' }, lbl('Gradient:'), gsel.el),
      checkbox({ label: 'Dither', checked: !!p.dither, onChange: (v) => setKey(api, 'dither', v) }).el,
      checkbox({ label: 'Reverse', checked: !!p.reverse, onChange: (v) => { setKey(api, 'reverse', v); paint(); } }).el,
    );
  }),
});

// =====================================================================
// Selective Color
// =====================================================================
const SC_KEYS = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const;
const SC_LABEL = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas', 'Whites', 'Neutrals', 'Blacks'];
const scDefaults = () => {
  const p: P = { method: 'relative' };
  for (const k of SC_KEYS) p[k] = [0, 0, 0, 0];
  return p;
};
const scPrep = memo((p) => {
  const adj = SC_KEYS.map((k) => { const a = p[k] as number[] | undefined; return a && a.some((v) => v) ? [0, 1, 2, 3].map((i) => nv(a[i], 0) / 100) : null; });
  return { adj, rel: p.method !== 'absolute', any: adj.some(Boolean) };
});
/** Photoshop selective color channel delta (CMY ink adjust `a`, black `k`), limited to the channel's headroom. */
function scDelta(v: number, a: number, k: number, rel: boolean) {
  let t = (-1 - a) * k - a;
  if (rel) t *= 1 - v;
  return t < -v ? -v : t > 1 - v ? 1 - v : t;
}
function scAdd(acc: Float64Array, r: number, g: number, b: number, a: number[] | null, w: number, rel: boolean) {
  if (!a || w <= 0) return;
  acc[0] += scDelta(r, a[0], a[3], rel) * w;
  acc[1] += scDelta(g, a[1], a[3], rel) * w;
  acc[2] += scDelta(b, a[2], a[3], rel) * w;
}
registerAdjustment({
  kind: 'selectivecolor', name: 'Selective Color', icon: 'a-selectivecolor',
  defaults: scDefaults,
  apply(d, p) {
    const { adj, rel, any } = scPrep(p);
    if (!any) return;
    const [aR, aY, aG, aC, aB, aM, aW, aN, aK] = adj;
    const acc = new Float64Array(3);
    for (let i = 0, n = d.length; i < n; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const mid = r + g + b - mx - mn;
      acc[0] = acc[1] = acc[2] = 0;
      if (mx > mid) scAdd(acc, r, g, b, r === mx ? aR : g === mx ? aG : aB, mx - mid, rel);
      if (mid > mn) scAdd(acc, r, g, b, b === mn ? aY : r === mn ? aC : aM, mid - mn, rel);
      if (mn > 0.5) scAdd(acc, r, g, b, aW, (mn - 0.5) * 2, rel);
      if (mx < 0.5) scAdd(acc, r, g, b, aK, (0.5 - mx) * 2, rel);
      scAdd(acc, r, g, b, aN, 1 - (Math.abs(mx - 0.5) + Math.abs(mn - 0.5)), rel);
      d[i] = (r + acc[0]) * 255; d[i + 1] = (g + acc[1]) * 255; d[i + 2] = (b + acc[2]) * 255;
    }
  },
  buildUI: ui('selectivecolor', scDefaults, null, (api) => {
    const m = mem('selectivecolor');
    let c: string = m.color ?? 'reds';
    const fields = ['Cyan', 'Magenta', 'Yellow', 'Black'].map((n, k) => sf(n, 0, -100, 100, 0, (v) => {
      const p = api.get();
      const a = [...((p[c] ?? [0, 0, 0, 0]) as number[])];
      a[k] = v;
      api.set({ ...p, [c]: a });
    }, { unit: '%' }));
    const sync = () => fields.forEach((f, k) => f.set(nv(api.get()[c]?.[k], 0)));
    const csel = select({ options: SC_KEYS.map((k, i) => ({ value: k, label: SC_LABEL[i] })), value: c, onChange: (v) => { c = m.color = v; sync(); } });
    const grp = `sc${++radioSeq}`, abs = api.get().method === 'absolute';
    sync();
    return col(
      h('div', { class: 'row' }, lbl('Colors:'), csel.el),
      ...fields.map((f) => f.el),
      h('div', { class: 'row', style: { gap: '14px' } },
        radio(grp, 'Relative', !abs, () => setKey(api, 'method', 'relative')),
        radio(grp, 'Absolute', abs, () => setKey(api, 'method', 'absolute'))),
    );
  }),
});

// =====================================================================
// Desaturate / Equalize (Image menu only)
// =====================================================================
registerAdjustment({
  kind: 'desaturate', name: 'Desaturate', icon: 'a-desaturate', shortcut: 'Shift+Ctrl+U', noDialog: true, noLayer: true,
  defaults: () => ({}),
  apply(d) {
    for (let i = 0, n = d.length; i < n; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const mx = R > G ? (R > B ? R : B) : (G > B ? G : B), mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
      d[i] = d[i + 1] = d[i + 2] = (mx + mn) / 2;
    }
  },
  buildUI: ui('desaturate', () => ({}), null, note('No properties')),
});

registerAdjustment({
  kind: 'equalize', name: 'Equalize', icon: 'a-levels', noDialog: true, noLayer: true,
  defaults: () => ({}),
  apply(d) {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      hist[d[i]]++; hist[d[i + 1]]++; hist[d[i + 2]]++;
      n += 3;
    }
    if (!n) return;
    let acc = 0, cmin = -1;
    const cdf = new Float64Array(256);
    for (let v = 0; v < 256; v++) { acc += hist[v]; cdf[v] = acc; if (cmin < 0 && acc > 0) cmin = acc; }
    if (n === cmin) return;
    const lut = identOr(lutFrom((v) => (Math.max(0, cdf[v] - cmin) / (n - cmin)) * 255));
    applyLuts(d, lut, lut, lut);
  },
  buildUI: ui('equalize', () => ({}), null, note('No properties')),
});
