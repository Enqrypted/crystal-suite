// Development host for Quartz (`npm run quartz`): runs the PDF app on its own, the same way the Crystal
// Suite launcher hosts it. QUARTZ_USER_DATA points it at a test profile.
const { app, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const HERE = __dirname; // apps/quartz/standalone
const ROOT = path.join(HERE, '..', '..', '..');
const APP_DIR = path.join(ROOT, 'dist', 'quartz');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'app.json'), 'utf8'));

app.setName('Quartz');
if (process.env.QUARTZ_USER_DATA) app.setPath('userData', path.resolve(process.env.QUARTZ_USER_DATA)); // tests
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Quartz (dev)'));

function argsFrom(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && path.resolve(a) !== path.resolve(ROOT) && path.resolve(a) !== __filename);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let quartz = null;
  app.on('second-instance', (_e, argv) => { if (quartz) quartz.open(argsFrom(argv)); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    if (process.platform === 'win32') app.setAppUserModelId('app.crystalsuite.quartz');
    const { activate } = require(path.join(APP_DIR, 'main.cjs'));
    quartz = activate({
      appId: 'quartz',
      version: manifest.version,
      appDir: APP_DIR,
      dataDir: path.join(app.getPath('userData'), 'Quartz'),
      icon: path.join(HERE, '..', 'icon.png'),
      ico: path.join(HERE, '..', 'icon.ico'),
      standalone: true,
      launchCommand: () => ({ exe: process.execPath, args: [__filename] }),
    });
    quartz.open(argsFrom(process.argv));
  });
  app.on('window-all-closed', () => app.quit());
}
