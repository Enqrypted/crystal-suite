// Quartz's main-process module (bundled to main.cjs). It runs inside a host — the Crystal Suite launcher or
// Quartz's standalone dev host — and owns the windows plus a narrow file bridge for the reader/editor:
// open/save dialogs and whole-file reads and atomic writes, recent files, saved signatures, PDF.js's data
// files (character maps, standard fonts, decoders), printing, and registering Quartz as a PDF app.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, BrowserWindow, dialog, shell, type WebContents } from 'electron';
import { ensureListed, register as registerDefault, status as defaultStatus, unregister } from './defaultapp';

export interface Host {
  appId: string;
  version: string;
  /** Folder with main.cjs, preload.cjs and web/. */
  appDir: string;
  /** Where Quartz keeps recent files and saved signatures. */
  dataDir: string;
  icon: string | null;
  ico: string | null;
  standalone: boolean;
  launchCommand(): { exe: string; args: string[] };
  decorateWindow?(win: BrowserWindow): void;
}

const isPdf = (p: string) => /\.pdf$/i.test(p) && isFile(p);
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

interface Recent { path: string; name: string; at: number; pages?: number }

class Quartz {
  windows = new Set<BrowserWindow>();
  private recentFile: string;
  private signaturesFile: string;

  constructor(readonly host: Host) {
    fs.mkdirSync(host.dataDir, { recursive: true });
    this.recentFile = path.join(host.dataDir, 'recent.json');
    this.signaturesFile = path.join(host.dataDir, 'signatures.json');
  }

  open(args: string[]) {
    const files = args.filter(isPdf);
    const target = [...this.windows][0];
    if (target) {
      if (files.length) target.webContents.send('quartz:open', files);
      if (target.isMinimized()) target.restore();
      target.focus();
      return;
    }
    this.createWindow(files);
  }

  private createWindow(files: string[]) {
    const win = new BrowserWindow({
      width: 1440, height: 940, minWidth: 900, minHeight: 600, show: false,
      backgroundColor: '#1b1b1f', title: 'Quartz', autoHideMenuBar: true,
      ...(this.host.icon ? { icon: this.host.icon } : {}),
      webPreferences: { preload: path.join(this.host.appDir, 'preload.cjs'), sandbox: true, contextIsolation: true, spellcheck: true },
    });
    this.host.decorateWindow?.(win);
    win.removeMenu();
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(this.host.appDir, 'web', 'index.html'));
    const wc = win.webContents;
    wc.once('did-finish-load', () => { if (files.length) wc.send('quartz:open', files); });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') wc.toggleDevTools();
    });
    // closing with unsaved documents asks first (the page blocks the unload)
    wc.on('will-prevent-unload', (e) => {
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        title: 'Quartz', message: 'Some documents have unsaved changes.', detail: 'If you close Quartz now, those changes are lost.',
      });
      if (r === 0) e.preventDefault();
    });
    this.wire(wc, win);
    this.windows.add(win);
    win.on('closed', () => this.windows.delete(win));
  }

  private wire(wc: WebContents, win: BrowserWindow) {
    const on = (channel: string, fn: (...args: any[]) => unknown) => wc.ipc.handle(channel, (_e, ...args) => fn(...args));
    const pdfFilter = [{ name: 'PDF documents', extensions: ['pdf'] }];
    on('quartz:open-dialog', async (title?: string) => {
      const r = await dialog.showOpenDialog(win, { title: title || 'Open PDF', filters: pdfFilter, properties: ['openFile', 'multiSelections'] });
      return r.canceled ? [] : r.filePaths;
    });
    on('quartz:image-dialog', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Choose an Image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }], properties: ['openFile'] });
      return r.canceled ? null : r.filePaths[0];
    });
    on('quartz:save-dialog', async (defaultName: string, kind?: 'pdf' | 'png' | 'txt') => {
      const filters = kind === 'png' ? [{ name: 'PNG image', extensions: ['png'] }] : kind === 'txt' ? [{ name: 'Text', extensions: ['txt'] }] : pdfFilter;
      const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
      return r.canceled || !r.filePath ? null : r.filePath;
    });
    on('quartz:folder-dialog', async (title?: string) => {
      const r = await dialog.showOpenDialog(win, { title: title || 'Choose a Folder', properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    });
    on('quartz:read', async (p: string) => {
      const buf = await fs.promises.readFile(String(p));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    });
    on('quartz:stat', (p: string) => { try { const s = fs.statSync(String(p)); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; } });
    // writes go to a temporary file first, so a failed save never damages the original
    on('quartz:write', async (p: string, data: Uint8Array) => {
      const file = String(p);
      const tmp = `${file}.quartz-${process.pid}.tmp`;
      try {
        await fs.promises.writeFile(tmp, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        await fs.promises.rename(tmp, file);
        return '';
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        return (e as Error).message || 'The file could not be written.';
      }
    });
    on('quartz:recent', () => readJson<Recent[]>(this.recentFile, []).filter((r) => isFile(r.path)));
    on('quartz:add-recent', (r: Recent) => {
      if (!r?.path) return;
      const list = readJson<Recent[]>(this.recentFile, []).filter((x) => x.path.toLowerCase() !== r.path.toLowerCase());
      list.unshift({ path: r.path, name: r.name || path.basename(r.path), at: Date.now(), pages: r.pages });
      writeJson(this.recentFile, list.slice(0, 30));
      if (process.platform === 'win32') app.addRecentDocument(r.path);
    });
    on('quartz:remove-recent', (p: string) => writeJson(this.recentFile, readJson<Recent[]>(this.recentFile, []).filter((x) => x.path !== p)));
    on('quartz:signatures', () => readJson<unknown[]>(this.signaturesFile, []));
    on('quartz:set-signatures', (list: unknown[]) => writeJson(this.signaturesFile, Array.isArray(list) ? list.slice(0, 8) : []));
    // PDF.js data files, read from the app folder (file:// fetches aren't allowed in the page)
    const ASSET_DIRS: Record<string, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };
    on('quartz:asset', async (kind: string, filename: string) => {
      const dir = ASSET_DIRS[kind];
      if (!dir || !/^[\w.-]+$/.test(String(filename))) throw new Error('bad asset');
      const buf = await fs.promises.readFile(path.join(this.host.appDir, 'web', 'pdfjs', dir, filename));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    });
    on('quartz:show-in-folder', (p: string) => shell.showItemInFolder(String(p)));
    on('quartz:open-path', (p: string) => shell.openPath(String(p)));
    on('quartz:open-url', (url: string) => { if (/^(https?|mailto):/i.test(String(url))) shell.openExternal(String(url)); });
    on('quartz:set-title', (t: string) => win.setTitle(String(t || 'Quartz')));
    on('quartz:print', (pages: Uint8Array[], name: string) => this.print(win, pages, String(name || 'Document')));
    on('quartz:default-status', () => defaultStatus());
    on('quartz:make-default', () => registerDefault(this.host));
    on('quartz:about', () => ({ version: this.host.version, electron: process.versions.electron, chrome: process.versions.chrome }));
  }

  /** Prints page images through a hidden window and the system print dialog. */
  private async print(owner: BrowserWindow, pages: Uint8Array[], name: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartz-print-'));
    try {
      const imgs = pages.map((data, i) => {
        const f = path.join(dir, `p${i}.jpg`);
        fs.writeFileSync(f, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        return `<div class="p"><img src="p${i}.jpg"></div>`;
      });
      fs.writeFileSync(path.join(dir, 'print.html'), `<!doctype html><meta charset="utf-8"><title>${name.replace(/[<&]/g, '')}</title>
<style>@page{margin:0}html,body{margin:0}.p{height:100vh;display:flex;align-items:center;justify-content:center;break-after:page;overflow:hidden}.p:last-child{break-after:auto}img{max-width:100%;max-height:100%}</style>${imgs.join('')}`);
      const w = new BrowserWindow({ show: false, parent: owner, webPreferences: { sandbox: true, javascript: false } });
      await w.loadFile(path.join(dir, 'print.html'));
      const ok = await new Promise<boolean>((resolve) => w.webContents.print({ silent: false, printBackground: true, margins: { marginType: 'none' } }, (success) => resolve(success)));
      w.destroy();
      return ok;
    } finally {
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 5000);
    }
  }
}

let current: Quartz | null = null;

export function activate(host: Host) {
  const q = new Quartz(host);
  current = q;
  ensureListed(host).catch(() => {});
  return {
    open: (args: string[]) => q.open(args || []),
    windows: () => [...q.windows],
    deactivate: () => { for (const w of q.windows) w.destroy(); if (current === q) current = null; },
  };
}

/** Called by the launcher before Quartz's files are removed: take Quartz out of Windows' PDF app list. */
export async function uninstall() {
  await unregister();
}
