// Building blocks for the tool options bar.
import { h } from './dom';
import { icon } from './icons';
import { numberInput, scrubby, select, checkbox, slider, popover, Option, Field } from './widgets';
import { BLEND_MODES, BLEND_NAMES, BlendMode } from '../core/layer';
import { BrushOptions, BRUSH_PRESETS, tipPreview } from '../core/brush';
import { bus } from '../core/bus';

export const sep = () => h('div', { class: 'opt-sep' });
export const label = (t: string) => h('span', { class: 'opt-label' }, t);

export function toolHeader(iconName: string): HTMLElement {
  return h('div', { class: 'opt-tool', title: 'Tool Preset' }, icon(iconName, 20), icon('chevron-down', 10));
}

/** Label (scrubby) + number field. */
export function num(lbl: string, get: () => number, set: (v: number) => void, o: { min?: number; max?: number; step?: number; unit?: string; width?: number; title?: string } = {}): HTMLElement {
  const f = numberInput({ value: get(), min: o.min, max: o.max, step: o.step, unit: o.unit, width: o.width ?? 52, onChange: set, title: o.title });
  const l = label(lbl);
  scrubby(l, f, { min: o.min, max: o.max, step: o.step, onInput: set });
  bus.on('options', () => f.set(get()));
  return h('div', { class: 'opt-group', title: o.title ?? '' }, l, f.el);
}

/** Percentage field with a slider popover (Opacity / Flow / Strength...). */
export function pct(lbl: string, get: () => number, set: (v: number) => void, title = ''): HTMLElement {
  const f = numberInput({ value: Math.round(get() * 100), min: 0, max: 100, unit: '%', width: 44, onChange: (v) => set(v / 100) });
  const l = label(lbl);
  scrubby(l, f, { min: 0, max: 100, onInput: (v) => set(v / 100) });
  const drop = h('button', { class: 'icon-btn', style: { width: '14px' }, title: 'Show slider' }, icon('chevron-down', 10));
  drop.addEventListener('click', () => {
    const s = slider({ value: Math.round(get() * 100), min: 0, max: 100, width: 160, onInput: (v) => { f.set(v); set(v / 100); } });
    popover(drop, h('div', { style: { padding: '2px 4px' } }, s.el));
  });
  bus.on('options', () => f.set(Math.round(get() * 100)));
  return h('div', { class: 'opt-group', title }, l, f.el, drop);
}

export function check(lbl: string, get: () => boolean, set: (v: boolean) => void, title = ''): HTMLElement {
  const c = checkbox({ label: lbl, checked: get(), onChange: set, title });
  bus.on('options', () => c.set(get()));
  return c.el;
}

export function sel(lbl: string | null, options: Option[], get: () => string, set: (v: string) => void, width?: number): HTMLElement {
  const s = select({ options, value: get(), onChange: set, width });
  bus.on('options', () => s.set(get()));
  return lbl ? h('div', { class: 'opt-group' }, label(lbl), s.el) : s.el;
}

export function blendOptions(extra: Option[] = []): Option[] {
  return [...extra, ...BLEND_MODES.map((m) => (m === '-' ? '-' : { value: m, label: BLEND_NAMES[m as BlendMode] }))] as Option[];
}
export function blendSel(get: () => string, set: (v: string) => void, extra: Option[] = []): HTMLElement {
  return sel('Mode:', blendOptions(extra), get, set, 120);
}

/** New / Add / Subtract / Intersect selection buttons. */
export function selectModes(get: () => string, set: (v: string) => void): HTMLElement {
  const modes: [string, string, string][] = [
    ['new', 'New selection', '<rect x="4" y="5" width="16" height="14"/>'],
    ['add', 'Add to selection (Shift)', '<rect x="2" y="3" width="13" height="11"/><rect x="9" y="10" width="13" height="11" fill="currentColor" fill-opacity=".35"/>'],
    ['subtract', 'Subtract from selection (Alt)', '<rect x="2" y="3" width="13" height="11" fill="currentColor" fill-opacity=".35"/><rect x="9" y="10" width="13" height="11" fill="var(--panel)"/>'],
    ['intersect', 'Intersect with selection (Shift+Alt)', '<rect x="2" y="3" width="13" height="11"/><rect x="9" y="10" width="13" height="11"/><rect x="9" y="10" width="6" height="4" fill="currentColor"/>'],
  ];
  const wrap = h('div', { class: 'segmented' });
  const btns = modes.map(([v, t, svg]) => {
    const b = h('button', { class: 'seg-btn', title: t, html: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${svg}</svg>` });
    b.addEventListener('click', () => { set(v); sync(); });
    wrap.appendChild(b);
    return b;
  });
  const sync = () => btns.forEach((b, i) => b.classList.toggle('active', modes[i][0] === get()));
  sync();
  bus.on('options', sync);
  return wrap;
}

/** Brush preset picker button (dot + size) with popover: size, hardness, presets. */
export function brushPicker(get: () => BrushOptions, set: (o: Partial<BrushOptions>) => void, opts: { noHardness?: boolean } = {}): HTMLElement {
  const sizeLbl = h('span', { class: 'size' });
  const dot = h('span', { class: 'dot' });
  const btn = h('button', { class: 'brush-preview-btn', title: 'Click to open the Brush Preset picker' }, dot, sizeLbl, icon('chevron-down', 10));
  const sync = () => {
    const o = get();
    sizeLbl.textContent = String(Math.round(o.size));
    const hard = Math.round(o.hardness * 100);
    dot.style.background = `radial-gradient(circle, var(--text) ${Math.max(10, hard * 0.55)}%, transparent ${Math.min(72, 30 + hard * 0.42)}%)`;
  };
  sync();
  bus.on('options', sync);
  btn.addEventListener('click', () => {
    const o = get();
    const sizeF = numberInput({ value: Math.round(o.size), min: 1, max: 5000, unit: 'px', width: 56, onChange: (v) => { set({ size: v }); sizeS.set(v); sync(); } });
    const sizeS = slider({ value: Math.min(o.size, 1000), min: 1, max: 1000, onInput: (v) => { set({ size: v }); sizeF.set(v); sync(); } });
    const hardF = numberInput({ value: Math.round(o.hardness * 100), min: 0, max: 100, unit: '%', width: 56, onChange: (v) => { set({ hardness: v / 100 }); hardS.set(v); sync(); } });
    const hardS = slider({ value: Math.round(o.hardness * 100), min: 0, max: 100, onInput: (v) => { set({ hardness: v / 100 }); hardF.set(v); sync(); } });
    const list = h('div', { class: 'brush-list' });
    for (const p of BRUSH_PRESETS) {
      const item = h('div', { class: 'brush-item', title: p.name }, tipPreview(p.opts), h('span', null, String(p.opts.size ?? '')));
      item.addEventListener('click', () => {
        set({ ...defaultsFor(p.opts) });
        const n = get();
        sizeF.set(n.size); sizeS.set(Math.min(n.size, 1000)); hardF.set(Math.round(n.hardness * 100)); hardS.set(Math.round(n.hardness * 100));
        list.querySelectorAll('.brush-item').forEach((e) => e.classList.remove('active'));
        item.classList.add('active');
        sync();
      });
      list.appendChild(item);
    }
    const content = h('div', { class: 'brush-popover' },
      h('div', { class: 'row between' }, h('span', { class: 'field-label' }, 'Size:'), sizeF.el), sizeS.el,
      opts.noHardness ? null : h('div', { class: 'row between' }, h('span', { class: 'field-label' }, 'Hardness:'), hardF.el),
      opts.noHardness ? null : hardS.el,
      list);
    popover(btn, content);
  });
  return btn;
}
function defaultsFor(p: Partial<BrushOptions>): Partial<BrushOptions> {
  // reset dynamics not specified by the preset
  return {
    hardness: 1, spacing: 0.25, angle: 0, roundness: 1, tip: 'round', sizeJitter: 0, angleJitter: 0, scatter: 0, count: 1,
    opacityJitter: 0, angleFollow: false, sizePressure: true, opacityPressure: false, flow: 1, ...p,
  };
}

/** Bind a Field to bus 'options' refresh. */
export function bindField<T>(f: Field<T>, get: () => T) { bus.on('options', () => f.set(get())); return f.el; }

export function iconToggle(name: string, title: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const b = h('button', { class: 'icon-btn', title }, icon(name, 16));
  const sync = () => b.classList.toggle('active', get());
  b.addEventListener('click', () => { set(!get()); sync(); });
  sync();
  bus.on('options', sync);
  return b;
}
export function bar(...children: (HTMLElement | null | false)[]): HTMLElement {
  return h('div', { class: 'opt-bar-inner', style: { display: 'contents' } }, ...children);
}
