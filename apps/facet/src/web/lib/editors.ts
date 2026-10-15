// Settings forms for a clock or a folder. The same forms appear in the popover on the desktop and in the
// Facet window; every change is reported at once so the widget updates live.
import type { ClockWidget, FolderWidget } from '../../shared/types';
import { h } from './dom';
import { FACES, FONTS } from './clock';
import { field, segmented, slider, stepper, swatches, toggle } from './controls';

export function clockEditor(w: ClockWidget, onChange: (patch: Partial<ClockWidget>) => void) {
  const el = h('div', { class: 'editor' });
  const render = () => {
    const digital = w.face !== 'analog';
    const set = (patch: Partial<ClockWidget>, rebuild = false) => { Object.assign(w, patch); onChange(patch); if (rebuild) render(); };
    el.replaceChildren(
      field('Style', faceCards(w.face, (face) => {
        // a card needs a surface; the others look best straight on the wallpaper
        const patch: Partial<ClockWidget> = { face };
        if (face === 'card' && w.bg === 'none') patch.bg = 'glass';
        if (face !== 'card' && w.face === 'card' && w.bg === 'glass') patch.bg = 'none';
        if (face === 'analog' && !w.seconds) patch.seconds = true;
        if (face === 'stacked' && w.weight < 500) patch.weight = 700;
        if (face === 'minimal' && w.face === 'stacked') patch.weight = 200;
        if (face === 'card') patch.align = 'left';
        set(patch, true);
      })),
      digital ? field('Font', fontChips(w.font, (font) => set({ font }))) : '',
      digital ? field('Weight', slider(100, 900, 100, w.weight, (v) => WEIGHTS[v] ?? String(v), (weight) => set({ weight }))) : '',
      field('Size', slider(40, 300, 5, w.scale, (v) => `${v}%`, (scale) => set({ scale }))),
      field('Colour', swatches(w.color, (color) => set({ color }))),
      field(w.face === 'analog' ? 'Second hand' : w.face === 'card' ? 'Weekday colour' : 'Accent', swatches(w.accent, (accent) => set({ accent }))),
      field('Date', segmented([{ id: 'none', label: 'None' }, { id: 'short', label: 'Short' }, { id: 'long', label: 'Long' }] as const, w.date, (date) => set({ date }))),
      field('Background', segmented([{ id: 'none', label: 'None' }, { id: 'glass', label: 'Glass' }, { id: 'dark', label: 'Dark' }] as const, w.bg, (bg) => set({ bg }))),
      digital ? field('Align', segmented([{ id: 'left', label: 'Left' }, { id: 'center', label: 'Center' }, { id: 'right', label: 'Right' }] as const, w.align, (align) => set({ align }))) : '',
      h('div', { class: 'toggles' },
        digital ? toggle('24-hour time', w.hour24, (hour24) => set({ hour24 })) : '',
        toggle(w.face === 'analog' ? 'Second hand' : 'Seconds', w.seconds, (seconds) => set({ seconds })),
        toggle('Shadow', w.shadow, (shadow) => set({ shadow })),
        digital && w.face !== 'stacked' ? toggle('Blinking colon', w.blink, (blink) => set({ blink })) : '',
      ),
    );
  };
  render();
  return el;
}

const WEIGHTS: Record<number, string> = { 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };

function faceCards(value: ClockWidget['face'], onPick: (f: ClockWidget['face']) => void) {
  const el = h('div', { class: 'faces' });
  for (const f of FACES) {
    const b = h('button', { type: 'button', class: `face-opt${f.id === value ? ' on' : ''}`, html: FACE_ART[f.id] }, h('span', { text: f.label }));
    b.addEventListener('click', () => onPick(f.id));
    el.append(b);
  }
  return el;
}

const FACE_ART: Record<ClockWidget['face'], string> = {
  minimal: '<svg viewBox="0 0 64 40"><text x="32" y="25" text-anchor="middle" font-size="20" font-weight="200" fill="currentColor" font-family="Segoe UI Variable Display, Segoe UI">9:41</text><rect x="18" y="31" width="28" height="2.4" rx="1.2" fill="currentColor" opacity=".45"/></svg>',
  card: '<svg viewBox="0 0 64 40"><rect x="6" y="3" width="52" height="34" rx="8" fill="currentColor" opacity=".16"/><rect x="12" y="9" width="16" height="2.6" rx="1.3" fill="#ff9f0a"/><text x="12" y="28" font-size="15" font-weight="300" fill="currentColor" font-family="Segoe UI Variable Display, Segoe UI">9:41</text></svg>',
  analog: '<svg viewBox="0 0 64 40"><circle cx="32" cy="20" r="16" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="1.4"/><line x1="32" y1="20" x2="32" y2="9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="32" y1="20" x2="40" y2="23" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><line x1="32" y1="22" x2="25" y2="11" stroke="#ff9f0a" stroke-width="1"/></svg>',
  stacked: '<svg viewBox="0 0 64 40"><text x="32" y="18" text-anchor="middle" font-size="17" font-weight="800" fill="currentColor" font-family="Segoe UI Variable Display, Segoe UI">09</text><text x="32" y="36" text-anchor="middle" font-size="17" font-weight="800" fill="currentColor" font-family="Segoe UI Variable Display, Segoe UI">41</text></svg>',
};

function fontChips(value: string, onPick: (f: string) => void) {
  const el = h('div', { class: 'chips' });
  for (const [id, f] of Object.entries(FONTS)) {
    const b = h('button', { type: 'button', class: `chip${id === value ? ' on' : ''}`, style: `font-family:${f.css}`, text: f.label });
    b.addEventListener('click', () => { el.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); onPick(id); });
    el.append(b);
  }
  return el;
}

/** Folder appearance. `nameInput` lets the desktop popover ask for keyboard focus before typing. */
export function folderEditor(w: FolderWidget, onChange: (patch: Partial<FolderWidget>) => void, opts: { onNameFocus?: (focus: boolean) => void } = {}) {
  const el = h('div', { class: 'editor' });
  const render = () => {
    const set = (patch: Partial<FolderWidget>, rebuild = false) => { Object.assign(w, patch); onChange(patch); if (rebuild) render(); };
    const name = h('input', { type: 'text', class: 'text', value: w.name, maxlength: '60', spellcheck: 'false' }) as HTMLInputElement;
    name.addEventListener('input', () => set({ name: name.value.trim() || 'Folder' }));
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') name.blur(); });
    name.addEventListener('pointerdown', () => opts.onNameFocus?.(true));
    name.addEventListener('blur', () => { if (!name.value.trim()) name.value = w.name; opts.onNameFocus?.(false); });
    el.replaceChildren(
      field('Name', name),
      field('Show as', segmented([{ id: 'tile', label: 'Folder', title: 'An icon that opens like an iPhone folder' }, { id: 'panel', label: 'Panel', title: 'Always open on the desktop' }] as const, w.style, (style) => set({ style }, true))),
      field(w.style === 'tile' ? 'Folder size' : 'Icon size', segmented([{ id: 's', label: 'Small' }, { id: 'm', label: 'Medium' }, { id: 'l', label: 'Large' }] as const, w.size, (size) => set({ size }))),
      w.style === 'panel' ? h('div', { class: 'pair' }, field('Columns', stepper(2, 10, w.cols, (cols) => set({ cols }))), field('Rows', stepper(1, 10, w.rows, (rows) => set({ rows })))) : '',
      field('Tint', swatches(w.tint, (tint) => set({ tint }), { none: 'Clear glass' })),
    );
  };
  render();
  return el;
}
