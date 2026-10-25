// Image menu: Image Size, Canvas Size, Image Rotation, Trim, Reveal All, Duplicate.
import { app } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { Layer } from '../core/layer';
import { createCanvas, ctx2d, cssColor, Rect, RGB, alphaBounds, getImageData, cloneCanvas } from '../core/util';
import { renderTextLayer } from '../core/text';
import { renderShapeLayer } from '../core/shapes';
import { openDialog } from '../dialogs/dialog';
import { h } from '../ui/dom';
import { numberInput, select, checkbox, labeled, button, toast, segmented } from '../ui/widgets';
import { activeDoc } from './target';
import { rasterize } from './rasterize';
import { renderFillLayer } from './layerops';
import { cropDocument } from '../tools/transform';

export type Resample = 'nearest' | 'bilinear' | 'bicubic' | 'smoother';

/** High quality resize (step-down halving for big reductions). */
export function resampleCanvas(src: HTMLCanvasElement, w: number, hh: number, method: Resample = 'bicubic'): HTMLCanvasElement {
  w = Math.max(1, Math.round(w)); hh = Math.max(1, Math.round(hh));
  if (method === 'nearest') {
    const c = createCanvas(w, hh);
    const x = ctx2d(c);
    x.imageSmoothingEnabled = false;
    x.drawImage(src, 0, 0, w, hh);
    return c;
  }
  let cur = src;
  if (method !== 'bilinear') {
    while (cur.width / 2 > w && cur.height / 2 > hh) {
      const half = createCanvas(Math.max(w, Math.round(cur.width / 2)), Math.max(hh, Math.round(cur.height / 2)));
      const hx = ctx2d(half);
      hx.imageSmoothingQuality = 'high';
      hx.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
  }
  const c = createCanvas(w, hh);
  const x = ctx2d(c);
  x.imageSmoothingQuality = method === 'bilinear' ? 'low' : 'high';
  x.drawImage(cur, 0, 0, w, hh);
  return c;
}

/** Scale the whole document. */
export function resizeImage(doc: Doc, w: number, hh: number, method: Resample, resolution = doc.resolution) {
  const sx = w / doc.width, sy = hh / doc.height;
  const before = doc.captureState();
  for (const L of doc.layers) {
    if (L.kind === 'raster') {
      L.canvas = resampleCanvas(L.canvas, L.canvas.width * sx, L.canvas.height * sy, method);
      L.x = Math.round(L.x * sx); L.y = Math.round(L.y * sy);
    } else if (L.kind === 'text' && L.text) {
      const pad = L.text.pad ?? 0;
      const ax = (L.x + pad) * sx, ay = (L.y + pad) * sy;
      L.text = { ...L.text, size: L.text.size * Math.min(sx, sy), boxWidth: L.text.boxWidth ? L.text.boxWidth * sx : undefined, boxHeight: L.text.boxHeight ? L.text.boxHeight * sy : undefined, pad: 0 };
      L.x = ax; L.y = ay;
      renderTextLayer(L);
    } else if (L.kind === 'shape' && L.shape) {
      const pad = L.shape.pad ?? 0;
      const ax = (L.x + pad) * sx, ay = (L.y + pad) * sy;
      L.shape = { ...L.shape, w: L.shape.w * sx, h: L.shape.h * sy, strokeWidth: L.shape.strokeWidth * Math.min(sx, sy), pad: 0, x1: (L.shape.x1 ?? 0) * sx, y1: (L.shape.y1 ?? 0) * sy, x2: (L.shape.x2 ?? 0) * sx, y2: (L.shape.y2 ?? 0) * sy };
      L.x = ax; L.y = ay;
      renderShapeLayer(L);
    }
    if (L.mask) {
      L.mask = resampleCanvas(L.mask, L.mask.width * sx, L.mask.height * sy, method === 'nearest' ? 'nearest' : 'bilinear');
      L.maskX = Math.round(L.maskX * sx); L.maskY = Math.round(L.maskY * sy);
    }
    L.touch();
  }
  if (doc.selection) {
    const s = resampleCanvas(doc.selection, w, hh, 'bilinear');
    doc.selection = null;
    doc.setSelection(s);
  }
  doc.channels = doc.channels.map((c) => ({ ...c, canvas: resampleCanvas(c.canvas, w, hh, 'bilinear') }));
  doc.guides = doc.guides.map((g) => ({ ...g, pos: g.pos * (g.dir === 'v' ? sx : sy) }));
  doc.width = Math.round(w); doc.height = Math.round(hh); doc.resolution = resolution;
  doc.composite = createCanvas(doc.width, doc.height);
  for (const L of doc.layers) if (L.kind === 'fill') renderFillLayer(doc, L);
  doc.commit('Image Size', before);
  doc.viewInit = false;
  bus.emit('view', doc);
}

export async function imageSizeDialog() {
  const doc = activeDoc(); if (!doc) return;
  let unit: 'px' | '%' | 'in' | 'cm' = 'px';
  let res = doc.resolution;
  let constrain = true;
  let W = doc.width, H = doc.height;
  const ratio = doc.width / doc.height;
  const toUnit = (px: number, full: number) => unit === 'px' ? px : unit === '%' ? (px / full) * 100 : unit === 'in' ? px / res : (px / res) * 2.54;
  const fromUnit = (v: number, full: number) => unit === 'px' ? v : unit === '%' ? (v / 100) * full : unit === 'in' ? v * res : (v / 2.54) * res;
  const sizeLabel = h('div', { class: 'field-label' });
  const updLabel = () => { sizeLabel.textContent = `Image Size: ${fmtBytes(Math.round(W) * Math.round(H) * 4)}   Dimensions: ${Math.round(W)} px × ${Math.round(H)} px`; };
  const wIn = numberInput({ value: W, min: 0.01, max: 100000, step: 1, decimals: 2, width: 90, onChange: (v) => { W = fromUnit(v, doc.width); if (constrain) { H = W / ratio; hIn.set(toUnit(H, doc.height)); } updLabel(); } });
  const hIn = numberInput({ value: H, min: 0.01, max: 100000, step: 1, decimals: 2, width: 90, onChange: (v) => { H = fromUnit(v, doc.height); if (constrain) { W = H * ratio; wIn.set(toUnit(W, doc.width)); } updLabel(); } });
  const unitSel = select({ options: [{ value: 'px', label: 'Pixels' }, { value: '%', label: 'Percent' }, { value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimeters' }], value: 'px', width: 110, onChange: (v) => { unit = v as any; wIn.set(toUnit(W, doc.width)); hIn.set(toUnit(H, doc.height)); } });
  const resIn = numberInput({ value: res, min: 1, max: 10000, width: 90, decimals: 2, onChange: (v) => { res = v; } });
  const link = checkbox({ label: 'Constrain Proportions', checked: true, onChange: (v) => { constrain = v; } });
  const resample = checkbox({ label: 'Resample:', checked: true });
  const method = select({ options: [{ value: 'bicubic', label: 'Automatic (Bicubic)' }, { value: 'smoother', label: 'Bicubic Smoother (enlargement)' }, { value: 'bilinear', label: 'Bilinear' }, { value: 'nearest', label: 'Nearest Neighbor (hard edges)' }], value: 'bicubic', width: 230 });
  const fit = select({
    options: [{ value: '', label: 'Original Size' }, { value: '640x480', label: '640 × 480 px' }, { value: '800x600', label: '800 × 600 px' }, { value: '1024x768', label: '1024 × 768 px' }, { value: '1280x720', label: '1280 × 720 px (HD)' }, { value: '1920x1080', label: '1920 × 1080 px (Full HD)' }, { value: '3840x2160', label: '3840 × 2160 px (4K)' }],
    value: '', width: 230,
    onChange: (v) => {
      if (!v) { W = doc.width; H = doc.height; } else {
        const [fw, fh] = v.split('x').map(Number);
        const s = Math.min(fw / doc.width, fh / doc.height);
        W = doc.width * s; H = doc.height * s;
      }
      wIn.set(toUnit(W, doc.width)); hIn.set(toUnit(H, doc.height)); updLabel();
    },
  });
  updLabel();
  const ok = await openDialog({
    title: 'Image Size', width: 480,
    content: h('div', { class: 'col' }, sizeLabel,
      h('div', { class: 'form-grid' },
        h('span', { class: 'field-label' }, 'Fit To:'), fit.el,
        h('span', { class: 'field-label' }, 'Width:'), h('div', { class: 'row' }, wIn.el, unitSel.el),
        h('span', { class: 'field-label' }, 'Height:'), hIn.el,
        h('span', { class: 'field-label' }, ''), link.el,
        h('span', { class: 'field-label' }, 'Resolution:'), h('div', { class: 'row' }, resIn.el, h('span', { class: 'field-label' }, 'Pixels/Inch')),
        resample.el, method.el)),
  });
  if (!ok) return;
  if (!resample.get()) { doc.resolution = res; bus.emit('docs'); return; }
  if (Math.round(W) === doc.width && Math.round(H) === doc.height) { doc.resolution = res; return; }
  resizeImage(doc, W, H, method.get() as Resample, res);
}
export const fmtBytes = (n: number) => n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}M` : `${Math.round(n / 1024)}K`;

/** Change canvas size with anchor (ax, ay in 0, 0.5, 1). */
export function resizeCanvas(doc: Doc, w: number, hh: number, ax: number, ay: number, ext: RGB, name = 'Canvas Size') {
  const dx = Math.round((w - doc.width) * ax), dy = Math.round((hh - doc.height) * ay);
  const before = doc.captureState();
  for (const L of doc.layers) {
    L.x += dx; L.y += dy; L.maskX += dx; L.maskY += dy;
  }
  doc.width = Math.round(w); doc.height = Math.round(hh);
  for (const L of doc.layers) {
    if (L.isBackground) {
      const c = createCanvas(doc.width, doc.height);
      const cx = ctx2d(c);
      cx.fillStyle = cssColor(ext); cx.fillRect(0, 0, doc.width, doc.height);
      cx.drawImage(L.canvas, L.x, L.y);
      L.canvas = c; L.x = 0; L.y = 0;
    } else if (L.kind === 'raster') doc.ensureCoverage(L);
    else if (L.kind === 'fill') renderFillLayer(doc, L);
    if (L.mask) doc.ensureCoverage(L);
    L.touch();
  }
  if (doc.selection) {
    const s = createCanvas(doc.width, doc.height);
    ctx2d(s).drawImage(doc.selection, dx, dy);
    doc.selection = null;
    doc.setSelection(s);
  }
  doc.guides = doc.guides.map((g) => ({ ...g, pos: g.pos + (g.dir === 'v' ? dx : dy) }));
  doc.composite = createCanvas(doc.width, doc.height);
  doc.commit(name, before);
  doc.viewInit = false;
  bus.emit('view', doc);
}

export async function canvasSizeDialog() {
  const doc = activeDoc(); if (!doc) return;
  let relative = false;
  let ax = 0.5, ay = 0.5;
  const wIn = numberInput({ value: doc.width, min: -30000, max: 30000, width: 90 });
  const hIn = numberInput({ value: doc.height, min: -30000, max: 30000, width: 90 });
  const rel = checkbox({ label: 'Relative', checked: false, onChange: (v) => { relative = v; wIn.set(v ? 0 : doc.width); hIn.set(v ? 0 : doc.height); } });
  const anchor = h('div', { class: 'anchor-grid' });
  const arrows = ['↖', '↑', '↗', '←', '•', '→', '↙', '↓', '↘'];
  const btns: HTMLButtonElement[] = [];
  const sync = () => btns.forEach((b, i) => { const bx = (i % 3) / 2, by = Math.floor(i / 3) / 2; b.classList.toggle('on', bx === ax && by === ay); b.textContent = bx === ax && by === ay ? '●' : arrows[i]; });
  for (let i = 0; i < 9; i++) {
    const b = h('button', { type: 'button' }) as HTMLButtonElement;
    b.addEventListener('click', () => { ax = (i % 3) / 2; ay = Math.floor(i / 3) / 2; sync(); });
    btns.push(b); anchor.appendChild(b);
  }
  sync();
  const ext = select({ options: [{ value: 'bg', label: 'Background' }, { value: 'fg', label: 'Foreground' }, { value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'gray', label: 'Gray' }], value: 'bg', width: 140 });
  const ok = await openDialog({
    title: 'Canvas Size', width: 420,
    content: h('div', { class: 'col' },
      h('div', { class: 'field-label' }, `Current Size: ${doc.width} px × ${doc.height} px`),
      h('div', { class: 'form-grid' },
        h('span', { class: 'field-label' }, 'Width:'), h('div', { class: 'row' }, wIn.el, h('span', { class: 'field-label' }, 'Pixels')),
        h('span', { class: 'field-label' }, 'Height:'), h('div', { class: 'row' }, hIn.el, h('span', { class: 'field-label' }, 'Pixels')),
        h('span', null), rel.el,
        h('span', { class: 'field-label' }, 'Anchor:'), anchor,
        h('span', { class: 'field-label' }, 'Canvas extension color:'), ext.el)),
  });
  if (!ok) return;
  const w = relative ? doc.width + wIn.get() : wIn.get();
  const hh = relative ? doc.height + hIn.get() : hIn.get();
  if (w < 1 || hh < 1) return;
  const c = ext.get();
  const color: RGB = c === 'bg' ? app.bg : c === 'fg' ? app.fg : c === 'white' ? { r: 255, g: 255, b: 255 } : c === 'black' ? { r: 0, g: 0, b: 0 } : { r: 128, g: 128, b: 128 };
  resizeCanvas(doc, w, hh, ax, ay, color);
}

/** Rotate/flip a canvas by a 2D transform; returns new canvas and its position. */
function transformed(src: HTMLCanvasElement, x: number, y: number, m: DOMMatrix, smooth: boolean) {
  const pts = [[x, y], [x + src.width, y], [x, y + src.height], [x + src.width, y + src.height]].map(([px, py]) => m.transformPoint(new DOMPoint(px, py)));
  const minX = Math.floor(Math.min(...pts.map((p) => p.x)) + 1e-6), minY = Math.floor(Math.min(...pts.map((p) => p.y)) + 1e-6);
  const maxX = Math.ceil(Math.max(...pts.map((p) => p.x)) - 1e-6), maxY = Math.ceil(Math.max(...pts.map((p) => p.y)) - 1e-6);
  const c = createCanvas(Math.max(1, maxX - minX), Math.max(1, maxY - minY));
  const cx = ctx2d(c);
  cx.imageSmoothingEnabled = smooth;
  cx.imageSmoothingQuality = 'high';
  cx.setTransform(m.a, m.b, m.c, m.d, m.e - minX, m.f - minY);
  cx.drawImage(src, x, y);
  return { canvas: c, x: minX, y: minY };
}

/** Image > Image Rotation and Flip Canvas. deg in degrees clockwise. */
export function rotateCanvas(doc: Doc, deg: number, flip?: 'h' | 'v', name?: string) {
  const before = doc.captureState();
  const W = doc.width, H = doc.height;
  let m = new DOMMatrix();
  let nw = W, nh = H;
  if (flip === 'h') m = new DOMMatrix([-1, 0, 0, 1, W, 0]);
  else if (flip === 'v') m = new DOMMatrix([1, 0, 0, -1, 0, H]);
  else {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const right = Math.abs(deg % 90) < 1e-9;
    nw = right ? Math.round(Math.abs(W * c) + Math.abs(H * s)) : Math.ceil(Math.abs(W * c) + Math.abs(H * s));
    nh = right ? Math.round(Math.abs(W * s) + Math.abs(H * c)) : Math.ceil(Math.abs(W * s) + Math.abs(H * c));
    m = new DOMMatrix().translate(nw / 2, nh / 2).rotate(deg).translate(-W / 2, -H / 2);
  }
  const smooth = !(flip || Math.abs(deg % 90) < 1e-9);
  let rasterized = false;
  for (const L of doc.layers) {
    if (L.kind === 'text' || L.kind === 'shape') { rasterize(doc, L); rasterized = true; }
    if (L.kind === 'raster') {
      const r = transformed(L.canvas, L.x, L.y, m, smooth);
      L.canvas = r.canvas; L.x = r.x; L.y = r.y;
    }
    if (L.mask) {
      const r = transformed(L.mask, L.maskX, L.maskY, m, smooth);
      L.mask = r.canvas; L.maskX = r.x; L.maskY = r.y;
    }
    L.touch();
  }
  doc.width = nw; doc.height = nh;
  for (const L of doc.layers) {
    if (L.isBackground && smooth) {
      const c = createCanvas(nw, nh);
      const cx = ctx2d(c);
      cx.fillStyle = cssColor(app.bg); cx.fillRect(0, 0, nw, nh);
      cx.drawImage(L.canvas, L.x, L.y);
      L.canvas = c; L.x = 0; L.y = 0;
    } else if (L.kind === 'raster') doc.ensureCoverage(L);
    if (L.kind === 'fill') renderFillLayer(doc, L);
    if (L.mask) doc.ensureCoverage(L);
  }
  if (doc.selection) {
    const r = transformed(doc.selection, 0, 0, m, smooth);
    const s = createCanvas(nw, nh);
    ctx2d(s).drawImage(r.canvas, r.x, r.y);
    doc.selection = null;
    doc.setSelection(s);
  }
  doc.composite = createCanvas(nw, nh);
  doc.guides = [];
  doc.commit(name ?? (flip ? (flip === 'h' ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical') : 'Rotate Canvas'), before);
  doc.viewInit = false;
  bus.emit('view', doc);
  if (rasterized) toast('Type and shape layers were rasterized');
}

export async function arbitraryRotateDialog() {
  const doc = activeDoc(); if (!doc) return;
  const a = numberInput({ value: 0, min: -359.99, max: 359.99, step: 0.1, decimals: 2, width: 80 });
  const dir = segmented({ value: 'cw', options: [{ value: 'cw', label: '°CW' }, { value: 'ccw', label: '°CCW' }] });
  const ok = await openDialog({ title: 'Rotate Canvas', width: 340, content: h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Angle:'), a.el, dir.el), onOpen: () => a.input.focus() });
  if (!ok || !a.get()) return;
  rotateCanvas(doc, dir.get() === 'cw' ? a.get() : -a.get());
}

/** Rotate just the active layer around the doc center (Ruler > Straighten Layer) or the canvas. */
export function rotateLayerOrCanvas(deg: number, what: 'layer' | 'canvas') {
  const doc = activeDoc(); if (!doc) return;
  if (what === 'canvas') { rotateCanvas(doc, deg); return; }
  const L = doc.active;
  if (!L || L.kind !== 'raster') { toast('Select a pixel layer to straighten'); return; }
  const before = doc.captureState();
  const m = new DOMMatrix().translate(doc.width / 2, doc.height / 2).rotate(deg).translate(-doc.width / 2, -doc.height / 2);
  const r = transformed(L.canvas, L.x, L.y, m, true);
  L.canvas = r.canvas; L.x = r.x; L.y = r.y;
  if (L.isBackground) { L.isBackground = false; L.lockAlpha = false; L.lockPosition = false; L.name = 'Layer 0'; }
  doc.ensureCoverage(L);
  L.touch();
  doc.commit('Straighten Layer', before);
}

export async function trimDialog() {
  const doc = activeDoc(); if (!doc) return;
  const based = segmented({ value: 'transparent', options: [{ value: 'transparent', label: 'Transparent Pixels' }, { value: 'tl', label: 'Top Left Pixel Color' }, { value: 'br', label: 'Bottom Right Pixel Color' }] });
  const ok = await openDialog({ title: 'Trim', width: 460, content: h('div', { class: 'col' }, h('div', { class: 'field-label' }, 'Based On'), based.el) });
  if (!ok) return;
  let r: Rect | null;
  if (based.get() === 'transparent') r = alphaBounds(doc.composite);
  else {
    const img = getImageData(doc.composite);
    const d = img.data, w = img.width, hh = img.height;
    const i0 = based.get() === 'tl' ? 0 : (w * hh - 1) * 4;
    const same = (i: number) => Math.abs(d[i] - d[i0]) < 2 && Math.abs(d[i + 1] - d[i0 + 1]) < 2 && Math.abs(d[i + 2] - d[i0 + 2]) < 2 && Math.abs(d[i + 3] - d[i0 + 3]) < 2;
    let x0 = w, y0 = hh, x1 = -1, y1 = -1;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (!same((y * w + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    r = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  if (!r) { toast('Nothing to trim'); return; }
  if (r.x === 0 && r.y === 0 && r.w === doc.width && r.h === doc.height) { toast('Nothing to trim'); return; }
  cropDocument(doc, r, true);
}

export function revealAll() {
  const doc = activeDoc(); if (!doc) return;
  let x0 = 0, y0 = 0, x1 = doc.width, y1 = doc.height;
  for (const L of doc.layers) {
    if (L.kind === 'adjustment') continue;
    const b = alphaBounds(L.canvas);
    if (!b) continue;
    x0 = Math.min(x0, L.x + b.x); y0 = Math.min(y0, L.y + b.y);
    x1 = Math.max(x1, L.x + b.x + b.w); y1 = Math.max(y1, L.y + b.y + b.h);
  }
  if (x0 === 0 && y0 === 0 && x1 === doc.width && y1 === doc.height) { toast('All pixels are already visible'); return; }
  cropDocument(doc, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, false);
}

export function duplicateImage(name?: string) {
  const doc = activeDoc(); if (!doc) return;
  const d = new Doc(name ?? `${doc.name.replace(/\.[^.]+$/, '')} copy`, doc.width, doc.height);
  d.resolution = doc.resolution;
  for (const L of doc.layers) {
    const c = new Layer(L.name, 1, 1);
    const { layer: _ignored, ...props } = L.snapshot();
    Object.assign(c, props);
    c.canvas = cloneCanvas(L.canvas);
    c.mask = L.mask ? cloneCanvas(L.mask) : null;
    c.isBackground = L.isBackground;
    d.layers.push(c);
  }
  // remap group membership to the new layer ids
  const ids = new Map(doc.layers.map((l, i) => [l.id, d.layers[i].id]));
  for (const l of d.layers) l.parentId = ids.get(l.parentId) ?? 0;
  d.activeId = d.layers[d.layers.length - 1]?.id ?? 0;
  d.historyBaseName = 'Duplicate';
  app.addDoc(d);
}
void button; void labeled;
