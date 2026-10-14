// Builds the standalone Prism installers: release/prism/Prism-Setup-<v>.exe and Prism-Portable-<v>.exe.
// The same browser code is also installable from the Crystal Suite launcher (see pack-apps.cjs).
// Run `npm run build:prism` first (`npm run dist:prism` does both).
const fs = require('fs');
const path = require('path');
const builder = require('electron-builder');

const ROOT = path.join(__dirname, '..');
require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'patch-nsis-template.cjs')], { stdio: 'inherit' }); // same installer fix as Crystal Suite's
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'prism', 'app.json'), 'utf8'));
if (!fs.existsSync(path.join(ROOT, 'dist', 'prism', 'main.cjs'))) throw new Error('Run "npm run build:prism" first.');

builder.build({
  projectDir: ROOT,
  targets: builder.Platform.WINDOWS.createTarget(['nsis', 'portable'], builder.Arch.x64),
  config: {
    appId: 'app.crystalsuite.prism',
    productName: 'Prism',
    copyright: 'Copyright (c) 2026 Crystal Suite contributors. MIT License.',
    directories: { output: 'release/prism', buildResources: 'build' },
    files: ['apps/prism/standalone/**', 'apps/prism/app.json', 'apps/prism/icon.png', 'apps/prism/icon.ico', 'apps/prism/THIRD_PARTY_NOTICES.md', 'dist/prism/**', 'package.json'],
    extraMetadata: {
      name: 'prism', productName: 'Prism', version: manifest.version,
      description: 'Prism - a clean, private web browser from Crystal Suite.', main: 'apps/prism/standalone/main.cjs',
    },
    electronDist: 'node_modules/electron/dist',
    electronVersion: '33.2.0',
    asar: true,
    electronLanguages: ['en-US'],
    win: { icon: 'apps/prism/icon.ico' },
    nsis: {
      oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'Prism',
      include: 'build/prism-installer.nsh',
      installerIcon: 'apps/prism/icon.ico', uninstallerIcon: 'apps/prism/icon.ico',
      artifactName: 'Prism-Setup-${version}.${ext}',
    },
    portable: { artifactName: 'Prism-Portable-${version}.${ext}', splashImage: 'build/prism-splash.bmp' },
  },
}).then((files) => {
  for (const f of files) if (/\.exe$/.test(f)) console.log(path.relative(ROOT, f), `${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
}).catch((e) => { console.error(e); process.exit(1); });
