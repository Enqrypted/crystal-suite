// Prism as its own app (Prism.exe, or `npm run prism:standalone` from source). The same browser code
// also runs inside the Crystal Suite launcher; this file is only the host for running it on its own.
const { app, protocol, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// prism:// pages need a standard, secure scheme; this must happen before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: 'prism', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const HERE = __dirname; // apps/prism/standalone
const ROOT = path.join(HERE, '..', '..', '..');
const APP_DIR = path.join(ROOT, 'dist', 'prism');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'app.json'), 'utf8'));

app.setName('Prism');
if (process.env.PRISM_USER_DATA) app.setPath('userData', path.resolve(process.env.PRISM_USER_DATA)); // tests
else if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Prism'));

/** URLs and files from a command line (switches, the source folder and this script are skipped). */
function argsFrom(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && path.resolve(a) !== path.resolve(ROOT) && path.resolve(a) !== __filename);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  let prism = null;
  app.on('second-instance', (_e, argv) => { if (prism) prism.open(argsFrom(argv)); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    if (process.platform === 'win32') app.setAppUserModelId('app.crystalsuite.prism');
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const ico = path.join(HERE, '..', 'icon.ico');
    const { activate } = require(path.join(APP_DIR, 'main.cjs'));
    prism = activate({
      appId: 'prism',
      version: manifest.version,
      appDir: APP_DIR,
      dataDir: app.getPath('userData'),
      icon: path.join(HERE, '..', 'icon.png'),
      // Windows needs a real file for registry icons; inside the packaged app the exe carries the icon
      ico: app.isPackaged ? null : ico,
      standalone: true,
      launchCommand: () => (app.isPackaged ? { exe, args: [] } : { exe: process.execPath, args: [__filename] }),
    });
    prism.open(argsFrom(process.argv));
  });
  app.on('window-all-closed', () => app.quit());
}
