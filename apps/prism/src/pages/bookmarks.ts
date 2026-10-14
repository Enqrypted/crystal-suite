// Bookmarks: search, open, rename, change the address, reorder, delete.
import { prism, icon, esc, shell, favicon, fixIcons, debounce, $ } from './common';
import type { BookmarkItem } from '../shared';

const content = shell('bookmarks', 'Bookmarks', `<label class="search">${icon('search', 16)}<input id="q" placeholder="Search bookmarks" spellcheck="false" /></label>`);

let list: BookmarkItem[] = [];
let editing = '';

function render() {
  const q = $<HTMLInputElement>('#q').value.trim().toLowerCase();
  const shown = list.filter((b) => !q || b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q));
  if (!shown.length) {
    content.innerHTML = `<div class="empty">${icon('star', 40)}${q ? 'No bookmarks match your search.' : 'Bookmark pages with Ctrl+D or the star in the address bar.'}</div>`;
    return;
  }
  content.innerHTML = '<div class="list">' + shown.map((b) => {
    const i = list.indexOf(b);
    if (b.id === editing) {
      return `<div class="item" style="gap:10px">${favicon(b.url, b.icon)}
        <input class="text" id="et" value="${esc(b.title)}" placeholder="Name" style="flex:1" />
        <input class="text" id="eu" value="${esc(b.url)}" placeholder="URL" style="flex:1.4" />
        <button class="btn primary" data-act="save" data-id="${esc(b.id)}">Save</button><button class="btn" data-act="cancel">Cancel</button></div>`;
    }
    return `<div class="item">${favicon(b.url, b.icon)}
      <div class="main"><a class="title ellipsis" href="${esc(b.url)}">${esc(b.title || b.url)}</a><span class="sub ellipsis">${esc(b.url)}</span></div>
      <div class="acts">
        ${q ? '' : `<button class="icon-btn" data-act="up" data-id="${esc(b.id)}" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up', 16)}</button>
        <button class="icon-btn" data-act="down" data-id="${esc(b.id)}" title="Move down" ${i === list.length - 1 ? 'disabled' : ''}>${icon('down', 16)}</button>`}
        <button class="icon-btn" data-act="edit" data-id="${esc(b.id)}" title="Edit">${icon('edit', 16)}</button>
        <button class="icon-btn" data-act="delete" data-id="${esc(b.id)}" title="Delete">${icon('trash', 16)}</button>
      </div></div>`;
  }).join('') + '</div>';
  fixIcons(content);
  if (editing) $<HTMLInputElement>('#et')?.focus();
}

async function load() {
  list = await prism.call<BookmarkItem[]>('bookmarks');
  render();
}

content.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.title');
    if (a && e.ctrlKey) { e.preventDefault(); prism.call('open', a.href, true); }
    return;
  }
  const id = el.dataset.id || '';
  const i = list.findIndex((b) => b.id === id);
  switch (el.dataset.act) {
    case 'edit': editing = id; render(); return;
    case 'cancel': editing = ''; render(); return;
    case 'save':
      await prism.call('updateBookmark', id, { title: $<HTMLInputElement>('#et').value, url: $<HTMLInputElement>('#eu').value });
      editing = '';
      break;
    case 'delete': await prism.call('removeBookmark', id); break;
    case 'up': await prism.call('moveBookmark', id, i - 1); break;
    case 'down': await prism.call('moveBookmark', id, i + 1); break;
  }
  load();
});
content.addEventListener('keydown', (e) => {
  if (!editing) return;
  if (e.key === 'Enter') ($('[data-act="save"]') as HTMLButtonElement).click();
  if (e.key === 'Escape') { editing = ''; render(); }
});
content.addEventListener('auxclick', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.title');
  if (a && e.button === 1) { e.preventDefault(); prism.call('open', a.href, true); }
});
$('#q').addEventListener('input', debounce(render, 100));
prism.onUpdate((what) => { if (what === 'bookmarks' && !editing) load(); });
load();
