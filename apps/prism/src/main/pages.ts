// prism:// internal pages: serving their files, and the API they call through the tab preload.
import fs from 'fs';
import path from 'path';
import { dialog, shell, type IpcMainInvokeEvent } from 'electron';
import { ENGINES, INTERNAL_PAGES, type ClearDataOptions } from '../shared';
import type { Prism } from './prism';
import { inputToUrl } from './omnibox';
import * as defaultBrowser from './defaultbrowser';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};
const CSP = "default-src 'self'; img-src 'self' https: http: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

export function servePage(prism: Prism, req: Request): Response {
  const u = new URL(req.url);
  const root = prism.webDir;
  let file = '';
  if (u.pathname.startsWith('/assets/')) file = path.join(root, 'assets', decodeURIComponent(u.pathname.slice('/assets/'.length)));
  else if ((u.pathname === '/' || u.pathname === '') && INTERNAL_PAGES.includes(u.hostname)) file = path.join(root, 'pages', `${u.hostname}.html`);
  else if (u.pathname === '/favicon.png' && prism.host.icon) file = prism.host.icon;
  const rel = path.relative(root, file);
  const inside = file === prism.host.icon || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!file || !inside || !fs.existsSync(file)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  return new Response(fs.readFileSync(file), {
    headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'cache-control': 'no-cache' },
  });
}

/** Handles window.prism.call(method, ...args) from internal pages (and only from them). */
export async function pageApi(prism: Prism, e: IpcMainInvokeEvent, method: string, a: unknown[]): Promise<unknown> {
  const frame = e.senderFrame;
  if (!frame || frame.parent || !frame.url.startsWith('prism://')) throw new Error('Not allowed');
  const tab = prism.findTab(e.sender);
  switch (method) {
    case 'settings': return { settings: prism.settings, engines: ENGINES, about: prism.about(), downloadDir: prism.downloadDir() };
    case 'setSetting': prism.setSetting(String(a[0]), a[1]); return prism.settings;
    case 'navigate': {
      const url = inputToUrl(String(a[0] ?? ''), prism.engine().url).url;
      if (tab && url) { tab.load(url); tab.wc.focus(); }
      return;
    }
    case 'open': { // open a link from an internal page (history, bookmarks...), optionally in a new tab
      const url = String(a[0] ?? '');
      if (!tab || !/^(https?|file|prism|view-source):/i.test(url)) return;
      if (a[1]) tab.win.newTab(url, { background: true, after: tab }); else tab.load(url);
      return;
    }
    case 'topSites': return prism.topSites();
    case 'hideTopSite': prism.hideTopSite(String(a[0])); return prism.topSites();
    case 'history': return prism.history.query(String(a[0] ?? ''), Number(a[1]) || 300, Number(a[2]) || Infinity).map((v) => ({ ...v, icon: prism.faviconFor(v.url) }));
    case 'removeHistory': {
      const list = Array.isArray(a[0]) ? (a[0] as { url: unknown; time: unknown }[]).map((x) => ({ url: String(x.url), time: Number(x.time) })) : [];
      prism.history.remove(list);
      return;
    }
    case 'clearHistory': prism.history.clear(); return;
    case 'bookmarks': return prism.bookmarks.list().map((b) => ({ ...b, icon: prism.faviconFor(b.url) }));
    case 'updateBookmark': prism.bookmarks.update(String(a[0]), (a[1] || {}) as { title?: string; url?: string }); return;
    case 'removeBookmark': prism.bookmarks.remove(String(a[0])); return;
    case 'moveBookmark': prism.bookmarks.move(String(a[0]), Number(a[1])); return;
    case 'downloads': return prism.downloads.list();
    case 'download': {
      const id = String(a[1]);
      const d = prism.downloads;
      switch (a[0]) {
        case 'open': d.open(id); break;
        case 'show': d.show(id); break;
        case 'cancel': d.cancel(id); break;
        case 'pause': d.pause(id); break;
        case 'resume': d.resume(id); break;
        case 'remove': d.remove(id); break;
        case 'retry': { const url = d.urlOf(id); if (url) { d.remove(id); prism.normal.ses.downloadURL(url); } break; }
      }
      return;
    }
    case 'clearDownloads': prism.downloads.clear(); return;
    case 'openDownloadsFolder': shell.openPath(prism.downloadDir()); return;
    case 'chooseDownloadDir': {
      const win = tab?.win.win;
      const opts = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], defaultPath: prism.downloadDir() };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (!r.canceled && r.filePaths[0]) prism.setSetting('downloadDir', r.filePaths[0]);
      return prism.downloadDir();
    }
    case 'clearData': {
      const o = (a[0] || {}) as Partial<ClearDataOptions>;
      await prism.clearData({ history: !!o.history, cookies: !!o.cookies, cache: !!o.cache, downloads: !!o.downloads });
      return;
    }
    case 'adblock': return prism.adblockInfo();
    case 'updateAdblock': await prism.adblock.update(); return prism.adblockInfo();
    case 'removeAllow': prism.adblock.removeAllow(String(a[0])); return prism.adblockInfo();
    case 'permissions': return prism.permissions.list();
    case 'resetPermission': prism.permissions.reset(String(a[0]), a[1] ? String(a[1]) : undefined); return prism.permissions.list();
    case 'defaultBrowser': return defaultBrowser.status();
    case 'makeDefault': await defaultBrowser.register(prism.host); return defaultBrowser.status();
  }
  throw new Error(`Unknown method: ${method}`);
}
