// Builds Prism into dist/prism:
//   main.cjs, adblock-worker.cjs, preload-ui.cjs, preload-tab.cjs  (esbuild)
//   web/                                                           (vite: browser UI + prism:// pages)
//   adblock.bin                                                    (filter-list snapshot, so blocking works offline on first run)
// `--lists` forces a fresh filter-list snapshot (otherwise an existing one less than 3 days old is kept).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'apps', 'prism', 'src');
const OUT = path.join(ROOT, 'dist', 'prism');

async function bundle() {
  const common = { bundle: true, format: 'cjs', target: 'node20', external: ['electron'], logLevel: 'warning', legalComments: 'inline', charset: 'utf8' };
  await Promise.all([
    esbuild.build({ ...common, platform: 'node', entryPoints: [path.join(SRC, 'main', 'index.ts')], outfile: path.join(OUT, 'main.cjs') }),
    esbuild.build({ ...common, platform: 'node', entryPoints: [path.join(SRC, 'main', 'adblock-worker.ts')], outfile: path.join(OUT, 'adblock-worker.cjs') }),
    esbuild.build({ ...common, platform: 'browser', entryPoints: [path.join(SRC, 'preload', 'ui.ts')], outfile: path.join(OUT, 'preload-ui.cjs') }),
    esbuild.build({ ...common, platform: 'browser', entryPoints: [path.join(SRC, 'preload', 'tab.ts')], outfile: path.join(OUT, 'preload-tab.cjs') }),
  ]);
}

async function web() {
  const { build } = await import('vite');
  await build({ configFile: path.join(ROOT, 'vite.prism.config.ts') });
}

async function adblockSnapshot(force) {
  const file = path.join(OUT, 'adblock.bin');
  if (!force && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 3 * 86400000) return;
  const { FiltersEngine, adsAndTrackingLists } = require('@ghostery/adblocker');
  try {
    const engine = await FiltersEngine.fromLists(fetch, adsAndTrackingLists, { loadCosmeticFilters: true, loadNetworkFilters: true, enableMutationObserver: true });
    const bin = engine.serialize();
    fs.writeFileSync(file, bin);
    console.log(`adblock.bin  ${(bin.length / 1048576).toFixed(1)} MB`);
  } catch (e) {
    console.warn(`Could not download the filter lists (${e.message}). Prism will fetch them on first run.`);
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await bundle();
  await web();
  await adblockSnapshot(process.argv.includes('--lists'));
  console.log('Prism built -> dist/prism');
})().catch((e) => { console.error(e); process.exit(1); });
