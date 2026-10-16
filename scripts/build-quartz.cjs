// Builds Quartz into dist/quartz: main.cjs + preload.cjs (esbuild), web/ (vite) and the PDF.js data files
// it loads on demand (character maps, the standard fonts, image decoders, annotation icons).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'apps', 'quartz', 'src');
const OUT = path.join(ROOT, 'dist', 'quartz');
const PDFJS = path.dirname(require.resolve('pdfjs-dist/package.json'));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const common = { bundle: true, format: 'cjs', target: 'node20', external: ['electron'], logLevel: 'warning', legalComments: 'inline', charset: 'utf8' };
  await Promise.all([
    esbuild.build({ ...common, platform: 'node', entryPoints: [path.join(SRC, 'main', 'index.ts')], outfile: path.join(OUT, 'main.cjs') }),
    esbuild.build({ ...common, platform: 'browser', entryPoints: [path.join(SRC, 'preload.ts')], outfile: path.join(OUT, 'preload.cjs') }),
  ]);
  const { build } = await import('vite');
  await build({ configFile: path.join(ROOT, 'vite.quartz.config.ts') });
  for (const [from, to] of [['cmaps', 'cmaps'], ['standard_fonts', 'standard_fonts'], ['wasm', 'wasm'], ['legacy/web/images', 'images']]) {
    // QuickJS only runs PDF scripts (PDF.js's scripting sandbox), which Quartz doesn't enable
    fs.cpSync(path.join(PDFJS, from), path.join(OUT, 'web', 'pdfjs', to), { recursive: true, filter: (src) => !/quickjs/i.test(path.basename(src)) });
  }
  // PDF.js's own licence travels with the data files
  fs.copyFileSync(path.join(PDFJS, 'LICENSE'), path.join(OUT, 'web', 'pdfjs', 'LICENSE'));
  console.log('Quartz built -> dist/quartz');
})().catch((e) => { console.error(e); process.exit(1); });
