// Layer Style dialog (Layer > Layer Style, Layers panel fx button) and Copy / Paste / Clear Layer Style.
// Style values: opacity 0..1, spread / choke 0..100 (%), size / distance px, angle degrees, scale %.
import { app } from '../app';
import { bus } from '../core/bus';
import { BLEND_MODES, BLEND_NAMES, BlendMode, GradientStyle, Layer, LayerStyle } from '../core/layer';
import { rafThrottle, RGB } from '../core/util';
import { h, injectStyle, onDrag } from '../ui/dom';
import { button, checkbox, colorSwatch, numberInput, Option, section, select, sliderField } from '../ui/widgets';
import { MenuItem, SEP } from '../ui/menutypes';
import { gradientPicker } from '../ui/gradientpicker';
import { patternPicker } from '../ui/patternpicker';
import { defaultPattern } from '../core/patterns';
import { alertDialog, openDialog } from './dialog';

type FxKey = keyof LayerStyle;
type FullStyle = Required<LayerStyle>;

/** Photoshop's default settings for every effect (all disabled). */
export function styleDefaults(): FullStyle {
  const black: RGB = { r: 0, g: 0, b: 0 }, glow: RGB = { r: 255, g: 255, b: 190 };
  return {
    dropShadow: { enabled: false, color: black, opacity: 0.35, angle: 120, distance: 5, spread: 0, size: 5, blend: 'multiply' },
    innerShadow: { enabled: false, color: black, opacity: 0.35, angle: 120, distance: 5, choke: 0, size: 5, blend: 'multiply' },
    outerGlow: { enabled: false, color: glow, opacity: 0.35, spread: 0, size: 5, blend: 'screen' },
    innerGlow: { enabled: false, color: glow, opacity: 0.35, choke: 0, size: 5, blend: 'screen' },
    stroke: { enabled: false, color: black, opacity: 1, size: 3, position: 'outside', blend: 'normal' },
    colorOverlay: { enabled: false, color: { r: 255, g: 0, b: 0 }, opacity: 1, blend: 'normal' },
    gradientOverlay: {
      enabled: false, opacity: 1, angle: 90, style: 'linear', scale: 100, reverse: false, blend: 'normal',
      gradient: { name: 'Black, White', stops: [{ pos: 0, color: black, opacity: 1 }, { pos: 1, color: { r: 255, g: 255, b: 255 }, opacity: 1 }] },
    },
    patternOverlay: { enabled: false, pattern: defaultPattern(), opacity: 1, scale: 100, blend: 'normal' },
    satin: { enabled: false, color: black, opacity: 0.5, angle: 19, distance: 11, size: 14, invert: true, blend: 'multiply' },
    bevel: {
      enabled: false, style: 'inner', technique: 'smooth', depth: 100, up: true, size: 5, soften: 0, angle: 120, altitude: 30,
      highlightColor: { r: 255, g: 255, b: 255 }, opacity: 0.75, highlightBlend: 'screen',
      shadowColor: black, shadowOpacity: 0.75, shadowBlend: 'multiply',
    },
  };
}

/** Effects in Photoshop's dialog / fx-menu order (top of the stack first). */
const FX: { key: FxKey; label: string }[] = [
  { key: 'bevel', label: 'Bevel & Emboss' },
  { key: 'stroke', label: 'Stroke' },
  { key: 'innerShadow', label: 'Inner Shadow' },
  { key: 'innerGlow', label: 'Inner Glow' },
  { key: 'satin', label: 'Satin' },
  { key: 'colorOverlay', label: 'Color Overlay' },
  { key: 'gradientOverlay', label: 'Gradient Overlay' },
  { key: 'patternOverlay', label: 'Pattern Overlay' },
  { key: 'outerGlow', label: 'Outer Glow' },
  { key: 'dropShadow', label: 'Drop Shadow' },
];
const FX_LABEL = Object.fromEntries(FX.map((f) => [f.key, f.label])) as Record<FxKey, string>;

const styleable = (L: Layer | null | undefined): L is Layer => !!L && L.kind !== 'adjustment';
const blendOptions = (): Option[] => BLEND_MODES.map((m) => (m === '-' ? '-' : { value: m, label: BLEND_NAMES[m] }));

function normSection(s?: string): 'blending' | FxKey {
  if (s && (FX as { key: string }[]).some((f) => f.key === s)) return s as FxKey;
  return 'blending';
}

/** Open the Layer Style dialog on the active layer; `section` = 'blending' or an effect key (enables it). */
export async function openLayerStyleDialog(which?: string): Promise<void> {
  injectCss();
  const doc = app.doc;
  if (!doc) return;
  const L = doc.active;
  if (!L) { await alertDialog('Layer Style', 'There is no layer to apply a layer style to.'); return; }
  if (L.kind === 'adjustment') { await alertDialog('Layer Style', 'Layer styles cannot be applied to adjustment layers.'); return; }

  const before = doc.captureState();
  const orig = { style: L.style, blend: L.blend, opacity: L.opacity, fill: L.fillOpacity };
  const defs = styleDefaults();
  // Dialog-owned working copies (the layer always receives fresh copies, history keeps the old objects)
  const cur = {} as FullStyle;
  for (const { key } of FX) (cur as any)[key] = { ...defs[key], ...(L.style?.[key] ?? {}) };
  const keep = new Set<FxKey>(FX.map((f) => f.key).filter((k) => !!L.style?.[k]));
  const gen = { blend: L.blend, opacity: L.opacity, fill: L.fillOpacity };
  let preview = true;
  let selected = normSection(which);
  if (selected !== 'blending') { cur[selected].enabled = true; keep.add(selected); }

  const buildStyle = (): LayerStyle | null => {
    const st: LayerStyle = {};
    let any = false, enabled = false;
    for (const { key } of FX) {
      const e = cur[key];
      if (e.enabled) enabled = true;
      if (e.enabled || keep.has(key)) { (st as any)[key] = { ...e }; any = true; }
    }
    return any && (enabled || orig.style) ? st : null;
  };
  const restore = () => { L.style = orig.style; L.blend = orig.blend; L.opacity = orig.opacity; L.fillOpacity = orig.fill; };
  const emitLayers = rafThrottle(() => bus.emit('layers', doc));
  const apply = () => {
    if (preview) { L.style = buildStyle(); L.blend = gen.blend; L.opacity = gen.opacity; L.fillOpacity = gen.fill; }
    else restore();
    doc.invalidate();
    emitLayers();
  };
  const set = (k: FxKey, patch: Record<string, unknown>) => {
    Object.assign(cur[k], patch);
    keep.add(k);
    apply();
  };

  // ---- left list ----
  const list = h('div', { class: 'ls-list' });
  const pane = h('div', { class: 'ls-pane' });
  const rows = new Map<string, HTMLElement>();
  const checks = new Map<FxKey, HTMLInputElement>();
  const addRow = (key: 'blending' | FxKey, label: string) => {
    const row = h('div', { class: 'ls-item' });
    if (key === 'blending') row.classList.add('nocheck');
    else {
      const cb = h('input', { type: 'checkbox', class: 'ps-check' }) as HTMLInputElement;
      cb.checked = cur[key].enabled;
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => set(key, { enabled: cb.checked }));
      checks.set(key, cb);
      row.append(cb);
    }
    row.append(h('span', { class: 'ls-name' }, label));
    row.addEventListener('click', () => {
      // Clicking an effect name selects it and turns it on (Photoshop behaviour)
      if (key !== 'blending' && !cur[key].enabled) { checks.get(key)!.checked = true; set(key, { enabled: true }); }
      show(key);
    });
    rows.set(key, row);
    list.append(row);
  };
  addRow('blending', 'Blending Options');
  for (const f of FX) addRow(f.key, f.label);

  // ---- right pane field helpers ----
  const fx = (k: FxKey) => cur[k] as any;
  const LW = 86;
  const lrow = (label: string, ...els: (HTMLElement | null)[]) =>
    h('div', { class: 'ls-row' }, h('label', { class: 'field-label' }, label), ...els);
  const blendSel = (v: BlendMode, on: (m: BlendMode) => void) =>
    select({ options: blendOptions(), value: v, width: 150, onChange: (m) => on(m as BlendMode) }).el;
  const swatch = (k: FxKey) => colorSwatch({ color: fx(k).color, title: `Set ${FX_LABEL[k].toLowerCase()} color`, onChange: (c) => set(k, { color: c }) }).el;
  const num = (label: string, value: number, min: number, max: number, unit: string, on: (v: number) => void) =>
    sliderField({ label, value: Math.round(value), min, max, unit, inline: true, labelWidth: LW, onInput: on }).el;
  const opacity = (k: FxKey) => num('Opacity:', fx(k).opacity * 100, 0, 100, '%', (v) => set(k, { opacity: v / 100 }));
  const prop = (k: FxKey, p: string, label: string, min: number, max: number, unit: string) =>
    num(label, fx(k)[p], min, max, unit, (v) => set(k, { [p]: v }));
  const angle = (k: FxKey) => lrow('Angle:', angleDial(fx(k).angle, (v) => set(k, { angle: v })));
  const title = (t: string) => h('div', { class: 'ls-title' }, t);
  const resetBtn = (k: FxKey) => h('div', { class: 'ls-foot' }, button('Reset to Default', () => {
    Object.assign(cur[k], styleDefaults()[k], { enabled: cur[k].enabled });
    set(k, {});
    show(k);
  }));

  const panes: Record<'blending' | FxKey, () => (HTMLElement | null)[]> = {
    blending: () => [
      title('Blending Options'),
      section('General Blending',
        lrow('Blend Mode:', blendSel(gen.blend, (m) => { gen.blend = m; apply(); })),
        num('Opacity:', gen.opacity * 100, 0, 100, '%', (v) => { gen.opacity = v / 100; apply(); })),
      section('Advanced Blending',
        num('Fill Opacity:', gen.fill * 100, 0, 100, '%', (v) => { gen.fill = v / 100; apply(); })),
    ],
    dropShadow: () => [
      title('Drop Shadow'),
      section('Structure',
        lrow('Blend Mode:', blendSel(fx('dropShadow').blend, (m) => set('dropShadow', { blend: m })), swatch('dropShadow')),
        opacity('dropShadow'),
        angle('dropShadow'),
        prop('dropShadow', 'distance', 'Distance:', 0, 1000, 'px'),
        prop('dropShadow', 'spread', 'Spread:', 0, 100, '%'),
        prop('dropShadow', 'size', 'Size:', 0, 250, 'px')),
      resetBtn('dropShadow'),
    ],
    innerShadow: () => [
      title('Inner Shadow'),
      section('Structure',
        lrow('Blend Mode:', blendSel(fx('innerShadow').blend, (m) => set('innerShadow', { blend: m })), swatch('innerShadow')),
        opacity('innerShadow'),
        angle('innerShadow'),
        prop('innerShadow', 'distance', 'Distance:', 0, 1000, 'px'),
        prop('innerShadow', 'choke', 'Choke:', 0, 100, '%'),
        prop('innerShadow', 'size', 'Size:', 0, 250, 'px')),
      resetBtn('innerShadow'),
    ],
    outerGlow: () => [
      title('Outer Glow'),
      section('Structure',
        lrow('Blend Mode:', blendSel(fx('outerGlow').blend, (m) => set('outerGlow', { blend: m }))),
        opacity('outerGlow'),
        lrow('Color:', swatch('outerGlow'))),
      section('Elements',
        prop('outerGlow', 'spread', 'Spread:', 0, 100, '%'),
        prop('outerGlow', 'size', 'Size:', 0, 250, 'px')),
      resetBtn('outerGlow'),
    ],
    innerGlow: () => [
      title('Inner Glow'),
      section('Structure',
        lrow('Blend Mode:', blendSel(fx('innerGlow').blend, (m) => set('innerGlow', { blend: m }))),
        opacity('innerGlow'),
        lrow('Color:', swatch('innerGlow'))),
      section('Elements',
        lrow('Source:', h('span', { class: 'ls-static' }, 'Edge')),
        prop('innerGlow', 'choke', 'Choke:', 0, 100, '%'),
        prop('innerGlow', 'size', 'Size:', 0, 250, 'px')),
      resetBtn('innerGlow'),
    ],
    stroke: () => [
      title('Stroke'),
      section('Structure',
        prop('stroke', 'size', 'Size:', 1, 250, 'px'),
        lrow('Position:', select({
          options: [{ value: 'outside', label: 'Outside' }, { value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }],
          value: fx('stroke').position, width: 110, onChange: (v) => set('stroke', { position: v }),
        }).el),
        lrow('Blend Mode:', blendSel(fx('stroke').blend, (m) => set('stroke', { blend: m }))),
        opacity('stroke')),
      section('Fill Type: Color', lrow('Color:', swatch('stroke'))),
      resetBtn('stroke'),
    ],
    colorOverlay: () => [
      title('Color Overlay'),
      section('Color',
        lrow('Blend Mode:', blendSel(fx('colorOverlay').blend, (m) => set('colorOverlay', { blend: m })), swatch('colorOverlay')),
        opacity('colorOverlay')),
      resetBtn('colorOverlay'),
    ],
    gradientOverlay: () => {
      const e = cur.gradientOverlay;
      const gp = gradientPicker({ value: e.gradient, reverse: e.reverse, width: 170, onChange: (g) => set('gradientOverlay', { gradient: g }) });
      const rev = checkbox({ label: 'Reverse', checked: e.reverse, onChange: (v) => { gp.setReverse(v); set('gradientOverlay', { reverse: v }); } });
      const styles: { value: GradientStyle; label: string }[] = [
        { value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'angle', label: 'Angle' },
        { value: 'reflected', label: 'Reflected' }, { value: 'diamond', label: 'Diamond' },
      ];
      return [
        title('Gradient Overlay'),
        section('Gradient',
          lrow('Blend Mode:', blendSel(e.blend, (m) => set('gradientOverlay', { blend: m }))),
          opacity('gradientOverlay'),
          lrow('Gradient:', gp.el, rev.el),
          lrow('Style:', select({ options: styles, value: e.style, width: 110, onChange: (v) => set('gradientOverlay', { style: v }) }).el,
            h('span', { class: 'ls-static', title: 'The gradient spans the layer content bounds' }, 'Align with Layer')),
          angle('gradientOverlay'),
          prop('gradientOverlay', 'scale', 'Scale:', 10, 150, '%')),
        resetBtn('gradientOverlay'),
      ];
    },
    patternOverlay: () => {
      const e = cur.patternOverlay;
      const pp = patternPicker({ value: e.pattern, size: 40, onChange: (p) => set('patternOverlay', { pattern: p }) });
      return [
        title('Pattern Overlay'),
        section('Pattern',
          lrow('Blend Mode:', blendSel(e.blend, (m) => set('patternOverlay', { blend: m }))),
          opacity('patternOverlay'),
          lrow('Pattern:', pp.el, h('span', { class: 'ls-static', title: 'The pattern is anchored to the document origin' }, 'Snap to Origin')),
          prop('patternOverlay', 'scale', 'Scale:', 1, 1000, '%')),
        resetBtn('patternOverlay'),
      ];
    },
    satin: () => [
      title('Satin'),
      section('Structure',
        lrow('Blend Mode:', blendSel(fx('satin').blend, (m) => set('satin', { blend: m })), swatch('satin')),
        opacity('satin'),
        angle('satin'),
        prop('satin', 'distance', 'Distance:', 1, 250, 'px'),
        prop('satin', 'size', 'Size:', 0, 250, 'px'),
        lrow('', checkbox({ label: 'Invert', checked: fx('satin').invert, onChange: (v) => set('satin', { invert: v }) }).el)),
      resetBtn('satin'),
    ],
    bevel: () => {
      const e = cur.bevel;
      const colorOf = (p: 'highlightColor' | 'shadowColor', what: string) =>
        colorSwatch({ color: e[p], title: `Set ${what} color`, onChange: (c) => set('bevel', { [p]: c }) }).el;
      return [
        title('Bevel & Emboss'),
        section('Structure',
          lrow('Style:', select({
            options: [{ value: 'inner', label: 'Inner Bevel' }, { value: 'outer', label: 'Outer Bevel' }, { value: 'emboss', label: 'Emboss' }, { value: 'pillow', label: 'Pillow Emboss' }],
            value: e.style, width: 130, onChange: (v) => set('bevel', { style: v }),
          }).el),
          lrow('Technique:', select({
            options: [{ value: 'smooth', label: 'Smooth' }, { value: 'chisel', label: 'Chisel Hard' }],
            value: e.technique, width: 130, onChange: (v) => set('bevel', { technique: v }),
          }).el),
          prop('bevel', 'depth', 'Depth:', 1, 1000, '%'),
          lrow('Direction:', select({
            options: [{ value: 'up', label: 'Up' }, { value: 'down', label: 'Down' }],
            value: e.up ? 'up' : 'down', width: 80, onChange: (v) => set('bevel', { up: v === 'up' }),
          }).el),
          prop('bevel', 'size', 'Size:', 0, 250, 'px'),
          prop('bevel', 'soften', 'Soften:', 0, 16, 'px')),
        section('Shading',
          angle('bevel'),
          prop('bevel', 'altitude', 'Altitude:', 0, 90, '°'),
          lrow('Highlight:', blendSel(e.highlightBlend, (m) => set('bevel', { highlightBlend: m })), colorOf('highlightColor', 'highlight')),
          num('Opacity:', e.opacity * 100, 0, 100, '%', (v) => set('bevel', { opacity: v / 100 })),
          lrow('Shadow:', blendSel(e.shadowBlend, (m) => set('bevel', { shadowBlend: m })), colorOf('shadowColor', 'shadow')),
          num('Opacity:', e.shadowOpacity * 100, 0, 100, '%', (v) => set('bevel', { shadowOpacity: v / 100 }))),
        resetBtn('bevel'),
      ];
    },
  };

  const show = (key: 'blending' | FxKey) => {
    selected = key;
    rows.forEach((r, k) => r.classList.toggle('active', k === key));
    pane.replaceChildren(...panes[key]().filter((x): x is HTMLElement => !!x));
  };
  show(selected);
  apply();

  const changed = () =>
    JSON.stringify(L.style) !== JSON.stringify(orig.style) ||
    L.blend !== orig.blend || L.opacity !== orig.opacity || L.fillOpacity !== orig.fill;

  await openDialog({
    title: 'Layer Style',
    content: h('div', { class: 'ls' }, list, pane),
    width: 760,
    layout: 'side',
    className: 'ls-dlg',
    preview: { checked: true, onToggle: (on) => { preview = on; apply(); } },
    onOk: () => {
      preview = true;
      L.style = buildStyle(); L.blend = gen.blend; L.opacity = gen.opacity; L.fillOpacity = gen.fill;
      if (changed()) doc.commit('Layer Style', before);
      else { doc.invalidate(); bus.emit('layers', doc); }
    },
    onCancel: () => {
      restore();
      doc.invalidate();
      bus.emit('layers', doc);
    },
  });
}

/** Photoshop's round angle control + numeric field. */
function angleDial(value: number, onInput: (v: number) => void): HTMLElement {
  const hand = h('div', { class: 'ls-dial-hand' });
  const dial = h('div', { class: 'ls-dial', title: 'Drag to set the angle' }, hand, h('div', { class: 'ls-dial-dot' }));
  const paint = (v: number) => { hand.style.transform = `rotate(${-v}deg)`; };
  const field = numberInput({ value, min: -180, max: 180, unit: '°', width: 46, onInput: (v) => { paint(v); onInput(v); } });
  const fromEvent = (e: PointerEvent) => {
    const r = dial.getBoundingClientRect();
    const a = Math.round((Math.atan2(-(e.clientY - (r.top + r.height / 2)), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI);
    if (a === field.get()) return;
    field.set(a);
    paint(a);
    onInput(a);
  };
  onDrag(dial, { down: (e) => { fromEvent(e); }, move: (e) => fromEvent(e) });
  paint(value);
  return h('div', { class: 'ls-angle' }, dial, field.el);
}

// ---------------------------------------------------------------------------------------------
// Copy / Paste / Clear Layer Style

let clip: { style: LayerStyle | null; blend: BlendMode; opacity: number; fillOpacity: number } | null = null;

export function copyLayerStyle() {
  const L = app.doc?.active;
  if (!styleable(L) || !L.style) return;
  clip = { style: L.style, blend: L.blend, opacity: L.opacity, fillOpacity: L.fillOpacity };
}

export function pasteLayerStyle() {
  const doc = app.doc;
  if (!doc || !clip) return;
  const targets = doc.selectedLayers.filter(styleable);
  if (!targets.length) return;
  const before = doc.captureState();
  // Style objects are immutable values, so layers can share them
  for (const L of targets) { L.style = clip.style; L.blend = clip.blend; L.opacity = clip.opacity; L.fillOpacity = clip.fillOpacity; }
  doc.commit('Paste Layer Style', before);
}

export function clearLayerStyle() {
  const doc = app.doc;
  if (!doc) return;
  const targets = doc.selectedLayers.filter((L) => !!L.style);
  if (!targets.length) return;
  const before = doc.captureState();
  for (const L of targets) L.style = null;
  doc.commit('Clear Layer Style', before);
}

/** Layer > Layer Style submenu. */
export function layerStyleMenuItems(): MenuItem[] {
  const can = () => styleable(app.doc?.active);
  const open = (s: string) => () => { void openLayerStyleDialog(s); };
  return [
    { label: 'Blending Options...', action: open('blending'), enabled: can },
    SEP,
    ...FX.map((f): MenuItem => ({ label: `${f.label}...`, action: open(f.key), enabled: can })),
    SEP,
    { label: 'Copy Layer Style', action: copyLayerStyle, enabled: () => { const L = app.doc?.active; return styleable(L) && !!L.style; } },
    { label: 'Paste Layer Style', action: pasteLayerStyle, enabled: () => !!clip && !!app.doc?.selectedLayers.some(styleable) },
    { label: 'Clear Layer Style', action: clearLayerStyle, enabled: () => !!app.doc?.selectedLayers.some((L) => !!L.style) },
  ];
}

/** Items for the "fx" button popup at the bottom of the Layers panel. */
export function fxMenuItems(): { label: string; action: () => void }[] {
  return [
    { label: 'Blending Options...', action: () => { void openLayerStyleDialog('blending'); } },
    ...FX.map((f) => ({ label: `${f.label}...`, action: () => { void openLayerStyleDialog(f.key); } })),
  ];
}

function injectCss() {
  injectStyle('layerstyle', `
.ls-dlg .ls { min-height: 470px; }
.ls-item { user-select: none; -webkit-user-select: none; }
.ls-item.nocheck { padding-left: 32px; font-weight: 600; }
.ls-item .ls-name { flex: 1; white-space: nowrap; }
.ls-pane { min-width: 0; }
.ls-title { font-size: 13px; font-weight: 600; color: var(--text-strong); }
.ls-pane .slider-field.inline .field-label, .ls-row > .field-label { width: 86px; min-width: 86px; text-align: right; flex-shrink: 0; }
.ls-pane .slider-field.inline .ps-range { flex: 1; }
.ls-row { display: flex; align-items: center; gap: 8px; }
.ls-static { color: var(--text-2); }
.ls-angle { display: flex; align-items: center; gap: 8px; }
.ls-dial { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--input-border); background: var(--input); position: relative; flex-shrink: 0; cursor: pointer; touch-action: none; }
.ls-dial-hand { position: absolute; left: 50%; top: 50%; width: 13px; height: 2px; margin-top: -1px; background: var(--text-strong); transform-origin: 0 50%; pointer-events: none; }
.ls-dial-dot { position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px; border-radius: 50%; background: var(--text-strong); pointer-events: none; }
.ls-foot { display: flex; justify-content: center; gap: 8px; margin-top: 2px; }
`);
}
