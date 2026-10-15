// Development host for Facet (`npm run facet`): runs it on its own, the same way the Crystal Suite
// launcher hosts it. FACET_USER_DATA points it at a test profile.
const { app, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const HERE = __dirname; // apps/facet/standalone
const ROOT = path.join(HERE, '..', '..', '..');
const APP_DIR = path.join(ROOT, 'dist', 'facet');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'app.json'), 'utf8'));

app.setName('Facet');
if (process.env.FACET_USER_DATA) app.setPath('userData', path.resolve(process.env.FACET_USER_DATA)); // tests
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Facet (dev)'));

function argsFrom(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && path.resolve(a) !== path.resolve(ROOT) && path.resolve(a) !== __filename);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let facet = null;
  app.on('second-instance', (_e, argv) => { if (facet) facet.open(argsFrom(argv)); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    if (process.platform === 'win32') app.setAppUserModelId('app.crystalsuite.facet');
    const { activate } = require(path.join(APP_DIR, 'main.cjs'));
    facet = activate({
      appId: 'facet',
      version: manifest.version,
      appDir: APP_DIR,
      dataDir: path.join(app.getPath('userData'), 'Facet'),
      icon: path.join(HERE, '..', 'icon.png'),
      ico: path.join(HERE, '..', 'icon.ico'),
      standalone: true,
      launchCommand: () => ({ exe: process.execPath, args: [__filename] }),
    });
    facet.open(argsFrom(process.argv));
  });
  // the widgets have no window to close: "Quit Facet" (tray or window) ends the dev host
  app.on('window-all-closed', () => app.quit());
}
