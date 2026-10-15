// Development host for Cut (`npm run cut`): runs the editor on its own, the same way the Crystal Suite
// launcher hosts it.
const { app, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const HERE = __dirname; // apps/cut/standalone
const ROOT = path.join(HERE, '..', '..', '..');
const APP_DIR = path.join(ROOT, 'dist', 'cut');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'app.json'), 'utf8'));

app.setName('Cut');
if (process.env.CUT_USER_DATA) app.setPath('userData', path.resolve(process.env.CUT_USER_DATA)); // tests
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Cut (dev)'));

function argsFrom(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && path.resolve(a) !== path.resolve(ROOT) && path.resolve(a) !== __filename);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let cut = null;
  app.on('second-instance', (_e, argv) => { if (cut) cut.open(argsFrom(argv)); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    if (process.platform === 'win32') app.setAppUserModelId('app.crystalsuite.cut');
    const { activate } = require(path.join(APP_DIR, 'main.cjs'));
    cut = activate({
      appId: 'cut',
      version: manifest.version,
      appDir: APP_DIR,
      dataDir: path.join(app.getPath('userData'), 'Cut'),
      icon: path.join(HERE, '..', 'icon.png'),
      ico: path.join(HERE, '..', 'icon.ico'),
      standalone: true,
      launchCommand: () => ({ exe: process.execPath, args: [__filename] }),
    });
    cut.open(argsFrom(process.argv));
  });
  app.on('window-all-closed', () => app.quit());
}
