import { h, clear } from './dom';
import { icon } from './icons';
import { bus } from '../core/bus';
import { app } from '../app';
import { cssColor } from '../core/util';
import { TOOLBAR, toolsInGroup, groupTool, setTool, currentTool, Tool } from '../tools/tool';
import { pickColor } from './widgets';
import { toggleQuickMask } from '../ops/selectops';

let flyout: HTMLElement | null = null;
function closeFlyout() { flyout?.remove(); flyout = null; }

function tooltip(t: Tool) { return `${t.name}${t.key ? ` (${t.key})` : ''}`; }

export function buildToolbar(onScreenMode: () => void): HTMLElement {
  const el = h('div', { class: 'toolbar' });
  const grip = h('div', { class: 'toolbar-grip', title: 'Toggle one/two columns' });
  grip.addEventListener('click', () => el.classList.toggle('two-col'));
  const btnWrap = h('div', { style: { display: 'contents' } });
  const btns = new Map<string, HTMLButtonElement>();

  const render = () => {
    clear(btnWrap);
    btns.clear();
    for (const g of TOOLBAR) {
      if (g === null) { btnWrap.appendChild(h('div', { class: 'tool-sep' })); continue; }
      const t = groupTool(g);
      const members = toolsInGroup(g);
      const b = h('button', { class: `tool-btn${members.length > 1 ? ' has-group' : ''}`, title: tooltip(t) }, icon(t.icon, 20)) as HTMLButtonElement;
      let timer = 0;
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        timer = window.setTimeout(() => openFlyout(g, b), 380);
      });
      b.addEventListener('pointerup', () => clearTimeout(timer));
      b.addEventListener('pointerleave', () => clearTimeout(timer));
      b.addEventListener('click', (e) => {
        if (flyout) return;
        if (e.altKey && members.length > 1) {
          const i = members.indexOf(groupTool(g));
          setTool(members[(i + 1) % members.length].id);
        } else setTool(groupTool(g).id);
      });
      b.addEventListener('dblclick', () => {
        if (g === 'hand') (window as any).photonViewport?.fit();
        if (g === 'zoom') (window as any).photonViewport?.actualPixels();
      });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); if (members.length > 1) openFlyout(g, b); });
      btns.set(g, b);
      btnWrap.appendChild(b);
    }
    sync();
  };
  const sync = () => {
    const cur = currentTool();
    for (const [g, b] of btns) {
      const t = groupTool(g);
      b.classList.toggle('active', !!cur && cur.group === g);
      b.title = tooltip(t);
      const ic = b.querySelector('.ico');
      if (ic && ic.getAttribute('data-icon') !== t.icon) { const n = icon(t.icon, 20); n.setAttribute('data-icon', t.icon); ic.replaceWith(n); }
    }
  };
  function openFlyout(g: string, anchor: HTMLElement) {
    closeFlyout();
    const r = anchor.getBoundingClientRect();
    const cur = groupTool(g);
    flyout = h('div', { class: 'tool-flyout', style: { left: `${r.right + 2}px`, top: `${r.top}px` } },
      ...toolsInGroup(g).map((t) => {
        const it = h('div', { class: 'tool-flyout-item' }, h('span', { class: 'mark' }, t === cur ? '■' : ''), icon(t.icon, 18), h('span', { class: 'name' }, t.name), h('span', { class: 'key' }, t.key));
        it.addEventListener('click', () => { setTool(t.id); closeFlyout(); });
        return it;
      }));
    document.body.appendChild(flyout);
    setTimeout(() => document.addEventListener('pointerdown', (e) => { if (flyout && !flyout.contains(e.target as Node)) closeFlyout(); }, { once: true, capture: true }));
  }

  // colors widget
  const fg = h('div', { class: 'fg', title: 'Set foreground color' });
  const bg = h('div', { class: 'bg', title: 'Set background color' });
  const swap = h('div', { class: 'swap', title: 'Switch Foreground and Background Colors (X)' }, icon('swap', 12));
  const reset = h('div', { class: 'reset', title: 'Default Foreground and Background Colors (D)' }, icon('default-colors', 12));
  fg.addEventListener('click', async () => { const c = await pickColor(app.fg, 'Color Picker (Foreground Color)'); if (c) app.setFg(c); });
  bg.addEventListener('click', async () => { const c = await pickColor(app.bg, 'Color Picker (Background Color)'); if (c) app.setBg(c); });
  swap.addEventListener('click', () => app.swapColors());
  reset.addEventListener('click', () => app.resetColors());
  const colors = h('div', { class: 'colors-widget' }, fg, bg, swap, reset);
  const syncColors = () => { fg.style.background = cssColor(app.fg); bg.style.background = cssColor(app.bg); };
  syncColors();
  bus.on('colors', syncColors);

  const qm = h('button', { class: 'tool-btn', title: 'Edit in Quick Mask Mode (Q)' }, icon('quick-mask', 20));
  qm.addEventListener('click', () => toggleQuickMask());
  bus.on('selection', () => qm.classList.toggle('active', !!app.doc?.quickMask));
  bus.on('docs', () => qm.classList.toggle('active', !!app.doc?.quickMask));
  const sm = h('button', { class: 'tool-btn', title: 'Change Screen Mode (F)' }, icon('screen-mode', 20));
  sm.addEventListener('click', onScreenMode);

  el.append(grip, btnWrap, colors, qm, sm);
  render();
  bus.on('tool', sync);
  return el;
}

/** Options bar: shows the current tool's controls. */
export function buildOptionsBar(): HTMLElement {
  const el = h('div', { class: 'optionsbar' });
  let shown: HTMLElement | null = null;
  const sync = () => {
    const t = currentTool();
    const o = t?.options() ?? null;
    if (o === shown) return;
    clear(el);
    if (o) el.appendChild(o);
    shown = o;
  };
  bus.on('tool', sync);
  sync();
  return el;
}
