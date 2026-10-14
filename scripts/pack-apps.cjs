// Packages each suite app into release/apps/<id>-<version>.zip and writes the catalog the launcher reads.
//
//   node scripts/pack-apps.cjs                 -> catalog.json (repo root) pointing at GitHub release assets
//   node scripts/pack-apps.cjs --base <url>    -> release/apps/catalog.json pointing at <url><file> (local testing)
//
// Run `npm run build` first so dist/<id>/index.html is up to date (`npm run pack:apps` does both).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeZip } = require('../electron/zip.cjs');

const ROOT = path.join(__dirname, '..');
const REPO = 'Enqrypted/crystal-suite';
const APPS = ['photon'];
const OUT = path.join(ROOT, 'release', 'apps');

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

for (const id of APPS) {
  const appDir = path.join(ROOT, 'apps', id);
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
  const html = path.join(ROOT, 'dist', id, 'index.html');
  if (!fs.existsSync(html)) throw new Error(`${html} is missing - run "npm run build" first.`);
  const entries = [
    { name: 'index.html', data: fs.readFileSync(html) },
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
