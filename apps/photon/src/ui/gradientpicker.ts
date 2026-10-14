// Gradient preview button (like Photoshop's options bar): click the bar to open the Gradient Editor,
// click the chevron for a quick preset picker.
import { app } from '../app';
import { Gradient } from '../core/layer';
import { GRADIENT_PRESETS, fgBgGradient, fgTransparentGradient, gradientSwatch } from '../core/gradient';
import { createCanvas, ctx2d } from '../core/util';
import { openGradientEditor, cloneGradient } from '../dialogs/gradienteditor';
import { h, injectStyle } from './dom';
import { icon } from './icons';
import { popover } from './widgets';

const reversed = (g: Gradient): Gradient => ({ name: g.name, stops: g.stops.map((s) => ({ ...s, pos: 1 - s.pos })).reverse() });

export function gradientPicker(o: { value: Gradient; reverse?: boolean; onChange: (g: Gradient) => void; width?: number }): {
  el: HTMLElement; set(g: Gradient): void; get(): Gradient; setReverse(r: boolean): void;
} {
  injectCss();
  let value = o.value;
  let reverse = !!o.reverse;
  const W = o.width ?? 120, H = 22;
  const cv = createCanvas(W, H);
  const bar = h('button', { class: 'gp-bar', title: 'Click to edit the gradient' }, cv);
  const chev = h('button', { class: 'gp-chev', title: 'Open the gradient picker' }, icon('chevron-down', 12));
  const el = h('div', { class: 'gp' }, bar, chev);

  const paint = () => {
    const x = ctx2d(cv);
    x.clearRect(0, 0, W, H);
    x.drawImage(gradientSwatch(reverse ? reversed(value) : value, W, H), 0, 0);
    bar.title = `${value.name || 'Custom'} — click to edit the gradient`;
  };
  const pick = (g: Gradient) => { value = g; paint(); o.onChange(g); };
  let pop: { el: HTMLElement; close: () => void } | null = null;

  bar.addEventListener('click', async () => {
    pop?.close();
    const g = await openGradientEditor(value);
    if (g) pick(g);
  });

  chev.addEventListener('click', () => {
    if (pop) { pop.close(); return; }
    const presets = [fgBgGradient(app.fg, app.bg), fgTransparentGradient(app.fg), ...GRADIENT_PRESETS];
    const grid = h('div', { class: 'gp-grid' });
    for (const g of presets) {
      const t = h('button', { class: 'gp-tile', title: g.name ?? '' }, gradientSwatch(g, 32, 32));
      t.addEventListener('click', () => { pop?.close(); pick(cloneGradient(g)); });
      grid.append(t);
    }
    pop = popover(el, grid, { onClose: () => { pop = null; } });
    pop.el.style.zIndex = '2600'; // above modal dialogs (the picker is used inside Layer Style)
  });

  paint();
  return {
    el,
    set(g) { value = g; paint(); },
    get: () => value,
    setReverse(r) { reverse = r; paint(); },
  };
}

function injectCss() {
  injectStyle('gradientpicker', `
.gp { display: inline-flex; align-items: stretch; border: 1px solid var(--input-border); border-radius: 3px; overflow: hidden; background: var(--input); flex-shrink: 0; }
.gp-bar { padding: 0; border: none; background: none; display: block; line-height: 0; cursor: pointer; }
.gp-bar canvas { display: block; }
.gp-bar:hover { filter: brightness(1.08); }
.gp-chev { border: none; border-left: 1px solid var(--input-border); background: var(--input); color: var(--icon); width: 18px; padding: 0; display: flex; align-items: center; justify-content: center; }
.gp-chev:hover { background: var(--panel-3); }
.gp-grid { display: grid; grid-template-columns: repeat(7, 36px); gap: 4px; }
.gp-tile { width: 36px; height: 36px; padding: 1px; border: 1px solid var(--input-border); background: var(--panel-2); border-radius: 2px; line-height: 0; cursor: default; }
.gp-tile:hover { border-color: var(--accent); }
.gp-tile canvas { width: 32px; height: 32px; display: block; }
`);
}
