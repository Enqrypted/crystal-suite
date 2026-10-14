// Docked tabbed panel groups + collapsed icon strip, like Photoshop's right column.
import { h, clear } from './dom';
import { icon } from './icons';
import { contextMenu, CtxItem } from './widgets';
import { bus } from '../core/bus';

export interface Panel {
  id: string;
  title: string;
  icon: string;
  build(): HTMLElement;
  menu?(): CtxItem[];
}

const registry = new Map<string, { panel: Panel; el: HTMLElement | null; show: () => void; hide?: () => void; visible: () => boolean }>();

function bodyOf(p: Panel, reg: { el: HTMLElement | null }) {
  if (!reg.el) reg.el = p.build();
  return reg.el;
}

export function panelGroup(panels: Panel[], o: { grow?: boolean; height?: number } = {}): HTMLElement {
  const tabs = h('div', { class: 'panel-tabs' });
  const body = h('div', { class: 'panel-body' });
  const group = h('div', { class: `panel-group${o.grow ? ' grow' : ''}` }, tabs, body);
  if (o.height) { group.style.height = `${o.height}px`; group.style.flexShrink = '0'; }
  let active = panels[0];
  const menuBtn = h('button', { class: 'panel-menu-btn', title: 'Panel menu' }, icon('panel-menu', 14));
  menuBtn.addEventListener('click', () => {
    const items = active.menu?.() ?? [];
    const r = menuBtn.getBoundingClientRect();
    contextMenu(r.left - 180, r.bottom, items.length ? items : [{ label: 'Close Tab Group', action: () => { group.style.display = 'none'; } }]);
  });
  const tabEls = panels.map((p) => {
    const t = h('div', { class: 'panel-tab' }, p.title);
    t.addEventListener('click', () => activate(p));
    t.addEventListener('dblclick', () => group.classList.toggle('collapsed'));
    return t;
  });
  tabs.append(...tabEls, h('div', { class: 'spacer' }), menuBtn);
  const regs = panels.map((p) => {
    const reg = { panel: p, el: null as HTMLElement | null, show: () => { group.style.display = ''; group.classList.remove('collapsed'); activate(p); }, visible: () => group.style.display !== 'none' && active === p };
    registry.set(p.id, reg);
    return reg;
  });
  function activate(p: Panel) {
    active = p;
    tabEls.forEach((t, i) => t.classList.toggle('active', panels[i] === p));
    clear(body);
    const reg = regs[panels.indexOf(p)];
    body.appendChild(bodyOf(p, reg));
    bus.emit('panel-shown', p.id);
  }
  activate(active);
  return group;
}

/** Narrow strip of icons; clicking one opens its panel in a flyout. */
export function iconStrip(groups: Panel[][]): HTMLElement {
  const strip = h('div', { class: 'iconstrip' });
  let open: { id: string; el: HTMLElement } | null = null;
  const close = () => { open?.el.remove(); open = null; strip.querySelectorAll('.iconstrip-btn').forEach((b) => b.classList.remove('active')); };
  const show = (p: Panel, btn: HTMLElement) => {
    if (open?.id === p.id) { close(); return; }
    close();
    const reg = registry.get(p.id)!;
    const r = btn.getBoundingClientRect();
    const menuBtn = h('button', { class: 'panel-menu-btn' }, icon('close', 12));
    menuBtn.addEventListener('click', close);
    const el = h('div', { class: 'flyout-panel' },
      h('div', { class: 'panel-tabs' }, h('div', { class: 'panel-tab active' }, p.title), h('div', { class: 'spacer' }), menuBtn),
      h('div', { class: 'panel-body' }, bodyOf(p, reg)));
    document.body.appendChild(el);
    const er = el.getBoundingClientRect();
    el.style.left = `${r.left - er.width - 4}px`;
    el.style.top = `${Math.min(r.top, window.innerHeight - er.height - 8)}px`;
    open = { id: p.id, el };
    btn.classList.add('active');
    bus.emit('panel-shown', p.id);
  };
  groups.forEach((g, gi) => {
    if (gi) strip.appendChild(h('div', { class: 'iconstrip-sep' }));
    for (const p of g) {
      const b = h('button', { class: 'iconstrip-btn', title: p.title }, icon(p.icon, 18));
      b.addEventListener('click', () => show(p, b));
      strip.appendChild(b);
      registry.set(p.id, { panel: p, el: null, show: () => { if (open?.id !== p.id) show(p, b); }, hide: close, visible: () => open?.id === p.id });
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (open && !open.el.contains(e.target as Node) && !strip.contains(e.target as Node) && !(e.target as HTMLElement).closest('.popover, .menu, .dlg-overlay, .tool-flyout')) close();
  });
  return strip;
}

export function showPanel(id: string) { registry.get(id)?.show(); }
export function isPanelVisible(id: string) { return registry.get(id)?.visible() ?? false; }
export function togglePanel(id: string) {
  const r = registry.get(id);
  if (!r) return;
  if (r.visible() && r.hide) r.hide(); else r.show();
}
bus.on('show-panel', (id: string) => showPanel(id));
