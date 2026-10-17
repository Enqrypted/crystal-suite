// Onyx's main-process module (bundled to main.cjs): instant replay for games. It runs inside a host — the
// Crystal Suite launcher or Onyx's standalone dev host — and owns:
//  - OnyxHelper.exe, which records games into memory (GPU capture and hardware encoding), one replay buffer per
//    game, and writes out the last seconds of one on request (see native/);
//  - picking what to record: every open game automatically (the helper reports the window in front, and the
//    open windows are looked over every few seconds), one window, or a screen;
//  - the hotkey (Ctrl+Shift+G by default) and its on-screen picker (which game, how long), saving, the notices;
//  - the Onyx window (status, clips, settings) and the tray icon.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeImage, screen, shell, Tray, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { exeName, fileSafe, gameName, isGame, windowsGames, type WindowInfo } from './games';
import { Helper } from './helper';
import { muxDump, probeClip } from './mux';
import { deleteTask, registerTask } from './startup';
import { BUFFER_SECONDS, LENGTHS, MAX_RECORDINGS, RESOLUTIONS, type Clip, type DisplayInfo, type OverlayMessage, type Recording, type Settings, type State, type WindowChoice } from '../shared/types';

export interface Host {
  appId: string;
  version: string;
  /** Folder with main.cjs, preload.cjs, web/ and OnyxHelper.exe. */
  appDir: string;
  /** Where Onyx keeps its settings. */
  dataDir: string;
  icon: string | null;
  ico: string | null;
  standalone: boolean;
  launchCommand(): { exe: string; args: string[] };
  decorateWindow?(win: BrowserWindow): void;
}

/** Name of Onyx's value under HKCU\...\Run (the fallback way of starting with Windows). */
const RUN_NAME = 'CrystalSuite.Onyx';
/** The scheduled task that starts Onyx at sign-in. */
const TASK_NAME = 'Crystal Suite Onyx';
/** Passed (as a file, so any launcher version forwards it) when Windows starts Onyx: no window then. */
const STARTUP_MARKER = 'startup.onyx';
/** How long the picker waits before saving what is highlighted. */
const PICKER_MS = 3000;
/** How often the open windows are looked over for games that started behind others. */
const SCAN_MS = 4000;
const OVERLAY_W = 640, OVERLAY_H = 230;
const PICKER_KEYS = ['1', '2', '3', '4', 'num1', 'num2', 'num3', 'num4', 'Enter', 'Escape', 'Tab', 'Shift+Tab', 'Left', 'Right'];

const DEFAULTS: Settings = {
  enabled: true, mode: 'auto', window: null, display: null, resolution: 1080, fps: 60, quality: 1,
  systemAudio: true, mic: false, hotkey: 'Ctrl+Shift+G', folder: '', sound: true, startup: true, lastLength: 30,
  always: [], never: [],
};

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
const exists = (p: string) => { try { fs.accessSync(p); return true; } catch { return false; } };
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.toLowerCase()).slice(0, 200) : []);

function cleanSettings(raw: any): Settings {
  const s = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return s;
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
  if (['auto', 'window', 'screen'].includes(raw.mode)) s.mode = raw.mode;
  if (raw.window && typeof raw.window.exe === 'string') {
    s.window = { exe: raw.window.exe, title: String(raw.window.title || ''), name: String(raw.window.name || '') };
    if (typeof raw.window.hwnd === 'string') s.window.hwnd = raw.window.hwnd;
  }
  if (typeof raw.display === 'string' || raw.display === null) s.display = raw.display;
  if ((RESOLUTIONS as readonly number[]).includes(raw.resolution)) s.resolution = raw.resolution;
  if (raw.fps === 30 || raw.fps === 60) s.fps = raw.fps;
  if ([0, 1, 2].includes(raw.quality)) s.quality = raw.quality;
  for (const k of ['systemAudio', 'mic', 'sound', 'startup'] as const) if (typeof raw[k] === 'boolean') s[k] = raw[k];
  if (typeof raw.hotkey === 'string' && raw.hotkey.length < 60) s.hotkey = raw.hotkey;
  if (typeof raw.folder === 'string') s.folder = raw.folder;
  if ((LENGTHS as readonly number[]).includes(raw.lastLength)) s.lastLength = raw.lastLength;
  s.always = strList(raw.always);
  s.never = strList(raw.never);
  return s;
}

/** What a recording records. `key` tells targets apart (a window handle, or a monitor). */
interface Target {
  key: string;
  kind: 'window' | 'screen';
  handle: string;
  name: string;
  title: string;
  exe: string;
  /** The display it is on (physical pixels), for placing the picker. */
  monitor: { x: number; y: number; w: number; h: number } | null;
  /** A game recorded through its screen because its window gave no frames: that game's window. */
  fallback?: string;
}

interface Rec {
  id: string;
  target: Target;
  info: Recording;
  /** When its game was last in front. */
  lastFront: number;
  /** Seconds in a row the game was in front, fullscreen, and gave no frames. */
  zeroFps: number;
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

const lengthLabel = (s: number) => (s < 60 ? `${s} seconds` : s === 60 ? '1 minute' : `${s / 60} minutes`);

interface ClipMeta { game: string; duration: number; width: number; height: number }

class Onyx {
  private settings: Settings;
  private settingsFile: string;
  private clipsFile: string;
  private firstRun: boolean;
  private helper: Helper;
  private running = false;
  private main: BrowserWindow | null = null;
  private overlay: BrowserWindow | null = null;
  private overlayReady = false;
  private overlayQueue: OverlayMessage | null = null;
  private overlayTimer: NodeJS.Timeout | null = null;
  private tray: Tray | null = null;
  private recs = new Map<string, Rec>();
  private seq = 0;
  private status: 'waiting' | 'error' = 'waiting';
  private message = '';
  private foreground: WindowInfo | null = null;
  private hotkey: string | null = null;
  private hotkeyOk = false;
  private picker: { length: number; game: number; ids: string[]; timer: NodeJS.Timeout } | null = null;
  private timers: NodeJS.Timeout[] = [];
  /** Starting a capture takes a moment: decisions queue up behind each other. */
  private chain: Promise<void> = Promise.resolve();
  private deciding = false;
  /** Targets that failed to record, and when (not retried for a while). */
  private failed = new Map<string, number>();
  private known = new Set<string>();
  private knownAt = 0;
  private pushQueued = false;
  private thumbs = new Map<string, string>();
  private icons = new Map<string, string | null>();
  private probed = new Set<string>();

  constructor(readonly host: Host) {
    fs.mkdirSync(host.dataDir, { recursive: true });
    this.settingsFile = path.join(host.dataDir, 'onyx.json');
    this.clipsFile = path.join(host.dataDir, 'clips.json');
    this.firstRun = !exists(this.settingsFile);
    this.settings = cleanSettings(readJson(this.settingsFile, null));
    if (host.standalone) this.settings.startup = false;
    this.helper = new Helper(path.join(host.appDir, 'OnyxHelper.exe'));
    this.helper.onStart = () => this.onHelperStart();
    this.helper.onExit = () => {
      this.recs.clear();
      if (this.running) this.setStatus('waiting', 'The recorder stopped unexpectedly; it is starting again.');
    };
    this.helper.onEvent = (name, data) => this.onHelperEvent(name, data);
  }

  // ---------- lifecycle ----------

  open(args: string[]) {
    const silent = args.some((a) => path.basename(String(a)).toLowerCase() === STARTUP_MARKER);
    this.start();
    if (!silent) this.showMain();
  }

  windows() { return [this.main, this.overlay].filter((w): w is BrowserWindow => !!w && !w.isDestroyed()); }

  private start() {
    if (this.running) return;
    this.running = true;
    this.status = 'waiting';
    this.message = '';
    // a save interrupted earlier leaves its packet file behind
    try { fs.rmSync(path.join(this.host.dataDir, 'tmp'), { recursive: true, force: true }); } catch { /* in use */ }
    this.helper.start();
    if (!this.helper.available) this.setStatus('error', 'OnyxHelper.exe is missing. Reinstall Onyx from Crystal Suite.');
    this.createOverlay();
    this.createTray();
    this.registerHotkey();
    if (this.firstRun) { this.save(); this.firstRun = false; }
    if (this.settings.startup) this.applyStartup(true);
    this.timers.push(setInterval(() => this.checkForUpdate(), 10 * 60000));
    // games that open behind other windows (or while one is already being recorded)
    this.timers.push(setInterval(() => { if (this.settings.mode === 'auto') this.decide(); }, SCAN_MS));
    screen.on('display-added', this.onDisplays);
    screen.on('display-removed', this.onDisplays);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.closePicker();
    if (this.hotkey) { try { globalShortcut.unregister(this.hotkey); } catch { /* gone */ } this.hotkey = null; }
    screen.removeListener('display-added', this.onDisplays);
    screen.removeListener('display-removed', this.onDisplays);
    this.helper.stop();
    this.recs.clear();
    for (const w of this.windows()) w.destroy();
    this.main = null;
    this.overlay = null;
    this.overlayReady = false;
    this.tray?.destroy();
    this.tray = null;
  }

  private onDisplays = () => this.push();

  private save() { writeJson(this.settingsFile, this.settings); }

  // ---------- state ----------

  private folder() { return this.settings.folder || path.join(app.getPath('videos'), 'Onyx'); }

  private displays(): DisplayInfo[] {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id), label: d.label || `Display ${i + 1}`, primary: d.id === primary,
      width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor),
    }));
  }

  /** The recording whose game was in front last (the one the picker starts on). */
  private frontRec(): Rec | null {
    let best: Rec | null = null;
    for (const r of this.recs.values()) if (r.info.phase === 'recording' && (!best || r.lastFront > best.lastFront)) best = r;
    return best;
  }

  private recordings(): Recording[] {
    const front = this.frontRec();
    return [...this.recs.values()].map((r) => ({ ...r.info, front: r === front }));
  }

  private state(): State {
    const recs = this.recordings();
    return {
      version: this.host.version, settings: this.settings, recordings: recs,
      status: !this.settings.enabled ? 'off' : recs.length ? 'recording' : this.status, message: this.message,
      hotkeyOk: this.hotkeyOk, folder: this.folder(), displays: this.displays(), standalone: this.host.standalone, helper: this.helper.available,
    };
  }

  private push() {
    if (this.pushQueued) return;
    this.pushQueued = true;
    setImmediate(() => {
      this.pushQueued = false;
      if (this.main && !this.main.isDestroyed()) this.main.webContents.send('onyx:state', this.state());
      this.updateTray();
    });
  }

  private setStatus(status: 'waiting' | 'error', message = '') {
    this.status = status;
    this.message = message;
    this.push();
  }

  // ---------- the helper ----------

  private async onHelperStart() {
    this.recs.clear();
    const s = this.settings;
    await this.helper.call('audio', s.systemAudio ? 1 : 0, s.mic ? 1 : 0);
    const r = await this.helper.call('foreground');
    if (r.ok) { try { this.foreground = JSON.parse(r.value) as WindowInfo; } catch { /* none */ } }
    if (this.message.startsWith('The recorder stopped')) this.setStatus('waiting');
    this.decide();
  }

  private async windowList(): Promise<WindowInfo[]> {
    const r = await this.helper.call('windows');
    if (!r.ok) return [];
    try { return JSON.parse(r.value) as WindowInfo[]; } catch { return []; }
  }

  private onHelperEvent(name: string, data: string) {
    if (name === 'foreground') {
      let fg: WindowInfo;
      try { fg = JSON.parse(data) as WindowInfo; } catch { return; }
      this.foreground = fg;
      const r = this.recOfWindow(fg.hwnd);
      if (r) { r.lastFront = Date.now(); this.push(); }
      this.decide();
      return;
    }
    // the rest are about one recording: "<id>\t<data>"
    const tab = data.indexOf('\t');
    const id = tab >= 0 ? data.slice(0, tab) : data, rest = tab >= 0 ? data.slice(tab + 1) : '';
    const rec = this.recs.get(id);
    if (!rec) return;
    if (name === 'status') {
      let s: any;
      try { s = JSON.parse(rest); } catch { return; }
      if (rec.info.phase !== 'recording') return;
      rec.info.live = { fps: s.fps || 0, buffered: s.buffered || 0, bytes: s.bytes || 0, dropped: s.dropped || 0 };
      rec.info.message = String(s.audioProblem || '');
      this.checkFrames(rec);
      this.push();
    } else if (name === 'stopped') {
      this.recs.delete(id);
      const closed = rest === 'closed';
      if (!closed) { this.failed.set(rec.target.key, Date.now()); this.setStatus('error', `Recording ${rec.target.name} stopped: ${rest}`); }
      this.push();
      // the same window may come back, or another game be waiting
      setTimeout(() => this.decide(), closed ? 300 : 3000);
    } else if (name === 'error') {
      rec.info.message = rest;
      this.push();
    }
  }

  private recOfWindow(hwnd: string): Rec | null {
    for (const r of this.recs.values()) if (r.target.handle === hwnd || r.target.fallback === hwnd) return r;
    return null;
  }

  /**
   * A game in exclusive fullscreen can hide its window from capture (no frames arrive): record its
   * screen instead, for as long as that game runs.
   */
  private checkFrames(rec: Rec) {
    const fg = this.foreground, t = rec.target;
    const stuck = t.kind === 'window' && rec.info.live.fps === 0 && !!fg && fg.hwnd === t.handle && fg.fullscreen && !fg.minimized;
    rec.zeroFps = stuck ? rec.zeroFps + 1 : 0;
    if (stuck && rec.zeroFps >= 4 && fg) {
      rec.zeroFps = 0;
      this.enqueue(() => this.record({ key: `screen:${fg.monitor}:${fg.hwnd}`, kind: 'screen', handle: fg.monitor, name: t.name, title: t.title, exe: t.exe, monitor: monitorOf(fg), fallback: fg.hwnd }, rec.id));
    }
  }

  // ---------- choosing what to record ----------

  private enqueue(job: () => Promise<void>) {
    this.chain = this.chain.then(job).catch((e) => console.warn('Onyx:', e));
  }

  /** Works out what should be recorded now and starts or stops recordings to match. */
  private decide() {
    if (this.deciding) return; // one already queued looks at the latest state
    this.deciding = true;
    this.enqueue(async () => {
      this.deciding = false;
      if (!this.running || !this.helper.ready) return;
      if (!this.settings.enabled) {
        for (const r of [...this.recs.values()]) await this.stopRec(r);
        this.push();
        return;
      }
      const want = await this.wanted();
      // recordings no longer wanted end; wanted ones not yet recorded start
      for (const r of [...this.recs.values()]) if (!want.some((t) => t.key === r.target.key)) await this.stopRec(r);
      for (const t of want) {
        if ([...this.recs.values()].some((r) => r.target.key === t.key)) continue;
        if (this.recs.size >= MAX_RECORDINGS) break;
        const failedAt = this.failed.get(t.key);
        if (failedAt && Date.now() - failedAt < 15000) continue;
        await this.record(t);
      }
      if (!this.recs.size && this.status !== 'error') this.setStatus('waiting');
    });
  }

  /** Everything that should be recorded now. */
  private async wanted(): Promise<Target[]> {
    const s = this.settings, fg = this.foreground;
    if (s.mode === 'screen') {
      const mon = await this.monitorFor(s.display);
      if (!mon) return [];
      return [{ key: `screen:${mon.handle}`, kind: 'screen', handle: mon.handle, name: 'Screen', title: '', exe: '', monitor: { x: mon.x, y: mon.y, w: mon.w, h: mon.h } }];
    }
    const current = [...this.recs.values()].map((r) => r.target);
    if (s.mode === 'window') {
      const chosen = s.window;
      if (!chosen) return [];
      const matches = (w: WindowInfo) => w.pid !== process.pid && exeName(w.exe) === exeName(chosen.exe);
      // the chosen window keeps recording while it is open (a screen in its place too)
      const cur = current.find((t) => exeName(t.exe) === exeName(chosen.exe) && (!chosen.hwnd || t.handle === chosen.hwnd || t.fallback === chosen.hwnd));
      if (cur) return [cur];
      if (fg && matches(fg) && (!chosen.hwnd || fg.hwnd === chosen.hwnd)) return [windowTarget(fg)];
      const list = (await this.windowList()).filter(matches);
      const pick = list.find((w) => w.hwnd === chosen.hwnd) ?? list[0];
      return pick ? [windowTarget(pick)] : [];
    }
    // every game: the ones being recorded carry on until their window closes (even minimized, which hides
    // them from the window list), unless you said they aren't games; new ones join
    await this.refreshKnown();
    const rules = { ...this.settings, known: this.known };
    const out = current.filter((t) => !s.never.includes(exeName(t.exe)));
    const covered = new Set(out.flatMap((t) => [t.handle, t.fallback ?? '']));
    const candidates: WindowInfo[] = [];
    if (fg && fg.pid !== process.pid && isGame(fg, rules)) candidates.push(fg);
    for (const w of await this.windowList()) if (w.pid !== process.pid && isGame(w, rules) && !candidates.some((c) => c.hwnd === w.hwnd)) candidates.push(w);
    for (const w of candidates) {
      if (covered.has(w.hwnd)) continue;
      covered.add(w.hwnd);
      out.push(windowTarget(w));
    }
    return out;
  }

  /** Windows' own list of games, read again at most once a minute (new games join it when they first run). */
  private async refreshKnown() {
    if (Date.now() - this.knownAt < 60000) return;
    this.knownAt = Date.now();
    this.known = await windowsGames();
  }

  private async monitorFor(displayId: string | null) {
    const r = await this.helper.call('monitors');
    if (!r.ok) return null;
    let mons: { handle: string; x: number; y: number; w: number; h: number; primary: boolean }[];
    try { mons = JSON.parse(r.value); } catch { return null; }
    const d = screen.getAllDisplays().find((x) => String(x.id) === displayId);
    if (d) {
      const p = screen.dipToScreenRect(null, d.bounds);
      const m = mons.find((x) => Math.abs(x.x - p.x) < 4 && Math.abs(x.y - p.y) < 4);
      if (m) return m;
    }
    return mons.find((x) => x.primary) ?? mons[0] ?? null;
  }

  /** Starts recording `t` (as recording `reuse`, replacing it, or as a new one). */
  private async record(t: Target, reuse?: string) {
    if (!this.running) return;
    const s = this.settings;
    const id = reuse ?? `r${++this.seq}`;
    const prev = this.recs.get(id);
    const rec: Rec = {
      id, target: t, lastFront: prev?.lastFront ?? (this.foreground && (this.foreground.hwnd === t.handle || this.foreground.hwnd === t.fallback) ? Date.now() : 0), zeroFps: 0,
      info: {
        id, phase: 'starting', name: t.name, title: t.title, exe: t.exe, kind: t.kind, front: false, width: 0, height: 0, fps: s.fps, kbps: 0,
        encoder: '', hardware: false, gpu: '', live: { fps: 0, buffered: 0, bytes: 0, dropped: 0 }, message: '', saving: false,
      },
    };
    this.recs.set(id, rec);
    this.push();
    const r = await this.helper.call('start', id, t.kind === 'screen' ? 'monitor' : 'window', t.handle, s.fps, s.resolution, s.quality, BUFFER_SECONDS, t.fallback ?? '');
    if (!this.running || this.recs.get(id) !== rec) return;
    if (!r.ok) {
      this.recs.delete(id);
      this.failed.set(t.key, Date.now());
      this.setStatus('error', `${t.name}: ${r.value || 'recording could not start.'}`);
      return;
    }
    let d: any = {};
    try { d = JSON.parse(r.value); } catch { /* defaults */ }
    this.failed.delete(t.key);
    Object.assign(rec.info, {
      phase: 'recording', width: d.width || 0, height: d.height || 0, fps: d.fps || s.fps, kbps: d.kbps || 0,
      encoder: String(d.encoder || ''), hardware: !!d.hardware, gpu: String(d.gpu || ''), message: String(d.audioProblem || ''),
    });
    if (this.status === 'error') this.setStatus('waiting');
    this.push();
  }

  private async stopRec(r: Rec) {
    this.recs.delete(r.id);
    this.push();
    await this.helper.call('stop', r.id);
  }

  /** Settings that change how video is made start every buffer over. */
  private restartAll() {
    for (const r of [...this.recs.values()]) this.enqueue(() => this.record(r.target, r.id));
  }

  // ---------- saving ----------

  private ready() { return [...this.recs.values()].filter((r) => r.info.phase === 'recording'); }

  private onHotkey() {
    const p = this.picker;
    if (p) {
      p.length = (p.length + 1) % LENGTHS.length;
      this.armPicker();
      return;
    }
    const ready = this.ready();
    if (!ready.length) { this.explainNotRecording(); return; }
    if (ready.some((r) => r.info.saving)) { this.toast('info', 'Still saving the last clip…', '', 1800); return; }
    const front = this.frontRec();
    const ids = ready.map((r) => r.id);
    const i = LENGTHS.indexOf(this.settings.lastLength as (typeof LENGTHS)[number]);
    this.picker = { length: i >= 0 ? i : 1, game: Math.max(0, ids.indexOf(front?.id ?? '')), ids, timer: setTimeout(() => {}, 0) };
    const reg = (accel: string, fn: () => void) => { try { globalShortcut.register(accel, fn); } catch { /* taken */ } };
    for (const [k, idx] of [['1', 0], ['2', 1], ['3', 2], ['4', 3], ['num1', 0], ['num2', 1], ['num3', 2], ['num4', 3]] as const) reg(k, () => this.commitPicker(idx));
    reg('Enter', () => this.commitPicker());
    reg('Escape', () => { this.closePicker(); this.showOverlay({ kind: 'hide' }); });
    // several games: Tab and the arrow keys choose which one
    if (ids.length > 1) {
      reg('Tab', () => this.pickGame(1));
      reg('Right', () => this.pickGame(1));
      reg('Shift+Tab', () => this.pickGame(-1));
      reg('Left', () => this.pickGame(-1));
    }
    this.armPicker();
  }

  private pickGame(step: number) {
    const p = this.picker;
    if (!p) return;
    p.game = (p.game + step + p.ids.length) % p.ids.length;
    this.armPicker();
  }

  /** (Re)starts the picker's countdown and shows it. */
  private armPicker() {
    const p = this.picker;
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.commitPicker(), PICKER_MS);
    const games = p.ids.map((id) => this.recs.get(id)).filter((r): r is Rec => !!r);
    // two windows of one game: their titles tell them apart
    const dup = (r: Rec) => games.filter((g) => g.info.name === r.info.name).length > 1;
    this.showOverlay({
      kind: 'picker', lengths: [...LENGTHS], index: p.length, ms: PICKER_MS, hotkey: this.settings.hotkey,
      games: games.map((r) => ({ name: r.info.name, sub: dup(r) ? r.info.title : '', buffered: r.info.live.buffered })), game: Math.min(p.game, games.length - 1),
    });
  }

  private commitPicker(index?: number) {
    const p = this.picker;
    if (!p) return;
    const seconds = LENGTHS[index ?? p.length];
    const id = p.ids[p.game];
    this.closePicker();
    if (this.settings.lastLength !== seconds) { this.settings.lastLength = seconds; this.save(); }
    this.saveClip(id, seconds);
  }

  private closePicker() {
    if (!this.picker) return;
    clearTimeout(this.picker.timer);
    this.picker = null;
    for (const k of PICKER_KEYS) { try { globalShortcut.unregister(k); } catch { /* not ours */ } }
  }

  private explainNotRecording() {
    const s = this.settings;
    if (!s.enabled) this.toast('info', 'Instant replay is off', 'Turn it on in Onyx to save clips.', 2600);
    else if (this.recs.size) this.toast('info', 'Getting ready…', 'Onyx is starting to record. Try again in a moment.', 2400);
    else if (this.status === 'error') this.toast('error', 'Not recording', this.message || 'Recording could not start.', 3200);
    else if (s.mode === 'auto') this.toast('info', 'No game found yet', 'Onyx starts recording when a game opens. Open Onyx to pick a window.', 3200);
    else this.toast('info', 'Not recording', s.mode === 'window' ? `${s.window?.name || 'The chosen window'} isn't open.` : 'The screen isn\'t being recorded.', 3000);
  }

  async saveClip(id: string | undefined, seconds: number): Promise<{ ok: boolean; path?: string; error?: string }> {
    const rec = (id && this.recs.get(id)) || this.frontRec();
    if (!rec || rec.info.phase !== 'recording') { this.explainNotRecording(); return { ok: false, error: 'Not recording' }; }
    if (rec.info.saving) return { ok: false, error: 'Already saving' };
    const target = rec.target;
    rec.info.saving = true;
    this.push();
    const tmpDir = path.join(this.host.dataDir, 'tmp');
    const dump = path.join(tmpDir, `${Date.now()}.clip`);
    this.toast('info', 'Saving…', target.name, 60000, false, target.monitor);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const folder = this.folder();
      fs.mkdirSync(folder, { recursive: true });
      const base = `${fileSafe(target.name)} ${stamp(new Date())}`;
      let file = path.join(folder, `${base}.mp4`);
      for (let n = 2; exists(file); n++) file = path.join(folder, `${base} (${n}).mp4`);
      const r = await this.helper.call('save', rec.id, seconds, dump);
      if (!r.ok) throw new Error(r.value || 'The clip could not be saved.');
      const counts = JSON.parse(r.value) as { duration: number; videoPackets: number; audioPackets: number };
      const m = await muxDump(dump, file, counts);
      const meta = readJson<Record<string, ClipMeta>>(this.clipsFile, {});
      meta[file] = { game: target.name, duration: Math.round(m.duration * 100) / 100, width: m.width, height: m.height };
      writeJson(this.clipsFile, meta);
      const got = Math.round(m.duration);
      const short = got + 1 < seconds;
      this.toast('ok', `Saved ${short ? `${got} seconds` : lengthLabel(seconds)}`, short ? `${target.name} · only ${got} s recorded so far` : target.name, 5000, this.settings.sound, target.monitor,
        { label: 'Show in folder', run: () => shell.showItemInFolder(file) });
      this.main?.webContents.send('onyx:clips-changed');
      return { ok: true, path: file };
    } catch (e) {
      const msg = (e as Error).message || String(e);
      this.toast('error', 'Couldn\'t save the clip', msg, 4000, false, target.monitor);
      return { ok: false, error: msg };
    } finally {
      fs.rm(dump, { force: true }, () => {});
      rec.info.saving = false;
      this.push();
    }
  }

  // ---------- overlay (picker and notices) ----------

  private createOverlay() {
    if (this.overlay && !this.overlay.isDestroyed()) return;
    const win = new BrowserWindow({
      width: OVERLAY_W, height: OVERLAY_H, show: false, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      hasShadow: false, title: 'Onyx',
      webPreferences: { preload: path.join(this.host.appDir, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false, spellcheck: false },
    });
    this.overlay = win;
    this.overlayReady = false;
    win.setAlwaysOnTop(true, 'screen-saver');
    // clicks go through to the game; the page still sees the mouse move, and takes clicks only while the pointer
    // is over a notice with a button (it says so through onyx:overlay-hover)
    win.setIgnoreMouseEvents(true, { forward: true });
    // left out of screen recordings (Onyx's own included)
    win.setContentProtection(true);
    win.loadFile(path.join(this.host.appDir, 'web', 'overlay.html'));
    win.webContents.once('did-finish-load', () => {
      this.overlayReady = true;
      if (this.overlayQueue) { const m = this.overlayQueue; this.overlayQueue = null; this.showOverlay(m); }
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.ipc.on('onyx:overlay-hover', (_e, on: boolean) => this.overlayHover(!!on));
    win.webContents.ipc.handle('onyx:overlay-action', () => {
      const run = this.toastAction;
      this.toastAction = null;
      this.showOverlay({ kind: 'hide' });
      run?.();
    });
    win.on('closed', () => { if (this.overlay === win) { this.overlay = null; this.overlayReady = false; } });
  }

  /** What the button on the notice showing does (Show in folder, after a save). */
  private toastAction: (() => void) | null = null;
  private overlayHovered = false;

  /** The pointer is over the notice's button (it takes the click) or has left it (clicks go to the game again). */
  private overlayHover(on: boolean) {
    const win = this.overlay;
    if (!win || win.isDestroyed()) return;
    on = on && !!this.toastAction;
    if (on === this.overlayHovered) return;
    this.overlayHovered = on;
    win.setIgnoreMouseEvents(!on, { forward: true });
    // the notice stays while the pointer is on it, and goes a moment after it leaves
    if (this.overlayTimer) { clearTimeout(this.overlayTimer); this.overlayTimer = null; }
    if (!on && this.toastAction) this.overlayTimer = setTimeout(() => this.showOverlay({ kind: 'hide' }), 1500);
  }

  private toast(tone: 'ok' | 'info' | 'error', title: string, sub: string, ms: number, chime = false, monitor?: Target['monitor'], action?: { label: string; run: () => void }) {
    this.toastAction = action?.run ?? null;
    this.showOverlay({ kind: 'toast', tone, title, sub, ms, chime, action: action?.label }, monitor);
  }

  private showOverlay(m: OverlayMessage, monitor?: Target['monitor']) {
    if (!this.running) return;
    this.createOverlay();
    const win = this.overlay!;
    if (!this.overlayReady) { this.overlayQueue = m; return; }
    if (this.overlayTimer) { clearTimeout(this.overlayTimer); this.overlayTimer = null; }
    // anything but a notice with a button: clicks go through again
    if (m.kind !== 'toast' || !m.action) {
      if (m.kind !== 'toast') this.toastAction = null;
      if (this.overlayHovered) { this.overlayHovered = false; win.setIgnoreMouseEvents(true, { forward: true }); }
    }
    win.webContents.send('onyx:overlay', m);
    if (m.kind === 'hide') { this.overlayTimer = setTimeout(() => { if (!this.picker) win.hide(); }, 250); return; }
    // top middle of the screen with the game in front (or the one with the mouse)
    const fg = this.foreground && this.recOfWindow(this.foreground.hwnd) ? monitorOf(this.foreground) : null;
    const mon = monitor ?? fg ?? this.frontRec()?.target.monitor ?? null;
    const display = mon ? screen.getDisplayMatching(screen.screenToDipRect(null, { x: mon.x, y: mon.y, width: mon.w, height: mon.h }))
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const b = display.bounds;
    win.setBounds({ x: Math.round(b.x + (b.width - OVERLAY_W) / 2), y: b.y + 18, width: OVERLAY_W, height: OVERLAY_H });
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    if (m.kind === 'toast' && !this.overlayHovered) this.overlayTimer = setTimeout(() => this.showOverlay({ kind: 'hide' }), m.ms);
  }

  // ---------- hotkey ----------

  private registerHotkey(): boolean {
    if (this.hotkey) { try { globalShortcut.unregister(this.hotkey); } catch { /* gone */ } this.hotkey = null; }
    let ok = false;
    try { ok = globalShortcut.register(this.settings.hotkey, () => this.onHotkey()); } catch { ok = false; }
    if (ok) this.hotkey = this.settings.hotkey;
    this.hotkeyOk = ok;
    this.push();
    return ok;
  }

  /** Tries a new hotkey; keeps the old one if the new one is taken by another program. */
  private setHotkey(accel: string): { ok: boolean; error?: string } {
    const old = this.settings.hotkey;
    if (!/^((Ctrl|Alt|Shift|Super)\+)*[A-Za-z0-9]+$|^((Ctrl|Alt|Shift|Super)\+)*(F\d{1,2}|Home|End|PageUp|PageDown|Insert|Delete|Space|Tab|Backspace|Up|Down|Left|Right|Plus|Minus|num\d|PrintScreen|Pause|`|[[\];',./\\=-])$/.test(accel)) {
      return { ok: false, error: 'That key can\'t be used.' };
    }
    this.settings.hotkey = accel;
    if (this.registerHotkey()) { this.save(); return { ok: true }; }
    this.settings.hotkey = old;
    this.registerHotkey();
    return { ok: false, error: `${accel} is already used by another program.` };
  }

  // ---------- settings ----------

  private setSettings(patch: Partial<Settings>) {
    const before = this.settings;
    const next = cleanSettings({ ...before, ...patch });
    if (this.host.standalone) next.startup = false;
    next.hotkey = before.hotkey; // through setHotkey only
    this.settings = next;
    this.save();
    if (next.startup !== before.startup) this.applyStartup(next.startup);
    if (next.systemAudio !== before.systemAudio || next.mic !== before.mic) this.helper.call('audio', next.systemAudio ? 1 : 0, next.mic ? 1 : 0);
    const video = (['fps', 'resolution', 'quality'] as const).some((k) => next[k] !== before[k]);
    const source = next.enabled !== before.enabled || next.mode !== before.mode || next.display !== before.display
      || next.window?.exe !== before.window?.exe || next.window?.hwnd !== before.window?.hwnd || next.always.join() !== before.always.join() || next.never.join() !== before.never.join();
    if (source) {
      // a different choice of what to record: let the decision start from scratch
      this.failed.clear();
      if (this.status === 'error') this.setStatus('waiting');
      if (next.mode !== before.mode || next.window?.hwnd !== before.window?.hwnd || next.display !== before.display) {
        this.enqueue(async () => { for (const r of [...this.recs.values()]) await this.stopRec(r); });
      }
      this.decide();
    } else if (video) this.restartAll();
    this.push();
    return this.state();
  }

  private async pickWindow(hwnd: string) {
    const list = await this.windowList();
    const w = list.find((x) => x.hwnd === hwnd);
    if (!w) return this.state();
    // this very window (not just any window of the program)
    return this.setSettings({ mode: 'window', window: { exe: w.exe, title: w.title, name: gameName(w), hwnd: w.hwnd } });
  }

  private async windowChoices(): Promise<WindowChoice[]> {
    await this.refreshKnown();
    const rules = { ...this.settings, known: this.known };
    // not Onyx's (or the launcher's) own windows
    const list = (await this.windowList()).filter((w) => w.pid !== process.pid);
    return Promise.all(list.map(async (w) => ({
      hwnd: w.hwnd, exe: w.exe, title: w.title, name: gameName(w), game: isGame(w, rules), icon: await this.iconFor(w.exe),
    })));
  }

  private async iconFor(exe: string): Promise<string | null> {
    if (!exe) return null;
    if (this.icons.has(exe)) return this.icons.get(exe)!;
    let url: string | null = null;
    try { const img = await app.getFileIcon(exe, { size: 'normal' }); url = img.isEmpty() ? null : img.toDataURL(); } catch { url = null; }
    this.icons.set(exe, url);
    return url;
  }

  // ---------- clips ----------

  private async clips(): Promise<Clip[]> {
    const folder = this.folder();
    const meta = readJson<Record<string, ClipMeta>>(this.clipsFile, {});
    let names: string[] = [];
    try { names = fs.readdirSync(folder).filter((n) => /\.mp4$/i.test(n)); } catch { return []; }
    const out: Clip[] = [];
    for (const n of names) {
      const p = path.join(folder, n);
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      const m = meta[p];
      const game = m?.game || n.replace(/\.mp4$/i, '').replace(/\s+\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}( \(\d+\))?$/, '');
      out.push({ path: p, name: n, game, size: st.size, mtime: st.mtimeMs, duration: m?.duration, width: m?.width, height: m?.height });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    // videos Onyx knows nothing about (copied in, or its records were cleared): read their length once
    const unknown = out.filter((c) => c.duration === undefined && !this.probed.has(c.path)).slice(0, 40);
    if (unknown.length) {
      for (const c of unknown) {
        this.probed.add(c.path);
        const info = await probeClip(c.path);
        if (!info) continue;
        Object.assign(c, info);
        meta[c.path] = { game: c.game, ...info };
      }
      try { writeJson(this.clipsFile, meta); } catch { /* next time */ }
    }
    return out.slice(0, 500);
  }

  /** A still from the clip, made by Windows' own video thumbnailer. */
  private async thumb(p: string): Promise<string | null> {
    let key: string;
    try { key = `${p}|${fs.statSync(p).mtimeMs}`; } catch { return null; }
    const hit = this.thumbs.get(key);
    if (hit) return hit;
    try {
      const img = await nativeImage.createThumbnailFromPath(p, { width: 480, height: 270 });
      if (img.isEmpty()) return null;
      const url = 'data:image/jpeg;base64,' + img.toJPEG(82).toString('base64');
      this.thumbs.set(key, url);
      return url;
    } catch { return null; }
  }

  private inFolder(p: string) {
    const rel = path.relative(this.folder(), String(p));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && /\.mp4$/i.test(p);
  }

  // ---------- windows ----------

  showMain() {
    if (this.main && !this.main.isDestroyed()) {
      if (this.main.isMinimized()) this.main.restore();
      this.main.show();
      this.main.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 1180, height: 780, minWidth: 900, minHeight: 600, show: false, title: 'Onyx',
      backgroundColor: '#0c0e0b', autoHideMenuBar: true,
      ...(this.host.icon ? { icon: this.host.icon } : {}),
      webPreferences: { preload: path.join(this.host.appDir, 'preload.cjs'), sandbox: true, contextIsolation: true, spellcheck: false },
    });
    this.main = win;
    this.host.decorateWindow?.(win);
    win.removeMenu();
    this.wire(win.webContents, win);
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(this.host.appDir, 'web', 'index.html'));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
    });
    win.on('closed', () => {
      if (this.main === win) this.main = null;
      // a hotkey being changed when the window closed
      if (this.running && !this.hotkey) this.registerHotkey();
      setTimeout(() => this.checkForUpdate(), 3000);
    });
  }

  private wire(wc: WebContents, win: BrowserWindow) {
    const on = (channel: string, fn: (...args: any[]) => unknown) => wc.ipc.handle(channel, (_e, ...args) => fn(...args));
    on('onyx:init', () => this.state());
    on('onyx:settings', (patch: Partial<Settings>) => this.setSettings(patch && typeof patch === 'object' ? patch : {}));
    on('onyx:save', (id: string, seconds: number) => ((LENGTHS as readonly number[]).includes(seconds) ? this.saveClip(String(id), seconds) : { ok: false }));
    on('onyx:clips', () => this.clips());
    on('onyx:thumb', (p: string) => (this.inFolder(p) ? this.thumb(String(p)) : null));
    on('onyx:windows', () => this.windowChoices());
    on('onyx:pick-window', (hwnd: string) => this.pickWindow(String(hwnd)));
    on('onyx:rule', (exe: string, kind: 'always' | 'never' | 'none') => {
      const name = exeName(String(exe));
      if (!name) return this.state();
      const always = this.settings.always.filter((x) => x !== name), never = this.settings.never.filter((x) => x !== name);
      if (kind === 'always') always.push(name);
      if (kind === 'never') never.push(name);
      return this.setSettings({ always, never });
    });
    on('onyx:hotkey-capture', (capturing: boolean) => {
      // while a new key is being chosen, the current one has to reach the window
      if (capturing && this.hotkey) { globalShortcut.unregister(this.hotkey); this.hotkey = null; }
      if (!capturing && !this.hotkey) this.registerHotkey();
    });
    on('onyx:set-hotkey', (accel: string) => this.setHotkey(String(accel)));
    on('onyx:folder-dialog', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Save clips to', defaultPath: this.folder(), properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return this.state();
      return this.setSettings({ folder: r.filePaths[0] });
    });
    on('onyx:open-folder', () => { fs.mkdirSync(this.folder(), { recursive: true }); return shell.openPath(this.folder()); });
    on('onyx:reveal', (p: string) => { if (this.inFolder(p)) shell.showItemInFolder(String(p)); });
    on('onyx:open', (p: string) => (this.inFolder(p) ? shell.openPath(String(p)) : ''));
    on('onyx:trash', async (p: string) => {
      if (!this.inFolder(p)) return false;
      try { await shell.trashItem(String(p)); } catch { return false; }
      const meta = readJson<Record<string, ClipMeta>>(this.clipsFile, {});
      if (meta[p]) { delete meta[p]; writeJson(this.clipsFile, meta); }
      return true;
    });
    on('onyx:quit', () => this.stop());
  }

  private createTray() {
    if (this.tray) return;
    if (this.host.ico && exists(this.host.ico)) this.tray = new Tray(this.host.ico);
    else {
      const img = this.host.icon ? nativeImage.createFromPath(this.host.icon) : nativeImage.createEmpty();
      this.tray = new Tray(img.isEmpty() ? img : img.resize({ width: 32, height: 32, quality: 'best' }));
    }
    this.tray.on('click', () => this.showMain());
    this.updateTray();
  }

  private trayKey = '';

  private updateTray() {
    if (!this.tray) return;
    const s = this.settings, ready = this.ready();
    const what = !s.enabled ? 'instant replay off' : ready.length === 1 ? `recording ${ready[0].info.name}`
      : ready.length > 1 ? `recording ${ready.length} games` : this.recs.size ? 'starting…' : 'waiting for a game';
    const key = JSON.stringify([what, s.enabled, ready.map((r) => [r.id, r.info.name, r.info.saving])]);
    if (key === this.trayKey) return;
    this.trayKey = key;
    this.tray.setToolTip(`Onyx — ${what}`);
    const saves = (r: Rec): MenuItemConstructorOptions[] => LENGTHS.map((n) => ({ label: `Save the last ${lengthLabel(n)}`, enabled: !r.info.saving, click: () => { this.saveClip(r.id, n); } }));
    const items: MenuItemConstructorOptions[] = ready.length === 1 ? saves(ready[0])
      : ready.length > 1 ? ready.map((r) => ({ label: r.info.name, submenu: saves(r) }))
      : LENGTHS.map((n) => ({ label: `Save the last ${lengthLabel(n)}`, enabled: false }));
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Onyx', click: () => this.showMain() },
      { type: 'separator' },
      ...items,
      { label: 'Open Clips Folder', click: () => { fs.mkdirSync(this.folder(), { recursive: true }); shell.openPath(this.folder()); } },
      { type: 'separator' },
      { label: 'Instant Replay', type: 'checkbox', checked: s.enabled, click: (m) => this.setSettings({ enabled: m.checked }) },
      { type: 'separator' },
      { label: 'Quit Onyx', click: () => this.stop() },
    ]));
  }

  // ---------- Windows integration ----------

  private startupTimer: NodeJS.Timeout | null = null;

  /** Start with Windows (or not). schtasks takes a moment, so this never runs on the startup path. */
  private applyStartup(on: boolean) {
    // CRYSTAL_NO_STARTUP: tests run Onyx in the launcher without touching the real Run key or tasks
    if (this.host.standalone || process.platform !== 'win32' || process.env.CRYSTAL_NO_STARTUP) return;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => { this.startupTimer = null; this.writeStartup(on); }, on ? 5000 : 0);
  }

  private async writeStartup(on: boolean) {
    try {
      const cmd = this.host.launchCommand();
      const marker = path.join(this.host.dataDir, STARTUP_MARKER);
      if (on) fs.writeFileSync(marker, 'Windows starts Onyx with this file (it runs in the tray without a window).\n');
      const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
      const args = [...cmd.args, marker].map(quote);
      const task = on ? await registerTask(TASK_NAME, cmd.exe, args.join(' '), this.host.dataDir) : (await deleteTask(TASK_NAME), false);
      // the Run entry is only the fallback: exactly one of the two starts Onyx
      app.setLoginItemSettings({ openAtLogin: on && !task, path: cmd.exe, args, name: RUN_NAME } as Electron.Settings);
    } catch (e) { console.warn('Onyx: start with Windows', e); }
  }

  /**
   * The launcher installs updates next to the running version and only switches once the app has no
   * windows - but Onyx keeps running in the tray. When a newer version is installed, the Onyx window is
   * closed and no game is being recorded, ask the launcher to start Onyx again: it unloads this version and
   * loads the new one, silently, as at Windows start.
   */
  private checkForUpdate() {
    if (this.host.standalone || !this.running || (this.main && !this.main.isDestroyed()) || this.recs.size) return;
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
      fs.writeFileSync(marker, 'Windows starts Onyx with this file (it runs in the tray without a window).\n');
      const cmd = this.host.launchCommand();
      // this version has to let go first: its windows close, then the launcher loads the new files
      this.stop();
      spawn(cmd.exe, [...cmd.args, marker], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) { console.warn('Onyx: switching to the new version', e); }
  }
}

function monitorOf(w: WindowInfo) {
  return w.mw > 0 ? { x: w.mx, y: w.my, w: w.mw, h: w.mh } : null;
}

function windowTarget(w: WindowInfo): Target {
  return { key: `window:${w.hwnd}`, kind: 'window', handle: w.hwnd, name: gameName(w), title: w.title, exe: w.exe, monitor: monitorOf(w) };
}

let current: Onyx | null = null;

export function activate(host: Host) {
  const onyx = new Onyx(host);
  current = onyx;
  return {
    open: (args: string[]) => onyx.open(args || []),
    windows: () => onyx.windows(),
    deactivate: () => { onyx.stop(); if (current === onyx) current = null; },
  };
}

/** Called by the launcher before Onyx's files are removed: undo what it set up in Windows. */
export async function uninstall() {
  current?.stop();
  try { app.setLoginItemSettings({ openAtLogin: false, name: RUN_NAME } as Electron.Settings); } catch { /* not set */ }
  try { spawnSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { timeout: 10000, windowsHide: true }); } catch { /* not there */ }
}
