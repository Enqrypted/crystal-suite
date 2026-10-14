// The address-bar suggestion list. It lives in its own small view so it can float over the page.
import { icon, esc } from '../icons';
import type { SuggestState } from '../shared';

const api = (window as unknown as { prismUI: { send(a: string, ...x: unknown[]): Promise<unknown>; on(c: string, cb: (d: any) => void): void } }).prismUI;
const isPrivate = new URLSearchParams(location.search).get('private') === '1';

const style = document.createElement('style');
style.textContent = `
  :root { --bg: #ffffff; --fg: #202124; --dim: #6b6b76; --sel: #eeeaf9; --line: #dcd9e3; --accent: #6a4cf5; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #2b2a33; --fg: #e8e8ee; --dim: #a6a6b4; --sel: #3b3946; --line: #45444f; --accent: #a78bfa; color-scheme: dark; } }
  :root.private { --bg: #2a2140; --fg: #ece6ff; --dim: #b4a8d6; --sel: #3a2f57; --line: #4a3d69; --accent: #b794ff; color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; font: 13px/1.3 "Segoe UI", system-ui, sans-serif; user-select: none; overflow: hidden; }
  #list { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; padding: 5px; height: 100vh; }
  .row { height: 36px; display: flex; align-items: center; gap: 12px; padding: 0 12px; border-radius: 8px; cursor: default; }
  .row.sel { background: var(--sel); }
  .row .ic { color: var(--dim); }
  .row.sel .ic { color: var(--accent); }
  .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; min-width: 0; }
  .sub { color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .sub::before { content: '—'; margin-right: 8px; opacity: .6; }
`;
document.head.appendChild(style);
document.documentElement.classList.toggle('private', isPrivate);

const ICON = { search: 'search', url: 'globe', history: 'clock', bookmark: 'star' } as const;
const list = document.getElementById('list')!;

api.on('suggest', (s: SuggestState) => {
  list.innerHTML = s.items.map((it, i) => `<div class="row${i === s.selected ? ' sel' : ''}" data-i="${i}">
    ${icon(ICON[it.kind], 16)}<span class="title">${esc(it.title)}</span><span class="sub">${esc(it.sub)}</span></div>`).join('');
});
list.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (row && e.button === 0) api.send('suggest-pick', Number(row.dataset.i));
});
list.addEventListener('mousemove', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (!row || row.classList.contains('sel')) return;
  list.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel'));
  row.classList.add('sel');
});
