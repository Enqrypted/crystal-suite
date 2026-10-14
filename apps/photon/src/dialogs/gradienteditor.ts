// Photoshop-style Gradient Editor: presets, name, gradient bar with opacity stops (above)
// and color stops (below), and per-stop Color / Opacity / Location fields.
import { Gradient, GradientStop } from '../core/layer';
import { GRADIENT_PRESETS, gradientSwatch } from '../core/gradient';
import { clamp, createCanvas, ctx2d, cssColor, RGB } from '../core/util';
import { h, injectStyle } from '../ui/dom';
import { button, colorSwatch, numberInput, pickColor, section, textInput } from '../ui/widgets';
import { openDialog } from './dialog';

interface CStop { pos: number; color: RGB }
interface OStop { pos: number; opacity: number }
type Sel = { kind: 'c'; s: CStop } | { kind: 'o'; s: OStop };

const BAR_W = 400, BAR_H = 28;
/** Gradients added with "New" during this session. */
const userPresets: Gradient[] = [];

export function cloneGradient(g: Gradient): Gradient {
  return { name: g.name, stops: g.stops.map((s) => ({ pos: s.pos, color: { ...s.color }, opacity: s.opacity })) };
}

const byPos = <T extends { pos: number }>(a: T[]) => [...a].sort((p, q) => p.pos - q.pos);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRGB = (a: RGB, b: RGB, t: number): RGB => ({ r: Math.round(lerp(a.r, b.r, t)), g: Math.round(lerp(a.g, b.g, t)), b: Math.round(lerp(a.b, b.b, t)) });

/** Value of a piecewise-linear stop list at p; at coincident stops `right` picks the last one (hard edges). */
function evalAt<S extends { pos: number }, V>(stops: S[], p: number, right: boolean, val: (s: S) => V, mix: (a: V, b: V, t: number) => V): V {
  const s = byPos(stops);
  const eq = s.filter((x) => Math.abs(x.pos - p) < 1e-4);
  if (eq.length) return val(right ? eq[eq.length - 1] : eq[0]);
  const last = s[s.length - 1];
  if (p < s[0].pos) return val(s[0]);
  if (p > last.pos) return val(last);
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1];
    if (p > a.pos && p < b.pos) return mix(val(a), val(b), (p - a.pos) / (b.pos - a.pos));
  }
  return val(last);
}
const colorAt = (cs: CStop[], p: number, right = false) => evalAt(cs, p, right, (s) => s.color, mixRGB);
const opacityAt = (os: OStop[], p: number, right = false) => evalAt(os, p, right, (s) => s.opacity, lerp);

/** Drop interior stops that equal the interpolation of their neighbours. */
function simplify<T extends { pos: number }>(arr: T[], same: (s: T, a: T, b: T, t: number) => boolean): T[] {
  const out = byPos(arr);
  let i = 1;
  while (i < out.length - 1) {
    const a = out[i - 1], s = out[i], b = out[i + 1];
    if (s.pos > a.pos && s.pos < b.pos && same(s, a, b, (s.pos - a.pos) / (b.pos - a.pos))) out.splice(i, 1);
    else i++;
  }
  return out;
}

/** Split combined gradient stops into Photoshop's separate color and opacity stops. */
function split(g: Gradient): { cs: CStop[]; os: OStop[] } {
  const stops = byPos(g.stops.length ? g.stops : GRADIENT_PRESETS[0].stops);
  let cs: CStop[] = stops.map((s) => ({ pos: clamp(s.pos, 0, 1), color: { ...s.color } }));
  let os: OStop[] = stops.map((s) => ({ pos: clamp(s.pos, 0, 1), opacity: clamp(s.opacity, 0, 1) }));
  cs = simplify(cs, (s, a, b, t) => { const m = mixRGB(a.color, b.color, t); return Math.abs(m.r - s.color.r) + Math.abs(m.g - s.color.g) + Math.abs(m.b - s.color.b) <= 2; });
  os = simplify(os, (s, a, b, t) => Math.abs(lerp(a.opacity, b.opacity, t) - s.opacity) < 0.003);
  if (cs.length < 2) cs.push({ pos: 1, color: { ...cs[0].color } });
  if (os.length < 2) os.push({ pos: 1, opacity: os[0].opacity });
  return { cs, os };
}

/** Combine color + opacity stops into an equivalent Gradient (new object). */
function merge(cs: CStop[], os: OStop[], name: string): Gradient {
  const ps = [...new Set([...cs, ...os].map((s) => Math.round(clamp(s.pos, 0, 1) * 10000) / 10000))].sort((a, b) => a - b);
  const stops: GradientStop[] = [];
  for (const p of ps) {
    const cl = colorAt(cs, p), cr = colorAt(cs, p, true), ol = opacityAt(os, p), or = opacityAt(os, p, true);
    stops.push({ pos: p, color: cl, opacity: ol });
    if (cl.r !== cr.r || cl.g !== cr.g || cl.b !== cr.b || Math.abs(ol - or) > 1e-6) stops.push({ pos: p, color: cr, opacity: or });
  }
  return { name, stops };
}

const sameGradient = (a: Gradient, b: Gradient) => JSON.stringify(a.stops) === JSON.stringify(b.stops);

/** Photoshop Gradient Editor. Resolves with a NEW gradient, or null when cancelled. */
export async function openGradientEditor(initial: Gradient): Promise<Gradient | null> {
  injectCss();
  let name = initial.name || 'Custom';
  let { cs, os } = split(initial);
  let sel: Sel = { kind: 'c', s: byPos(cs)[0] };
  let removing: CStop | OStop | null = null;

  const current = () => merge(cs, os, name);
  const edited = () => { if (name !== 'Custom') { name = 'Custom'; nameField.set(name); } };

  // ---- presets ----
  const presetGrid = h('div', { class: 'ge-presets' });
  const fillPresets = () => {
    presetGrid.innerHTML = '';
    const list = [...GRADIENT_PRESETS, ...userPresets];
    if (!list.some((g) => g.name === initial.name && sameGradient(g, initial))) list.unshift(initial);
    for (const g of list) {
      const t = h('button', { class: 'ge-tile', title: g.name || 'Custom' }, gradientSwatch(g, 32, 32));
      t.addEventListener('click', () => load(g));
      presetGrid.append(t);
    }
  };
  const load = (g: Gradient) => {
    ({ cs, os } = split(g));
    name = g.name || 'Custom';
    nameField.set(name);
    sel = { kind: 'c', s: byPos(cs)[0] };
    refresh();
  };

  // ---- name ----
  const nameField = textInput({ value: name, width: 250, onInput: (v) => { name = v; } });
  const newBtn = button('New', () => { userPresets.push(current()); fillPresets(); }, { small: true, title: 'Add the gradient to the presets' });

  // ---- bar + stop tracks ----
  const bar = createCanvas(BAR_W, BAR_H);
  bar.className = 'ge-bar';
  const opTrack = h('div', { class: 'ge-track op', title: 'Click to add an opacity stop' });
  const colTrack = h('div', { class: 'ge-track col', title: 'Click to add a color stop' });
  opTrack.style.width = colTrack.style.width = `${BAR_W}px`;

  const drawBar = () => {
    const g = removing
      ? merge(cs.filter((s) => s !== removing), os.filter((s) => s !== removing), name)
      : current();
    const x = ctx2d(bar);
    x.clearRect(0, 0, BAR_W, BAR_H);
    x.drawImage(gradientSwatch(g, BAR_W, BAR_H), 0, 0);
  };
  const stopEl = (kind: 'c' | 'o', s: CStop | OStop, i: number) => {
    const sw = h('div', { class: 'ge-sw' });
    if (kind === 'c') sw.style.background = cssColor((s as CStop).color);
    else { const v = Math.round(255 * (1 - (s as OStop).opacity)); sw.style.background = `rgb(${v},${v},${v})`; }
    const tip = h('div', { class: 'ge-tip' });
    const cls = `ge-stop ${kind}${sel.s === s ? ' sel' : ''}${removing === s ? ' removing' : ''}`;
    const el = h('div', { class: cls, dataset: { i: String(i) }, title: kind === 'c' ? 'Color stop (double-click to pick a color)' : 'Opacity stop' }, kind === 'o' ? [sw, tip] : [tip, sw]);
    el.style.left = `${s.pos * 100}%`;
    return el;
  };
  const buildStops = () => {
    opTrack.innerHTML = '';
    colTrack.innerHTML = '';
    os.forEach((s, i) => opTrack.append(stopEl('o', s, i)));
    cs.forEach((s, i) => colTrack.append(stopEl('c', s, i)));
  };

  const editColor = async () => {
    if (sel.kind !== 'c') return;
    const s = sel.s;
    const c = await pickColor(s.color, 'Color Picker (Stop Color)');
    if (c) { s.color = c; edited(); refresh(); }
  };

  const track = (el: HTMLElement, kind: 'c' | 'o') => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const list: (CStop | OStop)[] = kind === 'c' ? cs : os;
      const r = el.getBoundingClientRect();
      const posOf = (cx: number) => Math.round(clamp((cx - r.left) / r.width, 0, 1) * 1000) / 1000;
      const hit = (e.target as HTMLElement).closest('.ge-stop') as HTMLElement | null;
      let stop: CStop | OStop;
      if (hit) stop = list[+(hit.dataset.i ?? 0)];
      else {
        const p = posOf(e.clientX);
        if (kind === 'c') { const s: CStop = { pos: p, color: colorAt(cs, p) }; cs.push(s); stop = s; }
        else { const s: OStop = { pos: p, opacity: opacityAt(os, p) }; os.push(s); stop = s; }
        edited();
      }
      sel = (kind === 'c' ? { kind, s: stop as CStop } : { kind, s: stop as OStop });
      refresh();
      el.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY;
      let moved = false;
      const mv = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - sx) < 3 && Math.abs(ev.clientY - sy) < 3) return;
        moved = true;
        // Dragging far away from the bar deletes the stop on release (Photoshop behaviour)
        removing = list.length > 2 && Math.abs(ev.clientY - (r.top + r.height / 2)) > 34 ? stop : null;
        stop.pos = posOf(ev.clientX);
        edited();
        refresh();
      };
      const up = () => {
        el.removeEventListener('pointermove', mv);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        if (removing) {
          list.splice(list.indexOf(removing), 1);
          removing = null;
          sel = kind === 'c' ? { kind, s: byPos(cs)[0] } : { kind, s: byPos(os)[0] };
        }
        refresh();
      };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    if (kind === 'c') el.addEventListener('dblclick', (e) => { if ((e.target as HTMLElement).closest('.ge-stop')) editColor(); });
  };
  track(opTrack, 'o');
  track(colTrack, 'c');

  // ---- stop fields ----
  const opNum = numberInput({ value: 100, min: 0, max: 100, unit: '%', width: 48, onInput: (v) => { if (sel.kind === 'o') { sel.s.opacity = v / 100; edited(); refresh(); } } });
  const opLoc = numberInput({ value: 0, min: 0, max: 100, unit: '%', width: 48, onInput: (v) => { if (sel.kind === 'o') { sel.s.pos = v / 100; edited(); refresh(); } } });
  const colSw = colorSwatch({ color: { r: 0, g: 0, b: 0 }, title: 'Stop color', onChange: (c) => { if (sel.kind === 'c') { sel.s.color = c; edited(); refresh(); } } });
  const colLoc = numberInput({ value: 0, min: 0, max: 100, unit: '%', width: 48, onInput: (v) => { if (sel.kind === 'c') { sel.s.pos = v / 100; edited(); refresh(); } } });
  const del = (kind: 'c' | 'o') => {
    if (sel.kind !== kind) return;
    if (sel.kind === 'c' && cs.length > 2) { cs.splice(cs.indexOf(sel.s), 1); sel = { kind: 'c', s: byPos(cs)[0] }; }
    else if (sel.kind === 'o' && os.length > 2) { os.splice(os.indexOf(sel.s), 1); sel = { kind: 'o', s: byPos(os)[0] }; }
    else return;
    edited();
    refresh();
  };
  const opDel = button('Delete', () => del('o'), { small: true });
  const colDel = button('Delete', () => del('c'), { small: true });

  const syncFields = () => {
    const isO = sel.kind === 'o', isC = sel.kind === 'c';
    opNum.input.disabled = opLoc.input.disabled = !isO;
    opDel.disabled = !isO || os.length <= 2;
    (colSw.el as HTMLButtonElement).disabled = colLoc.input.disabled = !isC;
    colDel.disabled = !isC || cs.length <= 2;
    if (sel.kind === 'o') {
      opNum.set(Math.round(sel.s.opacity * 100)); opLoc.set(Math.round(sel.s.pos * 100));
      colLoc.input.value = '';
    } else {
      colSw.set(sel.s.color); colLoc.set(Math.round(sel.s.pos * 100));
      opNum.input.value = ''; opLoc.input.value = '';
    }
  };
  const refresh = () => { buildStops(); drawBar(); syncFields(); };

  const lbl = (t: string) => h('label', { class: 'field-label' }, t);
  const content = h('div', { class: 'ge' },
    h('div', { class: 'ge-head' }, 'Presets'),
    presetGrid,
    h('div', { class: 'row' }, lbl('Name:'), nameField.el, newBtn),
    h('div', { class: 'ge-head' }, 'Gradient Type: Solid'),
    h('div', { class: 'ge-barwrap' }, opTrack, bar, colTrack),
    section('Stops',
      h('div', { class: 'row ge-row' }, lbl('Opacity:'), opNum.el, lbl('Location:'), opLoc.el, opDel),
      h('div', { class: 'row ge-row' }, lbl('Color:'), colSw.el, lbl('Location:'), colLoc.el, colDel)),
  );
  fillPresets();
  refresh();

  const ok = await openDialog({ title: 'Gradient Editor', content, width: 580, layout: 'side', className: 'ge-dlg' });
  return ok ? current() : null;
}

function injectCss() {
  injectStyle('gradienteditor', `
.ge { display: flex; flex-direction: column; gap: 10px; }
.ge-head { color: var(--text-2); }
.ge-presets { display: grid; grid-template-columns: repeat(auto-fill, 36px); gap: 4px; padding: 6px; background: var(--input); border: 1px solid var(--input-border); border-radius: 3px; max-height: 128px; overflow-y: auto; }
.ge-tile { width: 36px; height: 36px; padding: 1px; border: 1px solid var(--input-border); background: var(--panel-2); border-radius: 2px; line-height: 0; cursor: default; }
.ge-tile:hover { border-color: var(--accent); }
.ge-tile canvas { width: 32px; height: 32px; display: block; }
.ge-barwrap { align-self: center; padding: 0 10px; user-select: none; -webkit-user-select: none; }
.ge-bar { display: block; outline: 1px solid var(--border); }
.ge-track { position: relative; height: 20px; cursor: pointer; touch-action: none; }
.ge-stop { position: absolute; top: 0; width: 13px; height: 20px; margin-left: -6.5px; display: flex; flex-direction: column; align-items: center; cursor: default; }
.ge-stop.o { justify-content: flex-end; }
.ge-tip { width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; flex-shrink: 0; }
.ge-stop.c .ge-tip { border-bottom: 6px solid var(--text-2); }
.ge-stop.o .ge-tip { border-top: 6px solid var(--text-2); }
.ge-sw { width: 13px; height: 12px; border: 1px solid var(--text-2); flex-shrink: 0; }
.ge-stop.sel .ge-sw { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ge-stop.c.sel .ge-tip { border-bottom-color: var(--accent); }
.ge-stop.o.sel .ge-tip { border-top-color: var(--accent); }
.ge-stop.removing { opacity: .25; }
.ge-row .field-label { min-width: 58px; text-align: right; }
.ge .color-swatch:disabled { opacity: .35; cursor: default; }
`);
}
