// Edit menu: clipboard, fill, stroke, transforms, preferences.
import { app } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { Layer, BlendMode, BLEND_MODES, BLEND_NAMES } from '../core/layer';
import { createCanvas, ctx2d, cssColor, RGB, canvasToBlob, cloneCanvas, rectIntersect, alphaBounds } from '../core/util';
import { flattenLayers } from '../core/compositor';
import { maskBounds, expandMask, invertMask } from '../core/selection';
import { spotHeal } from '../core/heal';
import { openDialog, alertDialog } from '../dialogs/dialog';
import { h } from '../ui/dom';
import { select, numberInput, checkbox, colorSwatch, toast, pickColor, segmented, sliderField } from '../ui/widgets';
import { activeDoc, editableTarget, currentTarget } from './target';
import { paintOnto, solidFor } from './paintops';
import { liftContent, composeOnto, renderQuad, quadFromRect, transformMask, Quad } from './transform';
import { getTool, currentTool } from '../tools/tool';
import type { TransformTool } from '../tools/transform';
import { HISTORY_LIMIT } from '../core/document';
import { block } from '../core/groups';

// ---------- clipboard ----------
function selectionPixels(doc: Doc, merged: boolean): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  const A = doc.active;
  const src = merged ? { canvas: flattenLayers(doc, doc.layers), x: 0, y: 0 }
    : A && A.kind === 'group' ? { canvas: flattenLayers(doc, block(doc, A)), x: 0, y: 0 }
    : A && A.kind !== 'adjustment' ? { canvas: A.canvas, x: A.x, y: A.y } : null;
  if (!src) return null;
  let r = doc.selectionBounds() ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  r = rectIntersect(r, { x: 0, y: 0, w: doc.width, h: doc.height }) ?? r;
  const c = createCanvas(r.w, r.h);
  const x = ctx2d(c);
  x.drawImage(src.canvas, src.x - r.x, src.y - r.y);
  if (doc.selection) {
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(doc.selection, -r.x, -r.y);
  }
  return { canvas: c, x: r.x, y: r.y };
}

async function writeSystemClipboard(c: HTMLCanvasElement) {
  try {
    const blob = await canvasToBlob(c, 'image/png');
    await (navigator.clipboard as any).write([new (window as any).ClipboardItem({ 'image/png': blob })]);
  } catch { /* system clipboard unavailable: internal clipboard still works */ }
}

export function copy(merged = false) {
  const doc = activeDoc(); if (!doc) return;
  const p = selectionPixels(doc, merged);
  if (!p) return;
  app.clipboard = p;
  writeSystemClipboard(p.canvas);
  toast(merged ? 'Copied merged' : 'Copied');
}
export async function cut() {
  const doc = activeDoc(); if (!doc) return;
  if (!doc.selection) { toast('Make a selection first'); return; }
  const t = await editableTarget(doc, 'cut');
  if (!t) return;
  copy(false);
  clearSelection('Cut');
}

/** Paste a canvas as a new layer: centered on view/selection, or in place. */
export function pasteCanvas(c: HTMLCanvasElement, inPlace?: { x: number; y: number }, name?: string) {
  const doc = app.doc;
  if (!doc) return;
  const before = doc.captureState();
  const L = new Layer(name ?? doc.nextLayerName(), 1, 1);
  let x: number, y: number;
  if (inPlace) { x = inPlace.x; y = inPlace.y; }
  else {
    const sb = doc.selectionBounds();
    const cx = sb ? sb.x + sb.w / 2 : doc.width / 2, cy = sb ? sb.y + sb.h / 2 : doc.height / 2;
    x = Math.round(cx - c.width / 2); y = Math.round(cy - c.height / 2);
  }
  L.canvas = cloneCanvas(c);
  L.x = x; L.y = y;
  doc.ensureCoverage(L);
  doc.insertLayer(L);
  if (doc.selection) doc.setSelection(null);
  doc.commit('Paste', before);
}

export async function paste(inPlace = false) {
  const doc = app.doc;
  // try the system clipboard first (images copied from other apps)
  try {
    const items = await (navigator.clipboard as any).read();
    for (const it of items) {
      const type = it.types.find((t: string) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await it.getType(type);
      const img = await createImageBitmap(blob);
      const c = createCanvas(img.width, img.height);
      ctx2d(c).drawImage(img, 0, 0);
      if (!doc) { const { openCanvasAsDocument } = await import('./io'); openCanvasAsDocument(c, 'Clipboard'); return; }
      pasteCanvas(c, ownCopyPlace(c, inPlace));
      return;
    }
  } catch { /* fall back to the internal clipboard */ }
  if (!app.clipboard) { toast('Clipboard is empty'); return; }
  if (!doc) { const { openCanvasAsDocument } = await import('./io'); openCanvasAsDocument(app.clipboard.canvas, 'Clipboard'); return; }
  pasteCanvas(app.clipboard.canvas, ownCopyPlace(app.clipboard.canvas, inPlace));
}

/** Pasting our own copy back puts it where it came from (like Photoshop), if that spot is on the canvas. */
function ownCopyPlace(c: HTMLCanvasElement, force: boolean): { x: number; y: number } | undefined {
  const cb = app.clipboard, doc = app.doc;
  if (!cb || !doc || cb.canvas.width !== c.width || cb.canvas.height !== c.height) return undefined;
  const fits = cb.x + c.width > 0 && cb.y + c.height > 0 && cb.x < doc.width && cb.y < doc.height;
  return force || fits ? { x: cb.x, y: cb.y } : undefined;
}

/** Paste event handler (Ctrl+V in browsers delivers image data here). Returns true if handled. */
export function handlePasteEvent(e: ClipboardEvent): boolean {
  const files = Array.from(e.clipboardData?.items ?? []).filter((i) => i.type.startsWith('image/'));
  if (!files.length) return false;
  const f = files[0].getAsFile();
  if (!f) return false;
  createImageBitmap(f).then(async (img) => {
    const c = createCanvas(img.width, img.height);
    ctx2d(c).drawImage(img, 0, 0);
    if (!app.doc) { const { openCanvasAsDocument } = await import('./io'); openCanvasAsDocument(c, 'Clipboard'); }
    else pasteCanvas(c, ownCopyPlace(c, false));
  });
  return true;
}

export async function clearSelection(stepName = 'Clear') {
  const doc = activeDoc(); if (!doc) return;
  if (!doc.selection) {
    // Delete with no selection deletes the layer, like Photoshop
    const { deleteLayers } = await import('./layerops');
    deleteLayers();
    return;
  }
  const t = await editableTarget(doc, 'clear');
  if (!t) return;
  const before = doc.captureState();
  const out = cloneCanvas(t.canvas);
  const x = ctx2d(out);
  if (t.lockAlpha || t.layer?.isBackground) {
    const fill = solidFor(t, app.bg);
    t.replace(paintOnto(doc, t, fill, 1));
  } else if (t.alphaOnly) {
    x.globalCompositeOperation = 'destination-out';
    x.drawImage(doc.selection, -t.x, -t.y);
    t.replace(out);
  } else {
    x.globalCompositeOperation = 'destination-out';
    x.drawImage(doc.selection, -t.x, -t.y);
    t.replace(out);
  }
  doc.commit(stepName, before);
}

// ---------- fill / stroke ----------
type FillContents = 'fg' | 'bg' | 'color' | 'content-aware' | 'black' | 'gray' | 'white';
export async function fillWith(contents: FillContents, opacity = 1, mode: BlendMode = 'normal', preserve = false, color?: RGB) {
  const doc = activeDoc(); if (!doc) return;
  const t = await editableTarget(doc, 'fill');
  if (!t) return;
  if (contents === 'content-aware') { contentAwareFill(); return; }
  const c: RGB = contents === 'fg' ? app.fg : contents === 'bg' ? app.bg : contents === 'black' ? { r: 0, g: 0, b: 0 } : contents === 'white' ? { r: 255, g: 255, b: 255 } : contents === 'gray' ? { r: 128, g: 128, b: 128 } : color ?? app.fg;
  const before = doc.captureState();
  const src = solidFor(t, c);
  const tt = preserve && !t.alphaOnly ? { ...t, lockAlpha: true } : t;
  t.replace(paintOnto(doc, tt, src, opacity, mode));
  doc.commit('Fill', before);
}

export async function fillDialog() {
  const doc = activeDoc(); if (!doc) return;
  let custom: RGB = app.fg;
  const contents = select({
    options: [{ value: 'fg', label: 'Foreground Color' }, { value: 'bg', label: 'Background Color' }, { value: 'color', label: 'Color...' }, { value: 'content-aware', label: 'Content-Aware' }, '-', { value: 'black', label: 'Black' }, { value: 'gray', label: '50% Gray' }, { value: 'white', label: 'White' }],
    value: 'fg', width: 200,
    onChange: async (v) => { if (v === 'color') { const c = await pickColor(custom, 'Choose a color:'); if (c) custom = c; } },
  });
  const mode = select({ options: BLEND_MODES.map((m) => (m === '-' ? '-' : { value: m, label: BLEND_NAMES[m as BlendMode] })) as any, value: 'normal', width: 160 });
  const op = numberInput({ value: 100, min: 0, max: 100, unit: '%', width: 50 });
  const pres = checkbox({ label: 'Preserve Transparency', checked: false });
  const ok = await openDialog({
    title: 'Fill', width: 400,
    content: h('div', { class: 'col' },
      h('div', { class: 'form-grid' }, h('span', { class: 'field-label' }, 'Contents:'), contents.el),
      h('fieldset', { class: 'ps-section' }, h('legend', null, 'Blending'),
        h('div', { class: 'form-grid' }, h('span', { class: 'field-label' }, 'Mode:'), mode.el, h('span', { class: 'field-label' }, 'Opacity:'), op.el, h('span'), pres.el))),
  });
  if (!ok) return;
  await fillWith(contents.get() as FillContents, op.get() / 100, mode.get() as BlendMode, pres.get(), custom);
}

export async function strokeDialog() {
  const doc = activeDoc(); if (!doc) return;
  const hasSel = !!doc.selection;
  const L = doc.active;
  if (!hasSel && (!L || L.kind === 'adjustment')) { toast('Make a selection or select a layer'); return; }
  const width = numberInput({ value: 3, min: 1, max: 250, unit: 'px', width: 60 });
  const color = colorSwatch({ color: app.fg });
  const loc = segmented({ value: 'center', options: [{ value: 'inside', label: 'Inside' }, { value: 'center', label: 'Center' }, { value: 'outside', label: 'Outside' }] });
  const mode = select({ options: BLEND_MODES.map((m) => (m === '-' ? '-' : { value: m, label: BLEND_NAMES[m as BlendMode] })) as any, value: 'normal', width: 160 });
  const op = numberInput({ value: 100, min: 0, max: 100, unit: '%', width: 50 });
  const ok = await openDialog({
    title: 'Stroke', width: 420,
    content: h('div', { class: 'col' },
      h('fieldset', { class: 'ps-section' }, h('legend', null, 'Stroke'),
        h('div', { class: 'form-grid' }, h('span', { class: 'field-label' }, 'Width:'), width.el, h('span', { class: 'field-label' }, 'Color:'), color.el)),
      h('fieldset', { class: 'ps-section' }, h('legend', null, 'Location'), loc.el),
      h('fieldset', { class: 'ps-section' }, h('legend', null, 'Blending'),
        h('div', { class: 'form-grid' }, h('span', { class: 'field-label' }, 'Mode:'), mode.el, h('span', { class: 'field-label' }, 'Opacity:'), op.el))),
  });
  if (!ok) return;
  const t = await editableTarget(doc, 'stroke');
  if (!t) return;
  // shape = selection, or the layer's alpha
  let shape = doc.selection;
  if (!shape) { shape = createCanvas(doc.width, doc.height); ctx2d(shape).drawImage(L!.canvas, L!.x, L!.y); }
  const w = width.get(), where = loc.get();
  const outer = where === 'inside' ? shape : expandMask(shape, where === 'center' ? w / 2 : w);
  const inner = where === 'outside' ? shape : expandMask(shape, -(where === 'center' ? w / 2 : w));
  const ring = createCanvas(doc.width, doc.height);
  const rx = ctx2d(ring);
  rx.drawImage(outer, 0, 0);
  rx.globalCompositeOperation = 'destination-out';
  rx.drawImage(inner, 0, 0);
  rx.globalCompositeOperation = 'source-in';
  rx.fillStyle = cssColor(color.get());
  rx.fillRect(0, 0, doc.width, doc.height);
  const src = createCanvas(t.canvas.width, t.canvas.height);
  ctx2d(src).drawImage(ring, -t.x, -t.y);
  const before = doc.captureState();
  // stroke ignores the selection as a clip
  const sel = doc.selection;
  doc.selection = null;
  t.replace(paintOnto(doc, t, src, op.get() / 100, mode.get() as BlendMode));
  doc.selection = sel;
  doc.commit('Stroke', before);
}

export async function contentAwareFill() {
  const doc = activeDoc(); if (!doc) return;
  if (!doc.selection) { await alertDialog('Content-Aware Fill', 'Make a selection around the area to fill first.'); return; }
  const t = await editableTarget(doc, 'use Content-Aware Fill');
  if (!t || t.alphaOnly) return;
  const sb = doc.selectionBounds()!;
  const r = rectIntersect({ x: sb.x - t.x - 4, y: sb.y - t.y - 4, w: sb.w + 8, h: sb.h + 8 }, { x: 0, y: 0, w: t.canvas.width, h: t.canvas.height });
  if (!r) return;
  const before = doc.captureState();
  const out = cloneCanvas(t.canvas);
  const m = createCanvas(r.w, r.h);
  ctx2d(m).drawImage(expandMask(doc.selection, 2), -t.x - r.x, -t.y - r.y);
  const md = ctx2d(m).getImageData(0, 0, r.w, r.h).data;
  const mask = new Float32Array(r.w * r.h);
  for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4 + 3] / 255;
  const healed = spotHeal(ctx2d(out), out.width, out.height, r, mask);
  ctx2d(out).putImageData(healed, r.x, r.y);
  t.replace(out);
  doc.setSelection(null);
  doc.commit('Content-Aware Fill', before);
}

// ---------- immediate transforms (Edit > Transform) ----------
export async function transformImmediate(kind: 'flipH' | 'flipV' | 'rot90' | 'rot-90' | 'rot180') {
  const tool = currentTool();
  if (tool.id === 'transform') {
    const tt = tool as TransformTool;
    if (kind === 'flipH') tt.flip(true); else if (kind === 'flipV') tt.flip(false);
    else tt.rotateBy(kind === 'rot90' ? 90 : kind === 'rot-90' ? -90 : 180);
    return;
  }
  const doc = activeDoc(); if (!doc) return;
  const L = doc.active;
  if (!L || L.kind === 'adjustment') return;
  const t = await editableTarget(doc, 'transform');
  if (!t || t.kind !== 'layer') return;
  const before = doc.captureState();
  const lifted = liftContent(doc, L, false, L.isBackground && doc.selection ? app.bg : null);
  if (!lifted) return;
  if (L.isBackground && !doc.selection) { L.isBackground = false; L.lockAlpha = false; L.lockPosition = false; L.name = 'Layer 0'; }
  const w = lifted.float.width, hh = lifted.float.height;
  const cx = lifted.fx + w / 2, cy = lifted.fy + hh / 2;
  const r0 = quadFromRect(lifted.fx, lifted.fy, w, hh);
  const rot = (p: { x: number; y: number }, deg: number) => { const a = (deg * Math.PI) / 180; const dx = p.x - cx, dy = p.y - cy; return { x: Math.round(cx + dx * Math.cos(a) - dy * Math.sin(a)), y: Math.round(cy + dx * Math.sin(a) + dy * Math.cos(a)) }; };
  let q: Quad;
  if (kind === 'flipH') q = [r0[1], r0[0], r0[3], r0[2]];
  else if (kind === 'flipV') q = [r0[3], r0[2], r0[1], r0[0]];
  else q = r0.map((p) => rot(p, kind === 'rot90' ? 90 : kind === 'rot-90' ? -90 : 180)) as Quad;
  const piece = renderQuad(lifted.float, q, 'nearest');
  const res = composeOnto(doc, lifted.base, L.x, L.y, piece);
  L.canvas = res.canvas; L.x = res.x; L.y = res.y;
  if (L.mask) doc.ensureCoverage(L);
  L.touch();
  if (lifted.selection) { const s = transformMask(doc, lifted.selection, { x: lifted.fx, y: lifted.fy, w, h: hh }, q); doc.selection = null; doc.setSelection(s); }
  doc.commit({ flipH: 'Flip Horizontal', flipV: 'Flip Vertical', rot90: 'Rotate 90° Clockwise', 'rot-90': 'Rotate 90° Counter Clockwise', rot180: 'Rotate 180°' }[kind], before);
}

export function startTransform(mode: 'free' | 'scale' | 'rotate' | 'skew' | 'distort' | 'perspective' = 'free') {
  const T = getTool('transform') as any;
  T?.constructor.start(mode);
}

// ---------- preferences ----------
export async function preferencesDialog(onTheme: () => void) {
  const p = app.prefs;
  const originalTheme = p.theme;
  const themes: { v: typeof p.theme; c: string }[] = [{ v: 'darkest', c: '#262626' }, { v: 'dark', c: '#323232' }, { v: 'medium', c: '#535353' }, { v: 'light', c: '#e6e6e6' }];
  const themeRow = h('div', { class: 'row' });
  const swatches = themes.map((t) => {
    const b = h('button', { class: 'color-swatch', title: t.v, style: { width: '44px', height: '30px', background: t.c } });
    b.addEventListener('click', () => { p.theme = t.v; sync(); document.documentElement.dataset.theme = t.v; onTheme(); });
    themeRow.appendChild(b);
    return b;
  });
  const sync = () => swatches.forEach((b, i) => { b.style.outline = themes[i].v === p.theme ? '2px solid var(--accent)' : 'none'; b.style.outlineOffset = '2px'; });
  sync();
  const hist = numberInput({ value: p.historyStates, min: 5, max: 1000, width: 60 });
  const cursor = select({ options: [{ value: 'normal', label: 'Normal Brush Tip' }, { value: 'full', label: 'Full Size Brush Tip' }, { value: 'precise', label: 'Precise' }], value: p.brushCursor, width: 180 });
  const wheel = checkbox({ label: 'Zoom with Scroll Wheel', checked: p.zoomWithWheel });
  const grid = numberInput({ value: p.gridSize, min: 2, max: 1000, unit: 'px', width: 60 });
  const pix = checkbox({ label: 'Show Pixel Grid (zoom ≥ 800%)', checked: p.showPixelGrid });
  const ok = await openDialog({
    title: 'Preferences', width: 520,
    content: h('div', { class: 'col' },
      h('fieldset', { class: 'ps-section' }, h('legend', null, 'Interface'), h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Color Theme:'), themeRow)),
      h('fieldset', { class: 'ps-section' }, h('legend', null, 'Performance'), h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'History States:'), hist.el)),
      h('fieldset', { class: 'ps-section' }, h('legend', null, 'Cursors'), h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Painting Cursors:'), cursor.el)),
      h('fieldset', { class: 'ps-section' }, h('legend', null, 'Tools'), wheel.el),
      h('fieldset', { class: 'ps-section' }, h('legend', null, 'Guides, Grid & Slices'), h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Gridline Every:'), grid.el), pix.el)),
  });
  if (!ok) { p.theme = originalTheme; onTheme(); return; }
  p.historyStates = hist.get();
  HISTORY_LIMIT.value = p.historyStates;
  p.brushCursor = cursor.get() as any;
  p.zoomWithWheel = wheel.get();
  p.gridSize = grid.get();
  p.showPixelGrid = pix.get();
  app.savePrefs();
  bus.emit('render', app.doc);
}

void currentTarget; void maskBounds; void invertMask; void alphaBounds; void sliderField;
