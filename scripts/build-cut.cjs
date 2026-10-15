// Builds Cut into dist/cut: main.cjs + preload.cjs (esbuild) and web/ (vite).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'apps', 'cut', 'src');
const OUT = path.join(ROOT, 'dist', 'cut');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const common = { bundle: true, format: 'cjs', target: 'node20', external: ['electron'], logLevel: 'warning', legalComments: 'inline', charset: 'utf8' };
  await Promise.all([
    esbuild.build({ ...common, platform: 'node', entryPoints: [path.join(SRC, 'main', 'index.ts')], outfile: path.join(OUT, 'main.cjs') }),
    esbuild.build({ ...common, platform: 'browser', entryPoints: [path.join(SRC, 'preload.ts')], outfile: path.join(OUT, 'preload.cjs') }),
  ]);
  const { build } = await import('vite');
  await build({ configFile: path.join(ROOT, 'vite.cut.config.ts') });
  console.log('Cut built -> dist/cut');
})().catch((e) => { console.error(e); process.exit(1); });
