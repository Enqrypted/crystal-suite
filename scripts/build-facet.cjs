// Builds Facet into dist/facet: main.cjs + preload.cjs (esbuild), web/ (vite) and FacetHelper.exe
// (compiled with the C# compiler that ships with Windows' .NET Framework 4.x).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'facet');
const SRC = path.join(APP, 'src');
const OUT = path.join(ROOT, 'dist', 'facet');

function csc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(windir, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function buildHelper() {
  const src = path.join(APP, 'native', 'FacetHelper.cs');
  const exe = path.join(OUT, 'FacetHelper.exe');
  const compiler = csc();
  if (!compiler) {
    if (fs.existsSync(exe)) { console.warn('Facet: no C# compiler found, keeping the existing FacetHelper.exe'); return; }
    throw new Error('FacetHelper.exe needs the .NET Framework 4 C# compiler (csc.exe), which ships with Windows.');
  }
  execFileSync(compiler, ['-nologo', '-target:winexe', '-optimize+', '-platform:anycpu', `-out:${exe}`,
    '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', src], { stdio: ['ignore', 'pipe', 'inherit'] });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const common = { bundle: true, format: 'cjs', target: 'node20', external: ['electron'], logLevel: 'warning', legalComments: 'inline', charset: 'utf8' };
  await Promise.all([
    esbuild.build({ ...common, platform: 'node', entryPoints: [path.join(SRC, 'main', 'index.ts')], outfile: path.join(OUT, 'main.cjs') }),
    esbuild.build({ ...common, platform: 'browser', entryPoints: [path.join(SRC, 'preload.ts')], outfile: path.join(OUT, 'preload.cjs') }),
  ]);
  const { build } = await import('vite');
  await build({ configFile: path.join(ROOT, 'vite.facet.config.ts') });
  buildHelper();
  console.log('Facet built -> dist/facet');
})().catch((e) => { console.error(e.stdout ? e.stdout.toString() : e); process.exit(1); });
