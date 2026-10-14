import { app } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { Layer } from '../core/layer';
import {
  borderMask, colorRangeMask, colorRegion, combineMask, copyMask, expandMask, featherMask, invertMask, maskFromAlpha,
  maskFromLuminosity, SelectMode, smoothMask, hardenMask,
} from '../core/selection';
import { createCanvas, ctx2d, getImageData, RGB, uid, blurCanvas } from '../core/util';
import { flattenLayers } from '../core/compositor';
import { openDialog, alertDialog } from '../dialogs/dialog';
import { h } from '../ui/dom';
import { checkbox, numberInput, select, sliderField, toast, labeled, segmented } from '../ui/widgets';
import { activeDoc } from './target';

const lastSel = new WeakMap<Doc, HTMLCanvasElement>();

/** Replace the selection as an undoable step. */
export function commitSelection(doc: Doc, mask: HTMLCanvasElement | null, name: string) {
  const before = doc.captureState();
  if (doc.selection) lastSel.set(doc, doc.selection);
  doc.setSelection(mask);
  doc.commit(name, before);
}
/** Combine a shape mask into the selection with a marquee mode. */
export function applySelectShape(doc: Doc, shape: HTMLCanvasElement, mode: SelectMode, name: string) {
  commitSelection(doc, combineMask(doc.selection, shape, mode), name);
}

export function selectAll() {
  const d = activeDoc(); if (!d) return;
  const m = createCanvas(d.width, d.height);
  const x = ctx2d(m); x.fillStyle = '#000'; x.fillRect(0, 0, d.width, d.height);
  commitSelection(d, m, 'Select All');
}
export function deselect() {
  const d = app.doc; if (!d || !d.selection) return;
  commitSelection(d, null, 'Deselect');
}
export function reselect() {
  const d = app.doc; if (!d) return;
  const m = lastSel.get(d);
  if (m) commitSelection(d, m, 'Reselect');
}
export function inverse() {
  const d = app.doc; if (!d) return;
  commitSelection(d, invertMask(d.selection, d.width, d.height), 'Select Inverse');
}

/** Sample canvas for wand / bucket: active layer or merged. */
export function sampleImage(doc: Doc, allLayers: boolean): ImageData {
  if (allLayers) return getImageData(doc.composite);
  const L = doc.active;
  const c = createCanvas(doc.width, doc.height);
  if (L && L.kind !== 'adjustment') ctx2d(c).drawImage(L.canvas, L.x, L.y);
  return getImageData(c);
}

export function grow(similar = false) {
  const d = app.doc; if (!d || !d.selection) return;
  const tol = app.wandTolerance;
  const img = sampleImage(d, false);
  const sel = getImageData(d.selection).data;
  // average color of the selection
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < sel.length; i += 4) if (sel[i + 3] > 127) { r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
  if (!n) return;
  const avg: RGB = { r: r / n, g: g / n, b: b / n };
  let out: HTMLCanvasElement;
  if (similar) {
    out = colorRangeMask(img, avg, tol);
    hardenMask(out);
  } else {
    // contiguous: flood from each selected edge seed — approximate with dilation constrained to similar colors
    const sim = colorRangeMask(img, avg, tol);
    hardenMask(sim);
    const simD = getImageData(sim).data;
    let cur = copyMask(d.selection);
    for (let k = 0; k < 64; k++) {
      const grown = expandMask(cur, 2);
      const gd = getImageData(grown);
      let changed = false;
      const cd = getImageData(cur).data;
      for (let i = 3; i < gd.data.length; i += 4) {
        if (gd.data[i] && !simD[i] && !cd[i]) gd.data[i] = 0;
        if (gd.data[i] !== cd[i]) changed = true;
      }
      ctx2d(grown).putImageData(gd, 0, 0);
      cur = grown;
      if (!changed) break;
    }
    out = combineMask(d.selection, cur, 'add');
  }
  commitSelection(d, similar ? combineMask(d.selection, out, 'add') : out, similar ? 'Similar' : 'Grow');
}

export async function modifyDialog(kind: 'feather' | 'expand' | 'contract' | 'border' | 'smooth') {
  const d = app.doc; if (!d || !d.selection) { toast('No selection'); return; }
  const titles = { feather: 'Feather Selection', expand: 'Expand Selection', contract: 'Contract Selection', border: 'Border Selection', smooth: 'Smooth Selection' };
  const labels = { feather: 'Feather Radius:', expand: 'Expand By:', contract: 'Contract By:', border: 'Width:', smooth: 'Sample Radius:' };
  const n = numberInput({ value: kind === 'feather' ? 5 : kind === 'border' ? 10 : 4, min: kind === 'feather' ? 0.1 : 1, max: 500, step: kind === 'feather' ? 0.1 : 1, unit: 'pixels', width: 70 });
  const ok = await openDialog({
    title: titles[kind], width: 340,
    content: h('div', { class: 'col' }, labeled(labels[kind], n.el, 100)),
    onOpen: () => { n.input.focus(); n.input.select(); },
  });
  if (!ok) return;
  const v = n.get();
  const m = d.selection;
  let out: HTMLCanvasElement;
  switch (kind) {
    case 'feather': out = featherMask(m, v); break;
    case 'expand': out = expandMask(m, v); break;
    case 'contract': out = expandMask(m, -v); break;
    case 'border': out = borderMask(m, v); break;
    case 'smooth': out = smoothMask(m, v); break;
  }
  commitSelection(d, out, titles[kind].replace(' Selection', ''));
}

export function loadFromLayer(doc: Doc, L: Layer, mode: SelectMode = 'new', useMask = false) {
  let m: HTMLCanvasElement;
  if (useMask && L.mask) m = maskFromAlpha(L.mask, L.maskX, L.maskY, doc.width, doc.height);
  else if (L.kind === 'adjustment' || L.kind === 'fill') {
    m = L.mask ? maskFromAlpha(L.mask, L.maskX, L.maskY, doc.width, doc.height) : invertMask(null, doc.width, doc.height);
  } else m = maskFromAlpha(L.canvas, L.x, L.y, doc.width, doc.height);
  applySelectShape(doc, m, mode, 'Load Selection');
}
export function selectLuminosity() {
  const d = app.doc; if (!d) return;
  commitSelection(d, maskFromLuminosity(getImageData(d.composite)), 'Load Selection');
}

export async function saveSelectionDialog() {
  const d = app.doc; if (!d || !d.selection) { toast('No selection to save'); return; }
  const name = `Alpha ${d.channels.length + 1}`;
  const before = d.captureState();
  d.channels = [...d.channels, { id: uid(), name, canvas: copyMask(d.selection) }];
  d.commit('Save Selection', before);
  bus.emit('channels', d);
  toast(`Selection saved as “${name}”`);
}
export async function loadSelectionDialog() {
  const d = app.doc; if (!d) return;
  const opts = [
    ...d.channels.map((c) => ({ value: `ch:${c.id}`, label: c.name })),
    ...d.layers.filter((l) => l.kind !== 'adjustment').map((l) => ({ value: `ly:${l.id}`, label: `${l.name} Transparency` })),
    ...d.layers.filter((l) => l.mask).map((l) => ({ value: `mk:${l.id}`, label: `${l.name} Mask` })),
  ];
  if (!opts.length) { await alertDialog('Load Selection', 'There are no channels or layers to load a selection from.'); return; }
  const src = select({ options: opts, value: opts[0].value, width: 220 });
  const inv = checkbox({ label: 'Invert', checked: false });
  const mode = segmented({ value: d.selection ? 'new' : 'new', options: [
    { value: 'new', label: 'New' }, { value: 'add', label: 'Add' }, { value: 'subtract', label: 'Subtract' }, { value: 'intersect', label: 'Intersect' },
  ] });
  const ok = await openDialog({
    title: 'Load Selection', width: 420, layout: 'side',
    content: h('div', { class: 'col' }, labeled('Channel:', src.el, 70), inv.el, labeled('Operation:', mode.el, 70)),
  });
  if (!ok) return;
  const [k, idStr] = src.get().split(':');
  const id = Number(idStr);
  let m: HTMLCanvasElement | null = null;
  if (k === 'ch') m = copyMask(d.channels.find((c) => c.id === id)!.canvas);
  else {
    const L = d.byId(id)!;
    m = k === 'mk' ? maskFromAlpha(L.mask!, L.maskX, L.maskY, d.width, d.height) : maskFromAlpha(L.canvas, L.x, L.y, d.width, d.height);
  }
  if (inv.get()) m = invertMask(m, d.width, d.height);
  applySelectShape(d, m, mode.get() as SelectMode, 'Load Selection');
}

export function toggleQuickMask() {
  const d = app.doc; if (!d) return;
  d.quickMask = !d.quickMask;
  if (d.quickMask && !d.selection) {
    // empty selection: everything masked
    d.selection = createCanvas(d.width, d.height);
  }
  if (!d.quickMask) d.setSelection(d.selection); // drops empty, refreshes outline
  bus.emit('selection', d);
  bus.emit('layers', d);
  bus.emit('docs');
  d.invalidate();
}

/** Select > Color Range */
export async function colorRangeDialog() {
  const d = activeDoc(); if (!d) return;
  const img = sampleImage(d, true);
  let color: RGB = { ...app.fg };
  let fuzz = 40;
  const prevC = createCanvas(200, 200);
  const s = Math.min(200 / d.width, 200 / d.height);
  prevC.width = Math.max(1, Math.round(d.width * s)); prevC.height = Math.max(1, Math.round(d.height * s));
  prevC.style.cursor = 'crosshair';
  const small = createCanvas(prevC.width, prevC.height);
  ctx2d(small).drawImage(d.composite, 0, 0, small.width, small.height);
  const smallImg = getImageData(small);
  const showSel = segmented({ value: 'sel', options: [{ value: 'sel', label: 'Selection' }, { value: 'img', label: 'Image' }], onChange: () => draw() });
  const swatch = h('div', { style: { width: '26px', height: '22px', border: '1px solid var(--input-border)' } });
  const draw = () => {
    const x = ctx2d(prevC);
    if (showSel.get() === 'img') { x.drawImage(small, 0, 0); }
    else {
      const m = colorRangeMask(smallImg, color, fuzz);
      const md = getImageData(m);
      for (let i = 0; i < md.data.length; i += 4) { const a = md.data[i + 3]; md.data[i] = md.data[i + 1] = md.data[i + 2] = a; md.data[i + 3] = 255; }
      x.putImageData(md, 0, 0);
    }
    swatch.style.background = `rgb(${color.r},${color.g},${color.b})`;
  };
  prevC.addEventListener('pointerdown', (e) => {
    const r = prevC.getBoundingClientRect();
    const px = Math.floor(((e.clientX - r.left) / r.width) * small.width), py = Math.floor(((e.clientY - r.top) / r.height) * small.height);
    const i = (py * small.width + px) * 4;
    color = { r: smallImg.data[i], g: smallImg.data[i + 1], b: smallImg.data[i + 2] };
    draw();
  });
  const fz = sliderField({ label: 'Fuzziness:', value: fuzz, min: 0, max: 200, onInput: (v) => { fuzz = v; draw(); } });
  const inv = checkbox({ label: 'Invert', checked: false });
  draw();
  const ok = await openDialog({
    title: 'Color Range', layout: 'side', width: 420,
    content: h('div', { class: 'col' },
      h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Select: Sampled Colors'), swatch),
      fz.el,
      h('div', { class: 'preview-box', style: { height: '210px' } }, prevC),
      showSel.el, inv.el,
      h('div', { class: 'field-label', style: { fontSize: '11px' } }, 'Click in the preview to sample a color.')),
  });
  if (!ok) return;
  let m = colorRangeMask(img, color, fuzz);
  if (inv.get()) m = invertMask(m, d.width, d.height);
  applySelectShape(d, m, d.selection ? 'new' : 'new', 'Color Range');
}

/** Select and Mask (simplified refine edge). */
export async function selectAndMaskDialog() {
  const d = app.doc; if (!d || !d.selection) { toast('Make a selection first'); return; }
  const orig = d.selection;
  const p = { smooth: 0, feather: 0, contrast: 0, shift: 0 };
  const compute = () => {
    let m = copyMask(orig);
    if (p.shift) m = expandMask(m, (p.shift / 100) * 20);
    if (p.smooth) m = smoothMask(m, p.smooth);
    if (p.feather) m = featherMask(m, p.feather);
    if (p.contrast) {
      const id = getImageData(m);
      const k = 1 + (p.contrast / 100) * 10;
      for (let i = 3; i < id.data.length; i += 4) id.data[i] = Math.max(0, Math.min(255, (id.data[i] - 128) * k + 128));
      ctx2d(m).putImageData(id, 0, 0);
    }
    return m;
  };
  let timer = 0;
  const update = () => { clearTimeout(timer); timer = window.setTimeout(() => { d.setSelection(compute()); }, 60); };
  const fields = [
    sliderField({ label: 'Smooth', value: 0, min: 0, max: 100, onInput: (v) => { p.smooth = v; update(); } }),
    sliderField({ label: 'Feather', value: 0, min: 0, max: 250, step: 0.1, unit: 'px', onInput: (v) => { p.feather = v; update(); } }),
    sliderField({ label: 'Contrast', value: 0, min: 0, max: 100, unit: '%', onInput: (v) => { p.contrast = v; update(); } }),
    sliderField({ label: 'Shift Edge', value: 0, min: -100, max: 100, unit: '%', onInput: (v) => { p.shift = v; update(); } }),
  ];
  const ok = await openDialog({
    title: 'Select and Mask', layout: 'side', width: 380,
    content: h('div', { class: 'col' }, h('div', { class: 'field-label' }, 'Global Refinements'), ...fields.map((f) => f.el)),
  });
  clearTimeout(timer);
  d.selection = orig;
  if (ok) commitSelection(d, compute(), 'Select and Mask');
  else d.setSelection(orig);
}

/** Select > Subject-ish: select non-background area (alpha or dissimilar-to-border colors). */
export function selectSubject() {
  const d = activeDoc(); if (!d) return;
  const img = getImageData(flattenLayers(d, d.layers));
  const { width: w, height: h0, data } = img;
  // average border color
  let r = 0, g = 0, b = 0, n = 0;
  const add = (x: number, y: number) => { const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; };
  for (let x = 0; x < w; x += 2) { add(x, 0); add(x, h0 - 1); }
  for (let y = 0; y < h0; y += 2) { add(0, y); add(w - 1, y); }
  const bg: RGB = { r: r / n, g: g / n, b: b / n };
  // flood background from the borders with tolerance, then invert
  const tol = 48;
  let bgMask = createCanvas(w, h0);
  for (const [sx, sy] of [[0, 0], [w - 1, 0], [0, h0 - 1], [w - 1, h0 - 1], [w >> 1, 0], [0, h0 >> 1], [w - 1, h0 >> 1], [w >> 1, h0 - 1]]) {
    const i = (sy * w + sx) * 4;
    const dc = Math.max(Math.abs(data[i] - bg.r), Math.abs(data[i + 1] - bg.g), Math.abs(data[i + 2] - bg.b));
    if (dc > tol * 1.5) continue;
    bgMask = combineMask(bgMask, colorRegion(img, sx, sy, tol, true, false), 'add');
  }
  let m = invertMask(bgMask, w, h0);
  m = smoothMask(m, 2);
  m = blurCanvas(m, 0.7, 'transparent');
  commitSelection(d, m, 'Select Subject');
}

/** Move the selection outline (not pixels) — arrow keys with a selection tool. */
export function nudgeSelection(dx: number, dy: number) {
  const d = app.doc;
  if (!d || !d.selection || (!dx && !dy)) return;
  const m = createCanvas(d.width, d.height);
  ctx2d(m).drawImage(d.selection, dx, dy);
  commitSelection(d, m, 'Nudge Selection');
}
