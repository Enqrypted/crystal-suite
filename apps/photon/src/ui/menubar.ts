// Menu bar with Photoshop-style dropdowns and keyboard shortcut dispatch.
import { h, clear } from './dom';
import { MenuItem } from './menutypes';
import { isMac } from '../core/util';

export interface TopMenu { label: string; items: () => MenuItem[] }

const subItems = (it: MenuItem) => (typeof it.submenu === 'function' ? it.submenu() : it.submenu ?? []);

/** Display form of a shortcut ('Ctrl' → '⌘' on mac). */
export function displayShortcut(s?: string) {
  if (!s) return '';
  return isMac ? s.replace(/Ctrl/g, '⌘').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧') : s;
}

export function buildMenubar(menus: TopMenu[], left: HTMLElement[], right: HTMLElement[]): HTMLElement {
  const bar = h('div', { class: 'menubar' }, ...left);
  let openIdx = -1;
  let openEls: HTMLElement[] = [];
  const tops: HTMLElement[] = [];

  const closeAll = () => {
    openEls.forEach((e) => e.remove());
    openEls = [];
    tops.forEach((t) => t.classList.remove('open'));
    openIdx = -1;
  };
  const closeFrom = (level: number) => { openEls.slice(level).forEach((e) => e.remove()); openEls = openEls.slice(0, level); };

  function renderMenu(items: MenuItem[], x: number, y: number, level: number) {
    closeFrom(level);
    const m = h('div', { class: 'menu' });
    for (const it of items) {
      if (it.sep) { if (m.lastChild && !(m.lastChild as HTMLElement).classList.contains('menu-sep')) m.appendChild(h('div', { class: 'menu-sep' })); continue; }
      const enabled = it.enabled ? safe(it.enabled, true) : true;
      const checked = it.checked ? safe(it.checked, false) : false;
      const hasSub = !!it.submenu;
      const row = h('div', { class: `menu-item${enabled ? '' : ' disabled'}` },
        h('span', { class: 'menu-check' }, checked ? '✓' : ''),
        h('span', { class: 'menu-label' }, it.label ?? ''),
        hasSub ? h('span', { class: 'menu-arrow' }, '▶') : h('span', { class: 'menu-shortcut' }, displayShortcut(it.shortcut)));
      row.addEventListener('mouseenter', () => {
        m.querySelectorAll('.menu-item.open').forEach((e) => e.classList.remove('open'));
        if (hasSub && enabled) {
          row.classList.add('open');
          const r = row.getBoundingClientRect();
          renderMenu(subItems(it), r.right - 2, r.top - 4, level + 1);
        } else closeFrom(level + 1);
      });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!enabled || hasSub) return;
        closeAll();
        setTimeout(() => it.action?.());
      });
      m.appendChild(row);
    }
    if (m.lastChild && (m.lastChild as HTMLElement).classList.contains('menu-sep')) m.lastChild.remove();
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = level ? x - r.width - (openEls[level - 1]?.getBoundingClientRect().width ?? 0) + 4 : window.innerWidth - r.width - 2;
    if (y + r.height > window.innerHeight) y = Math.max(2, window.innerHeight - r.height - 2);
    m.style.left = `${Math.max(0, x)}px`;
    m.style.top = `${y}px`;
    openEls.push(m);
  }

  menus.forEach((menu, i) => {
    const t = h('div', { class: 'menubar-item' }, menu.label);
    const open = () => {
      closeAll();
      openIdx = i;
      t.classList.add('open');
      const r = t.getBoundingClientRect();
      renderMenu(menu.items(), r.left, r.bottom + 1, 0);
    };
    t.addEventListener('mousedown', (e) => { e.preventDefault(); if (openIdx === i) closeAll(); else open(); });
    t.addEventListener('mouseenter', () => { if (openIdx >= 0 && openIdx !== i) open(); });
    tops.push(t);
    bar.appendChild(t);
  });
  bar.append(h('div', { class: 'spacer' }), ...right);
  document.addEventListener('mousedown', (e) => {
    if (openIdx < 0) return;
    const tgt = e.target as Node;
    if (openEls.some((m) => m.contains(tgt)) || tops.some((t) => t.contains(tgt))) return;
    closeAll();
  }, true);
  window.addEventListener('keydown', (e) => { if (openIdx >= 0 && e.key === 'Escape') { closeAll(); e.stopPropagation(); } }, true);
  window.addEventListener('blur', closeAll);
  void clear;
  return bar;
}
function safe(fn: () => boolean, dflt: boolean) { try { return fn(); } catch { return dflt; } }

// ---------- shortcuts ----------
const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '+', NumpadAdd: '+', NumpadSubtract: '-', Backslash: '\\', Slash: '/',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Backquote: '`', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter',
  Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape', Tab: 'Tab',
};
/** Canonical "Alt+Ctrl+Shift+K" key for an event. */
export function eventCombo(e: KeyboardEvent): string {
  let k = '';
  if (e.code.startsWith('Key')) k = e.code.slice(3);
  else if (e.code.startsWith('Digit')) k = e.code.slice(5);
  else if (e.code.startsWith('Numpad') && /\d$/.test(e.code)) k = e.code.slice(-1);
  else if (/^F\d+$/.test(e.code)) k = e.code;
  else k = CODE_KEYS[e.code] ?? e.key;
  const mods = [e.altKey && 'Alt', (e.ctrlKey || e.metaKey) && 'Ctrl', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, k].join('+');
}
/** Canonical form of a shortcut string ('Shift+Ctrl+Z' → 'Ctrl+Shift+Z' order Alt,Ctrl,Shift). */
export function canonical(s: string): string {
  let parts = s.split('+');
  // "Ctrl++" splits into [..., '', ''] → key '+'
  if (s.endsWith('++')) parts = [...parts.slice(0, -2), '+'];
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => p.trim()));
  const k = key === '=' ? '+' : key.length === 1 ? key.toUpperCase() : key;
  return [mods.has('Alt') && 'Alt', mods.has('Ctrl') && 'Ctrl', mods.has('Shift') && 'Shift', k].filter(Boolean).join('+');
}
export function collectShortcuts(menus: TopMenu[]): Map<string, MenuItem> {
  const map = new Map<string, MenuItem>();
  const walk = (items: MenuItem[]) => {
    for (const it of items) {
      if (it.submenu) walk(subItems(it));
      else if (it.shortcut && it.bind !== false && it.action) { const c = canonical(it.shortcut); if (!map.has(c)) map.set(c, it); }
    }
  };
  for (const m of menus) walk(m.items());
  return map;
}
