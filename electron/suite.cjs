// Crystal Suite app manager: reads the app catalog, downloads, verifies, installs, updates and
// uninstalls apps, and keeps their shortcuts. Apps live in %LOCALAPPDATA%\Crystal Suite\Apps\<id>\<version>.
const { app, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
const { extractZip } = require('./zip.cjs');

const REPO = 'Enqrypted/crystal-suite';
const REPO_URL = `https://github.com/${REPO}`;
const CATALOG_URL = process.env.CRYSTAL_CATALOG || `https://raw.githubusercontent.com/${REPO}/main/catalog.json`;
const HOME = path.resolve(process.env.CRYSTAL_HOME || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Crystal Suite'));
const APPS_DIR = path.join(HOME, 'Apps');
const INSTALLED_FILE = path.join(HOME, 'installed.json');
const SETTINGS_FILE = path.join(HOME, 'settings.json');
const CATALOG_CACHE = path.join(HOME, 'catalog-cache.json');

/** Apps the launcher can present before (or without) a catalog, including unreleased ones. */
const KNOWN = [
  { id: 'photon', badge: 'Ph', name: 'Photon', description: 'Photo editing, retouching & compositing', color: '#31a8ff', bg: '#001e36' },
  { id: 'vector', badge: 'Ve', name: 'Vector', description: 'Vector illustration & logos', color: '#ff9a00', bg: '#330000' },
  { id: 'darkroom', badge: 'Dr', name: 'Darkroom', description: 'Photo library & RAW development', color: '#31c5f0', bg: '#001d26' },
  { id: 'cut', badge: 'Ct', name: 'Cut', description: 'Video editing', color: '#9999ff', bg: '#00005b' },
  { id: 'motion', badge: 'Mo', name: 'Motion', description: 'Motion graphics & effects', color: '#d291ff', bg: '#1a0033' },
  { id: 'layout', badge: 'La', name: 'Layout', description: 'Page layout & publishing', color: '#ff3366', bg: '#49021f' },
];
const DEFAULT_SETTINGS = { autoUpdate: true, desktopShortcut: true };

const ID_RE = /^[a-z0-9-]{1,32}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Keeps only well-formed catalog entries; the catalog is remote data. */
function sanitizeCatalog(raw, baseUrl) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.apps)) throw new Error('The app catalog is malformed.');
  const apps = new Map();
  for (const a of raw.apps) {
    if (!a || !ID_RE.test(a.id) || !VERSION_RE.test(a.version) || !/^[0-9a-f]{64}$/i.test(a.sha256) || !(a.size > 0)) continue;
    let url;
    try { url = new URL(a.url, baseUrl); } catch { continue; }
    if (!['https:', 'http:', 'file:'].includes(url.protocol)) continue;
    apps.set(a.id, {
      id: a.id, version: a.version, url: url.href, size: Math.floor(a.size), sha256: a.sha256.toLowerCase(),
      name: str(a.name, 40), badge: str(a.badge, 3), description: str(a.description),
      color: COLOR_RE.test(a.color) ? a.color : '', bg: COLOR_RE.test(a.bg) ? a.bg : '',
      notes: str(a.notes, 600), minLauncher: VERSION_RE.test(a.minLauncher) ? a.minLauncher : '',
    });
  }
  let launcher = null;
  if (raw.launcher && VERSION_RE.test(raw.launcher.version)) {
    const url = str(raw.launcher.url, 300);
    launcher = { version: raw.launcher.version, url: url.startsWith(REPO_URL + '/') ? url : `${REPO_URL}/releases/latest` };
  }
  return { apps, launcher };
}

class Suite extends EventEmitter {
  constructor() {
    super();
    this.home = HOME;
    this.repoUrl = REPO_URL;
    this.appsDir = APPS_DIR;
    this.catalogUrl = CATALOG_URL;
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
    this.installed = {};
    this.catalog = { status: 'idle', apps: new Map(), launcher: null, checkedAt: 0, error: '' };
    this.tasks = new Map(); // id -> { kind, phase, received, total, abort }
    this.errors = new Map(); // id -> last error message
    this.notice = null;
    this.running = () => 0; // set by main: number of open windows of an app
    this._emitTimer = null;
    const cached = readJson(CATALOG_CACHE, null);
    if (cached) {
      try { Object.assign(this.catalog, sanitizeCatalog(cached.data, cached.url || CATALOG_URL), { checkedAt: cached.checkedAt || 0 }); } catch { /* ignore a bad cache */ }
    }
    for (const [id, info] of Object.entries(readJson(INSTALLED_FILE, {}))) {
      if (ID_RE.test(id) && info && VERSION_RE.test(info.version) && fs.existsSync(path.join(APPS_DIR, id, info.version))) this.installed[id] = info;
    }
  }

  // ---------- queries ----------
  isInstalled(id) { return !!this.installed[id]; }
  appDir(id) { return this.installed[id] ? path.join(APPS_DIR, id, this.installed[id].version) : null; }
  /** The installed app's own manifest (app.json inside its package). */
  manifest(id) {
    const dir = this.appDir(id);
    const m = dir ? readJson(path.join(dir, 'app.json'), {}) : {};
    return m && typeof m === 'object' ? m : {};
  }
  /** Stable icon paths that survive updates (copied out of each installed version). */
  iconPng(id) { const p = path.join(APPS_DIR, id, 'icon.png'); return fs.existsSync(p) ? p : null; }
  iconIco(id) { const p = path.join(APPS_DIR, id, 'icon.ico'); return fs.existsSync(p) ? p : null; }
  info(id) {
    const known = KNOWN.find((k) => k.id === id) || {};
    const c = this.catalog.apps.get(id) || {};
    return {
      id,
      name: c.name || known.name || id,
      badge: c.badge || known.badge || id.slice(0, 2).replace(/^./, (s) => s.toUpperCase()),
      description: c.description || known.description || '',
      color: c.color || known.color || '#9a9aa4',
      bg: c.bg || known.bg || '#26262b',
    };
  }
  /** Picks the installed app that opens these files (Photon for images and projects). */
  appForFiles(files) {
    const ext = path.extname(files[0] || '').slice(1).toLowerCase();
    for (const id of Object.keys(this.installed)) {
      const types = this.manifest(id).fileTypes;
      if (Array.isArray(types) && types.includes(ext)) return id;
    }
    return 'photon';
  }
  launchTarget() {
    if (!app.isPackaged) return null;
    return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  }
  /** Command line that reopens an app; used for taskbar pinning. */
  relaunchCommand(id) {
    const exe = this.launchTarget();
    if (exe) return `"${exe}" --open-app=${id}`;
    return `"${process.execPath}" "${path.join(__dirname, '..')}" --open-app=${id}`;
  }

  state() {
    const ids = [...new Set([...KNOWN.map((k) => k.id), ...this.catalog.apps.keys(), ...Object.keys(this.installed)])];
    const apps = ids.map((id) => {
      const c = this.catalog.apps.get(id);
      const inst = this.installed[id];
      const t = this.tasks.get(id);
      return {
        ...this.info(id),
        available: c ? { version: c.version, size: c.size, notes: c.notes } : null,
        installed: inst ? { version: inst.version, installedAt: inst.installedAt } : null,
        update: !!(c && inst && compareVersions(c.version, inst.version) > 0),
        needsLauncher: !!(c && c.minLauncher && compareVersions(c.minLauncher, app.getVersion()) > 0) ? c.minLauncher : '',
        task: t ? { kind: t.kind, phase: t.phase, received: t.received, total: t.total } : null,
        running: this.running(id),
        error: this.errors.get(id) || '',
      };
    });
    const l = this.catalog.launcher;
    return {
      version: app.getVersion(),
      appsDir: APPS_DIR,
      packaged: app.isPackaged,
      settings: { ...this.settings },
      catalog: { status: this.catalog.status, checkedAt: this.catalog.checkedAt, error: this.catalog.error },
      launcherUpdate: l && compareVersions(l.version, app.getVersion()) > 0 ? l.version : '',
      notice: this.notice,
      apps,
    };
  }

  changed(now = true) {
    if (now) { clearTimeout(this._emitTimer); this._emitTimer = null; this.emit('change'); return; }
    if (!this._emitTimer) this._emitTimer = setTimeout(() => { this._emitTimer = null; this.emit('change'); }, 100);
  }
  setNotice(notice) { this.notice = notice; this.changed(); }
  setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS) || typeof value !== 'boolean') return;
    this.settings[key] = value;
    writeJson(SETTINGS_FILE, this.settings);
    this.changed();
  }

  // ---------- catalog ----------
  async refresh() {
    if (this._refreshing) return this._refreshing;
    this.catalog.status = 'loading';
    this.changed();
    this._refreshing = (async () => {
      try {
        const res = await net.fetch(CATALOG_URL, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`The app catalog could not be loaded (HTTP ${res.status}).`);
        const data = await res.json();
        Object.assign(this.catalog, sanitizeCatalog(data, CATALOG_URL), { status: 'ok', error: '', checkedAt: Date.now() });
        try { writeJson(CATALOG_CACHE, { url: CATALOG_URL, checkedAt: this.catalog.checkedAt, data }); } catch { /* cache is optional */ }
      } catch (err) {
        this.catalog.status = 'offline';
        this.catalog.error = err && err.name === 'TimeoutError' ? 'The app catalog took too long to answer.' : friendly(err);
      } finally {
        this._refreshing = null;
        this.changed();
      }
      if (this.settings.autoUpdate) {
        for (const a of this.state().apps) if (a.update && !a.task && !a.needsLauncher) this.install(a.id).catch(() => {});
      }
    })();
    return this._refreshing;
  }

  // ---------- install / update ----------
  async install(id) {
    if (this.tasks.has(id)) return;
    const entry = this.catalog.apps.get(id);
    this.errors.delete(id);
    if (!entry) { this.fail(id, 'This app is not available to download yet.'); return; }
    if (entry.minLauncher && compareVersions(entry.minLauncher, app.getVersion()) > 0) {
      this.fail(id, `This version needs Crystal Suite ${entry.minLauncher} or newer. Update Crystal Suite first.`);
      return;
    }
    const kind = this.installed[id] ? 'update' : 'install';
    const task = { kind, phase: 'download', received: 0, total: entry.size, abort: new AbortController() };
    this.tasks.set(id, task);
    this.changed();
    const base = path.join(APPS_DIR, id);
    const zipFile = path.join(base, `.download-${entry.version}.zip`);
    const partial = path.join(base, `.${entry.version}.partial`);
    const finalDir = path.join(base, entry.version);
    try {
      fs.mkdirSync(base, { recursive: true });
      const got = await download(entry.url, zipFile, task.abort.signal, entry.size, (received, total) => {
        task.received = received;
        task.total = total;
        this.changed(false);
      });
      task.phase = 'verify';
      this.changed();
      if (got.size !== entry.size || got.sha256 !== entry.sha256) throw new Error('The download was damaged or does not match the catalog (checksum mismatch). Try again.');
      task.phase = 'extract';
      this.changed();
      fs.rmSync(partial, { recursive: true, force: true });
      extractZip(fs.readFileSync(zipFile), partial);
      const manifest = readJson(path.join(partial, 'app.json'), null);
      if (!manifest || manifest.id !== id) throw new Error('The downloaded package is not a valid Crystal Suite app.');
      const entryFile = path.resolve(partial, typeof manifest.entry === 'string' ? manifest.entry : 'index.html');
      if (!entryFile.startsWith(partial + path.sep) || !fs.existsSync(entryFile)) throw new Error('The downloaded package is missing its start page.');
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(partial, finalDir);
      for (const icon of ['icon.png', 'icon.ico']) {
        const src = path.join(finalDir, icon);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(base, icon));
      }
      this.installed[id] = { version: entry.version, installedAt: Date.now() };
      writeJson(INSTALLED_FILE, this.installed);
      if (kind === 'install') this.createShortcuts(id);
      this.cleanup(id);
    } catch (err) {
      fs.rmSync(partial, { recursive: true, force: true });
      if (!task.abort.signal.aborted) this.errors.set(id, friendly(err));
    } finally {
      fs.rmSync(zipFile, { force: true });
      this.tasks.delete(id);
      this.changed();
    }
  }
  cancel(id) {
    const t = this.tasks.get(id);
    if (t && t.phase === 'download') t.abort.abort();
  }
  fail(id, message) { this.errors.set(id, message); this.changed(); }
  clearError(id) { if (this.errors.delete(id)) this.changed(); }

  uninstall(id) {
    if (!this.installed[id] || this.tasks.has(id)) return;
    this.errors.delete(id);
    if (this.running(id)) { this.fail(id, `Close ${this.info(id).name} before uninstalling it.`); return; }
    this.removeShortcuts(id);
    try {
      fs.rmSync(path.join(APPS_DIR, id), { recursive: true, force: true });
    } catch (err) {
      this.fail(id, `Some files could not be removed: ${friendly(err)}`);
    }
    delete this.installed[id];
    writeJson(INSTALLED_FILE, this.installed);
    this.changed();
  }

  /** Removes versions other than the current one, unless the app still has windows on them. */
  cleanup(id) {
    if (this.running(id)) return;
    const base = path.join(APPS_DIR, id);
    const keep = this.installed[id] && this.installed[id].version;
    let names = [];
    try { names = fs.readdirSync(base); } catch { return; }
    for (const n of names) {
      if (n === keep || n === 'icon.png' || n === 'icon.ico') continue;
      if (this.tasks.has(id) && n.startsWith('.')) continue;
      try { fs.rmSync(path.join(base, n), { recursive: true, force: true }); } catch { /* retried next start */ }
    }
  }
  cleanupAll() {
    let ids = [];
    try { ids = fs.readdirSync(APPS_DIR); } catch { return; }
    for (const id of ids) {
      if (this.installed[id]) this.cleanup(id);
      else if (ID_RE.test(id)) { try { fs.rmSync(path.join(APPS_DIR, id), { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }

  // ---------- shortcuts (installed builds on Windows only) ----------
  shortcutPaths(id) {
    const name = `${this.info(id).name}.lnk`;
    return {
      startMenu: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', name),
      desktop: path.join(app.getPath('desktop'), name),
    };
  }
  createShortcuts(id) {
    const target = this.launchTarget();
    if (!target || process.platform !== 'win32' || process.env.CRYSTAL_NO_SHORTCUTS) return;
    const info = this.info(id);
    const link = {
      target, args: `--open-app=${id}`, description: `${info.name} — ${info.description}`,
      icon: this.iconIco(id) || target, iconIndex: 0, appUserModelId: `app.crystalsuite.${id}`,
    };
    const { startMenu, desktop } = this.shortcutPaths(id);
    try { shell.writeShortcutLink(startMenu, 'create', link); } catch { /* not fatal */ }
    if (this.settings.desktopShortcut) { try { shell.writeShortcutLink(desktop, 'create', link); } catch { /* not fatal */ } }
  }
  removeShortcuts(id) {
    if (process.platform !== 'win32') return;
    for (const p of Object.values(this.shortcutPaths(id))) {
      try {
        // only remove links that point at Crystal Suite
        const l = shell.readShortcutLink(p);
        if (l && (l.args || '').includes(`--open-app=${id}`)) fs.rmSync(p, { force: true });
      } catch { /* missing */ }
    }
  }
}

/** Streams a URL to a file, reporting progress and hashing on the way. */
async function download(url, dest, signal, expected, onProgress) {
  const res = await net.fetch(url, { signal, cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || expected || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      size += value.length;
      if (!out.write(value)) await once(out, 'drain');
      onProgress(size, total);
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  return { size, sha256: hash.digest('hex') };
}

function friendly(err) {
  const msg = (err && err.message) || String(err);
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION/i.test(msg)) return 'You appear to be offline. Check your internet connection and try again.';
  if (/ENOSPC/.test(msg)) return 'There is not enough free disk space.';
  if (/EPERM|EACCES|EBUSY/.test(msg)) return 'A file is in use or not writable. Close the app and try again.';
  return msg.replace(/^net::/, '');
}

module.exports = { Suite, REPO_URL, compareVersions };
