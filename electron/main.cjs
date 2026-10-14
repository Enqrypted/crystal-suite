// Crystal Suite desktop shell: the launcher (installs, updates and opens apps) plus one window per
// open app. Apps are downloaded packages (see suite.cjs); `--photon` runs the local dev build of Photon.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SUITE_ICON = path.join(__dirname, 'suite.png');
const APP_PRELOAD = path.join(__dirname, 'preload.cjs');
const LAUNCHER_PRELOAD = path.join(__dirname, 'launcher-preload.cjs');
/** Only pass an icon that exists (Electron warns on undefined paths). */
const iconOpt = (p) => (p && fs.existsSync(p) ? { icon: p } : {});
const FILE_RE = /\.(psd|psb|phtn|png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

let suite = null; // created once the app is ready (it needs app paths)
let launcher = null;
const appWindows = new Map(); // app id -> Set<BrowserWindow>

/** --open-app=<id>, --photon (dev build) and file paths from a command line. Switches are single tokens
 *  because Chromium reorders a second instance's command line (switches first), splitting "--x value". */
function parseArgs(argv) {
  const args = argv.slice(1);
  const open = args.find((a) => a.toLowerCase().startsWith('--open-app='));
  const id = open ? open.slice(11).toLowerCase() : '';
  return {
    appId: /^[a-z0-9-]{1,32}$/.test(id) ? id : '',
    dev: args.includes('--photon'),
    files: args.filter((a) => !a.startsWith('-') && FILE_RE.test(a) && fs.existsSync(a)),
  };
}

// ---------- launcher ----------
function showLauncher() {
  if (launcher) {
    if (launcher.isMinimized()) launcher.restore();
    launcher.focus();
    return launcher;
  }
  launcher = new BrowserWindow({
    width: 1040, height: 680, minWidth: 780, minHeight: 540,
    backgroundColor: '#1b1b1f', title: 'Crystal Suite', ...iconOpt(SUITE_ICON),
    autoHideMenuBar: true, show: false,
    webPreferences: { preload: LAUNCHER_PRELOAD, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  launcher.removeMenu();
  launcher.once('ready-to-show', () => launcher.show());
  launcher.loadFile(path.join(__dirname, 'launcher.html'));
  launcher.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  launcher.webContents.on('will-navigate', (e) => e.preventDefault());
  launcher.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') launcher.webContents.toggleDevTools();
  });
  launcher.on('closed', () => { launcher = null; });
  return launcher;
}
const pushState = () => { if (launcher) launcher.webContents.send('suite:state', suite.state()); };

// ---------- app windows ----------
function windowsOf(id) { return [...(appWindows.get(id) || [])]; }
function focusWindow(w) { if (w.isMinimized()) w.restore(); w.focus(); }

/** Opens an installed app (or shows the launcher so it can be installed). */
function openApp(id, files = []) {
  if (!suite.isInstalled(id)) {
    const name = suite.info(id).name;
    suite.setNotice({
      appId: id,
      text: files.length ? `Install ${name} to open ${path.basename(files[0])}.` : `${name} isn't installed yet. Install it below to get started.`,
    });
    showLauncher();
    return null;
  }
  const dir = suite.appDir(id);
  const m = suite.manifest(id);
  const entry = path.resolve(dir, typeof m.entry === 'string' ? m.entry : 'index.html');
  if (!entry.startsWith(dir + path.sep) || !fs.existsSync(entry)) {
    dialog.showErrorBox(suite.info(id).name, 'This app looks damaged. Reinstall it from Crystal Suite.');
    showLauncher();
    return null;
  }
  return createAppWindow(id, entry, m, files, { icon: suite.iconPng(id), ico: suite.iconIco(id) });
}

/** Runs the local source build of Photon (npm run photon). */
function openDevPhoton(files) {
  const html = path.join(ROOT, 'dist', 'photon', 'index.html');
  if (!fs.existsSync(html)) {
    dialog.showErrorBox('Photon is not built', 'Run "npm run build" first (or use "npm run photon", which builds and starts).');
    return null;
  }
  const m = readManifest(path.join(ROOT, 'apps', 'photon', 'app.json'));
  return createAppWindow('photon', html, m, files, { icon: path.join(ROOT, 'apps', 'photon', 'icon.png'), ico: path.join(ROOT, 'apps', 'photon', 'icon.ico') });
}
function readManifest(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }

function createAppWindow(id, entry, m, files, icons) {
  const w = (m && typeof m.window === 'object' && m.window) || {};
  const num = (v, d) => (Number.isFinite(v) && v >= 200 && v <= 10000 ? v : d);
  const name = (typeof m.name === 'string' && m.name) || suite.info(id).name;
  const win = new BrowserWindow({
    width: num(w.width, 1600), height: num(w.height, 960), minWidth: num(w.minWidth, 800), minHeight: num(w.minHeight, 560),
    backgroundColor: /^#[0-9a-f]{6}$/i.test(w.background || '') ? w.background : '#1f1f1f',
    title: name, ...iconOpt(icons.icon), autoHideMenuBar: true, show: false,
    webPreferences: { preload: APP_PRELOAD, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  // Group the app's windows under its own taskbar button and icon instead of Crystal Suite's.
  if (process.platform === 'win32') {
    try {
      win.setAppDetails({
        appId: `app.crystalsuite.${id}`,
        ...(icons.ico && fs.existsSync(icons.ico) ? { appIconPath: icons.ico, appIconIndex: 0 } : {}),
        relaunchCommand: suite.relaunchCommand(id), relaunchDisplayName: name,
      });
    } catch { /* cosmetic */ }
  }
  win.removeMenu();
  if (w.maximize !== false) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(entry);
  // Apps cancel unload when documents have unsaved changes; ask the user.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Quit Without Saving', 'Cancel'], defaultId: 1, cancelId: 1,
      title: name, message: 'You have unsaved changes.', detail: 'If you quit now, your changes will be lost.',
    });
    if (choice === 0) e.preventDefault();
  });
  // keyboard: let the app handle everything (Ctrl+W, Ctrl+N, Ctrl+T...), but keep dev tools on Ctrl+Shift+I
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' }; // print preview popup
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
  if (files.length) win.webContents.once('did-finish-load', () => win.webContents.send('open-paths', files));
  if (!appWindows.has(id)) appWindows.set(id, new Set());
  appWindows.get(id).add(win);
  win.on('closed', () => {
    appWindows.get(id).delete(win);
    if (!appWindows.get(id).size) suite.cleanup(id); // drop versions replaced by an update while it was open
    pushState();
  });
  pushState();
  return win;
}

/** Acts on a command line: from the first start or from a second launch (single instance). */
function handleArgs(argv, firstRun) {
  const a = parseArgs(argv);
  if (a.dev) {
    const w = windowsOf('photon')[0];
    if (w && a.files.length) { w.webContents.send('open-paths', a.files); focusWindow(w); return; }
    if (w && !firstRun) { focusWindow(w); return; }
    openDevPhoton(a.files);
    return;
  }
  const id = a.appId || (a.files.length ? suite.appForFiles(a.files) : '');
  if (!id) { showLauncher(); return; }
  const w = windowsOf(id)[0];
  if (w && a.files.length) { w.webContents.send('open-paths', a.files); focusWindow(w); return; }
  if (w && !a.files.length) { focusWindow(w); return; }
  openApp(id, a.files);
}

// ---------- IPC: the launcher ----------
function fromLauncher(e) { return launcher && e.sender === launcher.webContents; }
const launcherApi = {
  'suite:state': () => suite.state(),
  'suite:refresh': () => { suite.refresh(); },
  'suite:install': (id) => { suite.install(String(id)); },
  'suite:cancel': (id) => suite.cancel(String(id)),
  'suite:uninstall': async (id) => {
    id = String(id);
    if (!suite.isInstalled(id)) return;
    const name = suite.info(id).name;
    const r = await dialog.showMessageBox(launcher, {
      type: 'question', buttons: ['Uninstall', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Crystal Suite', message: `Uninstall ${name}?`, detail: `${name} will be removed from this computer. Your documents are not affected, and you can install it again at any time.`,
    });
    if (r.response === 0) suite.uninstall(id);
  },
  'suite:launch': (id) => { openApp(String(id)); },
  'suite:reveal': (id) => { const d = suite.appDir(String(id)); shell.openPath(d || suite.appsDir); },
  'suite:open-apps-folder': () => { fs.mkdirSync(suite.appsDir, { recursive: true }); shell.openPath(suite.appsDir); },
  'suite:set-setting': (key, value) => suite.setSetting(String(key), value),
  'suite:clear-error': (id) => suite.clearError(String(id)),
  'suite:dismiss-notice': () => suite.setNotice(null),
  'suite:open-url': (key) => {
    const REPO_URL = suite.repoUrl;
    const l = suite.catalog.launcher;
    const urls = { repo: REPO_URL, releases: `${REPO_URL}/releases`, issues: `${REPO_URL}/issues`, 'launcher-update': (l && l.url) || `${REPO_URL}/releases/latest` };
    if (urls[key]) shell.openExternal(urls[key]);
  },
};
for (const [channel, fn] of Object.entries(launcherApi)) {
  ipcMain.handle(channel, (e, ...args) => (fromLauncher(e) ? fn(...args) : undefined));
}

// ---------- IPC: native file access for apps ----------
ipcMain.handle('open-files', async (e, filters) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
  if (r.canceled) return [];
  return r.filePaths.map((p) => readFileForRenderer(p)).filter(Boolean);
});
ipcMain.handle('save-file', async (e, { defaultPath, filters, data }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { defaultPath, filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return { path: r.filePath, name: path.basename(r.filePath) };
});
ipcMain.handle('write-file', async (_e, p, data) => {
  try { fs.writeFileSync(p, Buffer.from(data)); return true; } catch { return false; }
});
ipcMain.handle('read-file', async (_e, p) => readFileForRenderer(p));
ipcMain.handle('choose-folder', async (e, o) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const dp = o && typeof o.defaultPath === 'string' && fs.existsSync(o.defaultPath) ? o.defaultPath : undefined;
  const r = await dialog.showOpenDialog(win, { title: (o && o.title) || 'Choose Folder', defaultPath: dp, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

function readFileForRenderer(p) {
  try {
    const buf = fs.readFileSync(p);
    return { name: path.basename(p), path: p, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch { return null; }
}

// ---------- app lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => { if (suite) handleArgs(argv, false); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    if (process.platform === 'win32') app.setAppUserModelId('app.crystalsuite.suite');
    const { Suite } = require('./suite.cjs');
    suite = new Suite();
    suite.running = (id) => windowsOf(id).length;
    suite.on('change', pushState);
    suite.cleanupAll();
    handleArgs(process.argv, true);
    suite.refresh(); // checks for new apps and updates in the background
  });
  // Finish a running download/update before quitting when the last window closes.
  const quitWhenIdle = () => {
    if (BrowserWindow.getAllWindows().length) return;
    if (suite && suite.tasks.size) setTimeout(quitWhenIdle, 500);
    else app.quit();
  };
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') quitWhenIdle(); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) showLauncher(); });
}
