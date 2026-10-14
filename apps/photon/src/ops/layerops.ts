// Layer menu operations.
import { app } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { Layer, BlendMode, FillData, BLEND_MODES, BLEND_NAMES, GradientStyle, Gradient } from '../core/layer';
import { createCanvas, ctx2d, cssColor, cloneCanvas } from '../core/util';
import { flattenLayers, renderLayersInto, renderedLayer } from '../core/compositor';
import { renderGradient, fgBgGradient } from '../core/gradient';
import { getAdjustment } from '../core/adjustments';
import { invertMask } from '../core/selection';
import { hasActiveStyle } from '../core/effects';
import { openDialog, confirmDialog, alertDialog, promptDialog } from '../dialogs/dialog';
import { h } from '../ui/dom';
import { textInput, select, numberInput, checkbox, pickColor, toast, segmented } from '../ui/widgets';
import { gradientPicker } from '../ui/gradientpicker';
import { activeDoc, editableTarget } from './target';
import { rasterize } from './rasterize';
import { duplicateLayerObject } from '../tools/transform';
import { block, siblings, isInside, parentOf, normalizeLayers, isVisibleDeep, topLevelSelection } from '../core/groups';

export const LABEL_COLORS: Record<string, string> = { '': 'No Color', '#e14b4b': 'Red', '#f08c38': 'Orange', '#e8d33f': 'Yellow', '#58b858': 'Green', '#4a8fe0': 'Blue', '#9a6ad6': 'Violet', '#8a8a8a': 'Gray' };

export function newLayer(name?: string, opts: Partial<Pick<Layer, 'blend' | 'opacity' | 'clipped' | 'color'>> = {}) {
  const doc = activeDoc(); if (!doc) return null;
  const before = doc.captureState();
  const L = doc.newLayer(name);
  Object.assign(L, opts);
  doc.insertLayer(L);
  doc.commit('New Layer', before);
  return L;
}

export async function newLayerDialog() {
  const doc = activeDoc(); if (!doc) return;
  const name = textInput({ value: doc.nextLayerName(), width: 260 });
  const clip = checkbox({ label: 'Use Previous Layer to Create Clipping Mask', checked: false });
  const color = select({ options: Object.entries(LABEL_COLORS).map(([v, l]) => ({ value: v, label: l })), value: '', width: 120 });
  const mode = select({ options: BLEND_MODES.map((m) => (m === '-' ? '-' : { value: m, label: BLEND_NAMES[m as BlendMode] })) as any, value: 'normal', width: 140 });
  const op = numberInput({ value: 100, min: 0, max: 100, unit: '%', width: 50 });
  const ok = await openDialog({
    title: 'New Layer', width: 480,
    content: h('div', { class: 'form-grid' },
      h('span', { class: 'field-label' }, 'Name:'), name.el,
      h('span'), clip.el,
      h('span', { class: 'field-label' }, 'Color:'), color.el,
      h('span', { class: 'field-label' }, 'Mode:'), h('div', { class: 'row' }, mode.el, h('span', { class: 'field-label' }, 'Opacity:'), op.el)),
    onOpen: () => { name.input.focus(); name.input.select(); },
  });
  if (!ok) return;
  newLayer(name.get() || doc.nextLayerName(), { clipped: clip.get(), color: color.get(), blend: mode.get() as BlendMode, opacity: op.get() / 100 });
}

export function duplicateLayer(L?: Layer) {
  const doc = activeDoc(); if (!doc) return;
  const src = L ?? doc.active;
  if (!src) return;
  const before = doc.captureState();
  const copies = duplicateBlock(doc, src);
  doc.layers.splice(doc.indexOf(src) + 1, 0, ...copies);
  normalizeLayers(doc);
  doc.setActive(copies[copies.length - 1]);
  doc.invalidate();
  doc.commit(src.kind === 'group' ? 'Duplicate Group' : 'Duplicate Layer', before);
}

/** Copies of a layer (or a whole group with its contents) with fresh ids, in document order. */
export function duplicateBlock(doc: Doc, src: Layer): Layer[] {
  const items = block(doc, src);
  const ids = new Map<number, number>();
  const copies = items.map((l) => {
    const c = duplicateLayerObject(doc, l, l === src ? undefined : l.name);
    c.isBackground = false;
    c.collapsed = l.collapsed;
    ids.set(l.id, c.id);
    return c;
  });
  copies.forEach((c, i) => { const p = items[i].parentId; c.parentId = ids.get(p) ?? p; });
  return copies;
}

/** Ctrl+J / Shift+Ctrl+J */
export async function layerVia(cut: boolean) {
  const doc = activeDoc(); if (!doc) return;
  const L = doc.active;
  if (!L) return;
  if (!doc.selection) { if (!cut) duplicateLayer(); return; }
  const t = await editableTarget(doc, cut ? 'make a layer via cut' : 'make a layer via copy');
  if (!t || t.kind !== 'layer') return;
  const before = doc.captureState();
  const n = doc.newLayer(doc.nextLayerName());
  const nx = ctx2d(n.canvas);
  nx.drawImage(L.canvas, L.x, L.y);
  nx.globalCompositeOperation = 'destination-in';
  nx.drawImage(doc.selection, 0, 0);
  if (cut) {
    const base = cloneCanvas(L.canvas);
    const bx = ctx2d(base);
    if (L.isBackground) {
      const hole = createCanvas(base.width, base.height);
      const hx = ctx2d(hole);
      hx.drawImage(doc.selection, -L.x, -L.y);
      hx.globalCompositeOperation = 'source-in';
      hx.fillStyle = cssColor(app.bg);
      hx.fillRect(0, 0, hole.width, hole.height);
      bx.globalCompositeOperation = 'destination-out';
      bx.drawImage(doc.selection, -L.x, -L.y);
      bx.globalCompositeOperation = 'source-over';
      bx.drawImage(hole, 0, 0);
    } else {
      bx.globalCompositeOperation = 'destination-out';
      bx.drawImage(doc.selection, -L.x, -L.y);
    }
    L.canvas = base;
    L.touch();
  }
  n.parentId = L.parentId;
  doc.insertLayer(n, doc.indexOf(L) + 1);
  doc.setSelection(null);
  doc.commit(cut ? 'Layer Via Cut' : 'Layer Via Copy', before);
}

export async function deleteLayers() {
  const doc = activeDoc(); if (!doc) return;
  const sel = doc.selectedLayers;
  if (!sel.length) return;
  if (doc.layers.length - sel.length < 0) return;
  const before = doc.captureState();
  for (const L of sel) doc.removeLayer(L);
  if (!doc.layers.length) {
    // never leave a document without layers
    const L = doc.newLayer('Layer 1');
    doc.layers.push(L);
    doc.setActive(L);
  }
  doc.commit(sel.length > 1 ? 'Delete Layers' : 'Delete Layer', before);
}

let inlineRenamer: ((L: Layer) => boolean) | null = null;
/** The Layers panel registers in-place renaming; Layer > Rename falls back to a dialog when it's hidden. */
export function setInlineRenamer(fn: (L: Layer) => boolean) { inlineRenamer = fn; }

export async function renameLayer(L?: Layer) {
  const doc = activeDoc(); if (!doc) return;
  const l = L ?? doc.active;
  if (!l) return;
  if (inlineRenamer?.(l)) return;
  const n = await promptDialog('Rename Layer', 'Name:', l.name);
  if (n === null || n === l.name) return;
  setLayerProp(doc, l, 'name', n, 'Rename Layer');
}

/** Set a property with an undo step. */
export function setLayerProp<K extends keyof Layer>(doc: Doc, L: Layer, key: K, value: Layer[K], name: string) {
  const before = doc.captureState();
  L[key] = value;
  L.touch();
  doc.invalidate();
  doc.commit(name, before);
}

// opacity/fill/blend edits from the panel coalesce into one step while scrubbing
let pendingProp: { doc: Doc; before: ReturnType<Doc['captureState']>; name: string; timer: number } | null = null;
export function setLayerPropLive<K extends keyof Layer>(doc: Doc, L: Layer, key: K, value: Layer[K], name: string) {
  if (!pendingProp || pendingProp.doc !== doc || pendingProp.name !== name) {
    flushPendingProp();
    pendingProp = { doc, before: doc.captureState(), name, timer: 0 };
  }
  L[key] = value;
  L.touch();
  doc.invalidate();
  bus.emit('layers', doc);
  clearTimeout(pendingProp.timer);
  pendingProp.timer = window.setTimeout(flushPendingProp, 400);
}
export function flushPendingProp() {
  if (!pendingProp) return;
  const p = pendingProp;
  pendingProp = null;
  clearTimeout(p.timer);
  p.doc.commit(p.name, p.before);
}

/** Ctrl+] / Ctrl+[ / Shift+Ctrl+] / Shift+Ctrl+[ — moves among siblings (a group moves with its contents). */
export function arrange(dir: 'front' | 'forward' | 'backward' | 'back') {
  const doc = activeDoc(); if (!doc) return;
  const L = doc.active;
  if (!L || L.isBackground) return;
  const sib = siblings(doc, L).filter((s) => !s.isBackground);
  const k = sib.indexOf(L);
  const target = dir === 'front' ? sib[sib.length - 1] : dir === 'back' ? sib[0] : dir === 'forward' ? sib[k + 1] : sib[k - 1];
  if (!target || target === L) return;
  moveLayerTo(doc, L, target, dir === 'front' || dir === 'forward' ? 'above' : 'below', 'Arrange Layer');
}

/**
 * Move L (with its contents if it's a group) relative to target:
 * 'above' / 'below' = sibling of target, 'into' = top of target group.
 */
export function moveLayerTo(doc: Doc, L: Layer, target: Layer, where: 'above' | 'below' | 'into', name = 'Layer Order') {
  if (L === target || isInside(doc, target, L)) return;
  if (where === 'into' && target.kind !== 'group') where = 'above';
  if (target.isBackground && where === 'below') where = 'above';
  const before = doc.captureState();
  const moving = block(doc, L);
  for (const m of moving) doc.layers.splice(doc.indexOf(m), 1);
  L.parentId = where === 'into' ? target.id : target.parentId;
  let at: number;
  if (where === 'into') { at = doc.indexOf(target); target.collapsed = false; }
  else if (where === 'above') at = doc.indexOf(target) + 1;
  else at = doc.indexOf(block(doc, target)[0]);
  doc.layers.splice(at, 0, ...moving);
  normalizeLayers(doc);
  doc.invalidate();
  doc.commit(name, before);
}
/** Index-based move kept for callers outside the Layers panel. */
export function moveLayer(doc: Doc, L: Layer, toIndex: number, name = 'Layer Order') {
  const t = doc.layers[Math.max(0, Math.min(doc.layers.length - 1, toIndex))];
  if (!t || t === L) return;
  moveLayerTo(doc, L, t, toIndex > doc.indexOf(L) ? 'above' : 'below', name);
}

// ---------- groups ----------
/** Layer > New > Group: an empty group above the active layer. */
export function newGroup(name?: string) {
  const doc = activeDoc(); if (!doc) return null;
  const before = doc.captureState();
  const G = makeGroup(doc, name);
  doc.insertLayer(G);
  doc.commit('New Group', before);
  return G;
}
function makeGroup(doc: Doc, name?: string) {
  const G = new Layer(name ?? doc.nextLayerName('Group'), 1, 1);
  G.kind = 'group';
  G.blend = 'pass-through';
  return G;
}
/** Ctrl+G: put the selected layers into a new group. */
export function groupLayers() {
  const doc = activeDoc(); if (!doc) return;
  const sel = topLevelSelection(doc).filter((l) => !l.isBackground);
  if (!sel.length) { newGroup(); return; }
  const before = doc.captureState();
  const top = sel.reduce((a, b) => (doc.indexOf(b) > doc.indexOf(a) ? b : a));
  const G = makeGroup(doc);
  G.parentId = sel.every((l) => l.parentId === top.parentId) ? top.parentId : 0;
  doc.layers.splice(doc.indexOf(top) + 1, 0, G);
  for (const l of sel) l.parentId = G.id;
  normalizeLayers(doc);
  doc.setActive(G);
  doc.invalidate();
  doc.commit('Group Layers', before);
}
/** Shift+Ctrl+G: dissolve the active group, keeping its contents in place. */
export function ungroupLayers() {
  const doc = activeDoc(); if (!doc) return;
  const G = doc.active;
  if (!G || G.kind !== 'group') { const p = G && parentOf(doc, G); if (p) { doc.setActive(p); ungroupLayers(); } return; }
  const before = doc.captureState();
  const kids = doc.layers.filter((l) => l.parentId === G.id);
  for (const k of kids) k.parentId = G.parentId;
  doc.layers.splice(doc.indexOf(G), 1);
  normalizeLayers(doc);
  doc.selectedIds = new Set(kids.map((k) => k.id));
  if (kids.length) doc.activeId = kids[kids.length - 1].id;
  bus.emit('layers', doc);
  doc.invalidate();
  doc.commit('Ungroup Layers', before);
}
export function toggleCollapsed(G: Layer) {
  G.collapsed = !G.collapsed;
  bus.emit('layers', app.doc);
}

export async function mergeDown() {
  const doc = activeDoc(); if (!doc) return;
  const sel = doc.selectedLayers;
  if (sel.length > 1) { mergeLayers(sel, 'Merge Layers'); return; }
  const L = doc.active;
  if (!L) return;
  if (L.kind === 'group') { mergeLayers(block(doc, L), 'Merge Group'); return; }
  const sib = siblings(doc, L);
  const below = sib[sib.indexOf(L) - 1];
  if (!below) { toast('There is no layer below to merge with'); return; }
  if (!L.visible) { await alertDialog('Photon', 'Could not merge down because the layer is hidden.'); return; }
  if (below.kind === 'adjustment') { await alertDialog('Photon', 'Could not merge down because the layer below is an adjustment layer.'); return; }
  if (below.kind === 'group') { await alertDialog('Photon', 'Could not merge down because the layer below is a group. Use Merge Group on the group first.'); return; }
  const before = doc.captureState();
  const keep = { opacity: below.opacity, blend: below.blend, visible: below.visible };
  below.opacity = 1; below.blend = 'normal'; below.visible = true;
  const c = flattenLayers(doc, [below, L]);
  Object.assign(below, keep);
  if (below.kind !== 'raster') { below.kind = 'raster'; below.text = undefined; below.shape = undefined; below.fill = undefined; }
  below.canvas = c; below.x = 0; below.y = 0;
  below.mask = null; below.style = null;
  below.touch();
  doc.removeLayer(L);
  doc.setActive(below);
  doc.commit('Merge Down', before);
}

export function mergeLayers(layers: Layer[], name: string) {
  const doc = activeDoc(); if (!doc || !layers.length) return;
  // a selected group brings its contents along
  const set = new Set<Layer>();
  for (const l of layers) for (const b of block(doc, l)) set.add(b);
  const ordered = doc.layers.filter((l) => set.has(l));
  if (ordered.length < 2 && ordered[0]?.kind !== 'group') return;
  const before = doc.captureState();
  const c = flattenLayers(doc, ordered);
  const top = ordered[ordered.length - 1];
  const L = new Layer(top.name, 1, 1);
  L.canvas = c;
  L.parentId = ordered.every((l) => set.has(parentOf(doc, l)!) || l.parentId === top.parentId) ? top.parentId : 0;
  doc.layers.splice(doc.indexOf(top) + 1, 0, L);
  // layers left out of the merge (e.g. hidden ones) inside merged groups move up a level
  for (const l of doc.layers) if (!set.has(l) && l !== L && set.has(parentOf(doc, l)!)) l.parentId = L.parentId;
  for (const l of ordered) if (doc.indexOf(l) >= 0) doc.removeLayer(l);
  normalizeLayers(doc);
  doc.setActive(L);
  doc.commit(name, before);
}
export function mergeVisible() {
  const doc = activeDoc(); if (!doc) return;
  const vis = doc.layers.filter((l) => isVisibleDeep(doc, l));
  if (vis.filter((l) => l.kind !== 'group').length < 2) { toast('Need at least two visible layers'); return; }
  mergeLayers(vis, 'Merge Visible');
}
export async function flattenImage() {
  const doc = activeDoc(); if (!doc) return;
  if (doc.layers.some((l) => !isVisibleDeep(doc, l))) {
    const r = await confirmDialog('Photon', 'Discard hidden layers?', 'OK', 'Cancel');
    if (r !== 'ok') return;
  }
  const before = doc.captureState();
  const c = createCanvas(doc.width, doc.height);
  const x = ctx2d(c);
  x.fillStyle = '#fff';
  x.fillRect(0, 0, doc.width, doc.height);
  x.drawImage(flattenLayers(doc, doc.layers), 0, 0);
  const L = new Layer('Background', 1, 1);
  L.canvas = c; L.isBackground = true; L.lockAlpha = true; L.lockPosition = true;
  doc.layers = [L];
  doc.setActive(L);
  doc.invalidate();
  doc.commit('Flatten Image', before);
}
export function stampVisible() {
  const doc = activeDoc(); if (!doc) return;
  const before = doc.captureState();
  const L = doc.newLayer(doc.nextLayerName());
  ctx2d(L.canvas).drawImage(flattenLayers(doc, doc.layers), 0, 0);
  doc.layers.push(L);
  doc.setActive(L);
  doc.commit('Stamp Visible', before);
}

export function rasterizeActive() {
  const doc = activeDoc(); if (!doc) return;
  const L = doc.active;
  if (!L || L.kind === 'group' || (L.kind === 'raster' && !hasActiveStyle(L))) return;
  const before = doc.captureState();
  if (L.kind !== 'raster') rasterize(doc, L);
  doc.commit('Rasterize Layer', before);
}
export function rasterizeStyle() {
  const doc = activeDoc(); if (!doc) return;
  const L = doc.active;
  if (!L || !hasActiveStyle(L)) return;
  const before = doc.captureState();
  if (L.kind !== 'raster') rasterize(doc, L);
  const r = renderedLayer(doc, L);
  L.canvas = r.canvas; L.x = r.x; L.y = r.y; L.style = null; L.mask = null; L.fillOpacity = 1;
  doc.ensureCoverage(L);
  L.touch();
  doc.commit('Rasterize Layer Style', before);
}

export function convertBackground(L: Layer) {
  const doc = activeDoc(); if (!doc || !L.isBackground) return;
  const before = doc.captureState();
  L.isBackground = false; L.lockAlpha = false; L.lockPosition = false; L.lockAll = false; L.name = 'Layer 0';
  doc.commit('Layer From Background', before);
}

// ---------- masks ----------
export function addMask(kind: 'reveal' | 'hide' | 'selection' | 'hideSelection' = 'reveal') {
  const doc = activeDoc(); if (!doc) return;
  const L = doc.active;
  if (!L) return;
  if (L.isBackground) convertBackground(L);
  if (L.mask) { toast('Layer already has a mask'); return; }
  const before = doc.captureState();
  if (kind === 'reveal' && doc.selection) kind = 'selection';
  const m = createCanvas(doc.width, doc.height);
  const x = ctx2d(m);
  if (kind === 'reveal') { x.fillStyle = '#000'; x.fillRect(0, 0, doc.width, doc.height); }
  else if (kind === 'selection' && doc.selection) x.drawImage(doc.selection, 0, 0);
  else if (kind === 'hideSelection') x.drawImage(invertMask(doc.selection, doc.width, doc.height), 0, 0);
  L.mask = m; L.maskX = 0; L.maskY = 0; L.maskEnabled = true;
  doc.editMask = true;
  if (doc.selection) doc.setSelection(null);
  L.touch();
  doc.commit('Add Layer Mask', before);
}
export function deleteMask(apply = false) {
  const doc = activeDoc(); if (!doc) return;
  const L = doc.active;
  if (!L?.mask) return;
  const before = doc.captureState();
  if (apply && L.kind === 'raster') {
    const c = cloneCanvas(L.canvas);
    const x = ctx2d(c);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(L.mask, L.maskX - L.x, L.maskY - L.y);
    L.canvas = c;
  }
  L.mask = null;
  doc.editMask = false;
  L.touch();
  doc.commit(apply ? 'Apply Layer Mask' : 'Delete Layer Mask', before);
}
export function toggleMask() {
  const doc = activeDoc(); if (!doc) return;
  const L = doc.active;
  if (!L?.mask) return;
  setLayerProp(doc, L, 'maskEnabled', !L.maskEnabled, L.maskEnabled ? 'Disable Layer Mask' : 'Enable Layer Mask');
}
export function toggleClipping() {
  const doc = activeDoc(); if (!doc) return;
  const L = doc.active;
  if (!L || doc.indexOf(L) === 0 || L.isBackground) return;
  setLayerProp(doc, L, 'clipped', !L.clipped, L.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask');
}

// ---------- fill & adjustment layers ----------
export function renderFillLayer(doc: Doc, L: Layer) {
  const f = L.fill;
  if (!f) return;
  const c = createCanvas(doc.width, doc.height);
  const x = ctx2d(c);
  if (f.type === 'solid') { x.fillStyle = cssColor(f.color); x.fillRect(0, 0, c.width, c.height); }
  else {
    const a = (f.angle * Math.PI) / 180;
    const len = (Math.abs(doc.width * Math.cos(a)) + Math.abs(doc.height * Math.sin(a))) / 2 * (f.scale / 100);
    const cx = doc.width / 2, cy = doc.height / 2;
    const dx = Math.cos(a) * len, dy = -Math.sin(a) * len;
    const radial = f.style === 'radial' || f.style === 'angle' || f.style === 'diamond';
    const g = radial
      ? renderGradient(f.gradient, f.style, cx, cy, cx + dx, cy + dy, c.width, c.height, f.reverse)
      : renderGradient(f.gradient, f.style, cx - dx, cy - dy, cx + dx, cy + dy, c.width, c.height, f.reverse);
    x.drawImage(g, 0, 0);
  }
  L.canvas = c; L.x = 0; L.y = 0;
  L.touch();
}

function insertSpecialLayer(doc: Doc, L: Layer) {
  // mask from selection like Photoshop
  const m = createCanvas(doc.width, doc.height);
  const mx = ctx2d(m);
  if (doc.selection) mx.drawImage(doc.selection, 0, 0);
  else { mx.fillStyle = '#000'; mx.fillRect(0, 0, doc.width, doc.height); }
  L.mask = m;
  doc.insertLayer(L);
  if (doc.selection) doc.setSelection(null);
}

export function newAdjustmentLayer(kind: string) {
  const doc = activeDoc(); if (!doc) return;
  const def = getAdjustment(kind);
  if (!def) return;
  const before = doc.captureState();
  const L = new Layer(doc.nextLayerName(def.name), 1, 1);
  L.kind = 'adjustment';
  L.adjustment = { kind, params: def.defaults() };
  insertSpecialLayer(doc, L);
  doc.commit(`${def.name} Layer`, before);
  bus.emit('show-panel', 'properties');
}

export async function newFillLayer(type: 'solid' | 'gradient') {
  const doc = activeDoc(); if (!doc) return;
  let fill: FillData;
  if (type === 'solid') {
    const c = await pickColor(app.fg, 'Color Picker (Solid Color)');
    if (!c) return;
    fill = { type: 'solid', color: c };
  } else {
    const f = await gradientFillDialog({ type: 'gradient', gradient: fgBgGradient(app.fg, app.bg), style: 'linear', angle: 90, scale: 100, reverse: false });
    if (!f) return;
    fill = f;
  }
  const before = doc.captureState();
  const L = new Layer(doc.nextLayerName(type === 'solid' ? 'Color Fill' : 'Gradient Fill'), 1, 1);
  L.kind = 'fill';
  L.fill = fill;
  renderFillLayer(doc, L);
  insertSpecialLayer(doc, L);
  doc.commit(type === 'solid' ? 'Color Fill Layer' : 'Gradient Fill Layer', before);
}

export async function gradientFillDialog(init: Extract<FillData, { type: 'gradient' }>): Promise<Extract<FillData, { type: 'gradient' }> | null> {
  let g: Gradient = init.gradient;
  const picker = gradientPicker({ value: g, onChange: (v) => { g = v; } });
  const style = select({ options: ['linear', 'radial', 'angle', 'reflected', 'diamond'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })), value: init.style, width: 140 });
  const angle = numberInput({ value: init.angle, min: -360, max: 360, unit: '°', width: 60 });
  const scale = numberInput({ value: init.scale, min: 10, max: 1000, unit: '%', width: 60 });
  const rev = checkbox({ label: 'Reverse', checked: init.reverse });
  const ok = await openDialog({
    title: 'Gradient Fill', width: 420,
    content: h('div', { class: 'form-grid' },
      h('span', { class: 'field-label' }, 'Gradient:'), picker.el,
      h('span', { class: 'field-label' }, 'Style:'), style.el,
      h('span', { class: 'field-label' }, 'Angle:'), angle.el,
      h('span', { class: 'field-label' }, 'Scale:'), scale.el,
      h('span'), rev.el),
  });
  if (!ok) return null;
  return { type: 'gradient', gradient: g, style: style.get() as GradientStyle, angle: angle.get(), scale: scale.get(), reverse: rev.get() };
}

/** Edit fill layer content (double-click thumbnail). */
export async function editFillLayer(L: Layer) {
  const doc = activeDoc(); if (!doc || !L.fill) return;
  let fill: FillData | null = null;
  if (L.fill.type === 'solid') {
    const c = await pickColor(L.fill.color, 'Color Picker (Solid Color)');
    if (c) fill = { type: 'solid', color: c };
  } else fill = await gradientFillDialog(L.fill);
  if (!fill) return;
  const before = doc.captureState();
  L.fill = fill;
  renderFillLayer(doc, L);
  doc.invalidate();
  doc.commit('Edit Fill Layer', before);
}

export function setLabelColor(L: Layer, color: string) {
  const doc = activeDoc(); if (!doc) return;
  setLayerProp(doc, L, 'color', color, 'Layer Color');
}
void segmented; void renderLayersInto;
