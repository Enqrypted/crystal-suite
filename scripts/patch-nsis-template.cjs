// Works around an electron-builder NSIS template bug that makes Setup crash on launch.
//
// templates/nsis/multiUser.nsh (setInstallModePerUser) asks Windows for the per-user Programs
// folder, then copies NSIS_MAX_STRLEN wide characters out of the returned (much shorter) string:
//   System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'
// That reads far past the end of the allocation and intermittently crashes the installer with
// 0xc0000005 in System.dll before its window appears ("the setup exe doesn't open").
// The value is discarded anyway (System::Store L restores $0 right after), so the block is removed.
// Runs automatically before `npm run dist` and after `npm install`.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'multiUser.nsh');
const MARK = '; photon-patch: removed out-of-bounds SHGetKnownFolderPath read (see scripts/patch-nsis-template.cjs)';

if (!fs.existsSync(file)) {
  console.log('[patch-nsis] electron-builder not installed yet; skipping');
  process.exit(0);
}
let s = fs.readFileSync(file, 'utf8');
if (s.includes(MARK)) {
  console.log('[patch-nsis] NSIS template already patched');
  process.exit(0);
}
const block = /([ \t]*)System::Store S\r?\n[\s\S]*?SHGetKnownFolderPath[\s\S]*?System::Store L\r?\n/;
if (!block.test(s)) {
  console.warn('[patch-nsis] WARNING: electron-builder\'s multiUser.nsh changed; patch not applied. Check that Setup still opens reliably.');
  process.exit(0);
}
s = s.replace(block, (_m, indent) => `${indent}${MARK}\n`);
fs.writeFileSync(file, s);
console.log('[patch-nsis] patched', path.relative(process.cwd(), file));
