// One browser tab: a WebContentsView plus the state the tab strip and toolbar show.
import crypto from 'crypto';
import { WebContentsView, type WebContents, type WebPreferences } from 'electron';
import { NEW_TAB_URL, type ActiveTabState, type PermissionPrompt, type Security, type TabState } from '../shared';
import type { BrowserWin } from './window';
import { errorPageScript } from './errorpage';
import { pageApi } from './pages';
import { hostOf, originOf, prettyUrl } from './util';

export interface Prompt extends PermissionPrompt {
  resolve: (allow: boolean, remember: boolean) => void;
}

let nextTabId = 1;
let nextPromptId = 1;
const USER_INPUT = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'char', 'touchStart', 'touchEnd', 'gestureTap']);

export function tabPreferences(win: BrowserWin): WebPreferences {
  return {
    preload: win.prism.tabPreload, session: win.profile.ses,
    sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
    plugins: true, // built-in PDF viewer
    spellcheck: true, safeDialogs: true, navigateOnDragDrop: true,
    autoplayPolicy: 'document-user-activation-required',
  };
}

export class Tab {
  readonly id = nextTabId++;
  readonly view: WebContentsView;
  readonly wc: WebContents;
  title = '';
  favicon = '';
  loading = false;
  crashed = false;
  audible = false;
  destroyed = false;
  /** Restored tabs load the first time they are shown. */
  pending: { url: string; title: string } | null = null;
  /** URL of the failed navigation whose error page is showing. */
  errorUrl = '';
  private errorToken = '';
  find = { open: false, text: '', matches: 0, current: 0 };
  prompts: Prompt[] = [];
  private lastInput = 0;

  constructor(readonly win: BrowserWin, opts: { url?: string; webContents?: WebContents; lazy?: { url: string; title: string } }) {
    this.view = opts.webContents ? new WebContentsView({ webContents: opts.webContents }) : new WebContentsView({ webPreferences: tabPreferences(win) });
    this.wc = this.view.webContents;
    this.setBackground((opts.lazy?.url ?? opts.url ?? (opts.webContents ? 'about:blank' : NEW_TAB_URL)).startsWith('prism:'));
    if (win.prism.settings.webrtcProtect) this.wc.setWebRTCIPHandlingPolicy('default_public_interface_only');
    this.wire();
    if (opts.lazy) {
      this.pending = opts.lazy;
      this.title = opts.lazy.title;
    } else if (opts.url) this.load(opts.url);
  }

  get prism() { return this.win.prism; }
  /** Chromium paints pages without a background in the view's colour: white for the web (like Chrome), the theme for Prism's pages. */
  setBackground(internal: boolean) { this.view.setBackgroundColor(internal ? this.win.pageBackground() : '#ffffff'); }
  get url() { return this.pending ? this.pending.url : this.wc.getURL(); }
  private changed() { this.win.tabChanged(this); }

  load(url: string) {
    this.pending = null;
    this.errorUrl = '';
    this.wc.loadURL(url).catch(() => { /* failures show an error page */ });
  }
  /** Loads a lazily restored tab the first time it is shown. */
  wake() { if (this.pending) this.load(this.pending.url); }

  private wire() {
    const { wc, prism } = this;
    const profile = this.win.profile;
    // internal pages (prism://) and the ad blocker's element hiding talk to the main process through the tab preload
    wc.ipc.handle('prism:page', (e, method: string, ...args: unknown[]) => pageApi(prism, e, method, args));
    wc.ipc.handle('prism:cosmetics', prism.adblock.cosmetics);
    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      if (!profile.isPrivate) prism.history.setTitle(wc.getURL(), title);
      this.changed();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      this.favicon = icons[0] || '';
      if (!profile.isPrivate && this.favicon) prism.rememberFavicon(wc.getURL(), this.favicon);
      this.changed();
    });
    wc.on('did-start-loading', () => { this.loading = true; this.changed(); });
    wc.on('did-stop-loading', () => { this.loading = false; this.changed(); });
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.setBackground(details.url.startsWith('prism:'));
      prism.adblock.resetCount(wc.id);
      this.dismissPrompts();
    });
    wc.on('did-navigate', (_e, url) => {
      if (url !== this.errorUrl) this.errorUrl = '';
      if (url.startsWith('https:')) profile.upgraded.delete(wc.id);
      this.title = url.startsWith(NEW_TAB_URL) ? 'New Tab' : '';
      this.favicon = '';
      this.crashed = false;
      if (this.find.open) this.closeFind();
      if (!profile.isPrivate && !this.errorUrl) prism.history.add(url, '');
      this.changed();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (!profile.isPrivate) prism.history.add(url, this.title);
      this.changed();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted (a new navigation replaced it)
      const from = profile.upgraded.get(wc.id);
      if (from && url === 'https://' + from.slice(7)) {
        profile.upgraded.delete(wc.id);
        // the site has no working HTTPS: fall back to http:// and show "Not secure"
        if (code <= -100 && code !== -105 && code !== -106) {
          profile.httpAllowed.add(hostOf(from));
          this.load(from);
          return;
        }
      }
      this.showError(code, desc, url);
    });
    wc.on('certificate-error', (e, url, _error, _cert, callback) => {
      if (profile.certBypass.has(hostOf(url))) { e.preventDefault(); callback(true); } else callback(false);
    });
    wc.on('will-navigate', (e, url) => {
      const target = (e as unknown as { url?: string }).url || url;
      if (!target.startsWith('prism:')) return;
      const action = /^prism:\/\/(retry|proceed|back)\/\?t=([0-9a-f]+)$/.exec(target);
      if (action) {
        e.preventDefault();
        if (!this.errorUrl || action[2] !== this.errorToken) return;
        if (action[1] === 'retry') this.load(this.errorUrl);
        else if (action[1] === 'back') {
          if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); else this.load(NEW_TAB_URL);
        } else {
          profile.certBypass.add(hostOf(this.errorUrl));
          this.load(this.errorUrl);
        }
        return;
      }
      if (!wc.getURL().startsWith('prism:')) e.preventDefault(); // web pages can't open internal pages
    });
    wc.on('will-frame-navigate', (e) => {
      if (!e.isMainFrame && e.url.startsWith('prism:')) e.preventDefault();
    });
    wc.on('input-event', (_e, input) => { if (USER_INPUT.has(input.type)) this.lastInput = Date.now(); });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (url.startsWith('prism:') && !wc.getURL().startsWith('prism:')) return { action: 'deny' };
      // pop-up blocker: only allow new windows the user just asked for (a click or a key press)
      if (Date.now() - this.lastInput > 1500) {
        this.promptPopup(url);
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: tabPreferences(this.win) },
        createWindow: (options) => this.win.adoptTab((options as { webContents: WebContents }).webContents, this, disposition === 'background-tab').wc,
      };
    });
    wc.on('context-menu', (_e, params) => this.win.pageMenu(this, params));
    wc.on('before-input-event', (e, input) => { if (this.win.shortcut(input, false)) e.preventDefault(); });
    wc.on('zoom-changed', (_e, dir) => this.win.zoom(this, dir === 'in' ? 1 : -1));
    wc.on('enter-html-full-screen', () => this.win.setHtmlFullscreen(true));
    wc.on('leave-html-full-screen', () => this.win.setHtmlFullscreen(false));
    wc.on('audio-state-changed', (e) => { this.audible = e.audible; this.changed(); });
    wc.on('found-in-page', (_e, r) => {
      this.find.matches = r.matches;
      this.find.current = r.activeMatchOrdinal;
      this.changed();
    });
    wc.on('render-process-gone', (_e, d) => {
      if (d.reason === 'clean-exit') return;
      this.crashed = true;
      this.loading = false;
      this.changed();
    });
    wc.on('destroyed', () => {
      // the page closed itself (window.close() in a pop-up)
      if (!this.destroyed) { this.destroyed = true; this.dismissPrompts(); this.win.tabGone(this); }
    });
  }

  private showError(code: number, desc: string, url: string) {
    this.errorUrl = url;
    this.errorToken = crypto.randomBytes(12).toString('hex');
    const script = errorPageScript(code, desc, url, this.errorToken);
    const inject = () => { if (this.errorUrl === url && !this.wc.isDestroyed()) this.wc.executeJavaScript(script).catch(() => {}); };
    // the error document may not be ready yet when the failure is reported
    setTimeout(inject, 0);
    this.wc.once('dom-ready', inject);
    this.title = hostOf(url) || url;
    this.loading = false;
    this.changed();
  }

  // ---------- prompts (permissions, external apps, pop-ups) ----------
  addPrompt(p: Omit<Prompt, 'id'>) {
    const prompt = { ...p, id: nextPromptId++ };
    this.prompts.push(prompt);
    this.changed();
    return prompt;
  }
  answerPrompt(id: number, allow: boolean | null) {
    const i = this.prompts.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = this.prompts.splice(i, 1);
    p.resolve(!!allow, allow !== null);
    this.changed();
  }
  dismissPrompts() {
    const pending = this.prompts.splice(0);
    for (const p of pending) p.resolve(false, false);
    if (pending.length) this.changed();
  }
  private promptPopup(url: string) {
    if (this.prompts.some((p) => p.kind === 'popup')) return;
    this.addPrompt({
      origin: hostOf(this.wc.getURL()) || 'This page', text: 'Pop-up blocked', kind: 'popup',
      resolve: (allow) => { if (allow) this.win.newTab(url, { after: this }); },
    });
  }

  // ---------- find in page ----------
  findText(text: string, forward = true, next = false) {
    this.find.open = true;
    this.find.text = text;
    if (!text) {
      this.wc.stopFindInPage('clearSelection');
      this.find.matches = 0;
      this.find.current = 0;
      this.changed();
      return;
    }
    this.wc.findInPage(text, { forward, findNext: !next });
  }
  closeFind() {
    this.find = { open: false, text: '', matches: 0, current: 0 };
    if (!this.wc.isDestroyed()) this.wc.stopFindInPage('keepSelection');
    this.changed();
  }

  // ---------- state for the UI ----------
  displayTitle() {
    if (this.title) return this.title;
    const url = this.url;
    if (!url || url.startsWith(NEW_TAB_URL)) return 'New Tab';
    return prettyUrl(url);
  }
  security(): Security {
    if (this.errorUrl) return 'error';
    const url = this.url;
    if (!url || url.startsWith(NEW_TAB_URL)) return 'none';
    if (url.startsWith('prism:')) return 'internal';
    if (url.startsWith('file:')) return 'file';
    if (url.startsWith('https:')) return this.win.profile.certBypass.has(hostOf(url)) ? 'cert-bypass' : 'secure';
    if (url.startsWith('http:')) return 'insecure';
    return 'none';
  }
  state(): TabState {
    return {
      id: this.id, title: this.displayTitle(), url: this.url, favicon: this.favicon,
      loading: this.loading && !this.pending, audible: this.audible, muted: this.wc.isAudioMuted(), crashed: this.crashed,
    };
  }
  activeState(): ActiveTabState {
    const { wc, prism } = this;
    const url = this.errorUrl || this.url;
    const shieldAvailable = /^https?:/i.test(url) && !this.errorUrl;
    const p = this.prompts[0];
    return {
      id: this.id,
      url,
      displayUrl: !url || url.startsWith(NEW_TAB_URL) ? '' : url,
      security: this.security(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: this.loading,
      zoom: Math.round(wc.getZoomFactor() * 100),
      blocked: prism.adblock.blocked(wc.id),
      shieldOn: shieldAvailable && prism.settings.adblock && !prism.adblock.isAllowlisted(url),
      shieldAvailable,
      bookmarked: !!prism.bookmarks.find(url),
      find: { ...this.find },
      prompt: p ? { id: p.id, origin: p.origin, text: p.text, kind: p.kind } : null,
      crashed: this.crashed,
    };
  }
  origin() { return originOf(this.url); }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dismissPrompts();
    if (!this.wc.isDestroyed()) this.wc.close();
  }
}
