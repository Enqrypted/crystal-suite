// Prism's browser UI: tab strip, toolbar with the address bar, bookmarks bar, infobar and find bar.
// Everything here is presentation; the main process owns the tabs and sends the state to draw.
import './ui.css';
import { icon, esc } from '../icons';
import type { ActiveTabState, BookmarkItem, TabState, UIState } from '../shared';

interface Bridge {
  send(action: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (data: any) => void): void;
}
const api = (window as unknown as { prismUI: Bridge }).prismUI;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let state: UIState | null = null;
const isPrivate = new URLSearchParams(location.search).get('private') === '1';
document.body.classList.toggle('private', isPrivate);

// static icons
$('#private-badge').innerHTML = `${icon('mask', 15)}Private`;
$('#newtab').innerHTML = icon('plus', 18);
$('#back').innerHTML = icon('back', 18);
$('#forward').innerHTML = icon('forward', 18);
$('#menu').innerHTML = icon('menu', 18);
$('#shield').insertAdjacentHTML('afterbegin', icon('shield', 18));
$('#dl').insertAdjacentHTML('afterbegin', icon('download', 18));
$('#findprev').innerHTML = icon('up', 16);
$('#findnext').innerHTML = icon('down', 16);
$('#findclose').innerHTML = icon('close', 14);

const rectOf = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

// ---------- tabs ----------
const tabsEl = $('#tabs');
const tabEls = new Map<number, HTMLElement>();
let drag: { id: number; el: HTMLElement; startX: number; grab: number; moved: boolean } | null = null;

function defaultFavicon(t: TabState) {
  if (!t.url || t.url.startsWith('prism:')) return icon('prism', 16);
  if (t.url.startsWith('file:')) return icon('file', 16);
  return icon('globe', 16);
}

function createTab(id: number) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = String(id);
  el.innerHTML = `<span class="sep"></span><span class="fav"></span><span class="t"></span><button class="aud" hidden></button><button class="x" title="Close tab (Ctrl+W)">${icon('close', 13)}</button>`;
  el.querySelector('.x')!.addEventListener('click', (e) => { e.stopPropagation(); api.send('close-tab', id); });
  el.querySelector('.aud')!.addEventListener('click', (e) => { e.stopPropagation(); api.send('toggle-mute', id); });
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    api.send('activate', id);
    drag = { id, el, startX: e.clientX, grab: e.clientX - el.getBoundingClientRect().left, moved: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); api.send('close-tab', id); } });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.send('tab-menu', id); });
  return el;
}

function updateTab(el: HTMLElement, t: TabState, active: boolean) {
  el.classList.toggle('active', active);
  el.title = t.title + (t.url && !t.url.startsWith('prism:') ? `\n${t.url}` : '');
  const title = el.querySelector('.t')!;
  if (title.textContent !== t.title) title.textContent = t.title;
  const fav = el.querySelector<HTMLElement>('.fav')!;
  const key = t.loading ? 'loading' : t.crashed ? 'crashed' : t.favicon || `default:${t.url.split(':')[0]}`;
  if (fav.dataset.key !== key) {
    fav.dataset.key = key;
    if (t.loading) fav.innerHTML = '<span class="spinner"></span>';
    else if (t.crashed) fav.innerHTML = icon('warn', 16);
    else if (t.favicon) {
      const img = document.createElement('img');
      img.src = t.favicon;
      img.alt = '';
      img.onerror = () => { fav.innerHTML = defaultFavicon(t); };
      fav.replaceChildren(img);
    } else fav.innerHTML = defaultFavicon(t);
  }
  const aud = el.querySelector<HTMLButtonElement>('.aud')!;
  aud.hidden = !(t.audible || t.muted);
  const audKey = t.muted ? 'mute' : 'speaker';
  if (aud.dataset.key !== audKey) { aud.dataset.key = audKey; aud.innerHTML = icon(audKey, 14); aud.title = t.muted ? 'Unmute tab' : 'Mute tab'; }
}

function renderTabs(tabs: TabState[], activeId: number | undefined) {
  const ids = new Set(tabs.map((t) => t.id));
  for (const [id, el] of tabEls) if (!ids.has(id)) { el.remove(); tabEls.delete(id); }
  tabs.forEach((t) => {
    let el = tabEls.get(t.id);
    if (!el) { el = createTab(t.id); tabEls.set(t.id, el); tabsEl.appendChild(el); }
    updateTab(el, t, t.id === activeId);
  });
  if (!drag) {
    tabs.forEach((t, i) => {
      const el = tabEls.get(t.id)!;
      if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] || null);
    });
  }
  requestAnimationFrame(() => { for (const el of tabEls.values()) el.classList.toggle('narrow', el.offsetWidth < 76); });
}

document.addEventListener('pointermove', (e) => {
  const d = drag;
  if (!d) return;
  if (!d.moved && Math.abs(e.clientX - d.startX) < 6) return;
  d.moved = true;
  d.el.classList.add('dragging');
  const max = tabsEl.offsetWidth - d.el.offsetWidth;
  const x = Math.max(0, Math.min(max, e.clientX - tabsEl.getBoundingClientRect().left - d.grab));
  // swap with a neighbour once the dragged tab's centre passes the neighbour's centre
  const center = x + d.el.offsetWidth / 2;
  const next = d.el.nextElementSibling as HTMLElement | null;
  const prev = d.el.previousElementSibling as HTMLElement | null;
  if (next && center > next.offsetLeft + next.offsetWidth / 2) tabsEl.insertBefore(next, d.el);
  else if (prev && center < prev.offsetLeft + prev.offsetWidth / 2) tabsEl.insertBefore(prev, d.el.nextSibling);
  d.el.style.transform = `translateX(${x - d.el.offsetLeft}px)`;
});
document.addEventListener('pointerup', () => {
  const d = drag;
  if (!d) return;
  drag = null;
  d.el.classList.remove('dragging');
  d.el.style.transform = '';
  if (d.moved) api.send('move-tab', d.id, [...tabsEl.children].indexOf(d.el));
});

$('#newtab').addEventListener('click', () => api.send('new-tab'));

// ---------- toolbar ----------
const urlInput = $<HTMLInputElement>('#url');
const urlView = $('#urlview');
let editing = false;
let typed = '';

function formatUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const at = url.indexOf(u.host) + u.host.length;
      let rest = url.slice(at);
      if (rest === '/') rest = '';
      try { rest = decodeURI(rest); } catch { /* keep */ }
      return `<b>${esc(u.host.replace(/^www\./, ''))}</b>${esc(rest)}`;
    }
    if (u.protocol === 'prism:') return `<b>prism://${esc(u.hostname)}</b>`;
  } catch { /* not a URL */ }
  return esc(url);
}

function setUrlDisplay(a: ActiveTabState | null) {
  const display = a?.displayUrl || '';
  urlInput.value = display;
  urlView.innerHTML = display ? formatUrl(display) : '';
  urlInput.classList.toggle('has-view', !!display);
}

function renderSecurity(a: ActiveTabState | null) {
  const sec = $('#sec');
  const s = a?.security || 'none';
  const map: Record<string, [string, string, string]> = {
    secure: [icon('lock', 15), '', 'Connection is secure'],
    insecure: [icon('info', 15), 'Not secure', 'Your connection to this site is not secure'],
    'cert-bypass': [icon('warn', 15), 'Not secure', "This site's certificate is not trusted"],
    internal: [icon('prism', 15), 'Prism', 'Prism page'],
    file: [icon('file', 15), 'File', 'Local or shared file'],
    error: [icon('warn', 15), '', "This page couldn't be loaded"],
    none: [icon('search', 15), '', ''],
  };
  const [ic, text, tip] = map[s] || map.none;
  const key = s + (editing ? ':e' : '');
  if (sec.dataset.key === key) return;
  sec.dataset.key = key;
  sec.innerHTML = editing ? icon('search', 15) : ic + (text ? `<span>${text}</span>` : '');
  sec.title = editing ? '' : tip;
  sec.classList.toggle('insecure', !editing && (s === 'insecure' || s === 'cert-bypass'));
  sec.classList.toggle('icon-only', editing || !text);
}

function renderToolbar(s: UIState) {
  const a = s.active;
  ($('#back') as HTMLButtonElement).disabled = !a?.canGoBack;
  ($('#forward') as HTMLButtonElement).disabled = !a?.canGoForward;
  const reload = $('#reload');
  const rk = a?.loading ? 'stop' : 'reload';
  if (reload.dataset.key !== rk) { reload.dataset.key = rk; reload.innerHTML = icon(rk, 18); reload.title = a?.loading ? 'Stop (Esc)' : 'Reload (F5)'; }
  renderSecurity(a);
  urlInput.placeholder = `Search ${s.engine} or type a URL`;
  if (!editing) setUrlDisplay(a);
  const zoom = $('#zoom');
  zoom.hidden = !a || a.zoom === 100;
  if (a) zoom.textContent = `${a.zoom}%`;
  const star = $('#star');
  star.hidden = !a?.displayUrl || editing;
  const sk = a?.bookmarked ? 'on' : 'off';
  if (star.dataset.key !== sk) { star.dataset.key = sk; star.innerHTML = a?.bookmarked ? icon('starFill', 17, 'on') : icon('star', 17); star.title = a?.bookmarked ? 'Edit bookmark (Ctrl+D)' : 'Bookmark this tab (Ctrl+D)'; }
  const shield = $<HTMLButtonElement>('#shield');
  shield.disabled = !a?.shieldAvailable;
  shield.classList.toggle('off', !!a && a.shieldAvailable && !a.shieldOn);
  const shieldIcon = a && a.shieldAvailable && !a.shieldOn ? 'shieldOff' : 'shield';
  if (shield.dataset.key !== shieldIcon) { shield.dataset.key = shieldIcon; shield.querySelector('svg')!.outerHTML = icon(shieldIcon, 18); }
  shield.querySelector('.count')!.textContent = a?.shieldOn && a.blocked ? (a.blocked > 99 ? '99+' : String(a.blocked)) : '';
  shield.title = !a?.shieldAvailable ? 'Ad & tracker blocking' : a.shieldOn ? `${a.blocked} ads and trackers blocked` : 'Protections are off for this site';
  const dl = $('#dl');
  const d = s.downloads;
  dl.hidden = !(d.active || d.unseen);
  dl.classList.toggle('active', d.active > 0);
  dl.classList.toggle('indeterminate', d.active > 0 && d.progress < 0);
  dl.classList.toggle('unseen', d.unseen && !d.active);
  (dl.querySelector('.bar i') as HTMLElement).style.width = d.progress >= 0 ? `${Math.round(d.progress * 100)}%` : '';
}

$('#back').addEventListener('click', () => api.send('back'));
$('#forward').addEventListener('click', () => api.send('forward'));
$('#reload').addEventListener('click', (e) => api.send(state?.active?.loading ? 'stop' : 'reload', (e as MouseEvent).shiftKey || (e as MouseEvent).ctrlKey));
$('#star').addEventListener('click', () => api.send('bookmark'));
$('#zoom').addEventListener('click', () => api.send('zoom-reset'));
$('#shield').addEventListener('click', () => { const r = $('#shield').getBoundingClientRect(); api.send('shield', r.left, r.bottom + 4); });
$('#dl').addEventListener('click', () => { const r = $('#dl').getBoundingClientRect(); api.send('downloads-menu', r.left, r.bottom + 4); });
$('#menu').addEventListener('click', () => { const r = $('#menu').getBoundingClientRect(); api.send('app-menu', r.right - 4, r.bottom + 4); });
$('#sec').addEventListener('mousedown', (e) => e.preventDefault());

// address bar
let selectOnFocus = false;
urlInput.addEventListener('focus', () => {
  editing = true;
  document.body.classList.add('editing');
  typed = urlInput.value = state?.active?.displayUrl || '';
  urlInput.select();
  selectOnFocus = true;
  if (state) renderToolbar(state);
});
urlInput.addEventListener('mouseup', (e) => { if (selectOnFocus) { e.preventDefault(); selectOnFocus = false; } });
urlInput.addEventListener('input', () => {
  selectOnFocus = false;
  typed = urlInput.value;
  api.send('suggest', typed, rectOf($('#omnibox')));
});
urlInput.addEventListener('keydown', async (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const fill = (await api.send('suggest-move', e.key === 'ArrowDown' ? 1 : -1)) as string | null;
    urlInput.value = fill ?? typed;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const text = urlInput.value.trim();
    if (!text) return;
    api.send('navigate', text, e.altKey);
    urlInput.blur();
    endEditing();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    const shown = state?.active?.displayUrl || '';
    api.send('suggest-hide');
    if (urlInput.value !== shown) { typed = urlInput.value = shown; urlInput.select(); }
    else { urlInput.blur(); api.send('focus-content'); }
  }
});
urlInput.addEventListener('blur', () => {
  setTimeout(() => { if (document.activeElement !== urlInput) endEditing(); }, 150);
});
function endEditing() {
  if (!editing) return;
  editing = false;
  document.body.classList.remove('editing');
  api.send('suggest-hide');
  if (state) renderToolbar(state);
}
api.on('focus-omnibox', () => { urlInput.focus(); urlInput.select(); });
api.on('omnibox-done', () => { urlInput.blur(); endEditing(); });

// ---------- bookmarks bar ----------
let bookmarksKey = '';
function renderBookmarks(list: BookmarkItem[] | null) {
  const bar = $('#bookmarks');
  bar.hidden = !list;
  if (!list) return;
  const key = JSON.stringify(list.map((b) => [b.id, b.title, b.icon]));
  if (key === bookmarksKey) return;
  bookmarksKey = key;
  bar.innerHTML = list.length
    ? list.map((b) => `<button class="bm" data-id="${esc(b.id)}" title="${esc(b.title)}\n${esc(b.url)}">${b.icon ? `<img src="${esc(b.icon)}" alt="">` : icon('globe', 16)}<span>${esc(b.title || b.url)}</span></button>`).join('')
    : '<span class="hint">Bookmark pages with Ctrl+D or the star in the address bar to see them here.</span>';
  bar.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.outerHTML = icon('globe', 16); }));
}
$('#bookmarks').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.bm');
  if (b) api.send('open-bookmark', b.dataset.id, e.ctrlKey || e.metaKey);
});
$('#bookmarks').addEventListener('auxclick', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.bm');
  if (b && e.button === 1) api.send('open-bookmark', b.dataset.id, true);
});
$('#bookmarks').addEventListener('contextmenu', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.bm');
  if (b) { e.preventDefault(); api.send('bookmark-menu', b.dataset.id); }
});

// ---------- infobar (permissions, pop-ups, crashes) ----------
let infoKey = '';
function renderInfobar(a: ActiveTabState | null) {
  const bar = $('#infobar');
  const p = a?.prompt;
  const key = a?.crashed ? 'crashed' : p ? `p${p.id}` : '';
  if (key === infoKey) return;
  infoKey = key;
  bar.hidden = !key;
  if (!key) { bar.innerHTML = ''; return; }
  if (a?.crashed) {
    bar.innerHTML = `<div class="msg">${icon('warn', 18)}<span>This page crashed.</span></div><button class="btn primary" data-act="reload-crashed">Reload</button>`;
  } else if (p) {
    const allow = p.kind === 'external' ? 'Open' : p.kind === 'popup' ? 'Open it' : 'Allow';
    const block = p.kind === 'external' ? 'Cancel' : p.kind === 'popup' ? '' : 'Block';
    const text = p.kind === 'popup' ? `Prism blocked a pop-up from <b>${esc(p.origin)}</b>` : `<b>${esc(p.origin)}</b> ${esc(p.text)}`;
    bar.innerHTML = `<div class="msg">${icon(p.kind === 'popup' ? 'shield' : 'info', 18)}<span>${text}</span></div>
      <button class="btn primary" data-act="prompt" data-v="1">${allow}</button>
      ${block ? `<button class="btn" data-act="prompt" data-v="0">${block}</button>` : ''}
      <button class="ib small" data-act="prompt" data-v="" title="Dismiss">${icon('close', 14)}</button>`;
  }
}
$('#infobar').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'reload-crashed') api.send('reload-crashed');
  if (b.dataset.act === 'prompt' && state?.active?.prompt) api.send('prompt', state.active.prompt.id, b.dataset.v === '' ? null : b.dataset.v === '1');
});

// ---------- find in page ----------
const findText = $<HTMLInputElement>('#findtext');
function renderFind(a: ActiveTabState | null) {
  const f = a?.find;
  $('#findbar').hidden = !f?.open;
  if (!f?.open) return;
  if (document.activeElement !== findText) findText.value = f.text;
  const count = $('#findcount');
  count.textContent = f.text ? `${f.current}/${f.matches}` : '';
  count.classList.toggle('none', !!f.text && f.matches === 0);
}
findText.addEventListener('input', () => api.send('find', findText.value, true, false));
findText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); api.send('find', findText.value, !e.shiftKey, true); }
  if (e.key === 'Escape') { e.preventDefault(); api.send('find-close'); }
});
$('#findnext').addEventListener('click', () => api.send('find', findText.value, true, true));
$('#findprev').addEventListener('click', () => api.send('find', findText.value, false, true));
$('#findclose').addEventListener('click', () => api.send('find-close'));
api.on('focus-find', () => {
  $('#findbar').hidden = false;
  findText.focus();
  findText.select();
});

// ---------- state ----------
function render(s: UIState) {
  state = s;
  document.body.classList.toggle('fullscreen', s.fullscreen);
  renderTabs(s.tabs, s.active?.id);
  renderToolbar(s);
  renderBookmarks(s.bookmarksBar);
  renderInfobar(s.active);
  renderFind(s.active);
}
api.on('state', (s: UIState) => render(s));

// tell the main process how tall the browser UI is, so the page sits right below it
let lastHeight = 0;
new ResizeObserver(() => {
  const h = Math.ceil($('#chrome').getBoundingClientRect().height);
  if (h && h !== lastHeight) { lastHeight = h; api.send('chrome-height', h); }
}).observe($('#chrome'));

api.send('ready');
