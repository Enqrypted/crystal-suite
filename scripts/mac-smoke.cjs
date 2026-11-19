// End-to-end check of the launcher + Photon, for CI on macOS (works on Windows too):
//   npx vite build && npx electron scripts/mac-smoke.cjs <out-dir>
// Starts the real launcher (electron/main.cjs) with a throwaway profile and a local catalog holding the Photon
// just built, installs Photon through the launcher's own bridge, opens it, checks it, and saves screenshots.
// Exits 0 when every check passes.
const { app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[process.argv.length - 1].endsWith('.cjs') ? 'smoke-out' : process.argv[process.argv.length - 1]);
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crystal-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

// a catalog with only Photon, from dist/photon, served from disk
const { writeZip } = require(path.join(ROOT, 'electron', 'zip.cjs'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'photon', 'app.json'), 'utf8'));
const zip = writeZip([
  { name: 'index.html', data: fs.readFileSync(path.join(ROOT, 'dist', 'photon', 'index.html')) },
  { name: 'app.json', data: Buffer.from(JSON.stringify(manifest)) },
  { name: 'icon.png', data: fs.readFileSync(path.join(ROOT, 'apps', 'photon', 'icon.png')) },
]);
const zipFile = path.join(TMP, 'photon.zip');
fs.writeFileSync(zipFile, zip);
const catalogFile = path.join(TMP, 'catalog.json');
fs.writeFileSync(catalogFile, JSON.stringify({
  schema: 1, launcher: { version: '0.0.1', url: 'https://github.com/Enqrypted/crystal-suite/releases/latest' },
  apps: [
    { id: 'photon', name: 'Photon', version: manifest.version, description: manifest.description, url: 'file:///' + zipFile.replace(/\\/g, '/').replace(/^\//, ''), size: zip.length, sha256: crypto.createHash('sha256').update(zip).digest('hex'), minLauncher: '0.1.0', notes: '', platforms: ['win32', 'darwin'] },
    { id: 'quartz', name: 'Quartz', version: '9.9.9', description: 'PDF reader & editor', url: 'https://example.invalid/q.zip', size: 1, sha256: '0'.repeat(64), minLauncher: '0.1.0', notes: '', platforms: ['win32'] },
  ],
}));
process.env.CRYSTAL_HOME = path.join(TMP, 'home');
process.env.CRYSTAL_USER_DATA = path.join(TMP, 'userData');
process.env.CRYSTAL_CATALOG = 'file:///' + catalogFile.replace(/\\/g, '/').replace(/^\//, '');
process.env.CRYSTAL_NO_SHORTCUTS = '1';

const windows = [];
app.on('browser-window-created', (_e, w) => windows.push(w));
const shot = async (w, name) => { try { const img = await w.webContents.capturePage(); fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG()); } catch (e) { console.log('shot failed', name, e.message); } };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn().catch(() => null); if (v) return v; await sleep(250); } return null; };

require(path.join(ROOT, 'electron', 'main.cjs')); // the real launcher

app.whenReady().then(async () => {
  let code = 1;
  try {
    const launcher = await until(async () => windows.find((w) => /launcher\.html$/.test(w.webContents.getURL())));
    check('launcher window opens', !!launcher);
    if (!launcher) throw new Error('no launcher');
    await until(() => launcher.webContents.executeJavaScript('!!window.crystalSuite'));
    const state = await until(async () => { const s = await launcher.webContents.executeJavaScript('crystalSuite.getState()'); return s.catalog.status === 'ok' && s; });
    check('catalog loads', !!state, state ? state.catalog.status : '');
    const photon = state && state.apps.find((a) => a.id === 'photon');
    const quartz = state && state.apps.find((a) => a.id === 'quartz');
    check('Photon is offered on this platform', !!(photon && photon.available));
    check('Windows-only apps show as coming soon on a Mac', process.platform !== 'darwin' || !!(quartz && !quartz.available && /Mac/.test(quartz.platformNote)), quartz && quartz.platformNote);
    check('the data folder is the app data folder', state.appsDir.startsWith(process.env.CRYSTAL_HOME), state.appsDir);
    await sleep(800);
    await shot(launcher, 'launcher');
    await launcher.webContents.executeJavaScript("crystalSuite.install('photon')");
    const installed = await until(async () => { const s = await launcher.webContents.executeJavaScript('crystalSuite.getState()'); const a = s.apps.find((x) => x.id === 'photon'); if (a.error) return { error: a.error }; return a.installed && a; }, 60000);
    check('Photon installs (download, checksum, unzip)', !!(installed && installed.installed), installed && installed.error);
    await launcher.webContents.executeJavaScript("crystalSuite.launch('photon')");
    const pw = await until(async () => windows.find((w) => /Apps[\\/]photon/.test(decodeURIComponent(w.webContents.getURL()))));
    check('Photon window opens', !!pw);
    if (!pw) throw new Error('no Photon window');
    await until(() => pw.webContents.executeJavaScript('!!(window.photon && window.photon.app)'));
    await sleep(800);
    const info = await pw.webContents.executeJavaScript(`(() => {
      photon.io.newDocument({ name: 'Smoke', width: 800, height: 500, resolution: 72, background: 'white' });
      const d = photon.app.doc; photon.runMenu('Layer', 'New', 'Layer (no dialog)');
      const L = d.active, x = L.canvas.getContext('2d'); x.fillStyle = '#31a8ff'; x.fillRect(100, 100, 300, 200); L.touch(); d.invalidate();
      const px = [...L.canvas.getContext('2d').getImageData(200 - L.x, 200 - L.y, 1, 1).data];
      return { mac: navigator.platform, layers: d.layers.length, px, bridge: typeof window.photonNative?.openFiles };
    })()`);
    check('Photon runs: document, layer, pixels', info.layers === 2 && info.px[2] === 255, JSON.stringify(info));
    check('file bridge present', info.bridge === 'function');
    // menus show Mac shortcuts on a Mac
    await pw.webContents.executeJavaScript(`(() => { const t = [...document.querySelectorAll('.menubar .menu-top, .menubar > *')].find((e) => e.textContent.trim() === 'File'); t && t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); t && t.click(); return !!t; })()`);
    await sleep(400);
    const keys = await pw.webContents.executeJavaScript(`[...document.querySelectorAll('.menu-shortcut')].map((e) => e.textContent).filter(Boolean).slice(0, 8)`);
    if (process.platform === 'darwin') check('menus show ⌘ shortcuts', keys.some((k) => k.includes('⌘')) && !keys.some((k) => /Ctrl/.test(k)), JSON.stringify(keys));
    const fonts = await pw.webContents.executeJavaScript(`[...document.querySelectorAll('select option')].map((o) => o.value).filter((v) => /Helvetica|Segoe UI/.test(v)).slice(0, 4)`);
    if (process.platform === 'darwin') check('Mac font list', fonts.includes('Helvetica') && !fonts.includes('Segoe UI'), JSON.stringify(fonts));
    await shot(pw, 'photon');
    await pw.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    code = results.every((r) => r.ok) ? 0 : 1;
  } catch (e) {
    console.log('FAIL', e && e.stack || e);
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2));
  console.log(results.every((r) => r.ok) && code === 0 ? 'ALL PASSED' : 'SOME FAILED');
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  setTimeout(() => app.exit(code), 300);
});
