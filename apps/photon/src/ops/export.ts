// File > Export: Photoshop-style "Export As" for the whole document or individual layers
// (auto-trimmed to their content), Quick Export as PNG, and batch export of layers to a folder.
import { app } from '../app';
import { Doc } from '../core/document';
import { Layer } from '../core/layer';
import { createCanvas, ctx2d, canvasToBlob, downloadBlob, cssColor, getImageData, checkerboard, clamp, debounce, rectIntersect, Rect, RGB } from '../core/util';
import { flattenLayers, renderedLayer } from '../core/compositor';
import { isVisibleDeep, topLevelSelection } from '../core/groups';
import { openDialog } from '../dialogs/dialog';
import { h, clear, injectStyle } from '../ui/dom';
import { numberInput, select, toast, colorSwatch, sliderField, segmented, checkbox, iconButton, button, section } from '../ui/widgets';
import { MenuItem, SEP } from '../ui/menutypes';
import { resampleCanvas } from './imageops';

type Fmt = 'png' | 'jpg' | 'webp';
type ResampleMode = 'auto' | 'sharper' | 'bilinear' | 'nearest';
type Mode = 'document' | 'layers';
const FORMATS: Record<Fmt, { name: string; mime: string; ext: string }> = {
  png: { name: 'PNG', mime: 'image/png', ext: 'png' },
  jpg: { name: 'JPEG', mime: 'image/jpeg', ext: 'jpg' },
  webp: { name: 'WebP', mime: 'image/webp', ext: 'webp' },
};
const MAX_SIDE = 30000, MAX_AREA = 200e6;

interface Settings {
  fmt: Fmt; quality: number; transparent: boolean; matte: RGB;
  /** image scale (width / height factors) */
  sx: number; sy: number; resample: ResampleMode;
  trim: boolean; pad: number; clip: boolean; effects: boolean;
}

// ---------- settings memory ----------
const PREFS_KEY = 'photon.export.v1';
function loadPrefs(): Partial<Settings> {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}
function savePrefs(s: Settings) {
  const { fmt, quality, transparent, matte, resample } = s;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ fmt, quality, transparent, matte, resample })); } catch { /* storage unavailable */ }
}
function initialSettings(mode: Mode): Settings {
  const p = loadPrefs();
  return {
    fmt: p.fmt && p.fmt in FORMATS ? p.fmt : 'png', quality: clamp(p.quality ?? 90, 1, 100), transparent: p.transparent ?? true,
    matte: p.matte ?? { r: 255, g: 255, b: 255 }, sx: 1, sy: 1, resample: p.resample ?? 'auto',
    trim: mode === 'layers', pad: 0, clip: false, effects: true,
  };
}
const quickSettings = (trim: boolean): Settings => ({
  fmt: 'png', quality: 100, transparent: true, matte: { r: 255, g: 255, b: 255 }, sx: 1, sy: 1, resample: 'auto',
  trim, pad: 0, clip: false, effects: true,
});

// ---------- what gets exported ----------
interface Item { key: string; name: string; layer: Layer | null } // layer null = whole document
const baseName = (n: string) => n.replace(/\.[^.]+$/, '');
const docItem = (doc: Doc): Item => ({ key: 'doc', name: baseName(doc.name), layer: null });
const layerItem = (L: Layer): Item => ({ key: `L${L.id}`, name: L.name, layer: L });

const isGroupLayer = (L: Layer) => L.kind === 'group';
/** Selected layers to export (a selected group covers its contents). */
const exportableSelection = (doc: Doc) => topLevelSelection(doc).filter((l) => l.kind !== 'adjustment');

interface Rendered { canvas: HTMLCanvasElement; x: number; y: number }

/** A group as it renders (contents + group opacity/mask/blend), document-sized. Adjust here if the group model changes. */
const renderGroupItem = (doc: Doc, G: Layer): Rendered => renderedLayer(doc, G);

/** Item pixels as they render, positioned in document space (may extend beyond the document). Never mutates layers. */
function renderItem(doc: Doc, L: Layer | null, effects: boolean): Rendered {
  if (!L) return { canvas: flattenLayers(doc, doc.layers), x: 0, y: 0 };
  if (isGroupLayer(L)) return renderGroupItem(doc, L);
  let r: Rendered;
  if (effects) r = renderedLayer(doc, L); // may be the compositor's style cache: read-only
  else {
    // raw pixels + layer mask
    const c = createCanvas(L.canvas.width, L.canvas.height);
    const x = ctx2d(c);
    x.drawImage(L.canvas, 0, 0);
    if (L.mask && L.maskEnabled) {
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(L.mask, L.maskX - L.x, L.maskY - L.y);
    }
    r = { canvas: c, x: L.x, y: L.y };
  }
  if (L.opacity < 1) {
    const c = createCanvas(r.canvas.width, r.canvas.height);
    const x = ctx2d(c);
    x.globalAlpha = L.opacity;
    x.drawImage(r.canvas, 0, 0);
    r = { ...r, canvas: c };
  }
  return { canvas: r.canvas, x: Math.round(r.x), y: Math.round(r.y) };
}

/** Bounds of pixels with alpha > 0, scanning inward from the edges. */
function alphaBox(c: HTMLCanvasElement): Rect | null {
  const w = c.width, hh = c.height;
  let d: Uint8ClampedArray;
  try { d = getImageData(c).data; } catch { return { x: 0, y: 0, w, h: hh }; }
  const rowHas = (y: number) => { for (let i = y * w * 4 + 3, e = i + w * 4; i < e; i += 4) if (d[i]) return true; return false; };
  let top = 0;
  while (top < hh && !rowHas(top)) top++;
  if (top === hh) return null;
  let bottom = hh - 1;
  while (bottom > top && !rowHas(bottom)) bottom--;
  let left = w, right = -1;
  for (let y = top; y <= bottom; y++) {
    const row = y * w * 4 + 3;
    for (let x = 0; x < left; x++) if (d[row + x * 4]) { left = x; break; }
    for (let x = w - 1; x > right; x--) if (d[row + x * 4]) { right = x; break; }
  }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

function makeThumb(r: Rendered, b: Rect | null): HTMLCanvasElement {
  if (!b) return createCanvas(1, 1);
  const s = Math.min(80 / b.w, 64 / b.h, 1);
  const c = createCanvas(b.w * s, b.h * s);
  const x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(r.canvas, b.x - r.x, b.y - r.y, b.w, b.h, 0, 0, c.width, c.height);
  return c;
}

/** Alpha-aware 4-neighbour unsharp (Bicubic Sharper after a reduction). */
function sharpen(c: HTMLCanvasElement, k: number): HTMLCanvasElement {
  const w = c.width, hh = c.height;
  if (w < 3 || hh < 3) return c;
  const s = getImageData(c).data;
  const out = new ImageData(w, hh), d = out.data;
  d.set(s);
  const W = w * 4;
  for (let y = 1; y < hh - 1; y++) {
    for (let x = 1, i = y * W + 4; x < w - 1; x++, i += 4) {
      if (!s[i + 3]) continue;
      const a1 = s[i - 1], a2 = s[i + 7], a3 = s[i - W + 3], a4 = s[i + W + 3], a = a1 + a2 + a3 + a4;
      if (!a) continue;
      for (let ch = 0; ch < 3; ch++) {
        const avg = (s[i - 4 + ch] * a1 + s[i + 4 + ch] * a2 + s[i - W + ch] * a3 + s[i + W + ch] * a4) / a;
        d[i + ch] = s[i + ch] + k * (s[i + ch] - avg);
      }
    }
  }
  const o = createCanvas(w, hh);
  ctx2d(o).putImageData(out, 0, 0);
  return o;
}

function resize(src: HTMLCanvasElement, w: number, hh: number, mode: ResampleMode): HTMLCanvasElement {
  if (mode === 'nearest' || mode === 'bilinear') return resampleCanvas(src, w, hh, mode);
  const out = resampleCanvas(src, w, hh, 'bicubic'); // step-down halving for reductions
  return mode === 'sharper' && w * hh < src.width * src.height ? sharpen(out, 0.35) : out;
}

class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k: string, v: V) { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string); }
}

/** Output pipeline with caches: render (+effects) → trim/clip → scale → padding/matte → encode. */
class Exporter {
  private renders = new Lru<Rendered>(2);
  private bounds = new Map<string, Rect | null>();
  private thumbs = new Map<string, HTMLCanvasElement>();
  private crops = new Lru<HTMLCanvasElement>(2);
  private out: { key: string; canvas: HTMLCanvasElement } | null = null;
  private enc: { key: string; blob: Promise<Blob> } | null = null;
  constructor(readonly doc: Doc, readonly s: Settings) {}

  private fx(it: Item) { return `${it.key}|${it.layer && this.s.effects ? 'fx' : 'raw'}`; }
  private render(it: Item, keep = true): Rendered {
    const k = this.fx(it);
    let r = this.renders.get(k);
    if (!r) { r = renderItem(this.doc, it.layer, this.s.effects); if (keep) this.renders.set(k, r); }
    return r;
  }
  measured(it: Item) { return this.bounds.has(this.fx(it)); }
  /** Compute content bounds + thumbnail once per item/effects setting. */
  measure(it: Item, keep = true) {
    const k = this.fx(it);
    if (this.bounds.has(k)) return;
    const r = this.render(it, keep);
    const b = alphaBox(r.canvas);
    const db = b && { x: b.x + r.x, y: b.y + r.y, w: b.w, h: b.h };
    this.bounds.set(k, db);
    this.thumbs.set(k, makeThumb(r, db));
  }
  contentBounds(it: Item): Rect | null { this.measure(it); return this.bounds.get(this.fx(it)) ?? null; }
  thumb(it: Item) { this.measure(it, false); return this.thumbs.get(this.fx(it))!; }

  /** Document-space rect that becomes the image (before scale and padding). */
  cropRect(it: Item): Rect | null {
    const docR = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const b = this.contentBounds(it);
    if (it.layer && !b) return null;
    if (!this.s.trim) return it.layer && !rectIntersect(b!, docR) ? null : docR;
    if (!b) return null;
    return it.layer && this.s.clip ? rectIntersect(b, docR) : b;
  }
  imageSize(r: Rect) { return { w: Math.max(1, Math.round(r.w * this.s.sx)), h: Math.max(1, Math.round(r.h * this.s.sy)) }; }
  outSize(r: Rect) { const i = this.imageSize(r), p = this.s.pad; return { w: i.w + 2 * p, h: i.h + 2 * p }; }
  /** Why the item can't be exported with the current settings (null = OK). */
  problem(it: Item): string | null {
    const r = this.cropRect(it);
    if (!r) {
      if (this.contentBounds(it)) return 'Layer is outside the document';
      if (!it.layer) return 'Document is empty';
      return isGroupLayer(it.layer) ? (it.layer.visible ? 'Group is empty' : 'Group is hidden') : 'Layer is empty';
    }
    const o = this.outSize(r);
    if (o.w > MAX_SIDE || o.h > MAX_SIDE || o.w * o.h > MAX_AREA) return 'Output is too large';
    return null;
  }
  private cropped(it: Item, r: Rect): HTMLCanvasElement {
    const k = `${this.fx(it)}|${r.x},${r.y},${r.w},${r.h}`;
    let c = this.crops.get(k);
    if (!c) {
      const src = this.render(it);
      if (src.x === r.x && src.y === r.y && src.canvas.width === r.w && src.canvas.height === r.h) c = src.canvas;
      else { c = createCanvas(r.w, r.h); ctx2d(c).drawImage(src.canvas, src.x - r.x, src.y - r.y); }
      this.crops.set(k, c);
    }
    return c;
  }
  /** Final pixels (uncompressed). The returned canvas must not be modified. */
  output(it: Item): { key: string; canvas: HTMLCanvasElement } | null {
    if (this.problem(it)) return null;
    const r = this.cropRect(it)!, s = this.s, { w, h: hh } = this.imageSize(r);
    const opaque = s.fmt === 'jpg' || !s.transparent;
    const key = [this.fx(it), r.x, r.y, r.w, r.h, w, hh, s.resample, s.pad, opaque ? cssColor(s.matte) : '-'].join('|');
    if (this.out?.key === key) return this.out;
    let img = this.cropped(it, r);
    if (w !== img.width || hh !== img.height) img = resize(img, w, hh, s.resample);
    if (s.pad > 0 || opaque) {
      const c = createCanvas(w + 2 * s.pad, hh + 2 * s.pad);
      const x = ctx2d(c);
      if (opaque) { x.fillStyle = cssColor(s.matte); x.fillRect(0, 0, c.width, c.height); }
      x.drawImage(img, s.pad, s.pad);
      img = c;
    }
    this.out = { key, canvas: img };
    return this.out;
  }
  encode(it: Item): Promise<Blob> | null {
    const o = this.output(it);
    if (!o) return null;
    const f = FORMATS[this.s.fmt];
    const key = `${o.key}|${this.s.fmt}|${this.s.fmt === 'png' ? '' : this.s.quality}`;
    if (this.enc?.key !== key) {
      const blob = canvasToBlob(o.canvas, f.mime, this.s.quality / 100);
      blob.catch(() => { if (this.enc?.key === key) this.enc = null; });
      this.enc = { key, blob };
    }
    return this.enc.blob;
  }
}

// ---------- saving ----------
interface NativeBridge {
  saveFile(o: { defaultPath: string; filters: { name: string; extensions: string[] }[]; data: ArrayBuffer }): Promise<{ path: string; name: string } | null>;
  writeFile(path: string, data: ArrayBuffer): Promise<boolean>;
  chooseFolder?(o?: { title?: string; defaultPath?: string }): Promise<string | null>;
}
const nativeBridge = (): NativeBridge | undefined => (window as any).photonNative;
const DIR_KEY = 'photon.exportDir';
const lastDir = (doc: Doc): string | undefined => {
  try { const d = localStorage.getItem(DIR_KEY); if (d) return d; } catch { /* ignore */ }
  return doc.filePath ? dirOf(doc.filePath) : undefined;
};
const setLastDir = (d: string) => { try { localStorage.setItem(DIR_KEY, d); } catch { /* ignore */ } };
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
/** Join a folder from the native dialog with a file name (Windows or POSIX separators). */
export function joinPath(dir: string, name: string) {
  const sep = dir.includes('\\') || /^[a-zA-Z]:/.test(dir) ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}
const fileLabel = (p: string) => p.split(/[\\/]/).pop() || p;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(2)} MB`;

/** File-system safe name (Windows rules). */
export function sanitizeFileName(n: string): string {
  // eslint-disable-next-line no-control-regex
  let s = n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!s) s = 'Layer';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  return s.slice(0, 120);
}
function uniqueNames(bases: string[], ext: string): string[] {
  const used = new Set<string>();
  return bases.map((b) => {
    let n = `${b}.${ext}`;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${b}-${i}.${ext}`;
    used.add(n.toLowerCase());
    return n;
  });
}

/** One file: native save dialog (Electron), File System Access picker, or a download. Returns where it went, or null if cancelled. */
async function saveSingle(doc: Doc, name: string, fmt: Fmt, make: () => Promise<Blob>): Promise<string | null> {
  const f = FORMATS[fmt], nb = nativeBridge();
  if (nb) {
    const data = await (await make()).arrayBuffer();
    const dir = lastDir(doc);
    const r = await nb.saveFile({ defaultPath: dir ? joinPath(dir, name) : name, filters: [{ name: f.name, extensions: [f.ext] }], data });
    if (!r) return null;
    setLastDir(dirOf(r.path));
    return r.path;
  }
  const w = window as any;
  if (w.showSaveFilePicker) {
    let handle: any = null;
    // pick first: the picker needs the click's user activation, encoding can take a while
    try { handle = await w.showSaveFilePicker({ id: 'photon-export', suggestedName: name, types: [{ description: f.name, accept: { [f.mime]: [`.${f.ext}`] } }] }); } catch (e: any) { if (e?.name === 'AbortError') return null; console.warn(e); }
    if (handle) {
      const blob = await make();
      const wr = await handle.createWritable();
      await wr.write(blob);
      await wr.close();
      return handle.name;
    }
  }
  downloadBlob(await make(), name);
  return name;
}

interface OutFile { name: string; make: () => Promise<Blob> }
/** Several files into one folder. Returns null if cancelled. */
async function saveMany(doc: Doc, fmt: Fmt, files: OutFile[]): Promise<{ where: string; count: number; failed: number } | null> {
  const nb = nativeBridge();
  let count = 0, failed = 0;
  if (nb?.chooseFolder) {
    const dir = await nb.chooseFolder({ title: 'Export to Folder', defaultPath: lastDir(doc) });
    if (!dir) return null;
    setLastDir(dir);
    for (const f of files) {
      try { if (await nb.writeFile(joinPath(dir, f.name), await (await f.make()).arrayBuffer())) count++; else failed++; } catch (e) { console.warn(e); failed++; }
    }
    return { where: dir, count, failed };
  }
  if (nb) { // older shell without chooseFolder: one save dialog per file
    let where = '';
    for (const f of files) { const p = await saveSingle(doc, f.name, fmt, f.make); if (!p) break; where = dirOf(p); count++; }
    return count ? { where, count, failed } : null;
  }
  const w = window as any;
  if (w.showDirectoryPicker) {
    let dir: any = null;
    try { dir = await w.showDirectoryPicker({ id: 'photon-export', mode: 'readwrite' }); } catch (e: any) { if (e?.name === 'AbortError') return null; console.warn(e); }
    if (dir) {
      for (const f of files) {
        try {
          const blob = await f.make();
          const fh = await dir.getFileHandle(f.name, { create: true });
          const wr = await fh.createWritable();
          await wr.write(blob);
          await wr.close();
          count++;
        } catch (e) { console.warn(e); failed++; }
      }
      return { where: dir.name, count, failed };
    }
  }
  for (const f of files) { downloadBlob(await f.make(), f.name); count++; await sleep(250); }
  return { where: 'Downloads', count, failed };
}

/** Encode + save items with the exporter's settings; toasts the result. */
async function exportItems(ex: Exporter, items: Item[]): Promise<boolean> {
  const f = FORMATS[ex.s.fmt];
  const ok = items.filter((it) => !ex.problem(it));
  const skipped = items.length - ok.length;
  if (!ok.length) { toast(items.length === 1 ? ex.problem(items[0])! : 'Nothing to export: the layers are empty'); return false; }
  const names = uniqueNames(ok.map((it) => sanitizeFileName(it.name)), f.ext);
  const make = (it: Item) => () => ex.encode(it)!;
  try {
    if (ok.length === 1) {
      const where = await saveSingle(ex.doc, names[0], ex.s.fmt, make(ok[0]));
      if (!where) return false;
      toast(`Exported ${fileLabel(where)}${skipped ? ` · ${skipped} empty skipped` : ''}`);
      return true;
    }
    const res = await saveMany(ex.doc, ex.s.fmt, ok.map((it, i) => ({ name: names[i], make: make(it) })));
    if (!res) return false;
    toast(`Exported ${res.count} file${res.count === 1 ? '' : 's'} to ${res.where}${res.failed ? ` · ${res.failed} failed` : ''}${skipped ? ` · ${skipped} empty skipped` : ''}`, 3500);
    return res.count > 0;
  } catch (e: any) {
    console.error(e);
    toast(`Export failed: ${e?.message ?? e}`, 3500);
    return false;
  }
}

// ---------- quick exports ----------
/** File > Export > Quick Export as PNG (whole document). */
export async function quickExportDocumentPng() {
  const doc = app.doc; if (!doc) return;
  await exportItems(new Exporter(doc, quickSettings(false)), [docItem(doc)]);
}

/** Active (or given) layer trimmed to its content as PNG at 100%, no dialog. With several layers selected, exports each. */
export async function quickExportLayerPng(L?: Layer) {
  const doc = app.doc; if (!doc) return;
  const layers = L ? [L] : exportableSelection(doc);
  if (!layers.length || layers.every((l) => l.kind === 'adjustment')) { toast('Select a pixel, type, shape, fill or group layer to export'); return; }
  await exportItems(new Exporter(doc, quickSettings(true)), layers.filter((l) => l.kind !== 'adjustment').reverse().map(layerItem));
}

/** File > Export > Export Layers to Files: every visible pixel layer in the Export dialog. */
export async function exportLayersToFiles() {
  const doc = app.doc; if (!doc) return;
  const layers = doc.layers.filter((l) => l.kind !== 'adjustment' && !isGroupLayer(l) && isVisibleDeep(doc, l));
  if (!layers.length) { toast('There are no visible layers to export'); return; }
  await exportAsDialog('layers', layers);
}

// ---------- Export As dialog ----------
const SCALES = [10, 25, 33.33, 50, 66.67, 75, 100, 125, 150, 200, 300, 400];
const ZOOMS = [0.02, 0.03, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 6, 8, 12, 16, 32];

/** Photoshop-style Export As. 'layers' exports the selected layers (or `layers`) each trimmed to its content. */
export async function exportAsDialog(mode: Mode = 'document', layers?: Layer[]) {
  const doc = app.doc; if (!doc) return;
  let items: Item[];
  if (mode === 'layers') {
    const list = (layers ?? exportableSelection(doc)).filter((l) => l.kind !== 'adjustment');
    if (!list.length) { toast('Select one or more pixel, type, shape or fill layers to export'); return; }
    items = list.slice().reverse().map(layerItem); // top-most first, like the Layers panel
  } else items = [docItem(doc)];
  injectStyle('export', CSS);

  const s = initialSettings(mode);
  const ex = new Exporter(doc, s);
  const checker = `url(${checkerboard().toDataURL()})`;
  let cur = items.find((it) => it.layer?.id === doc.activeId) ?? items[0];
  let constrain = true, closed = false, busy = false, curProblem: string | null = null;
  let okBtn: HTMLButtonElement | null = null, root: HTMLElement | null = null;

  // ----- left: what is exported -----
  const rows = new Map<Item, { row: HTMLElement; th: HTMLElement; sz: HTMLElement }>();
  const listEl = h('div', { class: 'ex-list' },
    h('div', { class: 'ex-list-head' }, mode === 'layers' ? `${items.length} layer${items.length > 1 ? 's' : ''}${items.length > 1 ? ' · same settings for all' : ''}` : 'Document'));
  for (const it of items) {
    const th = h('div', { class: 'th', style: { backgroundImage: checker } });
    const sz = h('div', { class: 'sz' }, 'Measuring…');
    const hidden = it.layer && !it.layer.visible ? h('span', { class: 'hid' }, ' (hidden)') : null;
    const row = h('div', { class: 'ex-item', title: it.name }, th, h('div', { class: 'meta' }, h('div', { class: 'nm' }, it.name, hidden), sz));
    row.addEventListener('click', () => pick(it));
    rows.set(it, { row, th, sz });
    listEl.appendChild(row);
  }

  // ----- center: preview -----
  const imgBox = h('div', { class: 'ex-img', style: { backgroundImage: checker } });
  const msg = h('div', { class: 'ex-msg' });
  const stage = h('div', { class: 'ex-stage', title: 'Drag to pan · Ctrl+wheel to zoom · double-click toggles Fit / 100%' }, imgBox, msg);
  const zoomLbl = h('span', { class: 'zl' });
  const dimsEl = h('b'), sizeEl = h('span');
  const bar = h('div', { class: 'ex-bar' },
    button('Fit', () => setZoom('fit'), { small: true, title: 'Fit on screen' }),
    button('100%', () => setZoom(1), { small: true, title: 'Actual output pixels' }),
    iconButton('zoom-out', 'Zoom out', () => stepZoom(-1)), zoomLbl, iconButton('zoom-in', 'Zoom in', () => stepZoom(1)),
    h('span', { class: 'info' }, dimsEl, h('span', { class: 'dot' }, ' · '), sizeEl));

  // ----- right: settings -----
  const fmtSeg = segmented({
    value: s.fmt, options: [{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WebP' }],
    onChange: (v) => { s.fmt = v as Fmt; syncControls(); changed(false); },
  });
  const quality = sliderField({ label: 'Quality', value: s.quality, min: 1, max: 100, unit: '%', onInput: (v) => { s.quality = v; changed(false); }, onChange: (v) => { s.quality = v; changed(false); } });
  const transp = checkbox({ label: 'Transparency', checked: s.transparent, onChange: (v) => { s.transparent = v; syncControls(); changed(false); } });
  const matte = colorSwatch({ color: s.matte, title: 'Matte Color', onChange: (c) => { s.matte = c; changed(false); } });
  const matteRow = h('div', { class: 'row' }, h('span', { class: 'field-label lbl' }, 'Matte:'), matte.el);

  const setDim = (which: 'w' | 'h', v: number) => {
    const r = ex.measured(cur) ? ex.cropRect(cur) : null;
    if (!r) return;
    if (which === 'w') { s.sx = v / r.w; if (constrain) s.sy = s.sx; } else { s.sy = v / r.h; if (constrain) s.sx = s.sy; }
    syncSize(); changed(true);
  };
  const wIn = numberInput({ value: doc.width, min: 1, max: MAX_SIDE, width: 70, unit: 'px', onChange: (v) => setDim('w', v) });
  const hIn = numberInput({ value: doc.height, min: 1, max: MAX_SIDE, width: 70, unit: 'px', onChange: (v) => setDim('h', v) });
  const linkBtn = iconButton('link', 'Constrain Proportions', () => {
    constrain = !constrain;
    linkBtn.classList.toggle('active', constrain);
    if (constrain && s.sy !== s.sx) { s.sy = s.sx; syncSize(); changed(true); }
  }, { active: true });
  const scaleSel = select({
    options: [...SCALES.map((p) => ({ value: String(p / 100), label: `${p}%` })), { value: 'custom', label: 'Custom' }], value: '1', width: 150,
    onChange: (v) => { if (v === 'custom') return; s.sx = s.sy = Number(v); syncSize(); changed(true); },
  });
  const resSel = select({
    options: [{ value: 'auto', label: 'Bicubic Automatic' }, { value: 'sharper', label: 'Bicubic Sharper (reduction)' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'nearest', label: 'Nearest Neighbor' }],
    value: s.resample, width: 150, onChange: (v) => { s.resample = v as ResampleMode; changed(false); },
  });
  const trimCb = checkbox({
    label: mode === 'layers' ? 'Trim to layer content' : 'Trim transparent pixels', checked: s.trim,
    title: 'Size the canvas to the bounding box of the visible pixels (after mask and effects)',
    onChange: (v) => { s.trim = v; syncControls(); syncSize(); changed(true); },
  });
  const padIn = numberInput({ value: s.pad, min: 0, max: 5000, width: 56, unit: 'px', onChange: (v) => { s.pad = Math.round(v); changed(true); } });
  const clipCb = checkbox({ label: 'Clip to document bounds', checked: s.clip, onChange: (v) => { s.clip = v; syncSize(); changed(true); } });
  const clipInput = clipCb.el.querySelector('input') as HTMLInputElement;
  const fxCb = checkbox({ label: 'Include layer effects', checked: s.effects, title: 'Off: export the raw layer pixels and mask only', onChange: (v) => { s.effects = v; changed(true); } });

  const lbl = (t: string) => h('span', { class: 'field-label lbl' }, t);
  const settings = h('div', { class: 'ex-settings' },
    section('File Settings', h('div', { class: 'row' }, lbl('Format:'), fmtSeg.el), quality.el, transp.el, matteRow),
    section('Image Size',
      h('div', { class: 'ex-size' }, lbl('Width:'), wIn.el, linkBtn, lbl('Height:'), hIn.el),
      h('div', { class: 'ex-grid' }, lbl('Scale:'), scaleSel.el, lbl('Resample:'), resSel.el)),
    section('Canvas Size', trimCb.el, mode === 'layers' ? clipCb.el : null, h('div', { class: 'row' }, lbl('Padding:'), padIn.el)),
    mode === 'layers' ? section('Layer Options', fxCb.el) : null);

  const content = h('div', { class: 'ex' }, listEl, h('div', { class: 'ex-center' }, stage, bar), settings);

  const syncControls = () => {
    quality.el.style.display = s.fmt === 'png' ? 'none' : '';
    transp.el.style.display = s.fmt === 'jpg' ? 'none' : '';
    matteRow.style.display = s.fmt === 'jpg' || !s.transparent ? '' : 'none';
    clipInput.disabled = !s.trim;
    clipCb.el.classList.toggle('disabled', !s.trim);
  };
  const syncSize = () => {
    if (!ex.measured(cur)) return;
    const r = ex.cropRect(cur);
    if (r) { const z = ex.imageSize(r); wIn.set(z.w); hIn.set(z.h); }
    const p = s.sx === s.sy ? SCALES.find((v) => Math.abs(v / 100 - s.sx) < 1e-6) : undefined;
    scaleSel.set(p !== undefined ? String(p / 100) : 'custom');
  };
  const setBtns = () => {
    if (okBtn) okBtn.disabled = busy || !!curProblem;
    if (exportAllBtn) exportAllBtn.disabled = busy;
  };
  const setMsg = (t: string) => { msg.textContent = t; msg.style.display = t ? '' : 'none'; };

  // ----- preview display (zoom / pan) -----
  let shown: HTMLCanvasElement | null = null;
  let disp: { src: HTMLCanvasElement; c: HTMLCanvasElement } | null = null;
  let zoomMode: 'fit' | number = 'fit';
  const fitZoom = () => shown ? clamp(Math.min((stage.clientWidth - 24) / shown.width, (stage.clientHeight - 24) / shown.height, 1), 0.01, 1) : 1;
  const zoom = () => (zoomMode === 'fit' ? fitZoom() : zoomMode);
  const layout = (keepCenter = false) => {
    if (!shown) { imgBox.style.display = 'none'; zoomLbl.textContent = ''; stage.classList.remove('pannable'); return; }
    const cx = stage.scrollWidth > stage.clientWidth ? (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : 0.5;
    const cy = stage.scrollHeight > stage.clientHeight ? (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : 0.5;
    const z = zoom(), dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(shown.width * z)), ch = Math.max(1, Math.round(shown.height * z));
    imgBox.style.display = '';
    imgBox.style.width = `${cw}px`;
    imgBox.style.height = `${ch}px`;
    let c = shown;
    if (z * dpr < 0.999) {
      // high quality step-down for reduced previews (cached per size)
      const tw = Math.max(1, Math.round(cw * dpr)), th = Math.max(1, Math.round(ch * dpr));
      if (!disp || disp.src !== shown || disp.c.width !== tw || disp.c.height !== th) disp = { src: shown, c: resampleCanvas(shown, tw, th, 'bicubic') };
      c = disp.c;
    }
    imgBox.classList.toggle('pixelated', z > 1.001);
    if (imgBox.firstChild !== c) { clear(imgBox); imgBox.appendChild(c); }
    zoomLbl.textContent = `${+(z * 100).toFixed(z < 0.1 ? 1 : 0)}%`;
    stage.classList.toggle('pannable', cw > stage.clientWidth || ch > stage.clientHeight);
    if (keepCenter) {
      stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
      stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
    }
  };
  const show = (c: HTMLCanvasElement | null) => { shown = c; layout(); };
  const setZoom = (z: 'fit' | number) => { zoomMode = z === 'fit' ? z : clamp(z, 0.01, 32); layout(true); };
  const stepZoom = (dir: 1 | -1) => {
    const z = zoom();
    setZoom(dir > 0 ? ZOOMS.find((v) => v > z * 1.001) ?? 32 : [...ZOOMS].reverse().find((v) => v < z * 0.999) ?? 0.01);
  };
  stage.addEventListener('pointerdown', (e) => {
    if ((e.button !== 0 && e.button !== 1) || !stage.classList.contains('pannable')) return;
    const b = stage.getBoundingClientRect();
    if (e.clientX - b.left - stage.clientLeft >= stage.clientWidth || e.clientY - b.top - stage.clientTop >= stage.clientHeight) return; // scrollbars
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, sl = stage.scrollLeft, st = stage.scrollTop;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('panning');
    const mv = (ev: PointerEvent) => { stage.scrollLeft = sl - (ev.clientX - sx); stage.scrollTop = st - (ev.clientY - sy); };
    const up = () => {
      stage.removeEventListener('pointermove', mv);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', up);
      stage.classList.remove('panning');
    };
    stage.addEventListener('pointermove', mv);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
  });
  stage.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.altKey) return; e.preventDefault(); stepZoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  stage.addEventListener('dblclick', () => setZoom(zoomMode === 'fit' ? 1 : 'fit'));
  const ro = new ResizeObserver(() => { if (!closed) layout(); });

  // ----- pipeline scheduling -----
  let gen = 0, shownKey = '', listJob = 0;
  // let the browser paint (status text) before heavy work; timeout fallback for hidden windows
  const nextFrame = () => new Promise<void>((r) => {
    let done = false;
    const go = () => { if (!done) { done = true; setTimeout(r, 0); } };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });
  const refreshPreview = async () => {
    if (closed) return;
    const g = ++gen, it = cur;
    if (!ex.measured(it)) {
      setMsg('Rendering preview…');
      await nextFrame();
      if (g !== gen || closed) return;
    }
    ex.measure(it);
    syncSize();
    updateRow(it);
    curProblem = ex.problem(it);
    if (curProblem) {
      shownKey = '';
      show(null);
      setMsg(curProblem);
      dimsEl.textContent = '—';
      sizeEl.textContent = '';
      setBtns();
      return;
    }
    const o = ex.output(it)!;
    setMsg('');
    // lossy formats keep showing the last decoded image until the new encode lands (no flicker on quality drags)
    if (s.fmt === 'png' || o.key !== shownKey) { shownKey = o.key; show(o.canvas); }
    dimsEl.textContent = `${o.canvas.width} × ${o.canvas.height} px`;
    sizeEl.textContent = 'estimating size…';
    setBtns();
    scheduleEncode();
  };
  const refreshEncode = async () => {
    if (closed) return;
    const g = gen, it = cur;
    const p = curProblem ? null : ex.encode(it);
    if (!p) return;
    let blob: Blob;
    try { blob = await p; } catch { if (g === gen && !closed) sizeEl.textContent = 'could not encode'; return; }
    if (g !== gen || closed) return;
    const f = FORMATS[s.fmt];
    sizeEl.textContent = `${f.name} · ${fmtSize(blob.size)}${blob.type !== f.mime ? ' (format unsupported here, saved as PNG)' : ''}`;
    if (s.fmt === 'png') return;
    try {
      // show the decoded file so compression artifacts are visible
      const bmp = await createImageBitmap(blob);
      if (g !== gen || closed) { bmp.close(); return; }
      const c = createCanvas(bmp.width, bmp.height);
      ctx2d(c).drawImage(bmp, 0, 0);
      bmp.close();
      show(c);
    } catch { /* keep the uncompressed preview */ }
  };
  const updateRow = (it: Item) => {
    const r = rows.get(it);
    if (!r || !ex.measured(it)) return;
    const t = ex.thumb(it);
    if (r.th.firstChild !== t) { clear(r.th); r.th.appendChild(t); }
    const p = ex.problem(it);
    const rect = p ? null : ex.cropRect(it);
    const o = rect ? ex.outSize(rect) : null;
    r.sz.textContent = o ? `${o.w} × ${o.h} px` : p;
    r.row.classList.toggle('empty', !!p);
  };
  /** Measure every listed item progressively (thumbnails + final sizes) without blocking the UI for long. */
  const refreshList = async () => {
    const job = ++listJob;
    for (const it of items) {
      if (closed || job !== listJob) return;
      if (!ex.measured(it)) {
        await nextFrame();
        if (closed || job !== listJob) return;
        ex.measure(it, it === cur);
      }
      updateRow(it);
    }
  };
  const schedulePreview = debounce(() => void refreshPreview(), 120);
  const scheduleEncode = debounce(() => void refreshEncode(), 250);
  const scheduleList = debounce(() => void refreshList(), 150);
  const changed = (sizes: boolean) => { gen++; schedulePreview(); if (sizes) scheduleList(); };
  const pick = (it: Item) => {
    cur = it;
    rows.forEach((r, k) => r.row.classList.toggle('active', k === it));
    shownKey = '';
    void refreshPreview();
  };

  // ----- export -----
  const doExport = async (list: Item[]): Promise<boolean> => {
    if (busy || (list.length === 1 && curProblem)) return false;
    busy = true; setBtns();
    const prev = sizeEl.textContent;
    sizeEl.textContent = list.length > 1 ? `exporting ${list.length} files…` : 'exporting…';
    try {
      const ok = await exportItems(ex, list);
      if (ok) savePrefs(s);
      return ok;
    } finally {
      busy = false;
      if (!closed) { setBtns(); sizeEl.textContent = prev; }
    }
  };
  const exportAllBtn = items.length > 1
    ? button(`Export All (${items.length})`, async () => { if (await doExport(items)) (root?.querySelector('.dlg-x') as HTMLElement | null)?.click(); }, { title: 'Export every listed layer with these settings' })
    : null;

  // Enter in a text field commits the field instead of exporting (runs before the dialog's own key handler)
  const keyGuard = (e: KeyboardEvent) => {
    const t = e.target;
    if (e.key === 'Enter' && t instanceof HTMLInputElement && t.type === 'text' && content.contains(t)) {
      e.preventDefault(); e.stopImmediatePropagation();
      t.dispatchEvent(new Event('change'));
      t.blur();
    }
  };
  window.addEventListener('keydown', keyGuard, true);
  try {
    await openDialog({
      title: mode === 'layers' ? (items.length > 1 ? 'Export Layers' : 'Export Layer As') : 'Export As',
      width: Math.round(Math.min(1100, window.innerWidth * 0.95)),
      content, okLabel: 'Export', className: 'ex-dlg',
      extraButtons: exportAllBtn ? [exportAllBtn] : undefined,
      onOk: () => doExport([cur]),
      onOpen: (r) => {
        root = r;
        okBtn = r.querySelector('.dlg-footer .ps-btn.primary');
        syncControls();
        ro.observe(stage);
        pick(cur);
        void refreshList();
      },
    });
  } finally {
    closed = true;
    ro.disconnect();
    window.removeEventListener('keydown', keyGuard, true);
  }
}

// ---------- menu hooks ----------
/** File > Export submenu. */
export function exportMenuItems(): MenuItem[] {
  const hasDoc = () => !!app.doc;
  const hasLayer = () => !!app.doc && exportableSelection(app.doc).length > 0;
  return [
    { label: 'Quick Export as PNG', shortcut: "Shift+Alt+Ctrl+'", enabled: hasDoc, action: () => void quickExportDocumentPng() },
    { label: 'Export As...', shortcut: 'Alt+Shift+Ctrl+W', enabled: hasDoc, action: () => void exportAsDialog('document') },
    SEP,
    { label: 'Export Layer As...', enabled: hasLayer, action: () => void exportAsDialog('layers') },
    { label: 'Quick Export Layer as PNG', enabled: hasLayer, action: () => void quickExportLayerPng() },
    { label: 'Export Layers to Files...', enabled: hasDoc, action: () => void exportLayersToFiles() },
  ];
}

/** Layers panel right-click menu entries (act on the selected layers). */
export function layerExportContextItems(): { label: string; action: () => void }[] {
  return [
    { label: 'Export As...', action: () => void exportAsDialog('layers') },
    { label: 'Quick Export as PNG', action: () => void quickExportLayerPng() },
  ];
}

const CSS = `
.ex { display: grid; grid-template-columns: 200px minmax(0, 1fr) 270px; gap: 12px; height: min(72vh, 680px); }
.ex-list { background: var(--panel-2); border: 1px solid var(--border); border-radius: 3px; overflow-y: auto; min-height: 0; }
.ex-list-head { padding: 7px 8px; color: var(--text-3); font-size: 11px; border-bottom: 1px solid var(--divider); }
.ex-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-bottom: 1px solid var(--divider); cursor: default; }
.ex-item:hover { background: var(--panel-3); }
.ex-item.active { background: var(--sel-row); }
.ex-item .th { width: 44px; height: 34px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border: 1px solid var(--thumb-border); background-color: var(--input); }
.ex-item .th canvas { max-width: 100%; max-height: 100%; display: block; }
.ex-item .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ex-item .nm { color: var(--text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-item .nm .hid { color: var(--text-3); }
.ex-item .sz { color: var(--text-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ex-item.empty .sz { color: var(--text-2); font-style: italic; }
.ex-center { display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; }
.ex-stage { flex: 1; min-height: 0; position: relative; display: flex; overflow: auto; background: var(--pasteboard); border: 1px solid var(--border); border-radius: 3px; }
.ex-stage.pannable { cursor: grab; }
.ex-stage.panning { cursor: grabbing; }
.ex-img { margin: auto; flex-shrink: 0; outline: 1px solid var(--border); }
.ex-img canvas { display: block; width: 100%; height: 100%; }
.ex-img.pixelated canvas { image-rendering: pixelated; }
.ex-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 20px; color: var(--text-2); font-size: 13px; pointer-events: none; }
.ex-bar { display: flex; align-items: center; gap: 4px; flex-shrink: 0; min-width: 0; }
.ex-bar .zl { min-width: 46px; text-align: center; color: var(--text-2); font-variant-numeric: tabular-nums; }
.ex-bar .info { margin-left: auto; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ex-bar .info b { color: var(--text-strong); font-weight: 600; }
.ex-bar .info .dot { color: var(--text-3); }
.ex-settings { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; min-height: 0; padding-right: 2px; }
.ex-settings .lbl { width: 62px; flex-shrink: 0; }
.ex-size { display: grid; grid-template-columns: 62px auto 1fr; gap: 6px; align-items: center; }
.ex-size .icon-btn { grid-column: 3; grid-row: 1 / span 2; }
.ex-grid { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 6px; align-items: center; }
.ex-grid .ps-select { width: 100% !important; }
.ex-settings .check-row.disabled { opacity: .5; }
`;
