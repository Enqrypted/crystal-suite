// Menus: the menu bar, context menus and keyboard shortcut dispatch (shortcuts are declared on items).
import { h } from './dom';

export interface MenuItem {
  label?: string;
  key?: string; // shortcut shown and handled, e.g. "Ctrl+Shift+S", "S", "Delete"
  run?: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
  submenu?: () => MenuItem[];
  sep?: true;
}
export interface TopMenu { label: string; items: () => MenuItem[] }

let openMenus: HTMLElement[] = [];
let onCloseAll: (() => void) | null = null;

export function closeMenus() {
  openMenus.forEach((m) => m.remove());
  openMenus = [];
  onCloseAll?.();
  onCloseAll = null;
}

/** Shows a popup menu at (x, y). */
export function popup(items: MenuItem[], x: number, y: number, level = 0) {
  openMenus.slice(level).forEach((m) => m.remove());
  openMenus = openMenus.slice(0, level);
  const m = h('div', { class: 'menu' });
  for (const it of items) {
    if (it.sep) {
      if (m.lastElementChild && !m.lastElementChild.classList.contains('sep')) m.append(h('div', { class: 'sep' }));
      continue;
    }
    const enabled = it.enabled ? it.enabled() : true;
    const row = h('div', { class: `item${enabled ? '' : ' disabled'}` },
      h('span', { class: 'check' }, it.checked?.() ? '✓' : ''),
      h('span', { class: 'label' }, it.label ?? ''),
      it.submenu ? h('span', { class: 'arrow' }, '›') : h('span', { class: 'key' }, it.key ?? ''));
    row.addEventListener('pointerenter', () => {
      m.querySelectorAll('.hot').forEach((x) => x.classList.remove('hot'));
      if (it.submenu && enabled) {
        row.classList.add('hot');
        const r = row.getBoundingClientRect();
        popup(it.submenu(), r.right - 2, r.top - 5, level + 1);
      } else {
        openMenus.slice(level + 1).forEach((x) => x.remove());
        openMenus = openMenus.slice(0, level + 1);
      }
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!enabled || it.submenu) return;
      closeMenus();
      it.run?.();
    });
    m.append(row);
  }
  while (m.lastElementChild?.classList.contains('sep')) m.lastElementChild.remove();
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  openMenus.push(m);
  return m;
}

export function contextMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  closeMenus();
  popup(items, e.clientX, e.clientY);
}

window.addEventListener('pointerdown', (e) => {
  if (!openMenus.length) return;
  if (openMenus.some((m) => m.contains(e.target as Node))) return;
  if ((e.target as HTMLElement).closest?.('.menubar .top')) return;
  closeMenus();
}, true);
window.addEventListener('blur', closeMenus);

export function buildMenubar(menus: TopMenu[], brand: HTMLElement, right: HTMLElement) {
  const bar = h('div', { class: 'menubar' }, brand);
  const tops: HTMLElement[] = [];
  let open = -1;
  const openAt = (i: number) => {
    closeMenus();
    tops.forEach((t) => t.classList.remove('open'));
    open = i;
    tops[i].classList.add('open');
    const r = tops[i].getBoundingClientRect();
    popup(menus[i].items(), r.left, r.bottom + 2);
    onCloseAll = () => { tops.forEach((t) => t.classList.remove('open')); open = -1; };
  };
  menus.forEach((menu, i) => {
    const top = h('div', { class: 'top' }, menu.label);
    top.addEventListener('pointerdown', (e) => { e.preventDefault(); if (open === i) closeMenus(); else openAt(i); });
    top.addEventListener('pointerenter', () => { if (open >= 0 && open !== i) openAt(i); });
    tops.push(top);
    bar.append(top);
  });
  bar.append(h('div', { class: 'spacer' }), right);
  return bar;
}

// ---------- shortcuts ----------
export function comboOf(e: KeyboardEvent) {
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  else if (k === 'Esc') k = 'Escape';
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && (k.length > 1 || !/[^A-Z0-9]/.test(k))) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}

/** Finds the item whose shortcut matches the key event (searching submenus). */
export function findShortcut(menus: TopMenu[], combo: string): MenuItem | null {
  const walk = (items: MenuItem[]): MenuItem | null => {
    for (const it of items) {
      if (it.key && it.key.split(' / ').some((k) => k === combo)) return it;
      if (it.submenu) { const f = walk(it.submenu()); if (f) return f; }
    }
    return null;
  };
  for (const m of menus) { const f = walk(m.items()); if (f) return f; }
  return null;
}
