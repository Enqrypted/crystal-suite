// Shared helpers for Prism's internal pages.
import './pages.css';
import { icon, esc } from '../icons';

export { icon, esc };

interface PrismApi {
  call<T = any>(method: string, ...args: unknown[]): Promise<T>;
  onUpdate(cb: (what: string) => void): void;
}
export const prism = (window as unknown as { prism: PrismApi }).prism;

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

/** The side navigation shared by History, Downloads, Bookmarks and Settings. */
export function shell(active: string, title: string, tools = '') {
  const nav = [
    ['history', 'History', 'clock'],
    ['downloads', 'Downloads', 'download'],
    ['bookmarks', 'Bookmarks', 'star'],
    ['settings', 'Settings', 'shield'],
  ];
  document.title = title;
  document.body.innerHTML = `<div class="page">
    <nav class="side"><div class="brand"><img src="/favicon.png" alt="">Prism</div>
      ${nav.map(([id, label, ic]) => `<a class="nav${id === active ? ' active' : ''}" href="prism://${id}/">${icon(ic, 18)}${label}</a>`).join('')}
    </nav>
    <main class="content"><header class="top"><h1>${esc(title)}</h1>${tools}</header><div id="content"></div></main>
  </div>`;
  return $('#content');
}

const COLORS = ['#6a4cf5', '#d93a7a', '#0f9d58', '#e37400', '#1a73e8', '#9334e6', '#c5221f', '#00897b'];
export function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
/** A site's icon, or a coloured letter when there is none (or it fails to load). */
export function favicon(url: string, src?: string, size = 18) {
  const host = hostOf(url) || url;
  const letter = esc((host[0] || '?').toUpperCase());
  const color = COLORS[[...host].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  const fallback = `<span class="letter" style="background:${color};width:${size}px;height:${size}px">${letter}</span>`;
  if (!src) return fallback;
  return `<img class="fav" width="${size}" height="${size}" src="${esc(src)}" referrerpolicy="no-referrer" alt="" data-fallback="${esc(fallback)}">`;
}
/** Swaps broken favicons for their letter fallback (call after rendering). */
export function fixIcons(root: ParentNode) {
  root.querySelectorAll<HTMLImageElement>('img[data-fallback]').forEach((img) => {
    const swap = () => { img.outerHTML = img.dataset.fallback || ''; };
    if (img.complete && img.naturalWidth === 0) swap(); else img.addEventListener('error', swap, { once: true });
  });
}

export function bytes(n: number) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
export function dayLabel(t: number) {
  const d = new Date(t);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const full = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (d.toDateString() === today.toDateString()) return `Today - ${full}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday - ${full}`;
  return full;
}
export const timeOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
