// A browser window: the browser UI (tab strip + toolbar, its own renderer) on top, the active tab's
// view below it, and a small overlay view for address-bar suggestions that can float over the page.
import path from 'path';
import { BrowserWindow, WebContentsView, dialog, nativeTheme, type ContextMenuParams, type Input, type WebContents } from 'electron';
import { NEW_TAB_URL, type UIState, type Suggestion } from '../shared';
import type { Prism, SessionWindow } from './prism';
import type { Profile } from './profile';
import { Tab } from './tab';
import { inputToUrl, suggest } from './omnibox';
import * as menus from './menus';

const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
export const TITLEBAR_HEIGHT = 40;
const SUGGEST_ROW = 36;

export function chromeColors(isPrivate: boolean) {
  if (isPrivate) return { strip: '#1d1530', fg: '#ece6ff', page: '#2a2140' };
  return nativeTheme.shouldUseDarkColors
    ? { strip: '#1d1c22', fg: '#e8e8ee', page: '#2b2a33' }
    : { strip: '#e6e4ec', fg: '#202124', page: '#ffffff' };
}

interface Rect { x: number; y: number; width: number; height: number }

export class BrowserWin {
  readonly win: BrowserWindow;
  readonly ui: WebContents;
  tabs: Tab[] = [];
  activeId = 0;
  private chromeHeight = 84;
  private htmlFullscreen = false;
  private closedTabs: { url: string; title: string; index: number }[] = [];
  private suggestView: WebContentsView | null = null;
  private suggestions: Suggestion[] = [];
  private selected = 0;
  private stateQueued = false;
  private uiReady = false;
  private focusOmniboxWhenReady = false;
  private closing = false;
  private bounds: Electron.Rectangle;
  private maximized = false;

  constructor(readonly prism: Prism, readonly profile: Profile, opts: { urls?: string[]; restore?: SessionWindow }) {
    const c = chromeColors(profile.isPrivate);
    const b = opts.restore?.bounds;
    this.win = new BrowserWindow({
      width: b?.width || 1320, height: b?.height || 880, x: b?.x, y: b?.y, minWidth: 480, minHeight: 320,
      show: false, title: 'Prism', backgroundColor: c.strip,
      titleBarStyle: 'hidden', titleBarOverlay: { color: c.strip, symbolColor: c.fg, height: TITLEBAR_HEIGHT },
      ...(prism.host.icon ? { icon: prism.host.icon } : {}),
      webPreferences: { preload: prism.uiPreload, session: profile.ses, sandbox: true, contextIsolation: true, spellcheck: false, backgroundThrottling: false },
    });
    this.ui = this.win.webContents;
    prism.host.decorateWindow?.(this.win);
    this.win.removeMenu();
    if (opts.restore?.maximized) this.win.maximize();
    this.maximized = this.win.isMaximized();
    this.win.once('ready-to-show', () => this.win.show());
    this.ui.loadFile(path.join(prism.webDir, 'ui', 'index.html'), { query: { private: profile.isPrivate ? '1' : '0' } });
    this.ui.ipc.handle('ui', (_e, action: string, ...args: unknown[]) => this.onUi(action, args));
    this.ui.on('before-input-event', (e, input) => { if (this.shortcut(input, true)) e.preventDefault(); });
    this.ui.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.ui.on('will-navigate', (e) => e.preventDefault());
    this.win.on('resize', () => { this.hideSuggestions(); this.layout(); });
    this.win.on('enter-full-screen', () => { this.layout(); this.queueState(); });
    this.win.on('leave-full-screen', () => { this.htmlFullscreen = false; this.layout(); this.queueState(); });
    this.win.on('app-command', (_e, cmd) => {
      const t = this.active();
      if (cmd === 'browser-backward' && t?.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack();
      if (cmd === 'browser-forward' && t?.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward();
    });
    this.win.on('focus', () => { prism.lastFocused = this; });
    this.win.on('blur', () => this.hideSuggestions());
    this.bounds = this.win.getNormalBounds();
    const remember = () => { if (!this.win.isDestroyed()) { this.bounds = this.win.getNormalBounds(); this.maximized = this.win.isMaximized(); } };
    for (const ev of ['resized', 'moved', 'maximize', 'unmaximize'] as const) this.win.on(ev as 'resized', remember);
    this.win.on('close', () => { this.closing = true; prism.windowClosing(this); });
    this.win.on('closed', () => {
      if (!this.closing) prism.windowClosing(this); // closed without a 'close' event (e.g. window.close() from the UI)
      for (const t of this.tabs) t.destroy();
      this.tabs = [];
      if (this.suggestView && !this.suggestView.webContents.isDestroyed()) this.suggestView.webContents.close();
      prism.windowClosed(this);
    });
    this.ensureSuggestView();

    if (opts.restore?.tabs.length) {
      for (const t of opts.restore.tabs) this.addTab(new Tab(this, { lazy: t }), { activate: false });
      this.activate(this.tabs[Math.min(Math.max(0, opts.restore.active), this.tabs.length - 1)].id);
    }
    for (const u of opts.urls || []) this.newTab(u);
    if (!this.tabs.length) this.newTab();
  }

  get isPrivate() { return this.profile.isPrivate; }
  active() { return this.tabs.find((t) => t.id === this.activeId); }
  pageBackground() { return chromeColors(this.isPrivate).page; }
  focus() { if (this.win.isMinimized()) this.win.restore(); this.win.focus(); }

  // ---------- tabs ----------
  newTab(url = NEW_TAB_URL, o: { background?: boolean; after?: Tab } = {}) {
    const tab = new Tab(this, { url });
    this.addTab(tab, { activate: !o.background, after: o.after });
    return tab;
  }
  /** A page opened a window (link with target=_blank, window.open): it becomes a tab next to its opener. */
  adoptTab(wc: WebContents, opener: Tab, background: boolean) {
    const tab = new Tab(this, { webContents: wc });
    this.addTab(tab, { activate: !background, after: opener });
    return tab;
  }
  private addTab(tab: Tab, o: { activate: boolean; after?: Tab }) {
    let index = this.tabs.length;
    if (o.after) {
      const i = this.tabs.indexOf(o.after);
      if (i >= 0) index = i + 1;
    }
    this.tabs.splice(index, 0, tab);
    this.win.contentView.addChildView(tab.view);
    tab.view.setVisible(false);
    if (this.suggestView) this.win.contentView.addChildView(this.suggestView); // keep the overlay on top
    if (o.activate || !this.activeId) this.activate(tab.id);
    else this.queueState();
    this.prism.sessionChanged();
  }

  activate(id: number) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.activeId = id;
    tab.wake();
    this.hideSuggestions();
    this.layout();
    if (!tab.url || tab.url.startsWith(NEW_TAB_URL)) this.focusOmnibox();
    else this.focusPage(tab);
    this.queueState();
    this.prism.sessionChanged();
  }

  closeTab(id: number) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const url = tab.errorUrl || tab.url;
    if (!this.isPrivate && url && !url.startsWith(NEW_TAB_URL)) {
      this.closedTabs.push({ url, title: tab.displayTitle(), index: this.tabs.indexOf(tab) });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    }
    this.removeTab(tab);
    tab.destroy();
  }
  /** The page closed itself. */
  tabGone(tab: Tab) { this.removeTab(tab); }
  private removeTab(tab: Tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.win.isDestroyed()) return;
    try { this.win.contentView.removeChildView(tab.view); } catch { /* already gone */ }
    if (!this.tabs.length) { this.win.close(); return; }
    if (this.activeId === tab.id) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else this.queueState();
    this.prism.sessionChanged();
  }
  reopenClosedTab() {
    const t = this.closedTabs.pop();
    if (!t) return;
    const tab = new Tab(this, { url: t.url });
    this.tabs.splice(Math.min(t.index, this.tabs.length), 0, tab);
    this.win.contentView.addChildView(tab.view);
    tab.view.setVisible(false);
    if (this.suggestView) this.win.contentView.addChildView(this.suggestView);
    this.activate(tab.id);
  }
  get canReopen() { return this.closedTabs.length > 0; }
  moveTab(id: number, index: number) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(this.tabs.length, index)), 0, t);
    this.queueState();
    this.prism.sessionChanged();
  }
  cycle(delta: number) {
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    if (i < 0) return;
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id);
  }
  duplicate(tab: Tab) { this.newTab(tab.errorUrl || tab.url, { after: tab }); }
  closeOthers(tab: Tab, onlyRight = false) {
    const i = this.tabs.indexOf(tab);
    for (const t of [...this.tabs]) if (t !== tab && (!onlyRight || this.tabs.indexOf(t) > i)) this.closeTab(t.id);
  }
  /** Shows an internal page, reusing a tab that already has it open. */
  openInternal(page: string, hash = '') {
    const url = `prism://${page}/${hash}`;
    const existing = this.tabs.find((t) => t.url.startsWith(`prism://${page}/`));
    if (existing) {
      if (hash && existing.url !== url) existing.load(url);
      this.activate(existing.id);
      return;
    }
    const cur = this.active();
    if (cur && cur.url.startsWith(NEW_TAB_URL)) { cur.load(url); cur.wc.focus(); } else this.newTab(url);
  }

  go(url: string, inNewTab = false) {
    if (!url) return;
    if (inNewTab) { this.newTab(url); return; }
    const tab = this.active();
    if (!tab) { this.newTab(url); return; }
    tab.load(url);
    this.focusPage(tab);
  }
  /** Moves keyboard focus from the address bar into the page. */
  focusPage(tab: Tab) {
    if (this.uiReady) this.ui.send('omnibox-done');
    tab.wc.focus();
  }

  // ---------- layout and UI state ----------
  private contentTop() {
    return this.htmlFullscreen || this.win.isFullScreen() ? 0 : this.chromeHeight;
  }
  layout() {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    const top = this.contentTop();
    for (const t of this.tabs) {
      const on = t.id === this.activeId;
      if (on) t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
      t.view.setVisible(on);
    }
  }
  queueState() {
    if (this.stateQueued) return;
    this.stateQueued = true;
    setImmediate(() => { this.stateQueued = false; this.sendState(); });
  }
  private sendState() {
    if (this.win.isDestroyed() || !this.uiReady) return;
    const a = this.active();
    const state: UIState = {
      private: this.isPrivate,
      engine: this.prism.engine().name,
      fullscreen: this.htmlFullscreen || this.win.isFullScreen(),
      tabs: this.tabs.map((t) => t.state()),
      active: a ? a.activeState() : null,
      downloads: this.prism.downloads.summary(),
      bookmarksBar: this.prism.settings.bookmarksBar ? this.prism.bookmarks.list().map((b) => ({ ...b, icon: this.prism.faviconFor(b.url) })) : null,
    };
    this.ui.send('state', state);
    const title = a ? a.displayTitle() : 'Prism';
    this.win.setTitle(`${title} - Prism${this.isPrivate ? ' (Private)' : ''}`);
  }
  tabChanged(_tab: Tab) {
    this.queueState();
    this.prism.sessionChanged();
  }
  focusOmnibox() {
    if (!this.uiReady) { this.focusOmniboxWhenReady = true; return; }
    this.ui.focus();
    this.ui.send('focus-omnibox');
  }
  openFind() {
    const t = this.active();
    if (!t) return;
    t.find.open = true;
    this.queueState();
    this.ui.focus();
    this.ui.send('focus-find');
  }
  updateTheme() {
    if (this.win.isDestroyed()) return;
    const c = chromeColors(this.isPrivate);
    this.win.setTitleBarOverlay({ color: c.strip, symbolColor: c.fg });
    this.win.setBackgroundColor(c.strip);
    for (const t of this.tabs) if (!t.url || t.url.startsWith('prism:')) t.setBackground(true);
  }

  // ---------- address bar suggestions ----------
  private ensureSuggestView() {
    if (this.suggestView) return this.suggestView;
    const v = new WebContentsView({ webPreferences: { preload: this.prism.uiPreload, session: this.profile.ses, sandbox: true, contextIsolation: true, spellcheck: false } });
    v.setBackgroundColor('#00000000');
    v.setVisible(false);
    v.webContents.loadFile(path.join(this.prism.webDir, 'ui', 'suggest.html'), { query: { private: this.isPrivate ? '1' : '0' } });
    v.webContents.ipc.handle('ui', (_e, action: string, ...args: unknown[]) => this.onUi(action, args));
    v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    v.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.contentView.addChildView(v);
    this.suggestView = v;
    return v;
  }
  private showSuggestions(text: string, rect: Rect | undefined) {
    const items = suggest(text, this.prism.history, this.prism.bookmarks, this.prism.engine());
    this.suggestions = items;
    this.selected = 0;
    if (!items.length || !rect) { this.hideSuggestions(); return; }
    const v = this.ensureSuggestView();
    v.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y + rect.height + 4), width: Math.round(rect.width), height: items.length * SUGGEST_ROW + 12 });
    v.webContents.send('suggest', { items, selected: 0 });
    this.win.contentView.addChildView(v);
    v.setVisible(true);
  }
  private moveSelection(delta: number) {
    if (!this.suggestions.length) return null;
    this.selected = Math.max(0, Math.min(this.suggestions.length - 1, this.selected + delta));
    this.suggestView?.webContents.send('suggest', { items: this.suggestions, selected: this.selected });
    return this.selected > 0 ? this.suggestions[this.selected].fill : null;
  }
  hideSuggestions() {
    this.suggestions = [];
    if (this.suggestView && !this.win.isDestroyed()) this.suggestView.setVisible(false);
  }

  // ---------- messages from the browser UI ----------
  private onUi(action: string, args: unknown[]): unknown {
    const tab = this.active();
    const num = (i: number) => Number(args[i]);
    const str = (i: number) => String(args[i] ?? '');
    switch (action) {
      case 'ready':
        this.uiReady = true;
        this.sendState();
        if (this.focusOmniboxWhenReady) { this.focusOmniboxWhenReady = false; this.focusOmnibox(); }
        return;
      case 'chrome-height': {
        const h = Math.round(num(0));
        if (h > 0 && h < 400 && h !== this.chromeHeight) { this.chromeHeight = h; this.layout(); }
        return;
      }
      case 'new-tab': this.newTab(); return;
      case 'close-tab': this.closeTab(num(0)); return;
      case 'activate': this.activate(num(0)); return;
      case 'move-tab': this.moveTab(num(0), num(1)); return;
      case 'tab-menu': menus.tabMenu(this, num(0)); return;
      case 'toggle-mute': {
        const t = this.tabs.find((x) => x.id === num(0));
        if (t) { t.wc.setAudioMuted(!t.wc.isAudioMuted()); this.queueState(); }
        return;
      }
      case 'navigate': {
        // Enter in the address bar: the highlighted suggestion, or what was typed
        const pick = this.selected > 0 ? this.suggestions[this.selected] : null;
        const url = pick ? pick.url : inputToUrl(str(0), this.prism.engine().url).url;
        this.hideSuggestions();
        this.go(url, !!args[1]);
        return;
      }
      case 'suggest': this.showSuggestions(str(0), args[1] as Rect | undefined); return;
      case 'suggest-move': return this.moveSelection(num(0));
      case 'suggest-hide': this.hideSuggestions(); return;
      case 'suggest-pick': {
        const s = this.suggestions[num(0)];
        this.hideSuggestions();
        if (s) { this.ui.send('omnibox-done'); this.go(s.url); }
        return;
      }
      case 'back': if (tab?.wc.navigationHistory.canGoBack()) tab.wc.navigationHistory.goBack(); return;
      case 'forward': if (tab?.wc.navigationHistory.canGoForward()) tab.wc.navigationHistory.goForward(); return;
      case 'reload': if (tab) { if (tab.errorUrl) tab.load(tab.errorUrl); else if (args[0]) tab.wc.reloadIgnoringCache(); else tab.wc.reload(); } return;
      case 'stop': tab?.wc.stop(); return;
      case 'bookmark': this.toggleBookmark(); return;
      case 'shield': menus.shieldMenu(this, num(0), num(1)); return;
      case 'app-menu': menus.appMenu(this, num(0), num(1)); return;
      case 'downloads-menu': menus.downloadsMenu(this, num(0), num(1)); return;
      case 'find': tab?.findText(str(0), args[1] !== false, !!args[2]); return;
      case 'find-close': if (tab) { tab.closeFind(); tab.wc.focus(); } return;
      case 'prompt': tab?.answerPrompt(num(0), args[1] === null ? null : !!args[1]); return;
      case 'zoom-reset': if (tab) this.setZoom(tab, 100); return;
      case 'reload-crashed': if (tab) { tab.crashed = false; tab.wc.reload(); } return;
      case 'open-bookmark': {
        const b = this.prism.bookmarks.list().find((x) => x.id === str(0));
        if (b) { if (args[1]) this.newTab(b.url, { background: true }); else this.go(b.url); }
        return;
      }
      case 'bookmark-menu': menus.bookmarkMenu(this, str(0)); return;
      case 'focus-content': tab?.wc.focus(); return;
      case 'open-internal': this.openInternal(str(0)); return;
    }
    return undefined;
  }

  toggleBookmark() {
    const t = this.active();
    if (!t) return;
    const url = t.errorUrl || t.url;
    if (!url || url.startsWith(NEW_TAB_URL)) return;
    this.prism.bookmarks.toggle(url, t.displayTitle());
  }

  // ---------- zoom, full screen, page tools ----------
  zoom(tab: Tab, dir: number) {
    const cur = Math.round(tab.wc.getZoomFactor() * 100);
    const next = dir > 0 ? (ZOOM_STEPS.find((z) => z > cur) ?? 500) : ([...ZOOM_STEPS].reverse().find((z) => z < cur) ?? 25);
    this.setZoom(tab, next);
  }
  setZoom(tab: Tab, pct: number) {
    tab.wc.setZoomFactor(pct / 100);
    this.queueState();
  }
  setHtmlFullscreen(on: boolean) {
    this.htmlFullscreen = on;
    this.win.setFullScreen(on);
    this.layout();
    this.queueState();
  }
  toggleFullscreen() {
    this.htmlFullscreen = false;
    this.win.setFullScreen(!this.win.isFullScreen());
  }
  async savePage(tab: Tab) {
    const name = (tab.displayTitle() || 'page').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);
    const r = await dialog.showSaveDialog(this.win, {
      defaultPath: path.join(this.prism.downloadDir(), name + '.html'),
      filters: [{ name: 'Web page, complete', extensions: ['html', 'htm'] }],
    });
    if (!r.canceled && r.filePath) tab.wc.savePage(r.filePath, 'HTMLComplete').catch(() => {});
  }
  devTools(tab: Tab) {
    if (tab.wc.isDevToolsOpened()) tab.wc.closeDevTools(); else tab.wc.openDevTools({ mode: 'detach' });
  }
  pageMenu(tab: Tab, params: ContextMenuParams) { menus.pageMenu(this, tab, params); }

  // ---------- keyboard shortcuts (from the page or the browser UI) ----------
  shortcut(input: Input, fromUi: boolean): boolean {
    if (input.type !== 'keyDown') return false;
    const ctrl = input.control || input.meta;
    const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
    const combo = `${ctrl ? 'C' : ''}${input.shift ? 'S' : ''}${input.alt ? 'A' : ''}+${key}`;
    const tab = this.active();
    const nav = tab?.wc.navigationHistory;
    switch (combo) {
      case 'C+t': this.newTab(); return true;
      case 'C+n': this.prism.newWindow({ private: false }); return true;
      case 'CS+n': this.prism.newWindow({ private: true }); return true;
      case 'C+w': case 'C+F4': if (tab) this.closeTab(tab.id); return true;
      case 'CS+w': this.win.close(); return true;
      case 'CS+t': this.reopenClosedTab(); return true;
      case 'C+Tab': case 'C+PageDown': this.cycle(1); return true;
      case 'CS+Tab': case 'C+PageUp': this.cycle(-1); return true;
      case 'C+l': case 'A+d': case '+F6': case 'C+k': case 'C+e': this.focusOmnibox(); return true;
      case '+F5': case 'C+r': if (tab) { if (tab.errorUrl) tab.load(tab.errorUrl); else tab.wc.reload(); } return true;
      case 'C+F5': case 'S+F5': case 'CS+r': tab?.wc.reloadIgnoringCache(); return true;
      case '+Escape': if (!fromUi && tab?.loading) { tab.wc.stop(); return true; } return false;
      case 'A+ArrowLeft': if (nav?.canGoBack()) nav.goBack(); return true;
      case 'A+ArrowRight': if (nav?.canGoForward()) nav.goForward(); return true;
      case 'A+Home': this.go(this.prism.homeUrl()); return true;
      case 'C+f': this.openFind(); return true;
      case '+F3': case 'C+g': if (tab?.find.text) tab.findText(tab.find.text, true, true); else this.openFind(); return true;
      case 'S+F3': case 'CS+g': if (tab?.find.text) tab.findText(tab.find.text, false, true); return true;
      case 'C+d': this.toggleBookmark(); return true;
      case 'CS+b': this.prism.setSetting('bookmarksBar', !this.prism.settings.bookmarksBar); return true;
      case 'CS+o': this.openInternal('bookmarks'); return true;
      case 'C+h': this.openInternal('history'); return true;
      case 'C+j': this.openInternal('downloads'); return true;
      case 'CS+Delete': this.openInternal('settings', '#clear'); return true;
      case 'C+=': case 'C++': case 'CS+=': case 'CS++': if (tab) this.zoom(tab, 1); return true;
      case 'C+-': case 'CS+_': case 'CS+-': if (tab) this.zoom(tab, -1); return true;
      case 'C+0': if (tab) this.setZoom(tab, 100); return true;
      case 'C+p': tab?.wc.print({}, () => {}); return true;
      case 'C+s': if (tab) this.savePage(tab); return true;
      case 'C+u': if (tab && /^https?:/.test(tab.url)) this.newTab('view-source:' + tab.url, { after: tab }); return true;
      case '+F11': this.toggleFullscreen(); return true;
      case '+F12': case 'CS+i': case 'CS+j': if (tab) this.devTools(tab); return true;
    }
    if (ctrl && !input.shift && !input.alt && /^[1-9]$/.test(key)) {
      const n = Number(key);
      const t = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
      if (t) this.activate(t.id);
      return true;
    }
    return false;
  }

  sessionData(): SessionWindow | null {
    if (this.isPrivate) return null;
    const tabs = this.tabs
      .map((t) => ({ url: t.errorUrl || t.url, title: t.displayTitle() }))
      .filter((t) => t.url && !t.url.startsWith('view-source:'));
    if (!tabs.length) return null;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    return { tabs, active: Math.max(0, i), bounds: this.bounds, maximized: this.maximized };
  }
}
