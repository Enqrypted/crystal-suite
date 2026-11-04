// Builds Opal into dist/opal: main.cjs + preload.cjs (esbuild), web/ (vite) and libheif, the HEIC decoder,
// which stays a separate, unmodified pair of files (web/libheif/libheif.js + libheif.wasm) with its licence.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'apps', 'opal', 'src');
const OUT = path.join(ROOT, 'dist', 'opal');
const LIBHEIF = path.join(path.dirname(require.resolve('libheif-js/package.json')), 'libheif-wasm');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const common = { bundle: true, format: 'cjs', target: 'node20', external: ['electron'], logLevel: 'warning', legalComments: 'inline', charset: 'utf8' };
  await Promise.all([
    esbuild.build({ ...common, platform: 'node', entryPoints: [path.join(SRC, 'main', 'index.ts')], outfile: path.join(OUT, 'main.cjs') }),
    esbuild.build({ ...common, platform: 'browser', entryPoints: [path.join(SRC, 'preload.ts')], outfile: path.join(OUT, 'preload.cjs') }),
  ]);
  const { build } = await import('vite');
  await build({ configFile: path.join(ROOT, 'vite.opal.config.ts') });
  const heif = path.join(OUT, 'web', 'libheif');
  fs.mkdirSync(heif, { recursive: true });
  for (const f of ['libheif.js', 'libheif.wasm', 'LICENSE']) fs.copyFileSync(path.join(LIBHEIF, f), path.join(heif, f));
  console.log('Opal built -> dist/opal');
})().catch((e) => { console.error(e); process.exit(1); });
