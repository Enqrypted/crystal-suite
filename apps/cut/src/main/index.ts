// Cut's main-process module (bundled to main.cjs). It runs inside a host — the Crystal Suite launcher or
// Cut's standalone dev host — and owns the windows plus the narrow file bridge the editor needs:
// dialogs, ranged reads (media is streamed from disk, never loaded whole), positional writes for
// rendering, recent projects and crash recovery.
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, dialog, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';

export interface Host {
  appId: string;
  version: string;
  /** Folder with main.cjs, preload.cjs and web/. */
  appDir: string;
  /** Where Cut keeps recent projects, autosaves and settings. */
  dataDir: string;
  icon: string | null;
  ico: string | null;
  standalone: boolean;
  launchCommand(): { exe: string; args: string[] };
  decorateWindow?(win: BrowserWindow): void;
}

const MEDIA_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const PROJECT_EXT = 'cutproj';

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

class Cut {
  windows = new Set<BrowserWindow>();
  private readers = new Map<string, { fd: number; used: number }>(); // open files for streaming reads
  private writers = new Map<number, number>(); // handle -> fd
  private nextHandle = 1;
  private recentFile: string;
  private autosaveDir: string;

  constructor(readonly host: Host) {
    fs.mkdirSync(host.dataDir, { recursive: true });
    this.recentFile = path.join(host.dataDir, 'recent.json');
    this.autosaveDir = path.join(host.dataDir, 'autosave');
  }

  open(args: string[]) {
    const files = args.filter(isFile);
    const project = files.find((f) => f.toLowerCase().endsWith('.' + PROJECT_EXT));
    const media = files.filter((f) => MEDIA_EXT.includes(path.extname(f).slice(1).toLowerCase()));
    const target = [...this.windows][0];
    if (target && !project) {
      if (media.length) target.webContents.send('cut:open', { media });
      if (target.isMinimized()) target.restore();
      target.focus();
      return;
    }
    this.createWindow({ project, media });
  }

  private createWindow(initial: { project?: string; media: string[] }) {
    const win = new BrowserWindow({
      width: 1600, height: 960, minWidth: 1000, minHeight: 640, show: false,
      backgroundColor: '#17171a', title: 'Cut', autoHideMenuBar: true,
      ...(this.host.icon ? { icon: this.host.icon } : {}),
      webPreferences: {
        preload: path.join(this.host.appDir, 'preload.cjs'),
        sandbox: true, contextIsolation: true, spellcheck: false,
        backgroundThrottling: false, // keep rendering while minimised
      },
    });
    this.host.decorateWindow?.(win);
    win.removeMenu();
    win.once('ready-to-show', () => { win.maximize(); win.show(); });
    win.loadFile(path.join(this.host.appDir, 'web', 'index.html'));
    const wc = win.webContents;
    wc.once('did-finish-load', () => { if (initial.project || initial.media.length) wc.send('cut:open', initial); });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') { wc.toggleDevTools(); e.preventDefault(); }
    });
    // The editor cancels unload while there are unsaved changes; ask before closing.
    wc.on('will-prevent-unload', (e) => {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Close Without Saving', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        title: 'Cut', message: 'You have unsaved changes.', detail: 'If you close Cut now, your changes since the last save will be lost.',
      });
      if (choice === 0) e.preventDefault();
    });
    this.wire(win);
    this.windows.add(win);
    win.on('closed', () => {
      this.windows.delete(win);
      if (!this.windows.size) this.closeAllFiles();
    });
    return win;
  }

  private wire(win: BrowserWindow) {
    const ipc = win.webContents.ipc;
    const on = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => ipc.handle(channel, fn);
    const mediaFilter = { name: 'Media', extensions: MEDIA_EXT };
    on('cut:open-media', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Import Media', properties: ['openFile', 'multiSelections'], filters: [mediaFilter, { name: 'All files', extensions: ['*'] }] });
      return r.canceled ? [] : r.filePaths;
    });
    on('cut:open-project', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Open Project', properties: ['openFile'], filters: [{ name: 'Cut project', extensions: [PROJECT_EXT] }] });
      return r.canceled ? null : r.filePaths[0];
    });
    on('cut:save-project', async (_e, name: string) => {
      const r = await dialog.showSaveDialog(win, { title: 'Save Project', defaultPath: path.join(app.getPath('documents'), sanitize(name) + '.' + PROJECT_EXT), filters: [{ name: 'Cut project', extensions: [PROJECT_EXT] }] });
      return r.canceled || !r.filePath ? null : r.filePath;
    });
    on('cut:save-render', async (_e, defaultPath: string, ext: string) => {
      const filters = [ext === 'webm' ? { name: 'WebM video', extensions: ['webm'] } : { name: 'MP4 video', extensions: ['mp4'] }];
      const r = await dialog.showSaveDialog(win, { title: 'Render As', defaultPath, filters });
      return r.canceled || !r.filePath ? null : r.filePath;
    });
    on('cut:default-render-path', (_e, name: string, ext: string) => {
      let dir = app.getPath('videos');
      if (!fs.existsSync(dir)) dir = app.getPath('documents');
      return path.join(dir, `${sanitize(name)}.${ext}`);
    });
    on('cut:stat', (_e, p: string) => {
      try { const s = fs.statSync(p); return s.isFile() ? { size: s.size, mtime: s.mtimeMs } : null; } catch { return null; }
    });
    on('cut:read', (_e, p: string, start: number, end: number) => this.read(p, start, end));
    on('cut:read-text', (_e, p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } });
    on('cut:write-text', (_e, p: string, text: string) => {
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + '.tmp', text); fs.renameSync(p + '.tmp', p); return true; } catch { return false; }
    });
    on('cut:open-write', (_e, p: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const handle = this.nextHandle++;
      this.writers.set(handle, fs.openSync(p, 'w'));
      return handle;
    });
    on('cut:write-at', (_e, handle: number, data: Uint8Array, position: number) => {
      const fd = this.writers.get(handle);
      if (fd === undefined) throw new Error('File is not open');
      let off = 0;
      while (off < data.byteLength) off += fs.writeSync(fd, data, off, data.byteLength - off, position + off);
    });
    on('cut:close-write', (_e, handle: number, removePath?: string) => {
      const fd = this.writers.get(handle);
      if (fd !== undefined) { fs.closeSync(fd); this.writers.delete(handle); }
      if (removePath) fs.rmSync(removePath, { force: true });
    });
    on('cut:show-in-folder', (_e, p: string) => shell.showItemInFolder(p));
    on('cut:open-path', (_e, p: string) => shell.openPath(p));
    on('cut:recent', () => readJson<string[]>(this.recentFile, []).filter(isFile));
    on('cut:add-recent', (_e, p: string) => {
      const list = [p, ...readJson<string[]>(this.recentFile, []).filter((x) => x !== p)].slice(0, 12);
      writeJson(this.recentFile, list);
    });
    on('cut:autosave', (_e, text: string | null) => {
      const file = path.join(this.autosaveDir, `window-${win.id}.${PROJECT_EXT}`);
      if (text === null) fs.rmSync(file, { force: true });
      else { fs.mkdirSync(this.autosaveDir, { recursive: true }); fs.writeFileSync(file, text); }
    });
    on('cut:recovery', () => {
      // autosaves left behind by windows that are no longer open (Cut closed unexpectedly)
      let names: string[] = [];
      try { names = fs.readdirSync(this.autosaveDir); } catch { return null; }
      const open = new Set([...this.windows].map((w) => `window-${w.id}.${PROJECT_EXT}`));
      const orphan = names.filter((n) => !open.has(n)).map((n) => path.join(this.autosaveDir, n))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      if (!orphan) return null;
      const text = fs.readFileSync(orphan, 'utf8');
      for (const n of names) if (!open.has(n)) fs.rmSync(path.join(this.autosaveDir, n), { force: true });
      return text;
    });
    on('cut:set-title', (_e, title: string) => { win.setTitle(String(title).slice(0, 200)); });
    on('cut:about', () => ({ version: this.host.version, chrome: process.versions.chrome, electron: process.versions.electron }));
    on('cut:open-url', (_e, url: string) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
  }

  /** Bytes [start, end) of a file, keeping recently used files open between calls. */
  private read(p: string, start: number, end: number) {
    let r = this.readers.get(p);
    if (!r) {
      r = { fd: fs.openSync(p, 'r'), used: 0 };
      this.readers.set(p, r);
      if (this.readers.size > 24) { // close the least recently used
        const [oldPath, old] = [...this.readers.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        fs.closeSync(old.fd);
        this.readers.delete(oldPath);
      }
    }
    r.used = Date.now();
    const len = Math.max(0, end - start);
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(r.fd, buf, off, len - off, start + off);
      if (n === 0) break;
      off += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, off);
  }

  private closeAllFiles() {
    for (const r of this.readers.values()) { try { fs.closeSync(r.fd); } catch { /* ignore */ } }
    this.readers.clear();
    for (const fd of this.writers.values()) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    this.writers.clear();
  }

  deactivate() {
    for (const w of [...this.windows]) w.close();
    this.closeAllFiles();
  }
}

function sanitize(name: string) {
  return (name || 'Untitled').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'Untitled';
}

export function activate(host: Host) {
  const cut = new Cut(host);
  return {
    open: (args: string[] = []) => cut.open(args),
    windows: () => cut.windows.size,
    deactivate: () => cut.deactivate(),
  };
}

/** Accessor used by the standalone host for tests. */
export type CutApi = ReturnType<typeof activate>;
export type { WebContents };
