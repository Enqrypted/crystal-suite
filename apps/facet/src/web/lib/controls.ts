// Small form controls (mouse-first, so they also work on the desktop layer without keyboard focus).
import { h, clamp } from './dom';

export function segmented<T extends string>(options: readonly { id: T; label: string; title?: string }[], value: T, onPick: (v: T) => void) {
  const el = h('div', { class: 'seg' });
  for (const o of options) {
    const b = h('button', { type: 'button', class: o.id === value ? 'on' : '', title: o.title ?? null, text: o.label });
    b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      onPick(o.id);
    });
    el.append(b);
  }
  return el;
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void) {
  const sw = h('span', { class: `switch${value ? ' on' : ''}` }, h('span', { class: 'knob' }));
  const el = h('button', { type: 'button', class: 'toggle' }, h('span', { class: 'tl', text: label }), sw);
  let v = value;
  el.addEventListener('click', () => { v = !v; sw.classList.toggle('on', v); onChange(v); });
  return el;
}

/** A horizontal slider; drag anywhere on it. `format` labels the value. */
export function slider(min: number, max: number, step: number, value: number, format: (v: number) => string, onInput: (v: number) => void) {
  const fill = h('div', { class: 'fill' });
  const knob = h('div', { class: 'knob' });
  const track = h('div', { class: 'track' }, fill, knob);
  const out = h('span', { class: 'val' });
  const el = h('div', { class: 'slider' }, track, out);
  let v = value;
  const show = () => {
    const f = (v - min) / (max - min);
    fill.style.width = `${f * 100}%`;
    knob.style.left = `${f * 100}%`;
    out.textContent = format(v);
  };
  const at = (e: PointerEvent) => {
    const r = track.getBoundingClientRect();
    const raw = min + clamp((e.clientX - r.left) / r.width, 0, 1) * (max - min);
    const nv = Math.round(raw / step) * step;
    if (nv !== v) { v = nv; show(); onInput(v); }
  };
  track.addEventListener('pointerdown', (e) => { track.setPointerCapture(e.pointerId); at(e); });
  track.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) at(e); });
  track.addEventListener('wheel', (e) => { e.preventDefault(); v = clamp(v + (e.deltaY < 0 ? step : -step), min, max); show(); onInput(v); }, { passive: false });
  show();
  return el;
}

export function stepper(min: number, max: number, value: number, onChange: (v: number) => void) {
  let v = value;
  const out = h('span', { class: 'val', text: String(v) });
  const minus = h('button', { type: 'button', text: '−' });
  const plus = h('button', { type: 'button', text: '+' });
  const set = (nv: number) => { v = clamp(nv, min, max); out.textContent = String(v); minus.toggleAttribute('disabled', v <= min); plus.toggleAttribute('disabled', v >= max); onChange(v); };
  minus.addEventListener('click', () => set(v - 1));
  plus.addEventListener('click', () => set(v + 1));
  minus.toggleAttribute('disabled', v <= min);
  plus.toggleAttribute('disabled', v >= max);
  return h('div', { class: 'stepper' }, minus, out, plus);
}

export const PALETTE = ['#ffffff', '#d1d1d6', '#8e8e93', '#1c1c1e', '#ff453a', '#ff9f0a', '#ffd60a', '#30d158', '#63e6e2', '#40c8e0', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ac8e68'];

/** Colour swatches plus a custom picker (saturation/brightness square and hue bar). `none` allows ''. */
export function swatches(value: string, onPick: (c: string) => void, opts: { none?: string } = {}) {
  const el = h('div', { class: 'swatches' });
  const row = h('div', { class: 'row' });
  const custom = h('button', { type: 'button', class: 'sw custom', title: 'Custom colour' });
  const pickerHost = h('div', { class: 'picker-host' });
  el.append(row, pickerHost);
  let v = value;
  const mark = () => {
    row.querySelectorAll<HTMLElement>('.sw').forEach((b) => b.classList.toggle('on', b.dataset.c === v || (b === custom && !!v && !PALETTE.includes(v) && b.dataset.c === undefined)));
    custom.style.setProperty('--c', v && !PALETTE.includes(v) ? v : 'transparent');
  };
  const choose = (c: string) => { v = c; mark(); onPick(c); };
  if (opts.none !== undefined) {
    const b = h('button', { type: 'button', class: 'sw none', title: opts.none });
    b.dataset.c = '';
    b.addEventListener('click', () => { pickerHost.replaceChildren(); choose(''); });
    row.append(b);
  }
  for (const c of PALETTE) {
    const b = h('button', { type: 'button', class: 'sw', title: c });
    b.dataset.c = c;
    b.style.setProperty('--c', c);
    b.addEventListener('click', () => { pickerHost.replaceChildren(); choose(c); });
    row.append(b);
  }
  row.append(custom);
  custom.addEventListener('click', () => {
    if (pickerHost.firstChild) { pickerHost.replaceChildren(); return; }
    pickerHost.append(picker(v || '#0a84ff', choose));
  });
  mark();
  return el;
}

function picker(start: string, onPick: (c: string) => void) {
  let [hh, ss, vv] = toHsv(start);
  const sv = h('div', { class: 'sv' }, h('div', { class: 'sv-dot' }));
  const hue = h('div', { class: 'hue' }, h('div', { class: 'hue-dot' }));
  const el = h('div', { class: 'picker' }, sv, hue);
  const show = () => {
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hh}, 100%, 50%))`;
    (sv.firstChild as HTMLElement).style.cssText = `left:${ss * 100}%;top:${(1 - vv) * 100}%;background:${fromHsv(hh, ss, vv)}`;
    (hue.firstChild as HTMLElement).style.left = `${(hh / 360) * 100}%`;
  };
  const drag = (area: HTMLElement, fn: (fx: number, fy: number) => void) => {
    const at = (e: PointerEvent) => {
      const r = area.getBoundingClientRect();
      fn(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
      show();
      onPick(fromHsv(hh, ss, vv));
    };
    area.addEventListener('pointerdown', (e) => { area.setPointerCapture(e.pointerId); at(e); });
    area.addEventListener('pointermove', (e) => { if (area.hasPointerCapture(e.pointerId)) at(e); });
  };
  drag(sv, (fx, fy) => { ss = fx; vv = 1 - fy; });
  drag(hue, (fx) => { hh = fx * 360; });
  show();
  return el;
}

function toHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((hh * 60) + 360) % 360, max ? d / max : 0, max];
}

function fromHsv(hh: number, s: number, v: number) {
  const f = (n: number) => { const k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

export function field(label: string, control: HTMLElement, cls = '') {
  return h('div', { class: `field ${cls}` }, h('div', { class: 'fl', text: label }), control);
}
