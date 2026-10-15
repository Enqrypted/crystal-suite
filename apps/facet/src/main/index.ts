// Facet's main-process module (bundled to main.cjs). It runs inside a host — the Crystal Suite launcher or
// Facet's standalone dev host — and owns:
//  - one transparent "desk" window per display, covering its work area and kept by FacetHelper.exe
//    directly above the Windows desktop (below every app, still there after Show desktop). It is
//    click-through except where widgets are: the cursor is hit-tested against the rectangles the page
//    reports, so the real desktop under it keeps working;
//  - the Facet window (widget list, settings, Organize desktop) and the tray icon;
//  - icons (large shell icons, thumbnails and Steam artwork, cached as PNGs), the wallpaper for the
//    frosted glass, start-with-Windows and the Windows desktop-icons toggle.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { app, BrowserWindow, dialog, Menu, nativeImage, screen, shell, Tray, type Display, type WebContents } from 'electron';
import { Helper } from './helper';
import { categorize, displayName, scanDesktop } from './desktop';
import { cleanItem, cleanLayout, cleanSettings, cleanWidget, newClock, newFolder, newId, type Layout } from './layout';
import type { DeskCommand, DisplayInfo, FolderWidget, HitRect, IconInfo, OrganizeGroup, Rect, Settings, State, Wall, Widget } from '../shared/types';

export interface Host {
  appId: string;
  version: string;
  /** Folder with main.cjs, preload.cjs, web/ and FacetHelper.exe. */
  appDir: string;
  /** Where Facet keeps its layout and icon cache. */
  dataDir: string;
  icon: string | null;
  ico: string | null;
  standalone: boolean;
  launchCommand(): { exe: string; args: string[] };
  decorateWindow?(win: BrowserWindow): void;
}

/** Name of Facet's value under HKCU\...\Run. */
const RUN_NAME = 'CrystalSuite.Facet';
/** Passed (as a file, so any launcher version forwards it) when Windows starts Facet: no window then. */
const STARTUP_MARKER = 'startup.facet';
const IMAGE_EXT = /\.(jpe?g|png|bmp|webp|gif)$/i;

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
const exists = (p: string) => { try { fs.accessSync(p); return true; } catch { return false; } };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rectOf = (r: Electron.Rectangle): Rect => ({ x: r.x, y: r.y, w: r.width, h: r.height });

interface Desk {
  win: BrowserWindow;
  /** Window bounds (cached: read on every hit test). */
  bounds: Electron.Rectangle;
  display: DisplayInfo;
  rects: HitRect[];
  capture: boolean;
  interactive: boolean;
  wall: Wall | null;
  hwnd: string;
}

class Facet {
  private layout: Layout;
  private layoutFile: string;
  private iconDir: string;
  private firstRun: boolean;
  private desks = new Map<string, Desk>();
  private home: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private helper: Helper;
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private pushQueued = false;
  private iconsVisible: boolean | null = null;
  private iconJobs = new Map<string, Promise<IconInfo>>();
  private onDisplays = () => this.syncDisplays();

  constructor(readonly host: Host) {
    fs.mkdirSync(host.dataDir, { recursive: true });
    this.layoutFile = path.join(host.dataDir, 'facet.json');
    this.iconDir = path.join(host.dataDir, 'icons');
    this.firstRun = !exists(this.layoutFile);
    this.layout = cleanLayout(readJson(this.layoutFile, {}));
    this.helper = new Helper(path.join(host.appDir, 'FacetHelper.exe'));
    this.helper.onStart = () => {
      for (const d of this.desks.values()) if (d.hwnd) this.helper.call('pin', d.hwnd);
      this.refreshIconsVisible();
      this.refreshWalls();
      this.push();
    };
    this.helper.onEvent = (name) => {
      if (name === 'wallpaper') setTimeout(() => this.refreshWalls(), 400);
      if (name === 'explorer') { this.refreshIconsVisible(); this.refreshWalls(); }
    };
  }

  // ---------- lifecycle ----------

  open(args: string[]) {
    const silent = args.some((a) => path.basename(a).toLowerCase() === STARTUP_MARKER);
    this.start();
    if (!silent) this.showHome();
  }

  windows() { return [...(this.home ? [this.home] : []), ...[...this.desks.values()].map((d) => d.win)]; }

  private start() {
    if (this.running) return;
    this.running = true;
    this.helper.start();
    if (this.firstRun) {
      // a clock to start with, near the top right of the main display
      const d = screen.getPrimaryDisplay();
      this.layout.widgets.push(newClock(String(d.id), Math.max(40, d.workArea.width - 560), 60));
      this.save();
      if (!this.host.standalone) this.applyStartup(true);
      this.firstRun = false;
    } else if (this.layout.settings.startup && !this.host.standalone) {
      this.applyStartup(true); // keeps the Run entry pointing at the current launcher
    }
    this.syncDisplays();
    screen.on('display-added', this.onDisplays);
    screen.on('display-removed', this.onDisplays);
    screen.on('display-metrics-changed', this.onDisplays);
    this.scheduleHitTest();
    this.timers.push(setInterval(() => this.checkWallChanged(), 30000));
    this.timers.push(setInterval(() => this.checkForUpdate(), 10 * 60000));
    this.createTray();
    if (!this.helper.available) this.refreshWalls();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.hitTimer) { clearTimeout(this.hitTimer); this.hitTimer = null; }
    screen.removeListener('display-added', this.onDisplays);
    screen.removeListener('display-removed', this.onDisplays);
    screen.removeListener('display-metrics-changed', this.onDisplays);
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.writeNow(); }
    for (const d of this.desks.values()) if (!d.win.isDestroyed()) d.win.destroy();
    this.desks.clear();
    if (this.home && !this.home.isDestroyed()) this.home.destroy();
    this.home = null;
    this.tray?.destroy();
    this.tray = null;
    this.helper.stop();
  }

  // ---------- state ----------

  private displays(): DisplayInfo[] {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id), label: d.label || `Display ${i + 1}`, primary: d.id === primary,
      bounds: rectOf(d.bounds), workArea: rectOf(d.workArea), scale: d.scaleFactor,
    }));
  }

  private state(): State {
    return {
      version: this.host.version, widgets: this.layout.widgets, settings: this.layout.settings, displays: this.displays(),
      helper: this.helper.ready, iconsVisible: this.iconsVisible, standalone: this.host.standalone,
    };
  }

  /** Sends the state to every window (once per tick). */
  private push() {
    if (this.pushQueued) return;
    this.pushQueued = true;
    setImmediate(() => {
      this.pushQueued = false;
      const s = this.state();
      for (const w of this.windows()) if (!w.isDestroyed()) w.webContents.send('facet:state', s);
      this.updateTrayMenu();
    });
  }

  private save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.writeNow(); }, 250);
  }
  private writeNow() {
    try { writeJson(this.layoutFile, this.layout); } catch (e) { console.warn('Facet: could not save the layout', e); }
  }

  private changed() { this.save(); this.push(); }

  private widget(id: string) { return this.layout.widgets.find((w) => w.id === id); }

  private putWidget(raw: unknown) {
    const w = cleanWidget(raw);
    if (!w) return false;
    const i = this.layout.widgets.findIndex((x) => x.id === w.id);
    if (i < 0) return false;
    this.layout.widgets[i] = w;
    this.changed();
    return true;
  }

  private addWidget(type: 'folder' | 'clock', opts: { name?: string; display?: string; x?: number; y?: number; paths?: string[] } = {}) {
    const display = opts.display && this.displays().some((d) => d.id === opts.display) ? opts.display : String(screen.getPrimaryDisplay().id);
    const size = type === 'clock' ? { w: 440, h: 190 } : { w: 114, h: 108 };
    const at = opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : this.freeSpot(display, size.w, size.h);
    const w = type === 'clock' ? newClock(display, at.x, at.y) : newFolder(this.uniqueName(opts.name || 'New Folder'), display, at.x, at.y, this.itemsFor(opts.paths || []));
    this.layout.widgets.push(w);
    this.pending.push({ id: w.id, display, x: at.x, y: at.y, w: size.w, h: size.h });
    this.changed();
    return w.id;
  }

  private uniqueName(base: string) {
    const names = new Set(this.layout.widgets.filter((w) => w.type === 'folder').map((w) => (w as FolderWidget).name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }

  private itemsFor(paths: string[]) {
    return paths.filter((p) => typeof p === 'string' && p).map((p) => cleanItem({ id: newId(), path: p, name: displayName(p) })!).filter(Boolean);
  }

  private addItems(folderId: string, paths: string[], index?: number) {
    const f = this.widget(folderId);
    if (!f || f.type !== 'folder') return 0;
    const have = new Set(f.items.map((i) => i.path.toLowerCase()));
    const fresh = this.itemsFor(paths.filter((p) => !have.has(String(p).toLowerCase())));
    const at = typeof index === 'number' ? Math.max(0, Math.min(f.items.length, index)) : f.items.length;
    f.items.splice(at, 0, ...fresh);
    this.changed();
    return fresh.length;
  }

  /** Widgets just added whose real size the page hasn't reported yet. */
  private pending: (HitRect & { display: string })[] = [];

  /** A free place for a new widget: columns from the right edge (Windows puts its icons on the left). */
  private freeSpot(displayId: string, w: number, h: number) {
    const d = this.displays().find((x) => x.id === displayId) ?? this.displays()[0];
    const wa = d.workArea;
    const taken: Rect[] = [];
    for (const desk of this.desks.values()) if (desk.display.id === d.id) taken.push(...desk.rects.filter((r) => r.id));
    for (const p of this.pending) if (p.display === d.id) taken.push(p);
    const margin = 28, gap = 14, step = 12;
    for (let x = wa.w - w - margin; x >= margin; x -= step) {
      for (let y = margin; y + h <= wa.h - margin; y += step) {
        const r = { x: x - gap, y: y - gap, w: w + gap * 2, h: h + gap * 2 };
        if (!taken.some((t) => overlaps(r, t))) return { x, y };
      }
    }
    return { x: Math.max(margin, wa.w - w - margin), y: margin };
  }

  private setSettings(patch: Partial<Settings>) {
    const before = this.layout.settings;
    const next = cleanSettings({ ...before, ...patch });
    this.layout.settings = next;
    if (next.startup !== before.startup) this.applyStartup(next.startup);
    this.changed();
  }

  // ---------- desktop layers ----------

  private syncDisplays() {
    if (!this.running) return;
    const list = this.displays();
    for (const [id, desk] of this.desks) {
      const d = list.find((x) => x.id === id);
      if (!d) { desk.win.destroy(); this.desks.delete(id); continue; }
      desk.display = d;
      const wa = d.workArea;
      desk.win.setBounds({ x: wa.x, y: wa.y, width: wa.w, height: wa.h });
      desk.bounds = desk.win.getBounds();
    }
    for (const d of list) if (!this.desks.has(d.id)) this.createDesk(d);
    this.refreshWalls();
    this.push();
  }

  private createDesk(d: DisplayInfo) {
    const wa = d.workArea;
    const win = new BrowserWindow({
      x: wa.x, y: wa.y, width: wa.w, height: wa.h, show: false, title: 'Facet widgets',
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, thickFrame: false, roundedCorners: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, closable: true,
      skipTaskbar: true, focusable: false, type: 'toolbar',
      webPreferences: {
        preload: path.join(this.host.appDir, 'preload.cjs'),
        sandbox: true, contextIsolation: true, spellcheck: false,
        backgroundThrottling: false, // the clock keeps time while apps cover the desktop
      },
    });
    const desk: Desk = { win, bounds: { x: wa.x, y: wa.y, width: wa.w, height: wa.h }, display: d, rects: [], capture: false, interactive: false, wall: null, hwnd: '' };
    const keep = () => { if (!win.isDestroyed()) desk.bounds = win.getBounds(); };
    win.on('move', keep);
    win.on('resize', keep);
    this.desks.set(d.id, desk);
    win.setIgnoreMouseEvents(true);
    win.on('page-title-updated', (e) => e.preventDefault());
    this.wire(win.webContents, desk);
    win.loadFile(path.join(this.host.appDir, 'web', 'desk.html'), { query: { display: d.id } });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.showInactive();
      win.setBounds({ x: wa.x, y: wa.y, width: wa.w, height: wa.h });
      desk.bounds = win.getBounds();
      desk.hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
      this.helper.call('pin', desk.hwnd);
    });
    win.on('closed', () => { if (this.desks.get(d.id)?.win === win) this.desks.delete(d.id); });
    // nothing may navigate the layer away
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  private lastCursor = { x: NaN, y: NaN, at: 0 };
  private hitTimer: NodeJS.Timeout | null = null;

  /** Polls the cursor: every 40 ms while it moves, every 120 ms once it has been still for a moment. */
  private scheduleHitTest() {
    if (!this.running) return;
    const idle = Date.now() - this.lastCursor.at > 1500;
    this.hitTimer = setTimeout(() => { this.hitTest(); this.scheduleHitTest(); }, idle ? 120 : 40);
  }

  /** Click-through everywhere except over widgets (or everything while a menu, editor or drag is up). */
  private hitTest() {
    if (!this.desks.size) return;
    const p = screen.getCursorScreenPoint();
    if (p.x !== this.lastCursor.x || p.y !== this.lastCursor.y) this.lastCursor = { x: p.x, y: p.y, at: Date.now() };
    for (const d of this.desks.values()) {
      if (d.win.isDestroyed()) continue;
      const b = d.bounds;
      const x = p.x - b.x, y = p.y - b.y;
      const inside = x >= 0 && y >= 0 && x < b.width && y < b.height;
      const over = d.capture || (inside && d.rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h));
      if (over === d.interactive) continue;
      d.interactive = over;
      d.win.setIgnoreMouseEvents(!over);
      d.win.webContents.send('facet:interactive', over);
    }
  }

  /** Lets the layer take keystrokes (renaming a folder) without leaving the desktop level. */
  private keyboard(desk: Desk, on: boolean) {
    const w = desk.win;
    if (on) {
      w.setFocusable(true);
      w.setSkipTaskbar(true);
      w.focus();
      w.webContents.focus();
      this.helper.call('place');
    } else {
      w.setFocusable(false);
      w.setSkipTaskbar(true);
    }
  }

  // ---------- wallpaper (for the frosted glass) ----------

  private async refreshWalls() {
    if (!this.desks.size) return;
    const raw = await this.helper.call('wallpaper');
    let info: any = null;
    try { info = raw ? JSON.parse(raw) : null; } catch { /* treat as unknown */ }
    const transcoded = (info && info.transcoded) || path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
    const list: { x: number; y: number; w: number; h: number; path: string }[] = Array.isArray(info?.monitors) ? info.monitors : [];
    const phys = (r: Rect) => rectOf(screen.dipToScreenRect(null, { x: r.x, y: r.y, width: r.w, height: r.h }));
    const all = list.length ? list : this.displays().map((d) => ({ ...phys(d.bounds), path: '' }));
    const vx = Math.min(...all.map((m) => m.x)), vy = Math.min(...all.map((m) => m.y));
    const virtual = { x: vx, y: vy, w: Math.max(...all.map((m) => m.x + m.w)) - vx, h: Math.max(...all.map((m) => m.y + m.h)) - vy };
    for (const desk of this.desks.values()) {
      const mon = phys(desk.display.bounds);
      const work = phys(desk.display.workArea);
      const m = list.find((x) => Math.abs(x.x - mon.x) < 8 && Math.abs(x.y - mon.y) < 8);
      let image: string | null = null;
      if (m) {
        // an empty path means a solid colour; an image Chromium can't read falls back to Windows' own copy
        if (m.path) image = IMAGE_EXT.test(m.path) && exists(m.path) ? m.path : exists(transcoded) ? transcoded : null;
      } else if (exists(transcoded)) image = transcoded;
      let stamp = 'none';
      if (image) { try { const st = fs.statSync(image); stamp = `${image}|${st.mtimeMs}|${st.size}`; } catch { image = null; } }
      const box = m ? { x: m.x, y: m.y, w: m.w, h: m.h } : mon;
      desk.wall = {
        image, stamp, position: typeof info?.position === 'number' ? info.position : 4, bg: typeof info?.bg === 'string' ? info.bg : '#000000',
        monitor: box, virtual, work: { x: work.x - box.x, y: work.y - box.y, w: work.w, h: work.h },
      };
      if (!desk.win.isDestroyed()) desk.win.webContents.send('facet:wall', desk.wall);
    }
  }

  /** Slideshows and Spotlight don't always announce a new picture. */
  private checkWallChanged() {
    for (const d of this.desks.values()) {
      const w = d.wall;
      if (!w?.image) continue;
      try {
        const st = fs.statSync(w.image);
        if (`${w.image}|${st.mtimeMs}|${st.size}` !== w.stamp) { this.refreshWalls(); return; }
      } catch { this.refreshWalls(); return; }
    }
  }

  // ---------- icons ----------

  private async icon(p: string): Promise<IconInfo> {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { return { url: '', kind: 'icon', missing: true }; }
    const key = crypto.createHash('sha1').update(`${p.toLowerCase()}|${st.mtimeMs}|${st.size}|2`).digest('hex').slice(0, 24);
    for (const kind of ['icon', 'thumb', 'art'] as const) {
      const f = path.join(this.iconDir, `${key}-${kind}.png`);
      if (exists(f)) return { url: pathToFileURL(f).href, kind };
    }
    let job = this.iconJobs.get(key);
    if (!job) {
      job = this.extract(p, key).finally(() => this.iconJobs.delete(key));
      this.iconJobs.set(key, job);
    }
    return job;
  }

  private async extract(p: string, key: string): Promise<IconInfo> {
    fs.mkdirSync(this.iconDir, { recursive: true });
    const tmp = path.join(this.iconDir, `${key}.tmp.png`);
    const r = await this.helper.call('icon', p, 256, tmp);
    if (r && exists(tmp)) {
      const kind = (['icon', 'thumb', 'art'].includes(r.split(' ')[2]) ? r.split(' ')[2] : 'icon') as IconInfo['kind'];
      const f = path.join(this.iconDir, `${key}-${kind}.png`);
      fs.renameSync(tmp, f);
      return { url: pathToFileURL(f).href, kind };
    }
    try {
      const img = await app.getFileIcon(p, { size: 'large' });
      const f = path.join(this.iconDir, `${key}-icon.png`);
      fs.writeFileSync(f, img.toPNG());
      return { url: pathToFileURL(f).href, kind: 'icon' };
    } catch { return { url: '', kind: 'icon' }; }
  }

  // ---------- Windows integration ----------

  private applyStartup(on: boolean) {
    // CRYSTAL_NO_STARTUP: tests run Facet in the launcher without touching the real Run key
    if (this.host.standalone || process.platform !== 'win32' || process.env.CRYSTAL_NO_STARTUP) return;
    try {
      const cmd = this.host.launchCommand();
      const marker = path.join(this.host.dataDir, STARTUP_MARKER);
      if (on) fs.writeFileSync(marker, 'Windows starts Facet with this file (it opens the widgets without a window).\n');
      const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
      app.setLoginItemSettings({ openAtLogin: on, path: cmd.exe, args: [...cmd.args, marker].map(quote), name: RUN_NAME } as Electron.Settings);
    } catch (e) { console.warn('Facet: start with Windows', e); }
  }

  private async refreshIconsVisible() {
    const r = await this.helper.call('icons-visible');
    const v = r === null ? null : r === '1';
    if (v !== this.iconsVisible) { this.iconsVisible = v; this.push(); }
  }

  private async setDesktopIcons(show: boolean) {
    const r = await this.helper.call('set-icons', show ? '1' : '0');
    if (r === null) return;
    this.iconsVisible = r === '1';
    this.layout.settings.iconsHidden = !this.iconsVisible;
    // lets the Crystal Suite uninstaller bring the icons back (it can't read facet.json)
    const marker = path.join(this.host.dataDir, 'icons-hidden');
    try {
      if (this.iconsVisible) fs.rmSync(marker, { force: true });
      else fs.writeFileSync(marker, 'Facet hid the Windows desktop icons.\n');
    } catch { /* optional */ }
    this.changed();
  }

  // ---------- windows ----------

  showHome() {
    if (this.home && !this.home.isDestroyed()) {
      if (this.home.isMinimized()) this.home.restore();
      this.home.show();
      this.home.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 980, height: 700, minWidth: 760, minHeight: 540, show: false, title: 'Facet',
      backgroundColor: '#16161a', autoHideMenuBar: true,
      ...(this.host.icon ? { icon: this.host.icon } : {}),
      webPreferences: { preload: path.join(this.host.appDir, 'preload.cjs'), sandbox: true, contextIsolation: true, spellcheck: false },
    });
    this.home = win;
    this.host.decorateWindow?.(win);
    win.removeMenu();
    this.wire(win.webContents, null);
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(this.host.appDir, 'web', 'home.html'));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
    });
    win.on('closed', () => {
      if (this.home === win) this.home = null;
      setTimeout(() => this.checkForUpdate(), 3000);
    });
  }

  /**
   * The launcher installs updates next to the running version and only switches once the app has no
   * windows - but the widgets never close. When a newer version is installed (and the Facet window is
   * closed), ask the launcher to start Facet again: it unloads this version and loads the new one,
   * silently, as at Windows start.
   */
  private checkForUpdate() {
    if (this.host.standalone || !this.running || (this.home && !this.home.isDestroyed())) return;
    const base = path.dirname(this.host.appDir);
    const newer = (a: string, b: string) => {
      const x = a.split('.').map(Number), y = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
      return false;
    };
    let found = '';
    try {
      for (const n of fs.readdirSync(base)) if (/^\d+\.\d+\.\d+$/.test(n) && newer(n, this.host.version) && exists(path.join(base, n, 'main.cjs'))) found = n;
    } catch { return; }
    if (!found) return;
    try {
      const marker = path.join(this.host.dataDir, STARTUP_MARKER);
      fs.writeFileSync(marker, 'Windows starts Facet with this file (it opens the widgets without a window).\n');
      const cmd = this.host.launchCommand();
      spawn(cmd.exe, [...cmd.args, marker], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) { console.warn('Facet: switching to the new version', e); }
  }

  private deskOf(widgetId: string): Desk | undefined {
    const w = this.widget(widgetId);
    const desks = [...this.desks.values()];
    return desks.find((d) => d.display.id === w?.display) ?? desks.find((d) => d.display.primary) ?? desks[0];
  }

  private createTray() {
    if (this.tray) return;
    // the .ico lets Windows pick the right size for the tray's scaling
    if (this.host.ico && exists(this.host.ico)) this.tray = new Tray(this.host.ico);
    else {
      const img = this.host.icon ? nativeImage.createFromPath(this.host.icon) : nativeImage.createEmpty();
      this.tray = new Tray(img.isEmpty() ? img : img.resize({ width: 32, height: 32, quality: 'best' }));
    }
    this.tray.setToolTip('Facet — desktop folders & widgets');
    this.tray.on('click', () => this.showHome());
    this.tray.on('right-click', () => { this.refreshIconsVisible(); });
    this.updateTrayMenu();
  }

  private updateTrayMenu() {
    if (!this.tray) return;
    const s = this.layout.settings;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Facet', click: () => this.showHome() },
      { type: 'separator' },
      { label: 'New Folder', click: () => this.addWidget('folder') },
      { label: 'New Clock', click: () => this.addWidget('clock') },
      { label: 'Organize Desktop…', click: () => { this.showHome(); this.home?.webContents.send('facet:command', { kind: 'organize' }); } },
      { type: 'separator' },
      { label: 'Show Desktop Icons', type: 'checkbox', checked: this.iconsVisible !== false, enabled: this.iconsVisible !== null, click: (m) => this.setDesktopIcons(m.checked) },
      { label: 'Lock Widgets', type: 'checkbox', checked: s.lock, click: (m) => this.setSettings({ lock: m.checked }) },
      ...(this.host.standalone ? [] : [{ label: 'Start with Windows', type: 'checkbox' as const, checked: s.startup, click: (m: Electron.MenuItem) => this.setSettings({ startup: m.checked }) }]),
      { type: 'separator' },
      { label: 'Quit Facet', click: () => this.stop() },
    ]));
  }

  // ---------- IPC ----------

  private wire(wc: WebContents, desk: Desk | null) {
    const on = (channel: string, fn: (...args: any[]) => unknown) => wc.ipc.handle(channel, (_e, ...args) => fn(...args));
    on('facet:init', () => ({ state: this.state(), display: desk?.display ?? null, wall: desk?.wall ?? null }));
    on('facet:put', (w: Widget) => this.putWidget(w));
    on('facet:add', (type: 'folder' | 'clock', opts?: { name?: string; display?: string; x?: number; y?: number; paths?: string[] }) =>
      (type === 'folder' || type === 'clock' ? this.addWidget(type, { ...opts, display: opts?.display ?? desk?.display.id }) : null));
    on('facet:remove', (id: string) => {
      const n = this.layout.widgets.length;
      this.layout.widgets = this.layout.widgets.filter((w) => w.id !== id);
      if (this.layout.widgets.length !== n) this.changed();
    });
    on('facet:add-items', (id: string, paths: unknown, index?: number) => this.addItems(String(id), Array.isArray(paths) ? paths.map(String) : [], index));
    on('facet:settings', (patch: Partial<Settings>) => this.setSettings(patch));
    on('facet:icon', (p: string) => this.icon(String(p)));
    on('facet:exists', (paths: unknown) => (Array.isArray(paths) ? paths.map((p) => exists(String(p))) : []));
    on('facet:open', async (p: string) => {
      const err = await shell.openPath(String(p));
      return err || '';
    });
    on('facet:reveal', (p: string) => { shell.showItemInFolder(String(p)); });
    on('facet:pick', async (kind: 'files' | 'folder') => {
      const opts: Electron.OpenDialogOptions = {
        title: kind === 'folder' ? 'Add a Folder' : 'Add Apps or Files',
        defaultPath: app.getPath('desktop'),
        properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
      };
      // from the desktop layer the dialog stands on its own (owning it there would tie it to the desktop's z-order)
      const r = desk ? await dialog.showOpenDialog(opts) : await dialog.showOpenDialog(BrowserWindow.fromWebContents(wc)!, opts);
      return r.canceled ? [] : r.filePaths;
    });
    on('facet:desktop', () => scanDesktop());
    on('facet:categorize', (paths: unknown) => (Array.isArray(paths) ? paths.map((p) => categorize(String(p))) : []));
    on('facet:organize', (groups: OrganizeGroup[], hideIcons: boolean) => this.organize(groups, !!hideIcons));
    on('facet:desktop-icons', (show: boolean) => this.setDesktopIcons(!!show));
    on('facet:home', () => this.showHome());
    on('facet:quit', () => this.stop());
    on('facet:command', (cmd: DeskCommand) => {
      const d = this.deskOf(cmd.id);
      d?.win.webContents.send('facet:command', cmd);
    });
    on('facet:display-name', (paths: unknown) => (Array.isArray(paths) ? paths.map((p) => displayName(String(p))) : []));
    if (desk) {
      on('facet:rects', (rects: HitRect[], capture: boolean) => {
        desk.rects = Array.isArray(rects) ? rects.filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite)).slice(0, 500) : [];
        desk.capture = !!capture;
        const ids = new Set(desk.rects.map((r) => r.id));
        this.pending = this.pending.filter((p) => !ids.has(p.id));
        this.hitTest();
      });
      on('facet:keyboard', (enable: boolean) => this.keyboard(desk, !!enable));
      on('facet:read-wall', () => {
        const img = desk.wall?.image;
        if (!img) return null;
        try { return fs.readFileSync(img); } catch { return null; }
      });
    }
  }

  private organize(groups: OrganizeGroup[], hideIcons: boolean) {
    const display = String(screen.getPrimaryDisplay().id);
    let made = 0;
    for (const g of Array.isArray(groups) ? groups : []) {
      const paths = Array.isArray(g?.paths) ? g.paths.map(String).filter(exists) : [];
      if (!paths.length) continue;
      const id = this.addWidget('folder', { name: String(g.name || 'Folder').slice(0, 60), display, paths });
      const f = this.widget(id);
      if (f && f.type === 'folder' && g.style === 'panel') { f.style = 'panel'; f.cols = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(paths.length)))); }
      made++;
    }
    if (hideIcons && made) this.setDesktopIcons(false);
    this.changed();
    return made;
  }
}

let current: Facet | null = null;

export function activate(host: Host) {
  const facet = new Facet(host);
  current = facet;
  return {
    open: (args: string[]) => facet.open(args || []),
    windows: () => facet.windows(),
    deactivate: () => { facet.stop(); if (current === facet) current = null; },
  };
}

/** Called by the launcher before Facet's files are removed: undo what it set up in Windows. */
export async function uninstall() {
  current?.stop();
  try { app.setLoginItemSettings({ openAtLogin: false, name: RUN_NAME } as Electron.Settings); } catch { /* not set */ }
  const dataDir = path.join(app.getPath('userData'), 'Facet');
  const layout = readJson<any>(path.join(dataDir, 'facet.json'), null);
  const exe = path.join(__dirname, 'FacetHelper.exe');
  if ((layout?.settings?.iconsHidden || exists(path.join(dataDir, 'icons-hidden'))) && exists(exe)) {
    try { spawnSync(exe, ['show-icons'], { timeout: 5000, windowsHide: true }); } catch { /* best effort */ }
  }
  try { fs.rmSync(path.join(dataDir, 'icons-hidden'), { force: true }); } catch { /* gone */ }
}
