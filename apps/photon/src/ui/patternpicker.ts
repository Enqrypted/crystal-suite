// Pattern swatch button with a picker popup (Fill dialog, Pattern fill layers, Pattern Overlay, Pattern Stamp).
import { allPatterns, deletePattern, isUserPattern, Pattern, patternSwatch, usePattern } from '../core/patterns';
import { h, injectStyle } from './dom';
import { icon } from './icons';
import { popover } from './widgets';

export function patternPicker(o: { value: Pattern; onChange: (p: Pattern) => void; size?: number }): { el: HTMLElement; get(): Pattern; set(p: Pattern): void } {
  injectCss();
  let value = o.value;
  const S = o.size ?? 26;
  const face = h('button', { class: 'pp-face' });
  const chev = h('button', { class: 'pp-chev', title: 'Choose a pattern' }, icon('chevron-down', 12));
  const el = h('div', { class: 'pp' }, face, chev);
  const paint = () => { face.replaceChildren(patternSwatch(value, S)); face.title = value.name; };
  let pop: { el: HTMLElement; close: () => void } | null = null;
  const open = () => {
    if (pop) { pop.close(); return; }
    const grid = h('div', { class: 'pp-grid' });
    const fill = () => {
      grid.replaceChildren();
      for (const p of allPatterns()) {
        const t = h('button', { class: `pp-tile${p.data === value.data ? ' on' : ''}`, title: `${p.name} (${p.w} × ${p.h} px)${isUserPattern(p) ? ' — right-click to delete' : ''}` }, patternSwatch(p, 32));
        t.addEventListener('click', () => { pop?.close(); value = p; paint(); usePattern(p); o.onChange(p); });
        if (isUserPattern(p)) t.addEventListener('contextmenu', (e) => { e.preventDefault(); deletePattern(p.id); fill(); });
        grid.append(t);
      }
    };
    fill();
    const body = h('div', { class: 'col' }, grid, h('div', { class: 'field-label pp-note' }, 'Make your own with Edit › Define Pattern.'));
    pop = popover(el, body, { onClose: () => { pop = null; } });
    pop.el.style.zIndex = '2600'; // above modal dialogs
  };
  face.addEventListener('click', open);
  chev.addEventListener('click', open);
  paint();
  return { el, get: () => value, set(p) { value = p; paint(); } };
}

function injectCss() {
  injectStyle('patternpicker', `
.pp { display: inline-flex; align-items: stretch; border: 1px solid var(--input-border); border-radius: 3px; overflow: hidden; background: var(--input); flex-shrink: 0; }
.pp-face { padding: 0; border: none; background: none; line-height: 0; cursor: pointer; }
.pp-face canvas { display: block; }
.pp-face:hover { filter: brightness(1.08); }
.pp-chev { border: none; border-left: 1px solid var(--input-border); background: var(--input); color: var(--icon); width: 18px; padding: 0; display: flex; align-items: center; justify-content: center; }
.pp-chev:hover { background: var(--panel-3); }
.pp-grid { display: grid; grid-template-columns: repeat(6, 36px); gap: 4px; }
.pp-tile { width: 36px; height: 36px; padding: 1px; border: 1px solid var(--input-border); background: var(--panel-2); border-radius: 2px; line-height: 0; cursor: default; }
.pp-tile:hover, .pp-tile.on { border-color: var(--accent); }
.pp-tile canvas { width: 32px; height: 32px; display: block; }
.pp-note { font-size: 11px; max-width: 240px; }
`);
}
