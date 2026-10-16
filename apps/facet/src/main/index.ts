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
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { app, BrowserWindow, dialog, Menu, nativeImage, screen, shell, systemPreferences, Tray, type Display, type WebContents } from 'electron';
import { Helper } from './helper';
import { deleteTask, registerTask } from './startup';
import { categorize, displayName, scanDesktop } from './desktop';
import { cleanItem, cleanLayout, cleanSettings, cleanWidget, newClock, newControl, newFolder, newId, newMedia, newRecent, type Layout } from './layout';
import type { DeskCommand, DisplayInfo, FolderWidget, HitRect, IconInfo, MediaState, OrganizeGroup, RecentFolder, Rect, Settings, State, SysState, Track, Wall, Widget, WidgetType } from '../shared/types';

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

/** Name of Facet's value under HKCU\...\Run (the fallback way of starting with Windows, and Facet 0.1's). */
const RUN_NAME = 'CrystalSuite.Facet';
/** The scheduled task that starts Facet at sign-in (Windows holds Run-key programs back for a while). */
const TASK_NAME = 'Crystal Suite Facet';
/** Written while Facet hides the desktop icons, so the Crystal Suite uninstaller can bring them back. */
const ICONS_MARKER = 'icons-hidden';

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
      this.helper.call('logoff-keep', this.keepsIconsHiddenAtLogoff() ? '1' : '0');
      this.applyIcons();
      // once more shortly: a Facet version being replaced may still be putting the icons back
      setTimeout(() => this.applyIcons(), 1500);
      this.refreshWalls();
      this.push();
      // a (re)started helper has no watchers yet
      this.feeds = { media: false, sys: false, recent: false };
      this.syncFeeds();
    };
    this.helper.onEvent = (name, data) => {
      if (name === 'wallpaper') setTimeout(() => this.refreshWalls(), 400);
      if (name === 'explorer') { this.applyIcons(); this.refreshWalls(); }
      if (name === 'drag') this.onDesktopDrag(data);
      if (name === 'media') this.onMedia(data);
      if (name === 'sys') this.onSys(data);
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
    systemPreferences.on('accent-color-changed', this.onAccent);
    if (!this.helper.available) this.refreshWalls();
    this.syncFeeds();
    this.applyDim();
  }

  private onAccent = () => this.push();

  private accent() {
    try { return '#' + systemPreferences.getAccentColor().slice(0, 6); } catch { return '#0078d4'; }
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
    systemPreferences.removeListener('accent-color-changed', this.onAccent);
    for (const t of this.feedTimers) clearInterval(t);
    this.feedTimers = [];
    this.recentWatch?.close();
    this.recentWatch = null;
    this.feeds = { media: false, sys: false, recent: false };
    for (const w of this.dims.values()) if (!w.isDestroyed()) w.destroy();
    this.dims.clear();
    // closing the helper's input makes it show the desktop icons Facet hid
    this.helper.stop();
    if (this.layout.settings.iconsHidden) { try { fs.rmSync(path.join(this.host.dataDir, ICONS_MARKER), { force: true }); } catch { /* gone */ } }
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
      helper: this.helper.ready, iconsVisible: this.iconsVisible, standalone: this.host.standalone, accent: this.accent(),
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

  private changed() { this.save(); this.push(); this.syncFeeds(); }

  // ---------- live data for the media, Control Center and recent-folders widgets ----------

  private media: MediaState = { spotify: null, current: null };
  private sys: SysState | null = null;
  private recent: RecentFolder[] = [];
  private feeds = { media: false, sys: false, recent: false };
  private feedTimers: NodeJS.Timeout[] = [];
  private recentWatch: fs.FSWatcher | null = null;
  private cpuLast = os.cpus().map((c) => c.times);
  private dims = new Map<string, BrowserWindow>();
  private brightnessInfo: { monitors: { x: number; y: number; w: number; h: number; ddc: boolean; value: number }[]; wmi: number } | null = null;

  private sendAll(channel: string, value: unknown) {
    for (const w of this.windows()) if (!w.isDestroyed()) w.webContents.send(channel, value);
  }

  /** Starts or stops the helper's watchers to match the widgets on screen (nothing runs for no widget). */
  private syncFeeds() {
    if (!this.running) return;
    const has = (t: WidgetType) => this.layout.widgets.some((w) => w.type === t);
    const want = { media: has('media') || has('control'), sys: has('control'), recent: has('recent') };
    if (want.media !== this.feeds.media) this.helper.call('media-watch', want.media ? '1' : '0', path.join(this.host.dataDir, 'art'));
    if (want.sys !== this.feeds.sys) {
      this.helper.call('sys-watch', want.sys ? '1' : '0');
      if (want.sys) this.readBrightness();
    }
    if (want.recent !== this.feeds.recent) {
      if (want.recent) {
        this.loadRecent();
        try {
          let t: NodeJS.Timeout | null = null;
          this.recentWatch = fs.watch(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Recent'), () => {
            if (t) clearTimeout(t);
            t = setTimeout(() => this.loadRecent(), 1500);
          });
        } catch { /* polled below anyway */ }
      } else { this.recentWatch?.close(); this.recentWatch = null; }
    }
    this.feeds = want;
    for (const t of this.feedTimers) clearInterval(t);
    this.feedTimers = [];
    if (want.sys) this.feedTimers.push(setInterval(() => this.sampleCpu(), 3000));
    if (want.recent) this.feedTimers.push(setInterval(() => this.loadRecent(), 60000));
  }

  private onMedia(json: string) {
    let m: MediaState;
    try { m = JSON.parse(json); } catch { return; }
    const fix = (t: Track | null) => (t ? { ...t, art: t.art ? pathToFileURL(t.art).href : '' } : null);
    this.media = { spotify: fix(m.spotify), current: fix(m.current) };
    this.sendAll('facet:media', this.media);
  }

  private onSys(json: string) {
    let v: Partial<SysState>;
    try { v = JSON.parse(json); } catch { return; }
    this.sys = { ...(this.sys ?? this.emptySys()), ...v };
    this.sendAll('facet:sys', this.sys);
  }

  private emptySys(): SysState {
    return {
      volume: null, muted: false, device: '', nightlight: false, dark: true, wifi: null, bluetooth: null, net: null,
      brightness: this.layout.settings.dim, hardware: false, cpu: 0, ram: 0,
    };
  }

  private sampleCpu() {
    const now = os.cpus().map((c) => c.times);
    let busy = 0, total = 0;
    now.forEach((t, i) => {
      const p = this.cpuLast[i] ?? t;
      const d = (k: keyof typeof t) => t[k] - p[k];
      const all = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
      busy += all - d('idle');
      total += all;
    });
    this.cpuLast = now;
    const cpu = total ? Math.round((busy / total) * 100) : 0;
    const ram = Math.round((1 - os.freemem() / os.totalmem()) * 100);
    const s = this.sys ?? this.emptySys();
    // small wobbles aren't worth redrawing the Control Center for
    if (Math.abs(s.cpu - cpu) < 2 && Math.abs(s.ram - ram) < 2) return;
    this.sys = { ...s, cpu, ram };
    this.sendAll('facet:sys', this.sys);
  }

  private async loadRecent() {
    const raw = await this.helper.call('recent', 24);
    if (raw === null) return;
    let list: { path: string; time: number }[] = [];
    try { list = JSON.parse(raw); } catch { return; }
    const next: RecentFolder[] = list.map((r) => ({ path: r.path, name: path.basename(r.path) || r.path, parent: path.dirname(r.path) === r.path ? '' : path.dirname(r.path), time: r.time }));
    if (JSON.stringify(next) === JSON.stringify(this.recent)) return;
    this.recent = next;
    this.sendAll('facet:recent', this.recent);
  }

  // ---------- brightness: real where the display allows it, otherwise dimming ----------

  /** Which displays have hardware brightness (DDC/CI monitors, laptop panels through WMI). */
  private async readBrightness() {
    const raw = await this.helper.call('brightness');
    try { this.brightnessInfo = raw ? JSON.parse(raw) : null; } catch { this.brightnessInfo = null; }
    const hw = this.hardwareFor();
    const first = [...hw.values()][0];
    const s = this.sys ?? this.emptySys();
    this.sys = { ...s, hardware: hw.size > 0, brightness: first ? first.value : this.layout.settings.dim };
    this.sendAll('facet:sys', this.sys);
    this.applyDim();
  }

  /** display id -> its hardware brightness control. */
  private hardwareFor() {
    const out = new Map<string, { target: string; value: number }>();
    const info = this.brightnessInfo;
    if (!info) return out;
    for (const d of screen.getAllDisplays()) {
      const phys = screen.dipToScreenRect(null, d.bounds);
      const i = info.monitors.findIndex((m) => Math.abs(m.x - phys.x) < 8 && Math.abs(m.y - phys.y) < 8);
      if (i >= 0 && info.monitors[i].ddc) out.set(String(d.id), { target: String(i), value: info.monitors[i].value });
      else if (d.internal && info.wmi >= 0) out.set(String(d.id), { target: 'wmi', value: info.wmi });
    }
    return out;
  }

  private setBrightness(value: number) {
    value = Math.max(15, Math.min(100, Math.round(value)));
    const hw = this.hardwareFor();
    for (const t of new Set([...hw.values()].map((h) => h.target))) this.helper.call('brightness-set', t, value);
    if (hw.size < screen.getAllDisplays().length) { this.layout.settings.dim = value; this.save(); }
    this.sys = { ...(this.sys ?? this.emptySys()), brightness: value };
    this.sendAll('facet:sys', this.sys);
    this.applyDim();
  }

  /** A black, click-through, always-on-top veil over displays that can't dim themselves. */
  private applyDim() {
    const hw = this.hardwareFor();
    const level = this.layout.settings.dim;
    const alpha = this.running && level < 100 ? (100 - level) / 100 : 0;
    const keep = new Set<string>();
    for (const d of screen.getAllDisplays()) {
      const id = String(d.id);
      if (hw.has(id) || alpha <= 0) continue;
      keep.add(id);
      let w = this.dims.get(id);
      if (!w || w.isDestroyed()) {
        w = new BrowserWindow({
          ...{ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
          frame: false, show: false, backgroundColor: '#000000', hasShadow: false, thickFrame: false, roundedCorners: false,
          resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
          skipTaskbar: true, focusable: false, type: 'toolbar', title: 'Facet dimming',
          webPreferences: { sandbox: true, contextIsolation: true },
        });
        w.setIgnoreMouseEvents(true);
        w.setAlwaysOnTop(true, 'screen-saver');
        w.on('page-title-updated', (e) => e.preventDefault());
        this.dims.set(id, w);
        const win = w;
        win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
        win.loadURL('about:blank');
      }
      w.setBounds({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height });
      w.setOpacity(alpha);
    }
    for (const [id, w] of this.dims) if (!keep.has(id)) { if (!w.isDestroyed()) w.destroy(); this.dims.delete(id); }
  }

  /** Control Center changes. */
  private setSys(key: string, value: unknown) {
    const v = value as never;
    switch (key) {
      case 'volume': this.helper.call('volume', Math.round(Number(v))); break;
      case 'mute': this.helper.call('mute', v ? '1' : '0'); break;
      case 'nightlight': this.helper.call('nightlight', v ? '1' : '0'); break;
      case 'dark': this.helper.call('theme', v ? 'dark' : 'light'); break;
      case 'wifi': case 'bluetooth': this.helper.call('radio', key, v ? 'on' : 'off'); break;
      case 'brightness': this.setBrightness(Number(v)); return;
    }
    // show the change straight away; the helper's next report confirms it
    if (this.sys && key in this.sys) { this.sys = { ...this.sys, [key]: v }; this.sendAll('facet:sys', this.sys); }
  }

  /** The Control Center's buttons. */
  private launch(what: string) {
    const run = (cmd: string, args: string[] = []) => { try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* not available */ } };
    switch (what) {
      case 'spotify': shell.openExternal('spotify:'); break;
      case 'snip': shell.openExternal('ms-screenclip:'); break;
      case 'settings': shell.openExternal('ms-settings:'); break;
      case 'calc': run('calc.exe'); break;
      case 'lock': run('rundll32.exe', ['user32.dll,LockWorkStation']); break;
      case 'taskmgr': run('taskmgr.exe'); break;
      case 'network': shell.openExternal('ms-settings:network'); break;
      case 'bluetooth': shell.openExternal('ms-settings:bluetooth'); break;
      case 'nightlight': shell.openExternal('ms-settings:nightlight'); break;
      case 'sound': shell.openExternal('ms-settings:sound'); break;
      case 'display': shell.openExternal('ms-settings:display'); break;
    }
  }

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

  private addWidget(type: WidgetType, opts: { name?: string; display?: string; x?: number; y?: number; paths?: string[] } = {}) {
    const display = opts.display && this.displays().some((d) => d.id === opts.display) ? opts.display : String(screen.getPrimaryDisplay().id);
    const SIZES: Record<WidgetType, { w: number; h: number }> = {
      folder: { w: 114, h: 108 }, clock: { w: 440, h: 190 }, media: { w: 380, h: 170 }, control: { w: 372, h: 456 }, recent: { w: 320, h: 380 },
    };
    const size = SIZES[type];
    const at = opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : this.freeSpot(display, size.w, size.h);
    const w = type === 'clock' ? newClock(display, at.x, at.y)
      : type === 'media' ? newMedia(display, at.x, at.y)
        : type === 'control' ? newControl(display, at.x, at.y)
          : type === 'recent' ? newRecent(display, at.x, at.y)
            : newFolder(this.uniqueName(opts.name || 'New Folder'), display, at.x, at.y, this.itemsFor(opts.paths || []));
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
    if (next.startup !== before.startup) {
      this.applyStartup(next.startup);
      this.helper.call('logoff-keep', this.keepsIconsHiddenAtLogoff() ? '1' : '0');
    }
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
    if (this.dims.size || this.layout.settings.dim < 100) this.applyDim();
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
    // Only "not found" means missing. Windows briefly locks shortcuts while it updates them (for example
    // right after they're dragged), so a busy file is asked again rather than reported as gone.
    let st: fs.Stats | null = null;
    for (let i = 0; i < 5 && !st; i++) {
      try { st = fs.statSync(p); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return { url: '', kind: 'icon', missing: true };
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
    if (!st) return { url: '', kind: 'icon' };
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

  private startupTimer: NodeJS.Timeout | null = null;

  /** Start with Windows (or not). schtasks takes a moment, so this never runs on the startup path. */
  private applyStartup(on: boolean) {
    // CRYSTAL_NO_STARTUP: tests run Facet in the launcher without touching the real Run key or tasks
    if (this.host.standalone || process.platform !== 'win32' || process.env.CRYSTAL_NO_STARTUP) return;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => { this.startupTimer = null; this.writeStartup(on); }, on ? 4000 : 0);
  }

  private async writeStartup(on: boolean) {
    try {
      const cmd = this.host.launchCommand();
      const marker = path.join(this.host.dataDir, STARTUP_MARKER);
      if (on) fs.writeFileSync(marker, 'Windows starts Facet with this file (it opens the widgets without a window).\n');
      const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
      const args = [...cmd.args, marker].map(quote);
      const task = on ? await registerTask(TASK_NAME, cmd.exe, args.join(' '), this.host.dataDir) : (await deleteTask(TASK_NAME), false);
      // the Run entry is only the fallback: exactly one of the two starts Facet
      app.setLoginItemSettings({ openAtLogin: on && !task, path: cmd.exe, args, name: RUN_NAME } as Electron.Settings);
    } catch (e) { console.warn('Facet: start with Windows', e); }
  }

  /** At sign-out the icons stay hidden only if Facet comes back at sign-in to own them again. */
  private keepsIconsHiddenAtLogoff() {
    return this.layout.settings.startup && !this.host.standalone && !process.env.CRYSTAL_NO_STARTUP;
  }

  /**
   * "Hide the desktop icons" means while Facet runs: applied on every start (the helper shows them
   * again when Facet stops). While they're hidden the helper reports drags on the empty desktop, so the
   * layer can draw the selection box Windows no longer does.
   */
  private async applyIcons() {
    const marker = path.join(this.host.dataDir, ICONS_MARKER);
    if (this.layout.settings.iconsHidden) {
      const r = await this.helper.call('set-icons', '0');
      if (r !== null) {
        this.iconsVisible = r === '1';
        try { fs.writeFileSync(marker, 'Facet hid the Windows desktop icons.\n'); } catch { /* optional */ }
      }
    } else if (exists(marker)) {
      // still hidden from an earlier session (signed out while Facet was hiding them)
      const r = await this.helper.call('set-icons', '1');
      if (r !== null) { this.iconsVisible = r === '1'; try { fs.rmSync(marker, { force: true }); } catch { /* gone */ } }
    } else await this.refreshIconsVisible();
    await this.helper.call('drag-watch', this.layout.settings.iconsHidden ? '1' : '0');
    this.push();
  }

  private dragDesk: Desk | null = null;

  /** A drag that started on the empty desktop (helper, physical pixels) -> the layer it is on. */
  private onDesktopDrag(data: string) {
    const [phase, sx, sy] = data.split(' ');
    const p = screen.screenToDipPoint({ x: Number(sx), y: Number(sy) });
    if (phase === 'start') {
      this.dragDesk = [...this.desks.values()].find((d) => p.x >= d.bounds.x && p.y >= d.bounds.y && p.x < d.bounds.x + d.bounds.width && p.y < d.bounds.y + d.bounds.height) ?? null;
    }
    const d = this.dragDesk;
    if (!d || d.win.isDestroyed()) return;
    d.win.webContents.send('facet:marquee', { phase, x: p.x - d.bounds.x, y: p.y - d.bounds.y });
    if (phase === 'end') this.dragDesk = null;
  }

  private async refreshIconsVisible() {
    const r = await this.helper.call('icons-visible');
    const v = r === null ? null : r === '1';
    if (v !== this.iconsVisible) { this.iconsVisible = v; this.push(); }
  }

  private async setDesktopIcons(show: boolean) {
    this.layout.settings.iconsHidden = !show;
    this.changed();
    const r = await this.helper.call('set-icons', show ? '1' : '0');
    if (r === null) return;
    this.iconsVisible = r === '1';
    const marker = path.join(this.host.dataDir, ICONS_MARKER);
    try {
      if (this.iconsVisible) fs.rmSync(marker, { force: true });
      else fs.writeFileSync(marker, 'Facet hid the Windows desktop icons.\n');
    } catch { /* optional */ }
    await this.helper.call('drag-watch', show ? '0' : '1');
    this.push();
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
      { label: 'New Widget', submenu: [
        { label: 'Clock', click: () => this.addWidget('clock') },
        { label: 'Spotify', click: () => this.addWidget('media') },
        { label: 'Control Center', click: () => this.addWidget('control') },
        { label: 'Recent Folders', click: () => this.addWidget('recent') },
      ] },
      { label: 'Organize Desktop…', click: () => { this.showHome(); this.home?.webContents.send('facet:command', { kind: 'organize' }); } },
      { type: 'separator' },
      { label: 'Hide Desktop Icons', type: 'checkbox', checked: s.iconsHidden, enabled: this.helper.ready, click: (m) => this.setDesktopIcons(!m.checked) },
      { label: 'Lock Widgets', type: 'checkbox', checked: s.lock, click: (m) => this.setSettings({ lock: m.checked }) },
      ...(this.host.standalone ? [] : [{ label: 'Start with Windows', type: 'checkbox' as const, checked: s.startup, click: (m: Electron.MenuItem) => this.setSettings({ startup: m.checked }) }]),
      { type: 'separator' },
      { label: 'Quit Facet', click: () => this.stop() },
    ]));
  }

  // ---------- IPC ----------

  private wire(wc: WebContents, desk: Desk | null) {
    const on = (channel: string, fn: (...args: any[]) => unknown) => wc.ipc.handle(channel, (_e, ...args) => fn(...args));
    on('facet:init', () => ({ state: this.state(), display: desk?.display ?? null, wall: desk?.wall ?? null, media: this.media, sys: this.sys, recent: this.recent }));
    on('facet:media-cmd', (target: string, cmd: string, arg?: string) => this.helper.call('media', target === 'spotify' ? 'spotify' : 'current', String(cmd), String(arg ?? '')));
    on('facet:sys-set', (key: string, value: unknown) => this.setSys(String(key), value));
    on('facet:launch', (what: string) => this.launch(String(what)));
    on('facet:put', (w: Widget) => this.putWidget(w));
    on('facet:add', (type: WidgetType, opts?: { name?: string; display?: string; x?: number; y?: number; paths?: string[] }) =>
      (['folder', 'clock', 'media', 'control', 'recent'].includes(type) ? this.addWidget(type, { ...opts, display: opts?.display ?? desk?.display.id }) : null));
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
  try { spawnSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { timeout: 10000, windowsHide: true }); } catch { /* not there */ }
  const dataDir = path.join(app.getPath('userData'), 'Facet');
  const layout = readJson<any>(path.join(dataDir, 'facet.json'), null);
  const exe = path.join(__dirname, 'FacetHelper.exe');
  if ((layout?.settings?.iconsHidden || exists(path.join(dataDir, 'icons-hidden'))) && exists(exe)) {
    try { spawnSync(exe, ['show-icons'], { timeout: 5000, windowsHide: true }); } catch { /* best effort */ }
  }
  try { fs.rmSync(path.join(dataDir, 'icons-hidden'), { force: true }); } catch { /* gone */ }
}
