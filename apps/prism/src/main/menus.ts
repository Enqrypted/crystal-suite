// Native menus: page right-click, the ⋮ app menu, tabs, the shield, downloads and bookmarks.
import { Menu, clipboard, shell, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';
import type { BrowserWin } from './window';
import type { Tab } from './tab';
import { hostOf } from './util';

type Item = MenuItemConstructorOptions;
const SEP: Item = { type: 'separator' };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Drops leading, trailing and doubled separators. */
function tidy(items: Item[]) {
  const out: Item[] = [];
  for (const it of items) {
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

function popup(w: BrowserWin, items: Item[], x?: number, y?: number) {
  const menu = Menu.buildFromTemplate(tidy(items));
  menu.popup({ window: w.win, ...(x !== undefined && y !== undefined ? { x: Math.round(x), y: Math.round(y) } : {}) });
}

export function pageMenu(w: BrowserWin, tab: Tab, p: ContextMenuParams) {
  const prism = w.prism;
  const engine = prism.engine();
  const nav = tab.wc.navigationHistory;
  const items: Item[] = [];
  const openNew = (url: string) => w.newTab(url, { background: true, after: tab });
  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => tab.wc.replaceMisspelling(s) });
    if (!p.dictionarySuggestions.length) items.push({ label: 'No spelling suggestions', enabled: false });
    items.push({ label: 'Add to dictionary', click: () => tab.wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, SEP);
  }
  if (p.linkURL) {
    items.push(
      { label: 'Open link in new tab', click: () => openNew(p.linkURL) },
      { label: 'Open link in new window', click: () => prism.newWindow({ urls: [p.linkURL], private: w.isPrivate }) },
      { label: 'Open link in private window', click: () => prism.newWindow({ urls: [p.linkURL], private: true }) },
      SEP,
      { label: 'Save link as…', click: () => { prism.askNextDownload = true; tab.wc.downloadURL(p.linkURL); } },
      { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
      SEP,
    );
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: 'Open image in new tab', click: () => openNew(p.srcURL) },
      { label: 'Save image as…', click: () => { prism.askNextDownload = true; tab.wc.downloadURL(p.srcURL); } },
      { label: 'Copy image', click: () => tab.wc.copyImageAt(p.x, p.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
      SEP,
    );
  }
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && /^https?:/.test(p.srcURL)) {
    const kind = p.mediaType === 'video' ? 'video' : 'audio';
    items.push(
      { label: `Open ${kind} in new tab`, click: () => openNew(p.srcURL) },
      { label: `Save ${kind} as…`, click: () => { prism.askNextDownload = true; tab.wc.downloadURL(p.srcURL); } },
      { label: `Copy ${kind} address`, click: () => clipboard.writeText(p.srcURL) },
      SEP,
    );
  }
  const f = p.editFlags;
  if (p.isEditable) {
    items.push(
      { label: 'Undo', role: 'undo', enabled: f.canUndo }, { label: 'Redo', role: 'redo', enabled: f.canRedo }, SEP,
      { label: 'Cut', role: 'cut', enabled: f.canCut }, { label: 'Copy', role: 'copy', enabled: f.canCopy },
      { label: 'Paste', role: 'paste', enabled: f.canPaste }, { label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: f.canPaste },
      { label: 'Select all', role: 'selectAll' }, SEP,
    );
  } else if (p.selectionText.trim()) {
    const sel = p.selectionText.trim().replace(/\s+/g, ' ');
    items.push(
      { label: 'Copy', role: 'copy' },
      { label: `Search ${engine.name} for “${clip(sel, 28)}”`, click: () => w.newTab(engine.url.replace('%s', encodeURIComponent(sel)), { after: tab }) },
      SEP,
    );
  }
  if (!p.linkURL && p.mediaType === 'none' && !p.isEditable && !p.selectionText.trim()) {
    items.push(
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: 'Reload', click: () => tab.wc.reload() },
      SEP,
      { label: 'Save page as…', click: () => w.savePage(tab) },
      { label: 'Print…', click: () => tab.wc.print({}, () => {}) },
      SEP,
    );
    if (/^https?:/.test(tab.url)) items.push({ label: 'View page source', click: () => w.newTab('view-source:' + tab.url, { after: tab }) });
  }
  items.push(SEP, { label: 'Inspect', click: () => tab.wc.inspectElement(p.x, p.y) });
  popup(w, items);
}

export function appMenu(w: BrowserWin, x: number, y: number) {
  const prism = w.prism;
  const tab = w.active();
  const zoom = tab ? Math.round(tab.wc.getZoomFactor() * 100) : 100;
  const bookmarked = !!(tab && prism.bookmarks.find(tab.errorUrl || tab.url));
  const recent = prism.bookmarks.list().slice(-15).reverse();
  popup(w, [
    { label: 'New tab', accelerator: 'Ctrl+T', click: () => w.newTab() },
    { label: 'New window', accelerator: 'Ctrl+N', click: () => prism.newWindow({ private: false }) },
    { label: 'New private window', accelerator: 'Ctrl+Shift+N', click: () => prism.newWindow({ private: true }) },
    SEP,
    { label: 'History', accelerator: 'Ctrl+H', click: () => w.openInternal('history') },
    { label: 'Downloads', accelerator: 'Ctrl+J', click: () => w.openInternal('downloads') },
    {
      label: 'Bookmarks', submenu: tidy([
        { label: bookmarked ? 'Remove bookmark' : 'Bookmark this tab', accelerator: 'Ctrl+D', enabled: !!tab, click: () => w.toggleBookmark() },
        { label: 'Show bookmarks bar', type: 'checkbox', checked: prism.settings.bookmarksBar, accelerator: 'Ctrl+Shift+B', click: () => prism.setSetting('bookmarksBar', !prism.settings.bookmarksBar) },
        { label: 'Bookmark manager', accelerator: 'Ctrl+Shift+O', click: () => w.openInternal('bookmarks') },
        SEP,
        ...recent.map((b) => ({ label: clip(b.title || b.url, 50), click: () => w.go(b.url) })),
      ]),
    },
    { label: 'Reopen closed tab', accelerator: 'Ctrl+Shift+T', enabled: w.canReopen, click: () => w.reopenClosedTab() },
    SEP,
    {
      label: `Zoom (${zoom}%)`, submenu: [
        { label: 'Zoom in', accelerator: 'Ctrl+=', click: () => tab && w.zoom(tab, 1) },
        { label: 'Zoom out', accelerator: 'Ctrl+-', click: () => tab && w.zoom(tab, -1) },
        { label: 'Actual size', accelerator: 'Ctrl+0', click: () => tab && w.setZoom(tab, 100) },
        SEP,
        { label: 'Full screen', accelerator: 'F11', click: () => w.toggleFullscreen() },
      ],
    },
    { label: 'Find…', accelerator: 'Ctrl+F', enabled: !!tab, click: () => w.openFind() },
    { label: 'Print…', accelerator: 'Ctrl+P', enabled: !!tab, click: () => tab?.wc.print({}, () => {}) },
    { label: 'Save page as…', accelerator: 'Ctrl+S', enabled: !!tab, click: () => tab && w.savePage(tab) },
    {
      label: 'More tools', submenu: [
        { label: 'Developer tools', accelerator: 'F12', click: () => tab && w.devTools(tab) },
        { label: 'View page source', accelerator: 'Ctrl+U', enabled: !!tab && /^https?:/.test(tab.url), click: () => tab && w.newTab('view-source:' + tab.url, { after: tab }) },
        SEP,
        { label: 'Clear browsing data…', accelerator: 'Ctrl+Shift+Delete', click: () => w.openInternal('settings', '#clear') },
      ],
    },
    SEP,
    { label: 'Settings', click: () => w.openInternal('settings') },
    { label: 'About Prism', click: () => w.openInternal('settings', '#about') },
    SEP,
    { label: 'Exit', click: () => prism.closeAll() },
  ], x, y);
}

export function tabMenu(w: BrowserWin, id: number) {
  const tab = w.tabs.find((t) => t.id === id);
  if (!tab) return;
  const i = w.tabs.indexOf(tab);
  const muted = tab.wc.isAudioMuted();
  popup(w, [
    { label: 'New tab to the right', click: () => w.newTab(undefined, { after: tab }) },
    SEP,
    { label: 'Reload', click: () => (tab.pending ? w.activate(tab.id) : tab.wc.reload()) },
    { label: 'Duplicate', click: () => w.duplicate(tab) },
    { label: muted ? 'Unmute site' : 'Mute site', click: () => { tab.wc.setAudioMuted(!muted); w.queueState(); } },
    SEP,
    { label: 'Close tab', accelerator: 'Ctrl+W', click: () => w.closeTab(tab.id) },
    { label: 'Close other tabs', enabled: w.tabs.length > 1, click: () => w.closeOthers(tab) },
    { label: 'Close tabs to the right', enabled: i < w.tabs.length - 1, click: () => w.closeOthers(tab, true) },
    SEP,
    { label: 'Reopen closed tab', accelerator: 'Ctrl+Shift+T', enabled: w.canReopen, click: () => w.reopenClosedTab() },
  ]);
}

export function shieldMenu(w: BrowserWin, x: number, y: number) {
  const prism = w.prism;
  const tab = w.active();
  if (!tab) return;
  const url = tab.url;
  const host = hostOf(url).replace(/^www\./, '');
  if (!prism.settings.adblock) {
    popup(w, [
      { label: 'Ad & tracker blocking is turned off', enabled: false },
      { label: 'Turn it on in Settings…', click: () => w.openInternal('settings', '#privacy') },
    ], x, y);
    return;
  }
  const on = !prism.adblock.isAllowlisted(url);
  const n = prism.adblock.blocked(tab.wc.id);
  popup(w, [
    { label: host || 'This page', enabled: false },
    { label: on ? `${n} ad${n === 1 ? '' : 's'} and tracker${n === 1 ? '' : 's'} blocked` : 'Protections are off for this site', enabled: false },
    SEP,
    {
      label: `Block ads and trackers on ${host || 'this site'}`, type: 'checkbox', checked: on,
      click: () => { prism.adblock.setAllowlisted(url, on); tab.wc.reload(); },
    },
    SEP,
    { label: 'Privacy settings…', click: () => w.openInternal('settings', '#privacy') },
  ], x, y);
}

export function downloadsMenu(w: BrowserWin, x: number, y: number) {
  const prism = w.prism;
  prism.downloads.markSeen();
  const list = prism.downloads.list().slice(0, 8);
  const status = (r: (typeof list)[number]) => {
    if (r.state === 'progressing') return r.paused ? 'paused' : r.total ? `${Math.round((r.received / r.total) * 100)}%` : 'downloading';
    if (r.state === 'completed') return r.exists === false ? 'deleted' : 'done';
    return r.state === 'cancelled' ? 'cancelled' : 'failed';
  };
  popup(w, [
    ...list.map((r) => ({
      label: `${clip(r.filename, 40)}  —  ${status(r)}`,
      enabled: r.state !== 'completed' || r.exists !== false,
      click: () => (r.state === 'completed' ? shell.openPath(r.path) : shell.showItemInFolder(r.path)),
    })),
    ...(list.length ? [SEP] : []),
    { label: 'Show all downloads', accelerator: 'Ctrl+J', click: () => w.openInternal('downloads') },
  ], x, y);
}

export function bookmarkMenu(w: BrowserWin, id: string) {
  const prism = w.prism;
  const b = prism.bookmarks.list().find((x) => x.id === id);
  if (!b) return;
  popup(w, [
    { label: 'Open in new tab', click: () => w.newTab(b.url, { background: true }) },
    { label: 'Open in new window', click: () => prism.newWindow({ urls: [b.url], private: false }) },
    { label: 'Open in private window', click: () => prism.newWindow({ urls: [b.url], private: true }) },
    SEP,
    { label: 'Edit…', click: () => w.openInternal('bookmarks') },
    { label: 'Copy address', click: () => clipboard.writeText(b.url) },
    { label: 'Delete', click: () => prism.bookmarks.remove(b.id) },
  ]);
}
