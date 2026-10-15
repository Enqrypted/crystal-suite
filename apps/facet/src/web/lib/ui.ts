// Menus and popovers for the desktop layer (and small shared bits: icons, item images).
import type { IconInfo } from '../../shared/types';
import { api } from './api';
import { h, clamp } from './dom';
import { alignGlass } from './glass';

export const ICONS = {
  open: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5c0-.6.4-1 1-1h3l1.4 1.4H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  desktop: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 13.5h4M8 11v2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  edit: '<svg viewBox="0 0 16 16"><path d="M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  reveal: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M10 10l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  rename: '<svg viewBox="0 0 16 16"><path d="M3 12h10M4 9.5l5.5-5.5 2 2L6 11.5H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  sort: '<svg viewBox="0 0 16 16"><path d="M4 3v10M2 11l2 2 2-2M9 4h5M9 8h3.5M9 12h2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 5v3l2 1.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path d="M8 2l6.5 11.5h-13z" fill="#ffd60a"/><path d="M8 6.5v3.2M8 11.6v.2" stroke="#1c1c1e" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

export interface MenuItem { label?: string; icon?: keyof typeof ICONS; run?: () => void; danger?: boolean; disabled?: boolean; sep?: boolean }

/** Elements that make the whole layer clickable while they're up (menus, popovers, open folders). */
export const modal = { count: 0, changed: () => {} };
const holdModal = () => { modal.count++; modal.changed(); };
const releaseModal = () => { modal.count = Math.max(0, modal.count - 1); modal.changed(); };

let openMenu: (() => void) | null = null;

export function menu(items: MenuItem[], x: number, y: number) {
  openMenu?.();
  const root = document.getElementById('overlays')!;
  const el = h('div', { class: 'menu glass' });
  for (const it of items) {
    if (it.sep) { el.append(h('div', { class: 'msep' })); continue; }
    const row = h('button', { type: 'button', class: `mi${it.danger ? ' danger' : ''}`, disabled: it.disabled ? true : null },
      h('span', { class: 'mic', html: it.icon ? ICONS[it.icon] : '' }), h('span', { text: it.label ?? '' }));
    row.addEventListener('click', () => { close(); it.run?.(); });
    el.append(row);
  }
  const shield = h('div', { class: 'shield' });
  root.append(shield, el);
  const r = el.getBoundingClientRect();
  el.style.left = `${clamp(x, 6, innerWidth - r.width - 6)}px`;
  el.style.top = `${clamp(y, 6, innerHeight - r.height - 6)}px`;
  alignGlass(el);
  requestAnimationFrame(() => el.classList.add('in'));
  holdModal();
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const close = () => {
    if (openMenu !== close) return;
    openMenu = null;
    el.remove();
    shield.remove();
    removeEventListener('keydown', onKey);
    releaseModal();
  };
  shield.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
  shield.addEventListener('contextmenu', (e) => { e.preventDefault(); close(); });
  addEventListener('keydown', onKey);
  openMenu = close;
  return close;
}

let openPopover: (() => void) | null = null;

/** A panel next to `anchor` (a rect in page coordinates). Returns a close function. */
export function popover(anchor: DOMRect, title: string, body: HTMLElement, onClose?: () => void) {
  openPopover?.();
  openMenu?.();
  const root = document.getElementById('overlays')!;
  const shield = h('div', { class: 'shield' });
  const closeBtn = h('button', { type: 'button', class: 'pop-x', title: 'Done', html: ICONS.close });
  const el = h('div', { class: 'popover glass' }, h('div', { class: 'pop-head' }, h('div', { class: 'pop-title', text: title }), closeBtn), h('div', { class: 'pop-body' }, body));
  root.append(shield, el);
  const place = () => {
    const r = el.getBoundingClientRect();
    const gap = 14;
    let x = anchor.right + gap;
    if (x + r.width > innerWidth - 8) x = anchor.left - gap - r.width;
    if (x < 8) x = clamp(anchor.left + anchor.width / 2 - r.width / 2, 8, innerWidth - r.width - 8);
    const y = clamp(anchor.top + anchor.height / 2 - r.height / 2, 8, Math.max(8, innerHeight - r.height - 8));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    alignGlass(el);
  };
  place();
  new ResizeObserver(place).observe(el);
  requestAnimationFrame(() => el.classList.add('in'));
  holdModal();
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) close(); };
  const close = () => {
    if (openPopover !== close) return;
    openPopover = null;
    el.remove();
    shield.remove();
    removeEventListener('keydown', onKey);
    releaseModal();
    onClose?.();
  };
  shield.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
  closeBtn.addEventListener('click', close);
  addEventListener('keydown', onKey);
  openPopover = close;
  return close;
}

export function closeOverlays() { openMenu?.(); openPopover?.(); }

// ---------- item images ----------

const iconCache = new Map<string, Promise<IconInfo>>();

export function iconFor(path: string, refresh = false): Promise<IconInfo> {
  let p = refresh ? undefined : iconCache.get(path);
  if (!p) {
    p = api.icon(path).catch(() => ({ url: '', kind: 'icon' as const }));
    iconCache.set(path, p);
  }
  return p;
}

/** An <img> (or placeholder) for a folder item; fills in when the icon is ready. */
export function itemImage(path: string, cls = 'img') {
  const box = h('div', { class: `${cls} loading` });
  iconFor(path).then((info) => {
    box.classList.remove('loading');
    if (info.missing) { box.classList.add('missing'); box.innerHTML = ICONS.warn; box.title = 'This item was moved or deleted'; return; }
    if (!info.url) { box.classList.add('blank'); return; }
    box.classList.add(`k-${info.kind}`);
    const img = h('img', { src: info.url, draggable: 'false', alt: '' });
    box.append(img);
  });
  return box;
}
