// The Prism browser: windows, profiles, settings, history, bookmarks, downloads and protections.
// It runs inside a host: the Crystal Suite launcher, or Prism's own standalone executable.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { app, nativeTheme, type BrowserWindow, type Rectangle, type WebContents } from 'electron';
import { DEFAULT_SETTINGS, ENGINES, NEW_TAB_URL, type AboutInfo, type AdblockInfo, type ClearDataOptions, type Settings } from '../shared';
import { JsonFile } from './store';
import { History } from './history';
import { Bookmarks } from './bookmarks';
import { Downloads } from './downloads';
import { Permissions } from './permissions';
import { AdBlock } from './adblock';
import { Profile } from './profile';
import { BrowserWin } from './window';
import { servePage } from './pages';
import * as defaultBrowser from './defaultbrowser';
import { hostOf } from './util';

export interface Host {
  appId: string;
  version: string;
  /** Folder with main.cjs, the preloads and web/ (the installed package, or dist/prism). */
  appDir: string;
  /** Where Prism keeps settings, history, bookmarks... */
  dataDir: string;
  icon: string | null;
  ico: string | null;
  standalone: boolean;
  /** The command that opens Prism; a URL is appended when registering as the default browser. */
  launchCommand(): { exe: string; args: string[] };
  /** Lets the launcher give windows their taskbar identity and count them as running. */
  decorateWindow?(win: BrowserWindow): void;
}

export interface SessionWindow {
  tabs: { url: string; title: string }[];
  active: number;
  bounds?: Rectangle;
  maximized?: boolean;
}

function argToUrl(a: string) {
  if (/^(https?|file):/i.test(a)) return a;
  try { if (fs.statSync(a).isFile()) return pathToFileURL(path.resolve(a)).href; } catch { /* not a file */ }
  return '';
}

export class Prism {
  readonly webDir: string;
  readonly uiPreload: string;
  readonly tabPreload: string;
  readonly history: History;
  readonly bookmarks: Bookmarks;
  readonly downloads: Downloads;
  readonly permissions: Permissions;
  readonly adblock: AdBlock;
  readonly normal: Profile;
  windows = new Set<BrowserWin>();
  lastFocused: BrowserWin | null = null;
  /** "Save image as…" and friends ask where to save even when downloads normally go straight to the folder. */
  askNextDownload = false;
  private privateProfile: Profile | null = null;
  private settingsFile: JsonFile<Settings>;
  private sessionFile: JsonFile<{ windows: SessionWindow[]; clearPending: boolean }>;
  private favicons: JsonFile<{ map: Record<string, string> }>;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private ready: Promise<void>;
  private onTheme = () => { for (const w of this.windows) w.updateTheme(); };

  constructor(readonly host: Host) {
    const d = host.dataDir;
    fs.mkdirSync(d, { recursive: true });
    this.webDir = path.join(host.appDir, 'web');
    this.uiPreload = path.join(host.appDir, 'preload-ui.cjs');
    this.tabPreload = path.join(host.appDir, 'preload-tab.cjs');
    this.settingsFile = new JsonFile(path.join(d, 'settings.json'), () => ({ ...DEFAULT_SETTINGS }));
    if (!ENGINES[this.settings.searchEngine]) this.settings.searchEngine = DEFAULT_SETTINGS.searchEngine;
    this.history = new History(d);
    this.bookmarks = new Bookmarks(d);
    this.downloads = new Downloads(d);
    this.permissions = new Permissions(d);
    this.adblock = new AdBlock(d, host.appDir, () => this.settings.adblock);
    this.sessionFile = new JsonFile(path.join(d, 'session.json'), () => ({ windows: [] as SessionWindow[], clearPending: false }));
    this.favicons = new JsonFile(path.join(d, 'favicons.json'), () => ({ map: {} as Record<string, string> }));
    this.normal = new Profile(this, false);
    nativeTheme.themeSource = this.settings.theme;
    nativeTheme.on('updated', this.onTheme);
    this.adblock.on('change', () => this.notifyPages('adblock'));
    this.adblock.on('blocked', (wcId: number) => {
      for (const w of this.windows) if (w.active()?.wc.id === wcId) w.queueState();
    });
    this.downloads.on('change', () => {
      for (const w of this.windows) w.queueState();
      this.notifyPages('downloads');
    });
    this.bookmarks.onChange = () => {
      for (const w of this.windows) w.queueState();
      this.notifyPages('bookmarks');
    };
    this.adblock.init();
    // "Clear browsing data when Prism closes" finishes here if Prism was closed before it could
    this.ready = this.sessionFile.data.clearPending ? this.clearOnExitNow() : Promise.resolve();
  }

  get settings() { return this.settingsFile.data; }
  engine() { return ENGINES[this.settings.searchEngine] || ENGINES.duckduckgo; }
  homeUrl() { return NEW_TAB_URL; }
  downloadDir() {
    const d = this.settings.downloadDir;
    return d && fs.existsSync(d) ? d : app.getPath('downloads');
  }
  consumeAsk() {
    const ask = this.settings.askWhereToSave || this.askNextDownload;
    this.askNextDownload = false;
    return ask;
  }

  setSetting(key: string, value: unknown) {
    if (!(key in DEFAULT_SETTINGS)) return;
    const k = key as keyof Settings;
    const def = DEFAULT_SETTINGS[k];
    if (Array.isArray(def) ? !Array.isArray(value) : typeof value !== typeof def) return;
    if (k === 'searchEngine' && !ENGINES[value as string]) return;
    if (k === 'startup' && !['restore', 'newtab'].includes(value as string)) return;
    if (k === 'theme' && !['system', 'light', 'dark'].includes(value as string)) return;
    (this.settings as unknown as Record<string, unknown>)[k] = value;
    this.settingsFile.save(200);
    if (k === 'theme') nativeTheme.themeSource = this.settings.theme;
    if (k === 'webrtcProtect') {
      for (const w of this.windows) for (const t of w.tabs) t.wc.setWebRTCIPHandlingPolicy(value ? 'default_public_interface_only' : 'default');
    }
    for (const w of this.windows) w.queueState();
    this.notifyPages('settings');
  }

  // ---------- windows ----------
  /** Opens Prism: restores the last session on first start, otherwise a new window (or tabs for URLs). */
  async open(args: string[] = []) {
    await this.ready;
    const urls = args.map(argToUrl).filter(Boolean);
    if (!this.windows.size) {
      const restore = this.settings.startup === 'restore' ? this.sessionFile.data.windows : [];
      if (restore.length) restore.forEach((w, i) => this.newWindow({ restore: w, urls: i === restore.length - 1 ? urls : [] }));
      else this.newWindow({ urls });
      return;
    }
    const target = this.lastFocused && this.windows.has(this.lastFocused) && !this.lastFocused.isPrivate
      ? this.lastFocused : [...this.windows].find((w) => !w.isPrivate);
    if (urls.length && target) {
      for (const u of urls) target.newTab(u);
      target.focus();
      return;
    }
    this.newWindow({ urls });
  }

  newWindow(o: { private?: boolean; urls?: string[]; restore?: SessionWindow } = {}) {
    const profile = o.private ? (this.privateProfile ||= new Profile(this, true)) : this.normal;
    const w = new BrowserWin(this, profile, { urls: o.urls, restore: o.restore });
    this.windows.add(w);
    this.lastFocused = w;
    return w;
  }

  windowClosing(w: BrowserWin) {
    // the last normal window to close is what the next start restores
    const others = [...this.windows].filter((x) => x !== w && !x.isPrivate);
    if (!w.isPrivate && !others.length) {
      const data = w.sessionData();
      this.sessionFile.data.windows = data ? [data] : [];
      this.sessionFile.flush();
    }
  }

  windowClosed(w: BrowserWin) {
    this.windows.delete(w);
    if (this.lastFocused === w) this.lastFocused = null;
    if (w.isPrivate && this.privateProfile && ![...this.windows].some((x) => x.isPrivate)) {
      this.privateProfile.dispose();
      this.privateProfile = null;
    }
    if (this.windows.size) { this.sessionChanged(); return; }
    this.flush();
    if (this.settings.clearOnExit) {
      this.sessionFile.data.clearPending = true;
      this.sessionFile.data.windows = [];
      this.sessionFile.flush();
      this.clearOnExitNow().catch(() => {});
    }
  }

  closeAll() { for (const w of [...this.windows]) w.win.close(); }

  sessionChanged() {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      if (!this.windows.size) return;
      const data = [...this.windows].map((w) => w.sessionData()).filter((x): x is SessionWindow => !!x);
      if (!data.length) return;
      this.sessionFile.data.windows = data;
      this.sessionFile.save(0);
    }, 1000);
  }

  findTab(wc: WebContents) {
    for (const w of this.windows) for (const t of w.tabs) if (t.wc === wc) return t;
    return undefined;
  }

  // ---------- prompts raised by sessions ----------
  askPermission(wc: WebContents, origin: string, text: string, done: (allow: boolean, remember: boolean) => void) {
    const tab = this.findTab(wc);
    if (!tab) { done(false, false); return; }
    tab.addPrompt({ origin: hostOf(origin) || origin, text: `wants to ${text}`, kind: 'permission', resolve: done });
  }
  askExternal(wc: WebContents, externalUrl: string, requestingUrl: string, done: (allow: boolean) => void) {
    const tab = this.findTab(wc);
    if (!tab) { done(false); return; }
    const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(externalUrl)?.[1] || 'this').toLowerCase();
    const what = scheme === 'mailto' ? 'your email app' : scheme === 'tel' ? 'your phone app' : `an app for "${scheme}:" links`;
    tab.addPrompt({ origin: hostOf(requestingUrl) || 'This page', text: `wants to open ${what}`, kind: 'external', resolve: (allow) => done(allow) });
  }

  // ---------- internal pages ----------
  servePage(req: Request) { return servePage(this, req); }
  notifyPages(what: string) {
    for (const w of this.windows) for (const t of w.tabs) {
      if (!t.pending && t.url.startsWith('prism://') && !t.wc.isDestroyed()) t.wc.send('prism:page-update', what);
    }
  }
  rememberFavicon(pageUrl: string, icon: string) {
    const host = hostOf(pageUrl);
    if (!host || !/^https?:/.test(icon) || this.favicons.data.map[host] === icon) return;
    const map = this.favicons.data.map;
    delete map[host];
    map[host] = icon;
    const keys = Object.keys(map);
    if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete map[k];
    this.favicons.save(3000);
  }
  faviconFor(url: string) { return this.favicons.data.map[hostOf(url)] || ''; }
  topSites() {
    return this.history.topSites(8, this.settings.hiddenTopSites).map((t) => ({ ...t, icon: this.faviconFor(t.url) }));
  }
  hideTopSite(host: string) {
    if (!host || this.settings.hiddenTopSites.includes(host)) return;
    this.setSetting('hiddenTopSites', [...this.settings.hiddenTopSites, host]);
  }
  about(): AboutInfo {
    return { version: this.host.version, chrome: process.versions.chrome, electron: process.versions.electron, standalone: this.host.standalone, dataDir: this.host.dataDir };
  }
  adblockInfo(): AdblockInfo {
    const a = this.adblock;
    return { enabled: this.settings.adblock, ready: !!a.engine, updatedAt: a.updatedAt, updating: a.updating, error: a.error, allowlist: [...a.allowlist] };
  }

  async clearData(o: ClearDataOptions) {
    if (o.history) {
      this.history.clear();
      this.favicons.data.map = {};
      this.favicons.flush();
    }
    if (o.downloads) this.downloads.clear();
    const ses = this.normal.ses;
    const jobs: Promise<unknown>[] = [];
    if (o.cookies) jobs.push(ses.clearStorageData(), ses.clearAuthCache());
    if (o.cache) jobs.push(ses.clearCache(), ses.clearCodeCaches({}), ses.clearHostResolverCache());
    await Promise.allSettled(jobs);
    this.notifyPages('history');
  }
  private async clearOnExitNow() {
    await this.clearData({ history: true, cookies: true, cache: true, downloads: true });
    this.sessionFile.data.clearPending = false;
    this.sessionFile.flush();
  }

  flush() {
    this.settingsFile.flush();
    this.history.flush();
    this.bookmarks.flush();
    this.downloads.flush();
    this.permissions.flush();
    this.adblock.flush();
    this.favicons.flush();
  }

  /** Called before the launcher removes Prism from the computer. */
  async uninstall() {
    await defaultBrowser.unregister(this.host.standalone ? '' : '--open-app=prism');
  }
  /** Called before another Prism version takes over (or the host shuts it down). */
  deactivate() {
    this.closeAll();
    this.flush();
    this.normal.dispose();
    this.privateProfile?.dispose();
    nativeTheme.off('updated', this.onTheme);
  }
}
