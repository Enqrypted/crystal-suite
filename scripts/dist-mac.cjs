// Builds Crystal Suite for macOS: release/CrystalSuite-<v>-arm64.dmg (Apple silicon) and -x64.dmg (Intel).
// Runs on a Mac (the .app bundle needs macOS tools); .github/workflows/mac.yml builds it on GitHub's Mac runners.
//
// There is no Apple Developer ID, so electron-builder's signing is off and the finished app is signed ad hoc
// ("codesign --sign -"): Apple silicon only runs signed code, and an ad-hoc signature is enough for that. The app
// isn't notarized, so the first launch needs the user's OK (System Settings › Privacy & Security › Open Anyway).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const builder = require('electron-builder');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const archs = (process.env.MAC_ARCHS || 'arm64,x64').split(',').map((a) => builder.Arch[a.trim()]);

builder.build({
  projectDir: ROOT,
  targets: builder.Platform.MAC.createTarget(['dmg'], ...archs),
  config: {
    appId: 'app.crystalsuite.suite',
    productName: 'Crystal Suite',
    copyright: pkg.build.copyright,
    directories: { output: 'release', buildResources: 'build' },
    files: ['electron/**/*', 'package.json'],
    electronVersion: pkg.build.electronVersion,
    asar: true,
    electronLanguages: ['en'],
    mac: {
      icon: 'build/suite-mac.png',
      category: 'public.app-category.graphics-design',
      identity: null, // signed ad hoc in afterPack instead
      target: ['dmg'],
      darkModeSupport: true,
      minimumSystemVersion: '11.0',
      extendInfo: { NSHumanReadableCopyright: pkg.build.copyright },
    },
    dmg: { artifactName: 'CrystalSuite-${version}-${arch}.${ext}', title: 'Crystal Suite ${version}' },
    // Photon projects open from Finder; other images keep their usual app
    fileAssociations: [{ ext: 'phtn', name: 'Photon Project', description: 'Photon Project', role: 'Editor' }],
    afterPack: async (ctx) => {
      const appPath = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
      execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
      console.log('ad-hoc signed', appPath);
    },
  },
}).then((files) => {
  for (const f of files) if (/\.dmg$/.test(f)) console.log(path.relative(ROOT, f), `${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
}).catch((e) => { console.error(e); process.exit(1); });
