// Opal's main-process module (bundled to main.cjs). It runs inside a host — the Crystal Suite launcher or
// Opal's standalone dev host — and owns the windows plus a narrow file bridge for the viewer: reading photos,
// listing and watching their folder, thumbnails (Windows' own for common formats, a disk cache for the ones
// Opal decodes itself), the Recycle Bin, the clipboard, saving converted copies, and registering Opal as a
// photo viewer.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, clipboard, dialog, nativeImage, shell, type WebContents } from 'electron';
import { ensureListed, register as registerDefault, status as defaultStatus, unregister } from './defaultapp';

export interface Host {
  appId: string;
  version: string;
  /** Folder with main.cjs, preload.cjs and web/. */
  appDir: string;
  /** Where Opal keeps its settings, recent photos and thumbnail cache. */
  dataDir: string;
  icon: string | null;
  ico: string | null;
  standalone: boolean;
  launchCommand(): { exe: string; args: string[] };
  decorateWindow?(win: BrowserWindow): void;
}

/** Everything Opal shows. Chromium decodes all of these except HEIC/HEIF, which Opal decodes with libheif. */
export const IMAGE_EXTS = ['heic', 'heif', 'hif', 'avif', 'jpg', 'jpeg', 'jfif', 'jpe', 'png', 'apng', 'gif', 'webp', 'bmp', 'dib', 'ico', 'svg'];
const IMAGE_RE = new RegExp(`\\.(${IMAGE_EXTS.join('|')})$`, 'i');
/** Formats Windows makes thumbnails for on every PC (HEIC only with extra codecs, so Opal makes those). */
const SHELL_THUMB_RE = /\.(jpe?g|jfif|jpe|png|gif|bmp|dib)$/i;

const isImage = (p: string) => IMAGE_RE.test(p);
const statOf = (p: string) => { try { return fs.statSync(p); } catch { return null; } };
const isFile = (p: string) => !!statOf(p)?.isFile();
const isDir = (p: string) => !!statOf(p)?.isDirectory();

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const toBuffer = (d: Uint8Array) => Buffer.from(d.buffer, d.byteOffset, d.byteLength);

export interface PhotoEntry { path: string; name: string; size: number; mtime: number }
interface Recent { path: string; at: number }

/** Thumbnails Opal decoded itself (HEIC, WebP, AVIF...), as JPEG files named by path + size + date. */
class ThumbCache {
  constructor(private dir: string) {}
  private file(key: string) { return path.join(this.dir, crypto.createHash('sha1').update(key).digest('hex') + '.jpg'); }
  get(key: string) {
    try { return bytes(fs.readFileSync(this.file(key))); } catch { return null; }
  }
  put(key: string, data: Uint8Array) {
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file(key), toBuffer(data)); } catch { /* the cache is optional */ }
  }
  /** Keeps the cache to the most recently used few thousand thumbnails. */
  prune(max = 4000) {
    setTimeout(() => {
      try {
        const files = fs.readdirSync(this.dir).map((n) => { const p = path.join(this.dir, n); return { p, t: statOf(p)?.atimeMs ?? 0 }; });
        if (files.length <= max) return;
        files.sort((a, b) => a.t - b.t).slice(0, files.length - max).forEach((f) => fs.rmSync(f.p, { force: true }));
      } catch { /* no cache yet */ }
    }, 15000).unref?.();
  }
}

class Opal {
  windows = new Set<BrowserWindow>();
  private recentFile: string;
  private settingsFile: string;
  private thumbs: ThumbCache;

  constructor(readonly host: Host) {
    fs.mkdirSync(host.dataDir, { recursive: true });
    this.recentFile = path.join(host.dataDir, 'recent.json');
    this.settingsFile = path.join(host.dataDir, 'settings.json');
    this.thumbs = new ThumbCache(path.join(host.dataDir, 'thumbs'));
    this.thumbs.prune();
  }

  /** A photo to show from a command line: the first image, or the first image in a folder. */
  private target(args: string[]): string | null {
    for (const a of args) {
      if (isFile(a) && isImage(a)) return path.resolve(a);
      if (isDir(a)) { const first = listFolder(a)[0]; if (first) return first.path; }
    }
    return null;
  }

  open(args: string[]) {
    const file = this.target(args);
    const win = [...this.windows][0];
    if (win) {
      if (file) win.webContents.send('opal:open', file);
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
    this.createWindow(file);
  }

  private createWindow(file: string | null) {
    const win = new BrowserWindow({
      width: 1280, height: 860, minWidth: 640, minHeight: 440, show: false,
      backgroundColor: '#0f0f11', title: 'Opal', autoHideMenuBar: true,
      ...(this.host.icon ? { icon: this.host.icon } : {}),
      webPreferences: { preload: path.join(this.host.appDir, 'preload.cjs'), sandbox: true, contextIsolation: true, spellcheck: false },
    });
    this.host.decorateWindow?.(win);
    win.removeMenu();
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(this.host.appDir, 'web', 'index.html'));
    const wc = win.webContents;
    wc.once('did-finish-load', () => { if (file) wc.send('opal:open', file); });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') wc.toggleDevTools();
    });
    win.on('enter-full-screen', () => wc.send('opal:fullscreen', true));
    win.on('leave-full-screen', () => wc.send('opal:fullscreen', false));
    const watcher = new FolderWatcher((folder) => { if (!wc.isDestroyed()) wc.send('opal:folder-changed', folder); });
    this.wire(wc, win, watcher);
    this.windows.add(win);
    win.on('closed', () => { watcher.close(); this.windows.delete(win); });
  }

  private wire(wc: WebContents, win: BrowserWindow, watcher: FolderWatcher) {
    const on = (channel: string, fn: (...args: any[]) => unknown) => wc.ipc.handle(channel, (_e, ...args) => fn(...args));
    const imageFilter = [{ name: 'Photos', extensions: IMAGE_EXTS }, { name: 'All files', extensions: ['*'] }];
    on('opal:open-dialog', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Open Photo', filters: imageFilter, properties: ['openFile'] });
      return r.canceled ? null : r.filePaths[0];
    });
    on('opal:folder-dialog', async (title?: string, defaultPath?: string) => {
      const r = await dialog.showOpenDialog(win, { title: title || 'Choose a Folder', defaultPath: defaultPath || undefined, properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    });
    on('opal:save-dialog', async (defaultPath: string, ext: string) => {
      const names: Record<string, string> = { jpg: 'JPEG image', png: 'PNG image', webp: 'WebP image' };
      const r = await dialog.showSaveDialog(win, { title: 'Save a Copy', defaultPath, filters: [{ name: names[ext] || 'Image', extensions: [ext] }] });
      return r.canceled || !r.filePath ? null : r.filePath;
    });
    on('opal:read', async (p: string) => bytes(await fs.promises.readFile(String(p))));
    on('opal:stat', (p: string) => { const s = statOf(String(p)); return s && s.isFile() ? { size: s.size, mtime: s.mtimeMs, ctime: s.birthtimeMs } : null; });
    on('opal:list', (p: string) => {
      const file = String(p);
      const folder = isDir(file) ? file : path.dirname(file);
      watcher.watch(folder);
      return { folder, files: listFolder(folder) };
    });
    // writes go to a temporary file first, so a failed save never damages the original
    on('opal:write', async (p: string, data: Uint8Array) => {
      const file = String(p);
      const tmp = `${file}.opal-${process.pid}.tmp`;
      try {
        await fs.promises.writeFile(tmp, toBuffer(data));
        await fs.promises.rename(tmp, file);
        return '';
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        return (e as Error).message || 'The file could not be written.';
      }
    });
    on('opal:exists', (p: string) => fs.existsSync(String(p)));
    on('opal:trash', async (p: string) => {
      try { await shell.trashItem(String(p)); return ''; } catch (e) { return (e as Error).message || 'The file could not be moved to the Recycle Bin.'; }
    });
    // thumbnails: Windows' own (fast and cached by Windows) for the formats every PC has; Opal's disk cache for the rest
    on('opal:shell-thumb', async (p: string, size: number) => {
      const file = String(p);
      if (!SHELL_THUMB_RE.test(file)) return null;
      try {
        const img = await nativeImage.createThumbnailFromPath(file, { width: size, height: size });
        return img.isEmpty() ? null : bytes(img.toJPEG(86));
      } catch { return null; }
    });
    on('opal:thumb-get', (key: string) => this.thumbs.get(String(key)));
    on('opal:thumb-put', (key: string, data: Uint8Array) => this.thumbs.put(String(key), data));
    on('opal:asset', async (name: string) => {
      if (!/^[\w.-]+$/.test(String(name))) throw new Error('bad asset');
      return bytes(await fs.promises.readFile(path.join(this.host.appDir, 'web', 'libheif', String(name))));
    });
    on('opal:copy-image', (png: Uint8Array) => {
      const img = nativeImage.createFromBuffer(toBuffer(png));
      if (img.isEmpty()) return false;
      clipboard.writeImage(img);
      return true;
    });
    on('opal:show-in-folder', (p: string) => shell.showItemInFolder(String(p)));
    on('opal:open-url', (url: string) => { if (/^https?:/i.test(String(url))) shell.openExternal(String(url)); });
    // Edit in Photon: the launcher opens Photon (a second instance hands it over); the dev host can't
    on('opal:edit', (p: string) => {
      if (this.host.standalone) return false;
      const { exe, args } = this.host.launchCommand();
      const a = args.map((x) => (/^--open-app=/i.test(x) ? '--open-app=photon' : x));
      try { spawn(exe, [...a, String(p)], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); return true; } catch { return false; }
    });
    on('opal:recent', () => readJson<Recent[]>(this.recentFile, []).filter((r) => isFile(r.path)).slice(0, 12));
    on('opal:add-recent', (p: string) => {
      const file = String(p);
      const list = readJson<Recent[]>(this.recentFile, []).filter((r) => r.path.toLowerCase() !== file.toLowerCase() && path.dirname(r.path).toLowerCase() !== path.dirname(file).toLowerCase());
      list.unshift({ path: file, at: Date.now() });
      writeJson(this.recentFile, list.slice(0, 20));
      if (process.platform === 'win32') app.addRecentDocument(file);
    });
    on('opal:clear-recent', () => writeJson(this.recentFile, []));
    on('opal:settings', () => readJson<Record<string, unknown>>(this.settingsFile, {}));
    on('opal:set-settings', (s: Record<string, unknown>) => writeJson(this.settingsFile, s && typeof s === 'object' ? s : {}));
    on('opal:set-title', (t: string) => win.setTitle(String(t || 'Opal')));
    on('opal:set-fullscreen', (v: boolean) => win.setFullScreen(!!v));
    on('opal:is-fullscreen', () => win.isFullScreen());
    on('opal:default-status', () => defaultStatus());
    on('opal:make-default', () => registerDefault(this.host));
    on('opal:about', () => ({ version: this.host.version, electron: process.versions.electron, chrome: process.versions.chrome, standalone: this.host.standalone }));
  }
}

/** The photos in a folder, sorted later by the page. Hidden and system files are left out. */
function listFolder(folder: string): PhotoEntry[] {
  let names: fs.Dirent[] = [];
  try { names = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  const out: PhotoEntry[] = [];
  for (const d of names) {
    if (!d.isFile() || !isImage(d.name) || d.name.startsWith('.')) continue;
    const p = path.join(folder, d.name);
    const s = statOf(p);
    if (s) out.push({ path: p, name: d.name, size: s.size, mtime: s.mtimeMs });
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return out.sort((a, b) => coll.compare(a.name, b.name));
}

/** Tells the page when the open folder changes (photos added, renamed or deleted elsewhere). */
class FolderWatcher {
  private w: fs.FSWatcher | null = null;
  private folder = '';
  private timer: NodeJS.Timeout | null = null;
  constructor(private changed: (folder: string) => void) {}
  watch(folder: string) {
    if (folder === this.folder && this.w) return;
    this.close();
    this.folder = folder;
    try {
      this.w = fs.watch(folder, { persistent: false }, (_e, name) => {
        if (name && !isImage(String(name))) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.changed(folder), 400);
      });
      this.w.on('error', () => this.close());
    } catch { this.w = null; }
  }
  close() {
    this.w?.close();
    this.w = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

let current: Opal | null = null;

export function activate(host: Host) {
  const o = new Opal(host);
  current = o;
  ensureListed(host).catch(() => {});
  return {
    open: (args: string[]) => o.open(args || []),
    windows: () => [...o.windows],
    deactivate: () => { for (const w of o.windows) w.destroy(); if (current === o) current = null; },
  };
}

/** Called by the launcher before Opal's files are removed: take Opal out of Windows' photo app lists. */
export async function uninstall() {
  await unregister();
}
