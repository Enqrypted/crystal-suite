// Development host for Onyx (`npm run onyx`): runs the instant replay app on its own, the same way the
// Crystal Suite launcher hosts it. ONYX_USER_DATA points it at a test profile.
const { app, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const HERE = __dirname; // apps/onyx/standalone
const ROOT = path.join(HERE, '..', '..', '..');
const APP_DIR = path.join(ROOT, 'dist', 'onyx');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'app.json'), 'utf8'));

app.setName('Onyx');
if (process.env.ONYX_USER_DATA) app.setPath('userData', path.resolve(process.env.ONYX_USER_DATA)); // tests
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Onyx (dev)'));

function argsFrom(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && path.resolve(a) !== path.resolve(ROOT) && path.resolve(a) !== __filename);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let onyx = null;
  app.on('second-instance', (_e, argv) => { if (onyx) onyx.open(argsFrom(argv)); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    if (process.platform === 'win32') app.setAppUserModelId('app.crystalsuite.onyx');
    const { activate } = require(path.join(APP_DIR, 'main.cjs'));
    onyx = activate({
      appId: 'onyx',
      version: manifest.version,
      appDir: APP_DIR,
      dataDir: path.join(app.getPath('userData'), 'Onyx'),
      icon: path.join(HERE, '..', 'icon.png'),
      ico: path.join(HERE, '..', 'icon.ico'),
      standalone: true,
      launchCommand: () => ({ exe: process.execPath, args: [__filename] }),
    });
    onyx.open(argsFrom(process.argv));
  });
  app.on('window-all-closed', () => app.quit());
}
