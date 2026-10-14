// Filter menu: parameter dialogs (live canvas preview + Preview checkbox) and the menu model.
// Algorithms live in core/filters.ts; this file only builds UI and wires it to ops/target.
import { app } from '../app';
import * as F from '../core/filters';
import { clamp, createCanvas, ctx2d, debounce, rafThrottle, Rect, rectIntersect } from '../core/util';
import { alphaToGray, applyFilter, currentTarget, editableTarget, endPreview, FilterFn, FilterOpts, previewFilter } from '../ops/target';
import { h, injectStyle, onDrag } from '../ui/dom';
import { MenuItem, SEP } from '../ui/menutypes';
import { button, checkbox, labeled, numberInput, Option, section, select, sliderField } from '../ui/widgets';
import { openCameraRaw } from './cameraraw';
import { openDialog } from './dialog';
import { openLiquify } from './liquify';

injectStyle('filterdialogs', `
.flt-body { display: flex; flex-direction: column; gap: 10px; min-width: 260px; }
.flt-radio { display: flex; flex-direction: column; gap: 5px; }
.flt-radio.inline { flex-direction: row; flex-wrap: wrap; gap: 5px 16px; }
.flt-radio label { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.flt-radio input { accent-color: var(--accent); margin: 0; }
.flt-center { align-self: center; background: var(--pasteboard); border: 1px solid var(--border); cursor: crosshair; line-height: 0; touch-action: none; }
.flt-center canvas { display: block; }
.flt-kernel { display: grid; grid-template-columns: repeat(5, 48px); gap: 4px; justify-content: center; }
.flt-kernel .ps-input.num { width: 48px; text-align: center; }
.flt-kernel-opts { display: flex; justify-content: center; gap: 18px; }
.flt-kernel-opts .row.labeled .field-label { min-width: 0; }
.flt-hint { color: var(--text-3); font-size: 11px; }
body.photon-busy, body.photon-busy * { cursor: progress !important; }
`);

type P = Record<string, any>;
type Ctl =
  | { t: 'slider'; key: string; label: string; min: number; max: number; step?: number; unit?: string }
  | { t: 'select'; key: string; label: string; options: Option[] }
  | { t: 'radio'; key: string; label?: string; options: [string, string][]; inline?: boolean }
  | { t: 'check'; key: string; label: string }
  | { t: 'center'; x: string; y: string; label?: string; whole?: boolean; overlay?: (x: CanvasRenderingContext2D, w: number, h: number, p: P) => void }
  | { t: 'seed'; label?: string }
  | { t: 'group'; title: string; items: Ctl[] }
  | { t: 'custom'; build: (p: P, update: () => void) => HTMLElement };

interface Spec {
  /** Dialog title, history step and Last Filter name. */
  name: string;
  defaults: P | (() => P);
  controls: Ctl[] | (() => Ctl[]);
  fn: (p: P) => FilterFn;
  opts?: (p: P) => FilterOpts;
  /** Debounce previews (ms) for slow filters; default = once per animation frame. */
  delay?: number;
  width?: number;
  /** Keep p.seed (Wave's Randomize); otherwise each dialog / Last Filter run gets a fresh seed. */
  keepSeed?: boolean;
}

interface Ctx { p: P; defaults: P; update: () => void; listeners: (() => void)[] }

/** Last-used parameters per filter (Photoshop remembers them for the session). */
const memo = new Map<string, P>();
let radioId = 0;

/** Show a progress cursor and let the browser paint (dialog closing) before a slow synchronous filter. */
async function busy<T>(fn: () => Promise<T>): Promise<T> {
  document.body.classList.add('photon-busy');
  await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try { return await fn(); } finally { document.body.classList.remove('photon-busy'); }
}

function setLastFilter(spec: Spec, q: P) {
  app.lastFilter = {
    name: spec.name,
    run: () => {
      const r = structuredClone(q);
      if ('seed' in r && !spec.keepSeed) r.seed = F.newSeed();
      void busy(() => applyFilter(spec.name, spec.fn(r), spec.opts?.(r)));
    },
  };
}

/** Menu action for a filter without a dialog. make() is called per run (fresh seeds / current colors). */
function instant(name: string, make: () => FilterFn, opts?: FilterOpts): () => void {
  const run = async () => {
    const ok = await busy(() => applyFilter(name, make(), opts));
    if (ok) app.lastFilter = { name, run: () => void run() };
  };
  return () => void run();
}

/** Menu action that opens a parameter dialog with live preview. */
function dlg(spec: Spec): () => void {
  return () => void openFilterDialog(spec);
}

async function openFilterDialog(spec: Spec) {
  const doc = app.doc;
  if (!doc) return;
  if (!(await editableTarget(doc, 'use this filter'))) return;
  const defaults = typeof spec.defaults === 'function' ? spec.defaults() : spec.defaults;
  const p: P = structuredClone({ ...defaults, ...(memo.get(spec.name) ?? {}) });
  if ('seed' in p && !spec.keepSeed) p.seed = F.newSeed();
  let on = true, closed = false;
  const show = () => {
    if (closed || !on) return;
    try { previewFilter(spec.fn(p), spec.opts?.(p)); } catch (e) { console.error(`[${spec.name}]`, e); }
  };
  const schedule = spec.delay ? debounce(show, spec.delay) : rafThrottle(show);
  const ctx: Ctx = { p, defaults, listeners: [], update: () => { ctx.listeners.forEach((f) => f()); schedule(); } };
  const controls = typeof spec.controls === 'function' ? spec.controls() : spec.controls;
  const content = h('div', { class: 'flt-body' }, controls.map((c) => buildControl(c, ctx)));
  const ok = await openDialog({
    title: spec.name, content, layout: 'side', width: spec.width ?? 400, className: 'filter-dialog',
    preview: { checked: true, onToggle: (v) => { on = v; if (v) show(); else endPreview(); } },
    onOpen: () => { setTimeout(show, 30); },
    onCancel: () => { closed = true; endPreview(); },
  });
  closed = true;
  if (!ok) { endPreview(); return; }
  memo.set(spec.name, structuredClone(p));
  const q = structuredClone(p);
  const done = await busy(() => applyFilter(spec.name, spec.fn(q), spec.opts?.(q)));
  if (done) setLastFilter(spec, q);
}

// ---------- controls ----------
function buildControl(c: Ctl, ctx: Ctx): HTMLElement {
  const { p } = ctx;
  switch (c.t) {
    case 'slider':
      return sliderField({
        label: c.label, value: p[c.key], min: c.min, max: c.max, step: c.step, unit: c.unit, width: 58,
        reset: ctx.defaults[c.key], onInput: (v) => { p[c.key] = v; ctx.update(); },
      }).el;
    case 'select':
      return labeled(c.label, select({ options: c.options, value: p[c.key], onChange: (v) => { p[c.key] = v; ctx.update(); } }).el);
    case 'check':
      return checkbox({ label: c.label, checked: !!p[c.key], onChange: (v) => { p[c.key] = v; ctx.update(); } }).el;
    case 'radio': {
      const name = `flt-radio-${++radioId}`;
      const items = c.options.map(([value, label]) => {
        const inp = h('input', { type: 'radio', name, value }) as HTMLInputElement;
        inp.checked = p[c.key] === value;
        inp.addEventListener('change', () => { if (inp.checked) { p[c.key] = value; ctx.update(); } });
        return h('label', null, inp, h('span', null, label));
      });
      const box = h('div', { class: `flt-radio${c.inline ? ' inline' : ''}` }, items);
      return c.label ? h('div', { class: 'col' }, h('div', { class: 'field-label' }, c.label), box) : box;
    }
    case 'seed':
      return h('div', { class: 'row' }, button(c.label ?? 'Randomize', () => { p.seed = F.newSeed(); ctx.update(); }));
    case 'group':
      return section(c.title, ...c.items.map((it) => buildControl(it, ctx)));
    case 'custom':
      return c.build(p, ctx.update);
    case 'center':
      return centerPicker(c, ctx);
  }
}

/** The pixels a filter will see: selection bounds within the target, or the whole target. */
function regionSource(whole: boolean): HTMLCanvasElement | null {
  const doc = app.doc;
  const t = doc && currentTarget(doc);
  if (!doc || !t) return null;
  const full: Rect = { x: 0, y: 0, w: t.canvas.width, h: t.canvas.height };
  const sb = doc.selectionBounds();
  const r = !whole && sb && t.kind !== 'quickmask' ? rectIntersect({ x: sb.x - t.x, y: sb.y - t.y, w: sb.w, h: sb.h }, full) ?? full : full;
  let c = createCanvas(r.w, r.h);
  ctx2d(c).drawImage(t.canvas, -r.x, -r.y);
  if (t.alphaOnly) c = alphaToGray(c);
  return c;
}

/** Thumbnail of the filter region; click/drag sets p[x], p[y] (fractions 0..1). */
function centerPicker(c: Extract<Ctl, { t: 'center' }>, ctx: Ctx): HTMLElement {
  const src = regionSource(!!c.whole);
  const sw = src?.width ?? 4, sh = src?.height ?? 3, s = Math.min(220 / sw, 160 / sh);
  const cw = Math.max(24, Math.round(sw * s)), ch = Math.max(24, Math.round(sh * s));
  const base = createCanvas(cw, ch);
  if (src) { const bx = ctx2d(base); bx.imageSmoothingQuality = 'high'; bx.drawImage(src, 0, 0, cw, ch); }
  const cv = createCanvas(cw, ch);
  const draw = () => {
    const x = ctx2d(cv);
    x.clearRect(0, 0, cw, ch);
    x.drawImage(base, 0, 0);
    c.overlay?.(x, cw, ch, ctx.p);
    const px = Math.round(ctx.p[c.x] * cw) + 0.5, py = Math.round(ctx.p[c.y] * ch) + 0.5;
    for (const [col, wd] of [['rgba(0,0,0,.75)', 3], ['#fff', 1]] as [string, number][]) {
      x.strokeStyle = col; x.lineWidth = wd;
      x.beginPath();
      x.moveTo(px - 9, py); x.lineTo(px - 3, py); x.moveTo(px + 3, py); x.lineTo(px + 9, py);
      x.moveTo(px, py - 9); x.lineTo(px, py - 3); x.moveTo(px, py + 3); x.lineTo(px, py + 9);
      x.stroke();
    }
  };
  const set = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    ctx.p[c.x] = clamp((e.clientX - r.left) / r.width, 0, 1);
    ctx.p[c.y] = clamp((e.clientY - r.top) / r.height, 0, 1);
    ctx.update();
  };
  onDrag(cv, { down: (e) => { set(e); }, move: (e) => set(e) });
  ctx.listeners.push(draw);
  draw();
  return h('div', { class: 'col' },
    c.label ? h('div', { class: 'field-label' }, c.label) : null,
    h('div', { class: 'flt-center' }, cv));
}

// =====================================================================
// Filter specs
// =====================================================================
const px = 'Pixels';
const pct = '%';

// ---------- Blur ----------
const BOX_BLUR: Spec = {
  name: 'Box Blur', defaults: { radius: 10 }, delay: 120,
  controls: [{ t: 'slider', key: 'radius', label: 'Radius:', min: 1, max: 500, unit: px }],
  fn: (p) => (s) => F.boxBlur(s, p.radius), opts: (p) => ({ pad: Math.ceil(p.radius) + 1 }),
};
const GAUSSIAN_BLUR: Spec = {
  name: 'Gaussian Blur', defaults: { radius: 5 },
  controls: [{ t: 'slider', key: 'radius', label: 'Radius:', min: 0.1, max: 250, step: 0.1, unit: px }],
  fn: (p) => (s) => F.gaussianBlur(s, p.radius), opts: (p) => ({ pad: Math.ceil(p.radius * 3) }),
};
const MOTION_BLUR: Spec = {
  name: 'Motion Blur', defaults: { angle: 0, distance: 10 }, delay: 120,
  controls: [
    { t: 'slider', key: 'angle', label: 'Angle:', min: -90, max: 90, unit: '°' },
    { t: 'slider', key: 'distance', label: 'Distance:', min: 1, max: 999, unit: px },
  ],
  fn: (p) => (s) => F.motionBlur(s, p.angle, p.distance), opts: (p) => ({ pad: Math.ceil(p.distance / 2) + 2 }),
};
const RADIAL_BLUR: Spec = {
  name: 'Radial Blur', defaults: { amount: 10, method: 'spin', quality: 'good', cx: 0.5, cy: 0.5 }, delay: 200,
  controls: [
    { t: 'slider', key: 'amount', label: 'Amount:', min: 1, max: 100 },
    { t: 'radio', key: 'method', label: 'Blur Method:', inline: true, options: [['spin', 'Spin'], ['zoom', 'Zoom']] },
    { t: 'radio', key: 'quality', label: 'Quality:', inline: true, options: [['draft', 'Draft'], ['good', 'Good'], ['best', 'Best']] },
    {
      t: 'center', x: 'cx', y: 'cy', label: 'Blur Center:',
      overlay: (x, w, h, p) => {
        // spin circles / zoom rays guide like Photoshop's
        x.strokeStyle = 'rgba(255,255,255,.35)'; x.lineWidth = 1;
        const cx = p.cx * w, cy = p.cy * h, R = Math.hypot(w, h);
        x.beginPath();
        if (p.method === 'spin') for (let r = 12; r < R; r += 12) { x.moveTo(cx + r, cy); x.arc(cx, cy, r, 0, Math.PI * 2); }
        else for (let a = 0; a < 360; a += 10) { const t = (a * Math.PI) / 180; x.moveTo(cx, cy); x.lineTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R); }
        x.stroke();
      },
    },
  ],
  fn: (p) => (s) => F.radialBlur(s, p.method, p.amount, p.cx, p.cy, p.quality),
};
const SURFACE_BLUR: Spec = {
  name: 'Surface Blur', defaults: { radius: 5, threshold: 15 }, delay: 150,
  controls: [
    { t: 'slider', key: 'radius', label: 'Radius:', min: 1, max: 100, unit: px },
    { t: 'slider', key: 'threshold', label: 'Threshold:', min: 2, max: 255, unit: 'levels' },
  ],
  fn: (p) => (s) => F.surfaceBlur(s, p.radius, p.threshold), opts: (p) => ({ pad: Math.ceil(p.radius) * 2 }),
};

// ---------- Blur Gallery (positions relative to the whole layer) ----------
const TILT_SHIFT: Spec = {
  name: 'Tilt-Shift', defaults: { blur: 15, center: 50, focus: 20, transition: 25, angle: 0 }, delay: 120,
  controls: [
    { t: 'slider', key: 'blur', label: 'Blur:', min: 0, max: 500, unit: px },
    { t: 'slider', key: 'center', label: 'Focus Center:', min: 0, max: 100, unit: pct },
    { t: 'slider', key: 'focus', label: 'Focus Band:', min: 0, max: 100, unit: pct },
    { t: 'slider', key: 'transition', label: 'Transition:', min: 0, max: 100, unit: pct },
    { t: 'slider', key: 'angle', label: 'Angle:', min: -90, max: 90, unit: '°' },
  ],
  fn: (p) => (s) => F.tiltShift(s, p.blur, p.center, p.focus, p.transition, p.angle), opts: () => ({ wholeLayer: true }),
};
const IRIS_BLUR: Spec = {
  name: 'Iris Blur', defaults: { blur: 15, cx: 0.5, cy: 0.5, rx: 30, ry: 30, feather: 50 }, delay: 120,
  controls: [
    {
      t: 'center', x: 'cx', y: 'cy', whole: true, label: 'Center:',
      overlay: (x, w, h, p) => {
        const cx = p.cx * w, cy = p.cy * h, rx = (p.rx / 100) * w, ry = (p.ry / 100) * h, k = 1 - p.feather / 100;
        x.lineWidth = 1;
        x.strokeStyle = 'rgba(255,255,255,.85)';
        x.beginPath(); x.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2); x.stroke();
        x.setLineDash([3, 3]);
        x.beginPath(); x.ellipse(cx, cy, Math.max(0.5, rx * k), Math.max(0.5, ry * k), 0, 0, Math.PI * 2); x.stroke();
        x.setLineDash([]);
      },
    },
    { t: 'slider', key: 'blur', label: 'Blur:', min: 0, max: 500, unit: px },
    { t: 'slider', key: 'rx', label: 'Horizontal Radius:', min: 1, max: 100, unit: pct },
    { t: 'slider', key: 'ry', label: 'Vertical Radius:', min: 1, max: 100, unit: pct },
    { t: 'slider', key: 'feather', label: 'Feather:', min: 0, max: 100, unit: pct },
  ],
  fn: (p) => (s) => F.irisBlur(s, p.blur, p.cx, p.cy, p.rx / 100, p.ry / 100, p.feather), opts: () => ({ wholeLayer: true }),
};

// ---------- Distort (centered on the selection bounds, like Photoshop) ----------
const D = 120;
const PINCH: Spec = {
  name: 'Pinch', defaults: { amount: 50 }, delay: D,
  controls: [{ t: 'slider', key: 'amount', label: 'Amount:', min: -100, max: 100, unit: pct }],
  fn: (p) => (s) => F.pinch(s, p.amount),
};
const POLAR: Spec = {
  name: 'Polar Coordinates', defaults: { mode: 'toPolar' }, delay: D,
  controls: [{ t: 'radio', key: 'mode', options: [['toPolar', 'Rectangular to Polar'], ['toRect', 'Polar to Rectangular']] }],
  fn: (p) => (s) => F.polarCoordinates(s, p.mode),
};
const RIPPLE: Spec = {
  name: 'Ripple', defaults: { amount: 100, size: 'medium' }, delay: D,
  controls: [
    { t: 'slider', key: 'amount', label: 'Amount:', min: -999, max: 999, unit: pct },
    { t: 'select', key: 'size', label: 'Size:', options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }] },
  ],
  fn: (p) => (s) => F.ripple(s, p.amount, p.size), opts: (p) => ({ pad: Math.ceil(Math.abs(p.amount) / 100 * 6) + 2 }),
};
const SPHERIZE: Spec = {
  name: 'Spherize', defaults: { amount: 100, mode: 'normal' }, delay: D,
  controls: [
    { t: 'slider', key: 'amount', label: 'Amount:', min: -100, max: 100, unit: pct },
    { t: 'select', key: 'mode', label: 'Mode:', options: [{ value: 'normal', label: 'Normal' }, { value: 'horizontal', label: 'Horizontal only' }, { value: 'vertical', label: 'Vertical only' }] },
  ],
  fn: (p) => (s) => F.spherize(s, p.amount, p.mode),
};
const TWIRL: Spec = {
  name: 'Twirl', defaults: { angle: 50 }, delay: D,
  controls: [{ t: 'slider', key: 'angle', label: 'Angle:', min: -999, max: 999, unit: '°' }],
  fn: (p) => (s) => F.twirl(s, p.angle),
};
const WAVE: Spec = {
  name: 'Wave', keepSeed: true, delay: D, width: 440,
  defaults: { generators: 5, wlMin: 10, wlMax: 120, ampMin: 5, ampMax: 35, scaleH: 100, scaleV: 100, type: 'sine', undef: 'repeat', seed: 1 },
  controls: [
    { t: 'slider', key: 'generators', label: 'Number of Generators:', min: 1, max: 999 },
    { t: 'group', title: 'Wavelength', items: [
      { t: 'slider', key: 'wlMin', label: 'Min:', min: 1, max: 998 },
      { t: 'slider', key: 'wlMax', label: 'Max:', min: 2, max: 999 },
    ] },
    { t: 'group', title: 'Amplitude', items: [
      { t: 'slider', key: 'ampMin', label: 'Min:', min: 1, max: 998 },
      { t: 'slider', key: 'ampMax', label: 'Max:', min: 2, max: 999 },
    ] },
    { t: 'group', title: 'Scale', items: [
      { t: 'slider', key: 'scaleH', label: 'Horiz.:', min: 1, max: 100, unit: pct },
      { t: 'slider', key: 'scaleV', label: 'Vert.:', min: 1, max: 100, unit: pct },
    ] },
    { t: 'radio', key: 'type', label: 'Type:', inline: true, options: [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']] },
    { t: 'radio', key: 'undef', label: 'Undefined Areas:', inline: true, options: [['wrap', 'Wrap Around'], ['repeat', 'Repeat Edge Pixels']] },
    { t: 'seed' },
  ],
  fn: (p) => (s) => F.wave(s, p as F.WaveParams),
};
const ZIGZAG: Spec = {
  name: 'ZigZag', defaults: { amount: 10, ridges: 5, style: 'pond' }, delay: D,
  controls: [
    { t: 'slider', key: 'amount', label: 'Amount:', min: -100, max: 100 },
    { t: 'slider', key: 'ridges', label: 'Ridges:', min: 1, max: 20 },
    { t: 'select', key: 'style', label: 'Style:', options: [{ value: 'pond', label: 'Pond ripples' }, { value: 'out', label: 'Out from center' }, { value: 'around', label: 'Around center' }] },
  ],
  fn: (p) => (s) => F.zigzag(s, p.amount, p.ridges, p.style),
};

// ---------- Lens Correction ----------
const LENS_CORRECTION: Spec = {
  name: 'Lens Correction', delay: 150, width: 420,
  defaults: { distortion: 0, caRed: 0, caBlue: 0, vignette: 0, midpoint: 50, scale: 100, edge: 'transparent' },
  controls: [
    { t: 'group', title: 'Geometric Distortion', items: [{ t: 'slider', key: 'distortion', label: 'Remove Distortion:', min: -100, max: 100, step: 0.5 }] },
    { t: 'group', title: 'Chromatic Aberration', items: [
      { t: 'slider', key: 'caRed', label: 'Fix Red/Cyan Fringe:', min: -100, max: 100 },
      { t: 'slider', key: 'caBlue', label: 'Fix Blue/Yellow Fringe:', min: -100, max: 100 },
    ] },
    { t: 'group', title: 'Vignette', items: [
      { t: 'slider', key: 'vignette', label: 'Amount:', min: -100, max: 100 },
      { t: 'slider', key: 'midpoint', label: 'Midpoint:', min: 0, max: 100 },
    ] },
    { t: 'group', title: 'Transform', items: [{ t: 'slider', key: 'scale', label: 'Scale:', min: 50, max: 150, unit: pct }] },
    { t: 'select', key: 'edge', label: 'Edge:', options: [{ value: 'transparent', label: 'Transparency' }, { value: 'extend', label: 'Edge Extension' }] },
  ],
  fn: (p) => (s) => F.lensCorrection(s, p as F.LensCorrectionParams), opts: () => ({ wholeLayer: true }),
};

// ---------- Noise ----------
const ADD_NOISE: Spec = {
  name: 'Add Noise', defaults: { amount: 12.5, dist: 'uniform', mono: false, seed: 1 }, delay: 60,
  controls: [
    { t: 'slider', key: 'amount', label: 'Amount:', min: 0.1, max: 400, step: 0.1, unit: pct },
    { t: 'radio', key: 'dist', label: 'Distribution', options: [['uniform', 'Uniform'], ['gaussian', 'Gaussian']] },
    { t: 'check', key: 'mono', label: 'Monochromatic' },
  ],
  fn: (p) => (s) => F.addNoise(s, p.amount, p.dist === 'gaussian', p.mono, p.seed),
};
const DUST: Spec = {
  name: 'Dust & Scratches', defaults: { radius: 1, threshold: 0 }, delay: 150,
  controls: [
    { t: 'slider', key: 'radius', label: 'Radius:', min: 1, max: 100, unit: px },
    { t: 'slider', key: 'threshold', label: 'Threshold:', min: 0, max: 255, unit: 'levels' },
  ],
  fn: (p) => (s) => F.dustAndScratches(s, p.radius, p.threshold), opts: (p) => ({ pad: p.radius + 1 }),
};
const MEDIAN: Spec = {
  name: 'Median', defaults: { radius: 1 }, delay: 150,
  controls: [{ t: 'slider', key: 'radius', label: 'Radius:', min: 1, max: 100, unit: px }],
  fn: (p) => (s) => F.median(s, p.radius), opts: (p) => ({ pad: p.radius + 1 }),
};
const REDUCE_NOISE: Spec = {
  name: 'Reduce Noise', defaults: { strength: 6, preserve: 60, color: 45, sharpen: 25 }, delay: 150,
  controls: [
    { t: 'slider', key: 'strength', label: 'Strength:', min: 0, max: 10 },
    { t: 'slider', key: 'preserve', label: 'Preserve Details:', min: 0, max: 100, unit: pct },
    { t: 'slider', key: 'color', label: 'Reduce Color Noise:', min: 0, max: 100, unit: pct },
    { t: 'slider', key: 'sharpen', label: 'Sharpen Details:', min: 0, max: 100, unit: pct },
  ],
  fn: (p) => (s) => F.reduceNoise(s, p.strength, p.preserve, p.color, p.sharpen), opts: () => ({ pad: 16 }),
};

// ---------- Pixelate ----------
const COLOR_HALFTONE: Spec = {
  name: 'Color Halftone', defaults: { radius: 8, a1: 108, a2: 162, a3: 90, a4: 45 }, delay: 150,
  controls: [
    { t: 'slider', key: 'radius', label: 'Max. Radius:', min: 4, max: 127, unit: px },
    { t: 'group', title: 'Screen Angles (Degrees)', items: [
      { t: 'slider', key: 'a1', label: 'Channel 1:', min: -360, max: 360 },
      { t: 'slider', key: 'a2', label: 'Channel 2:', min: -360, max: 360 },
      { t: 'slider', key: 'a3', label: 'Channel 3:', min: -360, max: 360 },
      { t: 'slider', key: 'a4', label: 'Channel 4:', min: -360, max: 360 },
    ] },
  ],
  fn: (p) => (s) => F.colorHalftone(s, p.radius, [p.a1, p.a2, p.a3, p.a4]), opts: (p) => ({ pad: p.radius * 2 }),
};
const CRYSTALLIZE: Spec = {
  name: 'Crystallize', defaults: { cell: 10, seed: 1 }, delay: 150,
  controls: [{ t: 'slider', key: 'cell', label: 'Cell Size:', min: 3, max: 300, unit: '' }],
  fn: (p) => (s) => F.crystallize(s, p.cell, p.seed), opts: (p) => ({ pad: p.cell * 2 }),
};
const MEZZOTINT: Spec = {
  name: 'Mezzotint', defaults: { type: 'fine-dots', seed: 1 }, delay: 60,
  controls: [{
    t: 'select', key: 'type', label: 'Type:', options: [
      { value: 'fine-dots', label: 'Fine Dots' }, { value: 'medium-dots', label: 'Medium Dots' }, { value: 'grainy-dots', label: 'Grainy Dots' },
      { value: 'coarse-dots', label: 'Coarse Dots' }, { value: 'short-lines', label: 'Short Lines' }, { value: 'medium-lines', label: 'Medium Lines' },
      { value: 'long-lines', label: 'Long Lines' }, { value: 'short-strokes', label: 'Short Strokes' }, { value: 'medium-strokes', label: 'Medium Strokes' },
      { value: 'long-strokes', label: 'Long Strokes' },
    ],
  }],
  fn: (p) => (s) => F.mezzotint(s, p.type, p.seed),
};
const MOSAIC: Spec = {
  name: 'Mosaic', defaults: { cell: 8 },
  controls: [{ t: 'slider', key: 'cell', label: 'Cell Size:', min: 2, max: 200, unit: 'square' }],
  fn: (p) => (s) => F.mosaic(s, p.cell),
};
const POINTILLIZE: Spec = {
  name: 'Pointillize', defaults: { cell: 5, seed: 1 }, delay: 150,
  controls: [
    { t: 'slider', key: 'cell', label: 'Cell Size:', min: 3, max: 300, unit: '' },
    { t: 'custom', build: () => h('div', { class: 'flt-hint' }, 'Uses the background color between dots.') },
  ],
  fn: (p) => (s) => F.pointillize(s, p.cell, app.bg, p.seed), opts: (p) => ({ pad: p.cell * 2 }),
};

// ---------- Render ----------
const FIBERS: Spec = {
  name: 'Fibers', defaults: { variance: 16, strength: 4, seed: 1 }, delay: 150, keepSeed: false,
  controls: [
    { t: 'slider', key: 'variance', label: 'Variance:', min: 1, max: 64 },
    { t: 'slider', key: 'strength', label: 'Strength:', min: 1, max: 64 },
    { t: 'seed' },
  ],
  fn: (p) => (s) => F.fibers(s, p.variance, p.strength, app.fg, app.bg, p.seed),
};
const LENS_FLARE: Spec = {
  name: 'Lens Flare', defaults: { brightness: 100, cx: 0.35, cy: 0.35, lens: 'zoom' },
  controls: [
    { t: 'center', x: 'cx', y: 'cy', whole: true, label: 'Flare Center:' },
    { t: 'slider', key: 'brightness', label: 'Brightness:', min: 10, max: 300, unit: pct },
    { t: 'radio', key: 'lens', label: 'Lens Type', options: [['zoom', '50-300mm Zoom'], ['prime35', '35mm Prime'], ['prime105', '105mm Prime'], ['movie', 'Movie Prime']] },
  ],
  fn: (p) => (s) => F.lensFlare(s, p.cx * s.width, p.cy * s.height, p.brightness, p.lens), opts: () => ({ wholeLayer: true }),
};

// ---------- Sharpen ----------
const SMART_SHARPEN: Spec = {
  name: 'Smart Sharpen', defaults: { amount: 200, radius: 1, noise: 10, remove: 'gaussian', angle: 0 }, delay: 150,
  controls: [
    { t: 'slider', key: 'amount', label: 'Amount:', min: 0, max: 500, unit: pct },
    { t: 'slider', key: 'radius', label: 'Radius:', min: 0.1, max: 64, step: 0.1, unit: px },
    { t: 'slider', key: 'noise', label: 'Reduce Noise:', min: 0, max: 100, unit: pct },
    { t: 'select', key: 'remove', label: 'Remove:', options: [{ value: 'gaussian', label: 'Gaussian Blur' }, { value: 'lens', label: 'Lens Blur' }, { value: 'motion', label: 'Motion Blur' }] },
    { t: 'slider', key: 'angle', label: 'Motion Angle:', min: -180, max: 180, unit: '°' },
  ],
  fn: (p) => (s) => F.smartSharpen(s, p.amount, p.radius, p.noise, p.remove, p.angle), opts: (p) => ({ pad: Math.ceil(p.radius * 3) + 4 }),
};
const UNSHARP: Spec = {
  name: 'Unsharp Mask', defaults: { amount: 100, radius: 1, threshold: 0 }, delay: 40,
  controls: [
    { t: 'slider', key: 'amount', label: 'Amount:', min: 1, max: 500, unit: pct },
    { t: 'slider', key: 'radius', label: 'Radius:', min: 0.1, max: 1000, step: 0.1, unit: px },
    { t: 'slider', key: 'threshold', label: 'Threshold:', min: 0, max: 255, unit: 'levels' },
  ],
  fn: (p) => (s) => F.unsharpMask(s, p.amount, p.radius, p.threshold), opts: (p) => ({ pad: Math.ceil(p.radius * 3) }),
};

// ---------- Stylize ----------
const DIFFUSE: Spec = {
  name: 'Diffuse', defaults: { mode: 'normal', seed: 1 }, delay: 60,
  controls: [{ t: 'radio', key: 'mode', label: 'Mode', options: [['normal', 'Normal'], ['darken', 'Darken Only'], ['lighten', 'Lighten Only'], ['anisotropic', 'Anisotropic']] }],
  fn: (p) => (s) => F.diffuse(s, p.mode, p.seed), opts: () => ({ pad: 3 }),
};
const EMBOSS: Spec = {
  name: 'Emboss', defaults: { angle: 135, height: 3, amount: 100 }, delay: 40,
  controls: [
    { t: 'slider', key: 'angle', label: 'Angle:', min: -180, max: 180, unit: '°' },
    { t: 'slider', key: 'height', label: 'Height:', min: 1, max: 100, unit: px },
    { t: 'slider', key: 'amount', label: 'Amount:', min: 1, max: 500, unit: pct },
  ],
  fn: (p) => (s) => F.emboss(s, p.angle, p.height, p.amount), opts: (p) => ({ pad: p.height + 1 }),
};
const OIL_PAINT: Spec = {
  name: 'Oil Paint', defaults: { stylization: 2.5, cleanliness: 5, lighting: true, angle: -60, shine: 1.5 }, delay: 150,
  controls: [
    { t: 'group', title: 'Brush', items: [
      { t: 'slider', key: 'stylization', label: 'Stylization:', min: 0.1, max: 10, step: 0.1 },
      { t: 'slider', key: 'cleanliness', label: 'Cleanliness:', min: 0, max: 10, step: 0.1 },
    ] },
    { t: 'group', title: 'Lighting', items: [
      { t: 'check', key: 'lighting', label: 'Lighting' },
      { t: 'slider', key: 'angle', label: 'Angle:', min: -180, max: 180, unit: '°' },
      { t: 'slider', key: 'shine', label: 'Shine:', min: 0, max: 10, step: 0.1 },
    ] },
  ],
  fn: (p) => (s) => F.oilPaint(s, p.stylization, p.cleanliness, p.lighting ? p.shine : 0, p.angle),
  opts: (p) => ({ pad: Math.ceil(p.stylization) + 6 }),
};
const TILES: Spec = {
  name: 'Tiles', defaults: { count: 10, offset: 10, fill: 'background', seed: 1 }, delay: 40,
  controls: [
    { t: 'slider', key: 'count', label: 'Number Of Tiles:', min: 1, max: 99 },
    { t: 'slider', key: 'offset', label: 'Maximum Offset:', min: 1, max: 99, unit: pct },
    { t: 'radio', key: 'fill', label: 'Fill Empty Area With:', options: [['background', 'Background Color'], ['foreground', 'Foreground Color'], ['inverse', 'Inverse Image'], ['unaltered', 'Unaltered Image']] },
  ],
  fn: (p) => (s) => F.tiles(s, p.count, p.offset, p.fill, app.fg, app.bg, p.seed),
};
const TRACE_CONTOUR: Spec = {
  name: 'Trace Contour', defaults: { level: 128, edge: 'lower' }, delay: 40,
  controls: [
    { t: 'slider', key: 'level', label: 'Level:', min: 0, max: 255 },
    { t: 'radio', key: 'edge', label: 'Edge', inline: true, options: [['lower', 'Lower'], ['upper', 'Upper']] },
  ],
  fn: (p) => (s) => F.traceContour(s, p.level, p.edge), opts: () => ({ pad: 1 }),
};
const WIND: Spec = {
  name: 'Wind', defaults: { method: 'wind', dir: 'right', seed: 1 }, delay: 60,
  controls: [
    { t: 'radio', key: 'method', label: 'Method', options: [['wind', 'Wind'], ['blast', 'Blast'], ['stagger', 'Stagger']] },
    { t: 'radio', key: 'dir', label: 'Direction', options: [['right', 'From the Right'], ['left', 'From the Left']] },
  ],
  fn: (p) => (s) => F.wind(s, p.method, p.dir, p.seed),
};

// ---------- Other ----------
const CUSTOM: Spec = {
  name: 'Custom', width: 420, delay: 100,
  defaults: { kernel: [0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, -1, 5, -1, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0], scale: 1, offset: 0 },
  controls: [{
    t: 'custom',
    build: (p, update) => {
      const grid = h('div', { class: 'flt-kernel' });
      for (let k = 0; k < 25; k++) {
        grid.appendChild(numberInput({ value: p.kernel[k], min: -999, max: 999, width: 48, onChange: (v) => { p.kernel[k] = v; update(); } }).el);
      }
      const sc = numberInput({ value: p.scale, min: 1, max: 9999, width: 56, onChange: (v) => { p.scale = v; update(); } });
      const of = numberInput({ value: p.offset, min: -9999, max: 9999, width: 56, onChange: (v) => { p.offset = v; update(); } });
      return h('div', { class: 'col' }, grid, h('div', { class: 'flt-kernel-opts' }, labeled('Scale:', sc.el), labeled('Offset:', of.el)));
    },
  }],
  fn: (p) => (s) => F.convolve(s, p.kernel, 5, p.scale, p.offset), opts: () => ({ pad: 2 }),
};
const HIGH_PASS: Spec = {
  name: 'High Pass', defaults: { radius: 10 },
  controls: [{ t: 'slider', key: 'radius', label: 'Radius:', min: 0.1, max: 1000, step: 0.1, unit: px }],
  fn: (p) => (s) => F.highPass(s, p.radius), opts: (p) => ({ pad: Math.ceil(p.radius * 3) }),
};
const MAXIMUM: Spec = {
  name: 'Maximum', defaults: { radius: 1 }, delay: 100,
  controls: [{ t: 'slider', key: 'radius', label: 'Radius:', min: 1, max: 500, unit: px }],
  fn: (p) => (s) => F.maximum(s, p.radius), opts: (p) => ({ pad: p.radius + 1 }),
};
const MINIMUM: Spec = {
  name: 'Minimum', defaults: { radius: 1 }, delay: 100,
  controls: [{ t: 'slider', key: 'radius', label: 'Radius:', min: 1, max: 500, unit: px }],
  fn: (p) => (s) => F.minimum(s, p.radius), opts: (p) => ({ pad: p.radius + 1 }),
};
const OFFSET: Spec = {
  name: 'Offset', defaults: { dx: 0, dy: 0, mode: 'wrap' }, delay: 30,
  controls: () => {
    const W = app.doc?.width ?? 1000, H = app.doc?.height ?? 1000;
    return [
      { t: 'slider', key: 'dx', label: 'Horizontal:', min: -W, max: W, unit: 'pixels right' },
      { t: 'slider', key: 'dy', label: 'Vertical:', min: -H, max: H, unit: 'pixels down' },
      { t: 'radio', key: 'mode', label: 'Undefined Areas', options: [['transparent', 'Set to Transparent'], ['repeat', 'Repeat Edge Pixels'], ['wrap', 'Wrap Around']] },
    ];
  },
  fn: (p) => (s) => F.offset(s, p.dx, p.dy, p.mode),
};

// =====================================================================
// Menu
// =====================================================================
/** Filter menu items that follow the "Last Filter" entry. */
export function filterMenuItems(): MenuItem[] {
  const en = () => !!app.doc;
  const it = (label: string, action: () => void, shortcut?: string): MenuItem => ({ label, action, shortcut, enabled: en });
  const sub = (label: string, items: MenuItem[]): MenuItem => ({ label, submenu: items, enabled: en });
  const colors = () => ({ fg: { ...app.fg }, bg: { ...app.bg } });
  return [
    it('Camera Raw Filter...', () => void openCameraRaw(), 'Shift+Ctrl+A'),
    it('Lens Correction...', dlg(LENS_CORRECTION), 'Shift+Ctrl+R'),
    it('Liquify...', () => void openLiquify(), 'Shift+Ctrl+X'),
    SEP,
    sub('Blur', [
      it('Average', instant('Average', () => F.average)),
      it('Blur', instant('Blur', () => F.blur, { pad: 3 })),
      it('Blur More', instant('Blur More', () => F.blurMore, { pad: 6 })),
      it('Box Blur...', dlg(BOX_BLUR)),
      it('Gaussian Blur...', dlg(GAUSSIAN_BLUR)),
      it('Motion Blur...', dlg(MOTION_BLUR)),
      it('Radial Blur...', dlg(RADIAL_BLUR)),
      it('Surface Blur...', dlg(SURFACE_BLUR)),
    ]),
    sub('Blur Gallery', [
      it('Tilt-Shift...', dlg(TILT_SHIFT)),
      it('Iris Blur...', dlg(IRIS_BLUR)),
    ]),
    sub('Distort', [
      it('Pinch...', dlg(PINCH)),
      it('Polar Coordinates...', dlg(POLAR)),
      it('Ripple...', dlg(RIPPLE)),
      it('Spherize...', dlg(SPHERIZE)),
      it('Twirl...', dlg(TWIRL)),
      it('Wave...', dlg(WAVE)),
      it('ZigZag...', dlg(ZIGZAG)),
    ]),
    sub('Noise', [
      it('Add Noise...', dlg(ADD_NOISE)),
      it('Despeckle', instant('Despeckle', () => F.despeckle, { pad: 4 })),
      it('Dust & Scratches...', dlg(DUST)),
      it('Median...', dlg(MEDIAN)),
      it('Reduce Noise...', dlg(REDUCE_NOISE)),
    ]),
    sub('Pixelate', [
      it('Color Halftone...', dlg(COLOR_HALFTONE)),
      it('Crystallize...', dlg(CRYSTALLIZE)),
      it('Fragment', instant('Fragment', () => F.fragment, { pad: 4 })),
      it('Mezzotint...', dlg(MEZZOTINT)),
      it('Mosaic...', dlg(MOSAIC)),
      it('Pointillize...', dlg(POINTILLIZE)),
    ]),
    sub('Render', [
      it('Clouds', instant('Clouds', () => { const c = colors(), seed = F.newSeed(); return (s) => F.clouds(s, c.fg, c.bg, seed); })),
      it('Difference Clouds', instant('Difference Clouds', () => { const c = colors(), seed = F.newSeed(); return (s) => F.differenceClouds(s, c.fg, c.bg, seed); })),
      it('Fibers...', dlg(FIBERS)),
      it('Lens Flare...', dlg(LENS_FLARE)),
    ]),
    sub('Sharpen', [
      it('Sharpen', instant('Sharpen', () => F.sharpen, { pad: 2 })),
      it('Sharpen Edges', instant('Sharpen Edges', () => F.sharpenEdges, { pad: 4 })),
      it('Sharpen More', instant('Sharpen More', () => F.sharpenMore, { pad: 2 })),
      it('Smart Sharpen...', dlg(SMART_SHARPEN)),
      it('Unsharp Mask...', dlg(UNSHARP)),
    ]),
    sub('Stylize', [
      it('Diffuse...', dlg(DIFFUSE)),
      it('Emboss...', dlg(EMBOSS)),
      it('Find Edges', instant('Find Edges', () => F.findEdges, { pad: 1 })),
      it('Oil Paint...', dlg(OIL_PAINT)),
      it('Solarize', instant('Solarize', () => F.solarize)),
      it('Tiles...', dlg(TILES)),
      it('Trace Contour...', dlg(TRACE_CONTOUR)),
      it('Wind...', dlg(WIND)),
    ]),
    sub('Other', [
      it('Custom...', dlg(CUSTOM)),
      it('High Pass...', dlg(HIGH_PASS)),
      it('Maximum...', dlg(MAXIMUM)),
      it('Minimum...', dlg(MINIMUM)),
      it('Offset...', dlg(OFFSET)),
    ]),
  ];
}
