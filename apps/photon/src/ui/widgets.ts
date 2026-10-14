// Photoshop-style form controls.
import { h } from './dom';
import { icon } from './icons';
import { clamp, cssColor, RGB } from '../core/util';

export interface Field<T> { el: HTMLElement; set(v: T): void; get(): T }

const roundTo = (v: number, d: number) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };

export interface NumberOpts {
  value: number; min?: number; max?: number; step?: number; decimals?: number;
  unit?: string; width?: number; title?: string;
  onInput?: (v: number) => void; onChange?: (v: number) => void;
}
/** Numeric text field: arrow keys step (Shift = x10), Enter/blur commits. */
export function numberInput(o: NumberOpts): Field<number> & { input: HTMLInputElement } {
  const dec = o.decimals ?? (o.step && o.step < 1 ? String(o.step).split('.')[1]?.length ?? 1 : 0);
  const min = o.min ?? -Infinity, max = o.max ?? Infinity, step = o.step ?? 1;
  let value = o.value;
  const input = h('input', { class: 'ps-input num', type: 'text', value: String(roundTo(value, dec)), title: o.title ?? '', spellcheck: false }) as HTMLInputElement;
  if (o.width) input.style.width = `${o.width}px`;
  const commit = (v: number, final: boolean) => {
    if (!isFinite(v)) v = value;
    v = roundTo(clamp(v, min, max), dec);
    const changed = v !== value;
    value = v;
    input.value = String(v);
    if (changed) o.onInput?.(v);
    if (final) o.onChange?.(v);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const s = step * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      commit((parseFloat(input.value) || 0) + s, true);
    } else if (e.key === 'Enter') { commit(parseFloat(input.value), true); input.blur(); }
    else if (e.key === 'Escape') { input.value = String(value); input.blur(); }
    e.stopPropagation();
  });
  input.addEventListener('change', () => commit(parseFloat(input.value), true));
  input.addEventListener('focus', () => input.select());
  const el = o.unit ? h('span', { class: 'num-wrap' }, input, h('span', { class: 'unit' }, o.unit)) : input;
  return {
    el, input,
    set(v) { value = roundTo(v, dec); input.value = String(value); },
    get() { return value; },
  };
}

/** Make `label` a scrubby slider for a number field (drag left/right to change). */
export function scrubby(label: HTMLElement, field: Field<number>, opts: { min?: number; max?: number; step?: number; onInput?: (v: number) => void; onChange?: (v: number) => void }) {
  label.classList.add('scrub');
  label.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    label.setPointerCapture(e.pointerId);
    const start = field.get(), sx = e.clientX;
    const step = opts.step ?? 1;
    const mv = (ev: PointerEvent) => {
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      let v = start + Math.round((ev.clientX - sx) / 2) * step * mult;
      v = clamp(v, opts.min ?? -Infinity, opts.max ?? Infinity);
      if (v !== field.get()) { field.set(v); opts.onInput?.(field.get()); }
    };
    const up = () => {
      label.removeEventListener('pointermove', mv);
      label.removeEventListener('pointerup', up);
      opts.onChange?.(field.get());
    };
    label.addEventListener('pointermove', mv);
    label.addEventListener('pointerup', up);
  });
}

export interface SliderOpts {
  value: number; min: number; max: number; step?: number;
  onInput?: (v: number) => void; onChange?: (v: number) => void;
  track?: string; // CSS background for the track (e.g. hue gradient)
  width?: number;
}
export function slider(o: SliderOpts): Field<number> & { input: HTMLInputElement } {
  const input = h('input', { class: 'ps-range', type: 'range', min: o.min, max: o.max, step: o.step ?? 1, value: o.value }) as HTMLInputElement;
  if (o.track) { input.classList.add('custom-track'); input.style.setProperty('--track', o.track); }
  if (o.width) input.style.width = `${o.width}px`;
  input.addEventListener('input', () => o.onInput?.(parseFloat(input.value)));
  input.addEventListener('change', () => o.onChange?.(parseFloat(input.value)));
  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('dblclick', () => { /* allow reset by callers */ });
  return { el: input, input, set(v) { input.value = String(v); }, get() { return parseFloat(input.value); } };
}

export interface SliderFieldOpts extends NumberOpts {
  label: string;
  min: number; max: number;
  /** label | slider | number in one row (Properties panel) instead of label+number above slider (dialogs). */
  inline?: boolean;
  labelWidth?: number;
  track?: string;
  /** double-click label resets to this */
  reset?: number;
}
export function sliderField(o: SliderFieldOpts): Field<number> {
  let num: ReturnType<typeof numberInput>;
  const sl = slider({
    value: o.value, min: o.min, max: o.max, step: o.step, track: o.track,
    onInput: (v) => { num.set(v); o.onInput?.(v); },
    onChange: (v) => o.onChange?.(v),
  });
  num = numberInput({
    ...o, width: o.width ?? 46,
    onInput: (v) => { sl.set(v); o.onInput?.(v); },
    onChange: (v) => { sl.set(v); o.onChange?.(v); },
  });
  const label = h('label', { class: 'field-label' }, o.label);
  if (o.labelWidth) label.style.width = `${o.labelWidth}px`;
  const field: Field<number> = { el: null as any, set(v) { sl.set(v); num.set(v); }, get: () => num.get() };
  scrubby(label, num, {
    min: o.min, max: o.max, step: o.step,
    onInput: (v) => { sl.set(v); o.onInput?.(v); }, onChange: (v) => o.onChange?.(v),
  });
  if (o.reset !== undefined) label.addEventListener('dblclick', () => { field.set(o.reset!); o.onInput?.(o.reset!); o.onChange?.(o.reset!); });
  field.el = o.inline
    ? h('div', { class: 'slider-field inline' }, label, sl.el, num.el)
    : h('div', { class: 'slider-field' }, h('div', { class: 'sf-top' }, label, num.el), sl.el);
  return field;
}

export type Option = string | { value: string; label: string; disabled?: boolean } | '-';
export function select(o: { options: Option[]; value: string; onChange?: (v: string) => void; width?: number; title?: string }): Field<string> & { setOptions(opts: Option[]): void } {
  const sel = h('select', { class: 'ps-select', title: o.title ?? '' }) as HTMLSelectElement;
  const fill = (opts: Option[]) => {
    sel.innerHTML = '';
    for (const op of opts) {
      if (op === '-') { sel.appendChild(h('option', { disabled: true, class: 'sep' }, '──────────')); continue; }
      const v = typeof op === 'string' ? op : op.value, l = typeof op === 'string' ? op : op.label;
      sel.appendChild(h('option', { value: v, disabled: typeof op !== 'string' && op.disabled }, l));
    }
  };
  fill(o.options);
  sel.value = o.value;
  if (o.width) sel.style.width = `${o.width}px`;
  sel.addEventListener('change', () => o.onChange?.(sel.value));
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  return { el: sel, set(v) { sel.value = v; }, get: () => sel.value, setOptions(opts) { const v = sel.value; fill(opts); sel.value = v; } };
}

export function checkbox(o: { label: string; checked: boolean; onChange?: (v: boolean) => void; title?: string }): Field<boolean> {
  const input = h('input', { type: 'checkbox', class: 'ps-check' }) as HTMLInputElement;
  input.checked = o.checked;
  input.addEventListener('change', () => o.onChange?.(input.checked));
  const el = h('label', { class: 'check-row', title: o.title ?? '' }, input, h('span', null, o.label));
  return { el, set(v) { input.checked = v; }, get: () => input.checked };
}

export function textInput(o: { value: string; width?: number; placeholder?: string; onChange?: (v: string) => void; onInput?: (v: string) => void }): Field<string> & { input: HTMLInputElement } {
  const input = h('input', { class: 'ps-input', type: 'text', value: o.value, placeholder: o.placeholder ?? '', spellcheck: false }) as HTMLInputElement;
  if (o.width) input.style.width = `${o.width}px`;
  input.addEventListener('input', () => o.onInput?.(input.value));
  input.addEventListener('change', () => o.onChange?.(input.value));
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
  return { el: input, input, set(v) { input.value = v; }, get: () => input.value };
}

export function button(label: string, onClick: (e: MouseEvent) => void, o: { primary?: boolean; small?: boolean; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h('button', {
    class: `ps-btn${o.primary ? ' primary' : ''}${o.small ? ' small' : ''}`,
    title: o.title ?? '', disabled: o.disabled, onclick: onClick,
  }, label) as HTMLButtonElement;
}

export function iconButton(name: string, title: string, onClick: (e: MouseEvent) => void, o: { size?: number; active?: boolean; cls?: string } = {}): HTMLButtonElement {
  const b = h('button', { class: `icon-btn${o.active ? ' active' : ''} ${o.cls ?? ''}`, title, onclick: onClick }, icon(name, o.size ?? 16)) as HTMLButtonElement;
  return b;
}

/** Row of mutually exclusive icon/text buttons. */
export function segmented(o: { options: { value: string; icon?: string; label?: string; title?: string }[]; value: string; onChange?: (v: string) => void }): Field<string> {
  let value = o.value;
  const btns = o.options.map((op) => {
    const b = h('button', { class: 'seg-btn', title: op.title ?? op.label ?? '' }, op.icon ? icon(op.icon, 16) : null, op.label ? h('span', null, op.label) : null);
    b.addEventListener('click', () => { value = op.value; sync(); o.onChange?.(value); });
    return b;
  });
  const sync = () => btns.forEach((b, i) => b.classList.toggle('active', o.options[i].value === value));
  sync();
  return { el: h('div', { class: 'segmented' }, btns), set(v) { value = v; sync(); }, get: () => value };
}

// Color picker hook (implemented in dialogs/colorpicker.ts, injected to avoid an import cycle)
let pickColorImpl: ((c: RGB, title: string) => Promise<RGB | null>) | null = null;
export function setColorPickerImpl(fn: typeof pickColorImpl) { pickColorImpl = fn; }
export function pickColor(c: RGB, title = 'Color Picker'): Promise<RGB | null> {
  return pickColorImpl ? pickColorImpl(c, title) : Promise.resolve(null);
}

export function colorSwatch(o: { color: RGB; onChange?: (c: RGB) => void; title?: string; size?: number }): Field<RGB> {
  let color = o.color;
  const el = h('button', { class: 'color-swatch', title: o.title ?? 'Click to set color' });
  if (o.size) { el.style.width = `${o.size}px`; el.style.height = `${o.size}px`; }
  const paint = () => { el.style.background = cssColor(color); };
  paint();
  el.addEventListener('click', async () => {
    const c = await pickColor(color, o.title ?? 'Color Picker');
    if (c) { color = c; paint(); o.onChange?.(c); }
  });
  return { el, set(c) { color = c; paint(); }, get: () => color };
}

export function row(...children: (Node | string | null | false)[]): HTMLElement {
  return h('div', { class: 'row' }, ...children);
}
export function labeled(label: string, el: HTMLElement, width?: number): HTMLElement {
  const l = h('label', { class: 'field-label' }, label);
  if (width) l.style.width = `${width}px`;
  return h('div', { class: 'row labeled' }, l, el);
}
export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('fieldset', { class: 'ps-section' }, h('legend', null, title), ...children);
}

/** Floating popup anchored to an element; closes on outside click or Escape. */
export function popover(anchor: HTMLElement, content: HTMLElement, o: { onClose?: () => void; align?: 'left' | 'right'; offsetY?: number } = {}) {
  const pop = h('div', { class: 'popover' }, content);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = o.align === 'right' ? r.right - pr.width : r.left;
  left = clamp(left, 4, window.innerWidth - pr.width - 4);
  let top = r.bottom + (o.offsetY ?? 2);
  if (top + pr.height > window.innerHeight - 4) top = Math.max(4, r.top - pr.height - 2);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
    o.onClose?.();
  };
  const outside = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc, true);
  });
  return { el: pop, close };
}

/** Context menu at a screen position. */
export interface CtxItem { label: string; action?: () => void; disabled?: boolean; checked?: boolean; sep?: boolean; shortcut?: string }
export function contextMenu(x: number, y: number, items: CtxItem[]) {
  document.querySelectorAll('.menu.ctx').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu ctx' });
  for (const it of items) {
    if (it.sep) { menu.appendChild(h('div', { class: 'menu-sep' })); continue; }
    const mi = h('div', { class: `menu-item${it.disabled ? ' disabled' : ''}${it.checked ? ' checked' : ''}` },
      h('span', { class: 'menu-check' }, it.checked ? '✓' : ''),
      h('span', { class: 'menu-label' }, it.label),
      h('span', { class: 'menu-shortcut' }, it.shortcut ?? ''));
    if (!it.disabled) mi.addEventListener('click', () => { close(); it.action?.(); });
    menu.appendChild(mi);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${clamp(x, 0, window.innerWidth - r.width - 2)}px`;
  menu.style.top = `${clamp(y, 0, window.innerHeight - r.height - 2)}px`;
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
}

/** Small toast notification at bottom center. */
export function toast(msg: string, ms = 2200) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}
