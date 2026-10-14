// File menu: new / open / save / export. Works in Electron (native dialogs), Chromium
// (File System Access API) and any browser (input + download fallback).
import { readPsd, writePsd, Psd, Layer as PsdLayer, BlendMode as PsdBlend } from 'ag-psd';
import { app, APP_NAME } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { Layer, BlendMode, LayerKind } from '../core/layer';
import { createCanvas, ctx2d, canvasToBlob, downloadBlob, RGB, cssColor, loadImage, getImageData, uid } from '../core/util';
import { flattenLayers, renderedLayer } from '../core/compositor';
import { buildTree, LayerNode } from '../core/groups';
import { hasActiveStyle } from '../core/effects';
import { renderTextLayer } from '../core/text';
import { renderShapeLayer } from '../core/shapes';
import { openDialog, alertDialog, confirmDialog } from '../dialogs/dialog';
import { h, clear } from '../ui/dom';
import { textInput, numberInput, select, toast, colorSwatch, sliderField, segmented, checkbox } from '../ui/widgets';
import { renderFillLayer } from './layerops';
import { alphaToGray, grayToAlpha } from './target';
import { resampleCanvas } from './imageops';

// ---------- native bridge ----------
interface NativeFile { name: string; path?: string; data: ArrayBuffer }
interface NativeBridge {
  openFiles(filters: { name: string; extensions: string[] }[]): Promise<NativeFile[]>;
  saveFile(o: { defaultPath: string; filters: { name: string; extensions: string[] }[]; data: ArrayBuffer }): Promise<{ path: string; name: string } | null>;
  writeFile(path: string, data: ArrayBuffer): Promise<boolean>;
  readFile(path: string): Promise<NativeFile | null>;
  setTitle?(t: string): void;
}
const native: NativeBridge | undefined = (window as any).photonNative;
export const isElectron = !!native;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
const OPEN_FILTERS = [
  { name: 'All Supported', extensions: ['psd', 'phtn', ...IMAGE_EXT] },
  { name: 'Photoshop (PSD)', extensions: ['psd'] },
  { name: 'Photon Project', extensions: ['phtn'] },
  { name: 'Images', extensions: IMAGE_EXT },
];

async function pickFiles(multiple = true): Promise<NativeFile[]> {
  if (native) return native.openFiles(OPEN_FILTERS);
  if ((window as any).showOpenFilePicker) {
    try {
      const handles = await (window as any).showOpenFilePicker({
        multiple,
        types: [{ description: 'Images & Photoshop documents', accept: { 'image/*': IMAGE_EXT.map((e) => `.${e}`), 'application/octet-stream': ['.psd', '.phtn'] } }],
      });
      const out: NativeFile[] = [];
      for (const hd of handles) { const f = await hd.getFile(); out.push({ name: f.name, data: await f.arrayBuffer(), ...{ handle: hd } } as any); }
      return out;
    } catch (e: any) { if (e?.name === 'AbortError') return []; }
  }
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', multiple, accept: ['.psd', '.phtn', ...IMAGE_EXT.map((e) => `.${e}`)].join(',') }) as HTMLInputElement;
    inp.addEventListener('change', async () => {
      const files = Array.from(inp.files ?? []);
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))));
    });
    inp.click();
  });
}

// ---------- new document ----------
export interface NewDocOpts { name: string; width: number; height: number; resolution: number; background: 'white' | 'black' | 'bg' | 'transparent' | 'custom'; custom?: RGB }

export function newDocument(o: NewDocOpts): Doc {
  const d = new Doc(o.name, Math.round(o.width), Math.round(o.height));
  d.resolution = o.resolution;
  d.historyBaseName = 'New';
  if (o.background === 'transparent') {
    const L = d.newLayer('Layer 1');
    d.layers.push(L);
  } else {
    const L = d.newLayer('Background');
    const c: RGB = o.background === 'white' ? { r: 255, g: 255, b: 255 } : o.background === 'black' ? { r: 0, g: 0, b: 0 } : o.background === 'bg' ? app.bg : o.custom ?? { r: 255, g: 255, b: 255 };
    const x = ctx2d(L.canvas);
    x.fillStyle = cssColor(c);
    x.fillRect(0, 0, d.width, d.height);
    L.isBackground = true; L.lockAlpha = true; L.lockPosition = true;
    d.layers.push(L);
  }
  d.activeId = d.layers[d.layers.length - 1].id;
  app.addDoc(d);
  d.takeSnapshot(d.name);
  bus.emit('history', d);
  return d;
}

interface Preset { name: string; w: number; h: number; res: number; unit?: 'px' | 'in' | 'mm' }
export const NEW_PRESETS: Record<string, Preset[]> = {
  Photo: [
    { name: 'Default Photoshop Size', w: 1920, h: 1080, res: 72 }, { name: 'Landscape, 6 × 4', w: 1800, h: 1200, res: 300 },
    { name: 'Portrait, 4 × 6', w: 1200, h: 1800, res: 300 }, { name: 'Landscape, 7 × 5', w: 2100, h: 1500, res: 300 },
    { name: 'Square, 8 × 8', w: 2400, h: 2400, res: 300 }, { name: 'Landscape, 10 × 8', w: 3000, h: 2400, res: 300 },
  ],
  Print: [
    { name: 'Letter', w: 2550, h: 3300, res: 300 }, { name: 'Legal', w: 2550, h: 4200, res: 300 }, { name: 'Tabloid', w: 3300, h: 5100, res: 300 },
    { name: 'A4', w: 2480, h: 3508, res: 300 }, { name: 'A3', w: 3508, h: 4961, res: 300 }, { name: 'A5', w: 1748, h: 2480, res: 300 },
  ],
  'Art & Illustration': [
    { name: 'Poster', w: 5400, h: 7200, res: 300 }, { name: 'Postcard', w: 1748, h: 1240, res: 300 }, { name: 'Comic Page', w: 1988, h: 3075, res: 300 },
    { name: 'Square 2048', w: 2048, h: 2048, res: 150 },
  ],
  Web: [
    { name: 'Web Large', w: 1920, h: 1080, res: 72 }, { name: 'Web Medium', w: 1440, h: 900, res: 72 }, { name: 'Web Small', w: 1024, h: 768, res: 72 },
    { name: 'Instagram Post', w: 1080, h: 1080, res: 72 }, { name: 'Instagram Story', w: 1080, h: 1920, res: 72 }, { name: 'YouTube Thumbnail', w: 1280, h: 720, res: 72 },
    { name: 'Facebook Cover', w: 1640, h: 624, res: 72 }, { name: 'X Header', w: 1500, h: 500, res: 72 }, { name: 'Icon 512', w: 512, h: 512, res: 72 },
  ],
  Mobile: [
    { name: 'iPhone 15 Pro', w: 1179, h: 2556, res: 72 }, { name: 'iPhone 15 Pro Max', w: 1290, h: 2796, res: 72 }, { name: 'Android 1080p', w: 1080, h: 1920, res: 72 },
    { name: 'iPad Pro 12.9"', w: 2048, h: 2732, res: 72 }, { name: 'Apple Watch 45mm', w: 396, h: 484, res: 72 },
  ],
  'Film & Video': [
    { name: 'HDTV 1080p', w: 1920, h: 1080, res: 72 }, { name: 'HDV 720p', w: 1280, h: 720, res: 72 }, { name: 'UHD 4K', w: 3840, h: 2160, res: 72 },
    { name: 'DCI 4K', w: 4096, h: 2160, res: 72 }, { name: 'UHD 8K', w: 7680, h: 4320, res: 72 },
  ],
};

export async function newDocumentDialog() {
  const name = textInput({ value: `Untitled-${app.untitledCounter}`, width: 240 });
  name.input.classList.add('big');
  let unit: 'px' | 'in' | 'cm' = 'px';
  let W = 1920, H = 1080, res = 72;
  const conv = (px: number) => unit === 'px' ? px : unit === 'in' ? px / res : (px / res) * 2.54;
  const back = (v: number) => unit === 'px' ? v : unit === 'in' ? v * res : (v / 2.54) * res;
  const wIn = numberInput({ value: W, min: 1, max: 30000, decimals: 2, width: 110, onChange: (v) => { W = Math.round(back(v)); } });
  const hIn = numberInput({ value: H, min: 1, max: 30000, decimals: 2, width: 110, onChange: (v) => { H = Math.round(back(v)); } });
  const unitSel = select({ options: [{ value: 'px', label: 'Pixels' }, { value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimeters' }], value: 'px', width: 110, onChange: (v) => { unit = v as any; wIn.set(conv(W)); hIn.set(conv(H)); } });
  const resIn = numberInput({ value: res, min: 1, max: 9999, width: 70, onChange: (v) => { res = v; } });
  let custom: RGB = { r: 255, g: 255, b: 255 };
  const sw = colorSwatch({ color: custom, onChange: (c) => { custom = c; bgSel.set('custom'); } });
  const bgSel = select({ options: [{ value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'bg', label: 'Background Color' }, { value: 'transparent', label: 'Transparent' }, { value: 'custom', label: 'Custom...' }], value: 'white', width: 170 });
  const orient = segmented({ value: 'land', options: [{ value: 'port', label: 'Portrait' }, { value: 'land', label: 'Landscape' }], onChange: (v) => {
    if ((v === 'port') !== (H > W)) { [W, H] = [H, W]; wIn.set(conv(W)); hIn.set(conv(H)); }
  } });
  const setPreset = (p: Preset) => { W = p.w; H = p.h; res = p.res; wIn.set(conv(W)); hIn.set(conv(H)); resIn.set(res); orient.set(H > W ? 'port' : 'land'); };

  const presetsEl = h('div', { class: 'nd-presets' });
  const cats = h('div', { class: 'nd-cats' });
  const showCat = (cat: string) => {
    cats.querySelectorAll('.nd-cat').forEach((c) => c.classList.toggle('active', c.textContent === cat));
    clear(presetsEl);
    const list = cat === 'Recent' ? recentPresets() : NEW_PRESETS[cat];
    for (const p of list) {
      const s = Math.min(60 / p.w, 46 / p.h);
      const card = h('div', { class: 'nd-preset' },
        h('div', { class: 'shape', style: { width: `${Math.max(8, p.w * s)}px`, height: `${Math.max(8, p.h * s)}px` } }),
        h('div', { class: 'nm' }, p.name), h('div', { class: 'dim' }, `${p.w} × ${p.h} px @ ${p.res} ppi`));
      card.addEventListener('click', () => { presetsEl.querySelectorAll('.nd-preset').forEach((e) => e.classList.remove('active')); card.classList.add('active'); setPreset(p); });
      card.addEventListener('dblclick', () => { setPreset(p); (document.querySelector('.dlg-overlay:last-of-type .ps-btn.primary') as HTMLElement)?.click(); });
      presetsEl.appendChild(card);
    }
  };
  for (const c of ['Recent', ...Object.keys(NEW_PRESETS)]) cats.appendChild(h('div', { class: 'nd-cat', onclick: () => showCat(c) }, c));
  showCat(recentPresets().length ? 'Recent' : 'Photo');

  const content = h('div', { class: 'nd' },
    h('div', null, cats, presetsEl),
    h('div', { class: 'nd-details' },
      h('h3', null, 'Preset Details'), name.el,
      h('div', { class: 'field-label' }, 'Width'), h('div', { class: 'row' }, wIn.el, unitSel.el),
      h('div', { class: 'field-label' }, 'Height'), h('div', { class: 'row' }, hIn.el, orient.el),
      h('div', { class: 'field-label' }, 'Resolution'), h('div', { class: 'row' }, resIn.el, h('span', { class: 'field-label' }, 'Pixels/Inch')),
      h('div', { class: 'field-label' }, 'Color Mode'), h('div', { class: 'row' }, select({ options: ['RGB Color'], value: 'RGB Color', width: 130 }).el, select({ options: ['8 bit'], value: '8 bit', width: 70 }).el),
      h('div', { class: 'field-label' }, 'Background Contents'), h('div', { class: 'row' }, bgSel.el, sw.el)));
  const ok = await openDialog({ title: 'New Document', width: 860, content, okLabel: 'Create', onOpen: () => name.input.select() });
  if (!ok) return;
  app.untitledCounter++;
  addRecentPreset({ name: `${W} × ${H} px`, w: W, h: H, res });
  newDocument({ name: name.get() || 'Untitled', width: W, height: H, resolution: res, background: bgSel.get() as any, custom });
}
function recentPresets(): Preset[] { try { return JSON.parse(localStorage.getItem('photon.recentSizes') || '[]'); } catch { return []; } }
function addRecentPreset(p: Preset) {
  const list = recentPresets().filter((r) => r.w !== p.w || r.h !== p.h);
  list.unshift(p);
  try { localStorage.setItem('photon.recentSizes', JSON.stringify(list.slice(0, 8))); } catch { /* ignore */ }
}

// ---------- open ----------
export async function openFiles() {
  const files = await pickFiles(true);
  for (const f of files) await openFileData(f.name, f.data, (f as any).handle, f.path);
}
export async function openPath(path: string) {
  if (!native) return;
  const f = await native.readFile(path);
  if (f) await openFileData(f.name, f.data, undefined, f.path);
  else toast(`Could not open ${path}`);
}

export async function openFileData(name: string, data: ArrayBuffer, handle?: any, path?: string): Promise<Doc | null> {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  try {
    let doc: Doc;
    if (ext === 'psd' || ext === 'psb') doc = loadPsd(name, data);
    else if (ext === 'phtn') doc = await loadProject(name, data);
    else doc = await loadImageDoc(name, data, ext);
    doc.fileHandle = handle ?? null;
    doc.filePath = path ?? null;
    doc.fileFormat = ext === 'psd' || ext === 'phtn' ? ext : 'image';
    app.addDoc(doc);
    doc.takeSnapshot(name);
    bus.emit('history', doc);
    addRecentFile(name, path);
    return doc;
  } catch (e: any) {
    console.error(e);
    await alertDialog(APP_NAME, `Could not open “${name}” because it is not a supported file or it is damaged.\n\n${e?.message ?? ''}`);
    return null;
  }
}

async function decodeImage(data: ArrayBuffer, ext: string): Promise<HTMLCanvasElement> {
  const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const blob = new Blob([data], { type });
  let w: number, hh: number, src: CanvasImageSource;
  if (ext === 'svg') {
    const img = await loadImage(URL.createObjectURL(blob));
    w = img.naturalWidth || 1024; hh = img.naturalHeight || 1024; src = img;
  } else {
    const bmp = await createImageBitmap(blob);
    w = bmp.width; hh = bmp.height; src = bmp;
  }
  const c = createCanvas(w, hh);
  ctx2d(c).drawImage(src, 0, 0, w, hh);
  return c;
}

async function loadImageDoc(name: string, data: ArrayBuffer, ext: string): Promise<Doc> {
  const c = await decodeImage(data, ext);
  return openCanvasAsDocument(c, name, false);
}

/** Create (and by default activate) a document from a canvas. */
export function openCanvasAsDocument(c: HTMLCanvasElement, name: string, add = true): Doc {
  const d = new Doc(name, c.width, c.height);
  const L = new Layer('Background', 1, 1);
  L.canvas = c;
  // opaque images open as a locked Background like Photoshop; images with alpha as Layer 0
  const d0 = getImageData(c).data;
  let opaque = true;
  for (let i = 3; i < d0.length; i += 4 * 7) if (d0[i] < 255) { opaque = false; break; }
  if (opaque) { L.isBackground = true; L.lockAlpha = true; L.lockPosition = true; } else L.name = 'Layer 0';
  d.layers.push(L);
  d.activeId = L.id;
  if (add) { app.addDoc(d); d.takeSnapshot(name); bus.emit('history', d); }
  return d;
}

/** File > Place Embedded: add an image file as a new layer. */
export async function placeEmbedded() {
  const doc = app.doc;
  if (!doc) { openFiles(); return; }
  const files = await pickFiles(false);
  const f = files[0];
  if (!f) return;
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  let c: HTMLCanvasElement;
  if (ext === 'psd') { const p = readPsd(f.data, { skipLayerImageData: true }); c = p.canvas ?? createCanvas(p.width, p.height); }
  else c = await decodeImage(f.data, ext);
  // fit inside the document like Photoshop's Place
  const s = Math.min(1, doc.width / c.width, doc.height / c.height);
  if (s < 1) c = resampleCanvas(c, c.width * s, c.height * s);
  const { pasteCanvas } = await import('./editops');
  pasteCanvas(c, undefined, f.name.replace(/\.[^.]+$/, ''));
}

// ---------- PSD ----------
const toPsdBlend = (b: BlendMode): PsdBlend => b.replace(/-/g, ' ') as PsdBlend;
const fromPsdBlend = (b?: PsdBlend): BlendMode => (b && b !== 'pass through' ? b.replace(/ /g, '-') : 'normal') as BlendMode;
const PSD_COLORS: Record<string, string> = { red: '#e14b4b', orange: '#f08c38', yellow: '#e8d33f', green: '#58b858', blue: '#4a8fe0', violet: '#9a6ad6', gray: '#8a8a8a' };

function loadPsd(name: string, data: ArrayBuffer): Doc {
  const psd = readPsd(data, { skipThumbnail: true });
  const d = new Doc(name, psd.width, psd.height);
  const res = psd.imageResources?.resolutionInfo?.horizontalResolution;
  if (res) d.resolution = Math.round(res);
  const meta = parsePhotonXmp(psd.imageResources?.xmpMetadata);
  // groups: contents are pushed before their group entry (Photon's bottom→top order)
  let index = 0;
  const maskFrom = (pl: PsdLayer, L: Layer) => {
    if (!pl.mask || !pl.mask.canvas) return;
    const m = createCanvas(d.width, d.height);
    const mx = ctx2d(m);
    mx.fillStyle = (pl.mask.defaultColor ?? 255) > 127 ? '#fff' : '#000';
    mx.fillRect(0, 0, d.width, d.height);
    mx.drawImage(pl.mask.canvas, pl.mask.left ?? 0, pl.mask.top ?? 0);
    L.mask = grayToAlpha(m);
    L.maskEnabled = !pl.mask.disabled;
  };
  const walk = (list: PsdLayer[] | undefined, parentId: number) => {
    for (const pl of list ?? []) {
      if (pl.children) {
        const G = new Layer(pl.name ?? 'Group', 1, 1);
        G.kind = 'group';
        G.parentId = parentId;
        G.blend = pl.blendMode === 'pass through' || !pl.blendMode ? 'pass-through' : fromPsdBlend(pl.blendMode);
        G.opacity = pl.opacity ?? 1;
        G.visible = !pl.hidden;
        G.collapsed = !pl.opened;
        G.color = pl.layerColor && pl.layerColor !== 'none' ? PSD_COLORS[pl.layerColor] ?? '' : '';
        maskFrom(pl, G);
        walk(pl.children, G.id);
        index++;
        d.layers.push(G);
        continue;
      }
      const i = index++;
      const L = new Layer(pl.name ?? 'Layer ' + i, 1, 1);
      L.parentId = parentId;
      L.canvas = pl.canvas ?? createCanvas(1, 1);
      L.x = pl.left ?? 0; L.y = pl.top ?? 0;
      L.opacity = pl.opacity ?? 1;
      L.fillOpacity = pl.fillOpacity ?? 1;
      L.blend = fromPsdBlend(pl.blendMode);
      L.visible = !pl.hidden;
      L.clipped = !!pl.clipping;
      L.lockAlpha = !!pl.protected?.transparency;
      L.lockPosition = !!pl.protected?.position;
      L.color = pl.layerColor && pl.layerColor !== 'none' ? PSD_COLORS[pl.layerColor] ?? '' : '';
      maskFrom(pl, L);
      if (i === 0 && !parentId && pl.name === 'Background' && !pl.left && !pl.top && L.canvas.width === d.width && L.canvas.height === d.height) {
        L.isBackground = true; L.lockAlpha = true; L.lockPosition = true;
      }
      const m = meta?.layers?.[i];
      if (m && m.name === L.name) applyLayerMeta(d, L, m);
      if (L.kind === 'raster') d.ensureCoverage(L);
      d.layers.push(L);
    }
  };
  walk(psd.children, 0);
  if (!d.layers.length) {
    const L = new Layer('Background', 1, 1);
    L.canvas = psd.canvas ?? createCanvas(psd.width, psd.height);
    L.isBackground = true; L.lockAlpha = true; L.lockPosition = true;
    d.layers.push(L);
  }
  if (meta) {
    d.guides = meta.guides ?? [];
    d.paths = meta.paths ?? [];
  }
  d.activeId = d.layers[d.layers.length - 1].id;
  return d;
}

/** Restore Photon-only layer data stored in the PSD/project metadata. */
function applyLayerMeta(d: Doc, L: Layer, m: any) {
  if (m.kind) L.kind = m.kind as LayerKind;
  if (m.text) { L.text = m.text; }
  if (m.shape) { L.shape = m.shape; }
  if (m.fill) { L.fill = m.fill; renderFillLayer(d, L); }
  if (m.adjustment) { L.adjustment = m.adjustment; L.canvas = createCanvas(1, 1); }
  if (m.style && !m.styleBaked) L.style = m.style;
  if (m.isBackground !== undefined) { L.isBackground = m.isBackground; }
  if (L.kind === 'text' && L.text) { L.x = m.x ?? L.x; L.y = m.y ?? L.y; renderTextLayer(L); }
  if (L.kind === 'shape' && L.shape) { L.x = m.x ?? L.x; L.y = m.y ?? L.y; renderShapeLayer(L); }
}

function layerMeta(L: Layer, baked: boolean) {
  return {
    name: L.name, kind: L.kind, text: L.text, shape: L.shape, fill: L.fill, adjustment: L.adjustment,
    style: L.style, styleBaked: baked, isBackground: L.isBackground, x: L.x, y: L.y,
  };
}
function b64encode(s: string) { return btoa(unescape(encodeURIComponent(s))); }
function b64decode(s: string) { return decodeURIComponent(escape(atob(s))); }
function photonXmp(json: any) {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photon="https://crystalsuite.app/photon/1.0/" xmp:CreatorTool="${APP_NAME} (Crystal Suite)" photon:data="${b64encode(JSON.stringify(json))}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}
function parsePhotonXmp(x?: string): any | null {
  if (!x) return null;
  const m = x.match(/photon:data="([^"]+)"/);
  if (!m) return null;
  try { return JSON.parse(b64decode(m[1])); } catch { return null; }
}

export function buildPsd(doc: Doc): ArrayBuffer {
  const metaLayers: any[] = [];
  // metadata order = Photon order (a group's contents before the group), matching loadPsd's walk
  const toPsd = (nodes: LayerNode[]): PsdLayer[] => nodes.map((n) => {
    const L = n.layer;
    const mask = () => {
      if (!L.mask) return undefined;
      const g = alphaToGray(L.mask);
      return { canvas: g, left: L.maskX, top: L.maskY, right: L.maskX + g.width, bottom: L.maskY + g.height, defaultColor: 255, disabled: !L.maskEnabled };
    };
    if (L.kind === 'group') {
      const kids = toPsd(n.children);
      metaLayers.push(layerMeta(L, false));
      return {
        name: L.name, opacity: L.opacity, hidden: !L.visible, opened: !L.collapsed,
        blendMode: L.blend === 'pass-through' ? 'pass through' : toPsdBlend(L.blend),
        children: kids, mask: mask(), clipping: L.clipped,
      } as PsdLayer;
    }
    const baked = hasActiveStyle(L);
    let canvas: HTMLCanvasElement | undefined, left = L.x, top = L.y;
    if (L.kind === 'adjustment') canvas = undefined;
    else if (baked) { const r = renderedLayer(doc, L); canvas = r.canvas; left = r.x; top = r.y; }
    else canvas = L.canvas;
    const pl: PsdLayer = {
      name: L.name,
      left, top,
      right: left + (canvas?.width ?? 0), bottom: top + (canvas?.height ?? 0),
      opacity: L.opacity, blendMode: toPsdBlend(L.blend), hidden: !L.visible,
      clipping: L.clipped, canvas,
      fillOpacity: baked ? 1 : L.fillOpacity,
      protected: { transparency: L.lockAlpha, position: L.lockPosition },
      mask: baked ? undefined : mask(),
    };
    metaLayers.push(layerMeta(L, baked));
    return pl;
  });
  const children = toPsd(buildTree(doc.layers));
  const composite = createCanvas(doc.width, doc.height);
  ctx2d(composite).drawImage(flattenLayers(doc, doc.layers), 0, 0);
  const psd: Psd = {
    width: doc.width, height: doc.height, children, canvas: composite,
    imageResources: {
      resolutionInfo: { horizontalResolution: doc.resolution, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: doc.resolution, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } as any,
      xmpMetadata: photonXmp({ version: 1, layers: metaLayers, guides: doc.guides, paths: doc.paths }),
    },
  };
  return writePsd(psd, { generateThumbnail: true, noBackground: !doc.layers[0]?.isBackground });
}

// ---------- Photon project (lossless) ----------
export async function buildProject(doc: Doc): Promise<Blob> {
  const enc = (c: HTMLCanvasElement) => c.toDataURL('image/png');
  const json = {
    app: 'Photon', format: 1, width: doc.width, height: doc.height, resolution: doc.resolution,
    active: doc.layers.findIndex((l) => l.id === doc.activeId),
    layers: doc.layers.map((L) => ({
      name: L.name, kind: L.kind, x: L.x, y: L.y, visible: L.visible, opacity: L.opacity, fillOpacity: L.fillOpacity, blend: L.blend,
      lockAlpha: L.lockAlpha, lockPixels: L.lockPixels, lockPosition: L.lockPosition, lockAll: L.lockAll, clipped: L.clipped,
      color: L.color, isBackground: L.isBackground, style: L.style, text: L.text, shape: L.shape, fill: L.fill, adjustment: L.adjustment,
      id: L.id, parentId: L.parentId, collapsed: L.collapsed,
      canvas: L.kind === 'adjustment' ? null : enc(L.canvas),
      mask: L.mask ? { x: L.maskX, y: L.maskY, enabled: L.maskEnabled, data: enc(L.mask) } : null,
    })),
    channels: doc.channels.map((c) => ({ name: c.name, data: enc(c.canvas) })),
    selection: doc.selection ? enc(doc.selection) : null,
    paths: doc.paths, guides: doc.guides,
  };
  return new Blob([JSON.stringify(json)], { type: 'application/json' });
}
async function decodeDataUrl(u: string): Promise<HTMLCanvasElement> {
  const img = await loadImage(u);
  const c = createCanvas(img.naturalWidth, img.naturalHeight);
  ctx2d(c).drawImage(img, 0, 0);
  return c;
}
async function loadProject(name: string, data: ArrayBuffer): Promise<Doc> {
  const j = JSON.parse(new TextDecoder().decode(data));
  if (j.app !== 'Photon') throw new Error('Not a Photon project');
  const d = new Doc(name, j.width, j.height);
  d.resolution = j.resolution ?? 72;
  const ids = new Map<number, number>();
  for (const m of j.layers) {
    const L = new Layer(m.name, 1, 1);
    if (m.id) ids.set(m.id, L.id);
    Object.assign(L, {
      kind: m.kind, x: m.x, y: m.y, visible: m.visible, opacity: m.opacity, fillOpacity: m.fillOpacity, blend: m.blend,
      lockAlpha: m.lockAlpha, lockPixels: m.lockPixels, lockPosition: m.lockPosition, lockAll: m.lockAll, clipped: m.clipped,
      color: m.color ?? '', isBackground: m.isBackground, style: m.style ?? null, text: m.text, shape: m.shape, fill: m.fill, adjustment: m.adjustment,
      parentId: m.parentId ?? 0, collapsed: !!m.collapsed,
    });
    if (m.canvas) L.canvas = await decodeDataUrl(m.canvas);
    if (m.mask) { L.mask = await decodeDataUrl(m.mask.data); L.maskX = m.mask.x; L.maskY = m.mask.y; L.maskEnabled = m.mask.enabled; }
    d.layers.push(L);
  }
  for (const L of d.layers) L.parentId = ids.get(L.parentId) ?? 0;
  for (const c of j.channels ?? []) d.channels.push({ id: uid(), name: c.name, canvas: await decodeDataUrl(c.data) });
  if (j.selection) d.selection = await decodeDataUrl(j.selection);
  d.paths = j.paths ?? [];
  d.guides = j.guides ?? [];
  d.activeId = d.layers[Math.max(0, j.active ?? d.layers.length - 1)]?.id ?? 0;
  return d;
}

// ---------- save ----------
type SaveFormat = 'psd' | 'phtn' | 'png' | 'jpg' | 'webp';
const FORMAT_INFO: Record<SaveFormat, { name: string; mime: string; ext: string }> = {
  psd: { name: 'Photoshop', mime: 'image/vnd.adobe.photoshop', ext: 'psd' },
  phtn: { name: 'Photon Project', mime: 'application/json', ext: 'phtn' },
  png: { name: 'PNG', mime: 'image/png', ext: 'png' },
  jpg: { name: 'JPEG', mime: 'image/jpeg', ext: 'jpg' },
  webp: { name: 'WebP', mime: 'image/webp', ext: 'webp' },
};

async function encode(doc: Doc, fmt: SaveFormat, quality = 0.92, scale = 1): Promise<Blob> {
  if (fmt === 'psd') return new Blob([buildPsd(doc)], { type: FORMAT_INFO.psd.mime });
  if (fmt === 'phtn') return buildProject(doc);
  let c = flattenLayers(doc, doc.layers);
  if (fmt === 'jpg') {
    const o = createCanvas(c.width, c.height);
    const x = ctx2d(o);
    x.fillStyle = '#fff'; x.fillRect(0, 0, o.width, o.height);
    x.drawImage(c, 0, 0);
    c = o;
  }
  if (scale !== 1) c = resampleCanvas(c, c.width * scale, c.height * scale);
  return canvasToBlob(c, FORMAT_INFO[fmt].mime, quality);
}

const baseName = (n: string) => n.replace(/\.[^.]+$/, '');

async function writeOut(doc: Doc, blob: Blob, fmt: SaveFormat, forceDialog: boolean, nameOverride?: string): Promise<boolean> {
  const info = FORMAT_INFO[fmt];
  const suggested = `${nameOverride ?? baseName(doc.name)}.${info.ext}`;
  const data = await blob.arrayBuffer();
  if (native) {
    if (!forceDialog && doc.filePath && doc.filePath.toLowerCase().endsWith(`.${info.ext}`)) return native.writeFile(doc.filePath, data);
    const r = await native.saveFile({ defaultPath: doc.filePath ? doc.filePath.replace(/[^\\/]+$/, suggested) : suggested, filters: [{ name: info.name, extensions: [info.ext] }], data });
    if (!r) return false;
    if (fmt === 'psd' || fmt === 'phtn') { doc.filePath = r.path; doc.name = r.name; doc.fileFormat = fmt; addRecentFile(r.name, r.path); }
    return true;
  }
  if ((window as any).showSaveFilePicker) {
    try {
      let handle = !forceDialog && doc.fileHandle && doc.fileFormat === fmt ? doc.fileHandle : null;
      if (!handle) handle = await (window as any).showSaveFilePicker({ suggestedName: suggested, types: [{ description: info.name, accept: { [info.mime]: [`.${info.ext}`] } }] });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      if (fmt === 'psd' || fmt === 'phtn') { doc.fileHandle = handle; doc.name = handle.name; doc.fileFormat = fmt; }
      return true;
    } catch (e: any) { if (e?.name === 'AbortError') return false; console.warn(e); }
  }
  downloadBlob(blob, suggested);
  if (fmt === 'psd' || fmt === 'phtn') { doc.name = suggested; doc.fileFormat = fmt; }
  return true;
}

/** Ctrl+S */
export async function save(doc = app.doc): Promise<boolean> {
  if (!doc) return false;
  const fmt: SaveFormat = doc.fileFormat === 'phtn' ? 'phtn' : 'psd';
  const hasTarget = native ? !!doc.filePath && (doc.fileFormat === 'psd' || doc.fileFormat === 'phtn') : !!doc.fileHandle && (doc.fileFormat === 'psd' || doc.fileFormat === 'phtn');
  if (!hasTarget) return saveAs(doc);
  const ok = await writeOut(doc, await encode(doc, fmt), fmt, false);
  if (ok) { doc.markSaved(); toast(`Saved ${doc.name}`); }
  return ok;
}

/** Shift+Ctrl+S */
export async function saveAs(doc = app.doc): Promise<boolean> {
  if (!doc) return false;
  const fmtSel = select({
    options: [
      { value: 'psd', label: 'Photoshop (*.PSD)' }, { value: 'phtn', label: 'Photon Project (*.PHTN) — keeps everything editable' },
      { value: 'png', label: 'PNG (*.PNG)' }, { value: 'jpg', label: 'JPEG (*.JPG)' }, { value: 'webp', label: 'WebP (*.WEBP)' },
    ],
    value: doc.fileFormat === 'phtn' ? 'phtn' : 'psd', width: 360,
  });
  const nm = textInput({ value: baseName(doc.name), width: 360 });
  const q = sliderField({ label: 'Quality (JPEG / WebP)', value: 90, min: 1, max: 100, unit: '%' });
  const note = h('div', { class: 'field-label', style: { fontSize: '11px', lineHeight: '1.5' } },
    'PSD keeps layers, masks, blend modes and opacity and opens in Photoshop, GIMP and Photopea. Type, shape, fill, adjustment layers and layer styles stay editable when reopened in Photon.');
  const ok = await openDialog({
    title: 'Save As', width: 520,
    content: h('div', { class: 'col' }, h('div', { class: 'form-grid' }, h('span', { class: 'field-label' }, 'File name:'), nm.el, h('span', { class: 'field-label' }, 'Format:'), fmtSel.el), q.el, note),
    onOpen: () => nm.input.select(),
    okLabel: 'Save',
  });
  if (!ok) return false;
  const fmt = fmtSel.get() as SaveFormat;
  const blob = await encode(doc, fmt, q.get() / 100);
  const done = await writeOut(doc, blob, fmt, true, nm.get() || baseName(doc.name));
  if (done) {
    if (fmt === 'psd' || fmt === 'phtn') doc.markSaved();
    bus.emit('docs');
    toast(`Saved ${nm.get()}.${FORMAT_INFO[fmt].ext}`);
  }
  return done;
}

/** File > Export > Export As... */
export async function exportAsDialog() {
  const doc = app.doc; if (!doc) return;
  let fmt: SaveFormat = 'png';
  let scale = 1, quality = 0.9;
  const info = h('div', { class: 'field-label' });
  const prev = h('div', { class: 'preview-box', style: { height: '300px' } });
  const img = h('img', { style: { maxWidth: '100%', maxHeight: '100%' } }) as HTMLImageElement;
  prev.appendChild(img);
  let url = '';
  const refresh = async () => {
    const blob = await encode(doc, fmt, quality, scale);
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    img.src = url;
    info.textContent = `${Math.round(doc.width * scale)} × ${Math.round(doc.height * scale)} px · ${(blob.size / 1024).toFixed(1)} KB`;
  };
  const fmtSeg = segmented({ value: 'png', options: [{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WebP' }], onChange: (v) => { fmt = v as SaveFormat; refresh(); } });
  const q = sliderField({ label: 'Quality', value: 90, min: 1, max: 100, unit: '%', onChange: (v) => { quality = v / 100; refresh(); } });
  const sc = select({ options: ['0.25', '0.5', '0.75', '1', '1.5', '2', '3', '4'].map((v) => ({ value: v, label: `${Number(v) * 100}%` })), value: '1', width: 90, onChange: (v) => { scale = Number(v); refresh(); } });
  refresh();
  const ok = await openDialog({
    title: 'Export As', width: 760, okLabel: 'Export',
    content: h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 240px', gap: '14px' } },
      h('div', { class: 'col' }, prev, info),
      h('div', { class: 'col' }, h('div', { class: 'field-label' }, 'Format'), fmtSeg.el, q.el, h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Size:'), sc.el))),
  });
  if (url) URL.revokeObjectURL(url);
  if (!ok) return;
  const blob = await encode(doc, fmt, quality, scale);
  await writeOut(doc, blob, fmt, true);
}

export async function quickExportPng() {
  const doc = app.doc; if (!doc) return;
  await writeOut(doc, await encode(doc, 'png'), 'png', true);
}

/** Close with save prompt. Returns false if cancelled. */
export async function closeDoc(doc = app.doc): Promise<boolean> {
  if (!doc) return true;
  if (doc.isDirty) {
    const r = await confirmDialog(APP_NAME, `Save changes to the ${APP_NAME} document “${doc.name}” before closing?`, 'Yes', 'Cancel', 'No');
    if (r === 'cancel') return false;
    if (r === 'ok' && !(await save(doc))) return false;
  }
  app.removeDoc(doc);
  return true;
}

// ---------- recent files ----------
export function recentFiles(): { name: string; path?: string }[] {
  try { return JSON.parse(localStorage.getItem('photon.recent') || '[]'); } catch { return []; }
}
function addRecentFile(name: string, path?: string) {
  const list = recentFiles().filter((r) => (path ? r.path !== path : r.name !== name));
  list.unshift({ name, path });
  try { localStorage.setItem('photon.recent', JSON.stringify(list.slice(0, 12))); } catch { /* ignore */ }
}
export function clearRecent() { try { localStorage.removeItem('photon.recent'); } catch { /* ignore */ } }

void checkbox;
