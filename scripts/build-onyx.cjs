// Builds Onyx into dist/onyx: main.cjs + preload.cjs (esbuild), web/ (vite) and OnyxHelper.exe (compiled with
// the C# compiler that ships with Windows' .NET Framework 4.x).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'onyx');
const SRC = path.join(APP, 'src');
const OUT = path.join(ROOT, 'dist', 'onyx');

function csc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const p = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  return fs.existsSync(p) ? p : null;
}

function buildHelper() {
  const dir = path.join(APP, 'native');
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.cs')).map((f) => path.join(dir, f));
  const exe = path.join(OUT, 'OnyxHelper.exe');
  const compiler = csc();
  if (!compiler) {
    if (fs.existsSync(exe)) { console.warn('Onyx: no C# compiler found, keeping the existing OnyxHelper.exe'); return; }
    throw new Error('OnyxHelper.exe needs the 64-bit .NET Framework 4 C# compiler (csc.exe), which ships with Windows.');
  }
  // screen capture (Windows.Graphics.Capture) through the metadata every Windows 10/11 has; Media Foundation and
  // Direct3D through COM. 64-bit, as the GPU drivers' encoders are.
  const fw = path.dirname(compiler);
  const winmd = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WinMetadata');
  const refs = [path.join(fw, 'System.Runtime.dll'), ...['Foundation', 'Graphics'].map((n) => path.join(winmd, `Windows.${n}.winmd`))];
  execFileSync(compiler, ['-nologo', '-target:winexe', '-optimize+', '-platform:x64', `-out:${exe}`,
    ...refs.map((r) => `-r:${r}`), ...sources], { stdio: ['ignore', 'pipe', 'inherit'] });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const common = { bundle: true, format: 'cjs', target: 'node20', external: ['electron'], logLevel: 'warning', legalComments: 'inline', charset: 'utf8' };
  await Promise.all([
    esbuild.build({ ...common, platform: 'node', entryPoints: [path.join(SRC, 'main', 'index.ts')], outfile: path.join(OUT, 'main.cjs') }),
    esbuild.build({ ...common, platform: 'browser', entryPoints: [path.join(SRC, 'preload.ts')], outfile: path.join(OUT, 'preload.cjs') }),
  ]);
  const { build } = await import('vite');
  await build({ configFile: path.join(ROOT, 'vite.onyx.config.ts') });
  buildHelper();
  console.log('Onyx built -> dist/onyx');
})().catch((e) => { console.error(e.stdout ? e.stdout.toString() : e); process.exit(1); });
