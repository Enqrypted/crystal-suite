// Packages each suite app into release/apps/<id>-<version>.zip and writes the catalog the launcher reads.
//
//   node scripts/pack-apps.cjs                 -> catalog.json (repo root) pointing at GitHub release assets
//   node scripts/pack-apps.cjs --base <url>    -> release/apps/catalog.json pointing at <url><file> (local testing)
//
// Run `npm run build` first so dist/ is up to date (`npm run pack:apps` does both).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeZip } = require('../electron/zip.cjs');

const ROOT = path.join(__dirname, '..');
const REPO = 'Enqrypted/crystal-suite';
const OUT = path.join(ROOT, 'release', 'apps');

/** Every file under `dir`, as zip entries named relative to it (prefixed with `prefix`). */
function tree(dir, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tree(p, `${prefix}${e.name}/`));
    else out.push({ name: prefix + e.name, data: fs.readFileSync(p) });
  }
  return out;
}

/** The files of each app's package (besides app.json, icons and the licence, which all get). */
const CONTENTS = {
  // a page app: one self-contained HTML file
  photon: () => [{ name: 'index.html', data: fs.readFileSync(need(path.join(ROOT, 'dist', 'photon', 'index.html'))) }],
  // a module app: main-process code, preloads, web UI and the filter-list snapshot
  prism: () => {
    need(path.join(ROOT, 'dist', 'prism', 'main.cjs'));
    return [
      ...tree(path.join(ROOT, 'dist', 'prism')),
      { name: 'THIRD_PARTY_NOTICES.md', data: fs.readFileSync(path.join(ROOT, 'apps', 'prism', 'THIRD_PARTY_NOTICES.md')) },
    ];
  },
  // a module app: main process + preload + the editor UI
  cut: () => {
    need(path.join(ROOT, 'dist', 'cut', 'main.cjs'));
    return [
      ...tree(path.join(ROOT, 'dist', 'cut')),
      { name: 'THIRD_PARTY_NOTICES.md', data: fs.readFileSync(path.join(ROOT, 'apps', 'cut', 'THIRD_PARTY_NOTICES.md')) },
    ];
  },
  // a module app: main process + preload + the desktop layer and window UI + FacetHelper.exe
  facet: () => {
    need(path.join(ROOT, 'dist', 'facet', 'main.cjs'));
    need(path.join(ROOT, 'dist', 'facet', 'FacetHelper.exe'));
    return tree(path.join(ROOT, 'dist', 'facet'));
  },
};

function need(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing - run "npm run build" first.`);
  return file;
}

const argv = process.argv.slice(2);
const baseIdx = argv.indexOf('--base');
const base = baseIdx >= 0 ? argv[baseIdx + 1] : '';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const catalog = {
  schema: 1,
  launcher: { version: pkg.version, url: `https://github.com/${REPO}/releases/latest` },
  apps: [],
};

for (const id of Object.keys(CONTENTS)) {
  const appDir = path.join(ROOT, 'apps', id);
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
  const entries = [
    ...CONTENTS[id](),
    { name: 'app.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
    { name: 'icon.png', data: fs.readFileSync(path.join(appDir, 'icon.png')) },
    { name: 'icon.ico', data: fs.readFileSync(path.join(appDir, 'icon.ico')) },
    { name: 'LICENSE', data: fs.readFileSync(path.join(ROOT, 'LICENSE')) },
  ];
  const zip = writeZip(entries);
  const file = `${id}-${manifest.version}.zip`;
  fs.writeFileSync(path.join(OUT, file), zip);
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  catalog.apps.push({
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    // how the launcher draws the app before it's installed (launchers that don't know the app yet)
    badge: manifest.badge,
    color: manifest.color,
    bg: manifest.bg,
    url: base ? base + file : `https://github.com/${REPO}/releases/download/${id}-v${manifest.version}/${file}`,
    size: zip.length,
    sha256,
    minLauncher: manifest.minLauncher,
    notes: manifest.notes || '',
  });
  console.log(`${file}  ${(zip.length / 1024).toFixed(0)} KB  sha256 ${sha256}`);
}

const json = JSON.stringify(catalog, null, 2) + '\n';
fs.writeFileSync(path.join(OUT, 'catalog.json'), json);
if (!base) fs.writeFileSync(path.join(ROOT, 'catalog.json'), json);
console.log(base ? `catalog -> ${path.join(OUT, 'catalog.json')}` : 'catalog -> catalog.json (commit it to publish the release)');
