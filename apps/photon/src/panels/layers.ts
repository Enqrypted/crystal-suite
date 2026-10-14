import { Panel } from '../ui/dock';
import { h, clear } from '../ui/dom';
import { icon } from '../ui/icons';
import { app } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { Layer, BlendMode, BLEND_MODES, BLEND_NAMES } from '../core/layer';
import { createCanvas, ctx2d, rafThrottle, debounce } from '../core/util';
import { select, numberInput, scrubby, iconButton, contextMenu, popover, slider, CtxItem } from '../ui/widgets';
import {
  newLayer, deleteLayers, duplicateLayer, setLayerProp, setLayerPropLive, flushPendingProp, moveLayerTo, mergeDown, mergeVisible,
  groupLayers, ungroupLayers, newGroup, toggleCollapsed, setInlineRenamer,
  flattenImage, addMask, deleteMask, toggleMask, toggleClipping, newAdjustmentLayer, newFillLayer, editFillLayer,
  rasterizeActive, rasterizeStyle, convertBackground, LABEL_COLORS, setLabelColor, newLayerDialog,
} from '../ops/layerops';
import { loadFromLayer } from '../ops/selectops';
import { ADJUSTMENTS, getAdjustment } from '../core/adjustments';
import { hasActiveStyle } from '../core/effects';
import { fxMenuItems, openLayerStyleDialog, copyLayerStyle, pasteLayerStyle, clearLayerStyle } from '../dialogs/layerstyle';
import { setTool, getTool } from '../tools/tool';
import { alphaToGray } from '../ops/target';
import { depthOf, isInside, ancestors } from '../core/groups';
import { layerExportContextItems } from '../ops/export';

const BLEND_OPTIONS = (group: boolean) => [
  ...(group ? [{ value: 'pass-through', label: BLEND_NAMES['pass-through'] }] : []),
  ...BLEND_MODES.map((m) => (m === '-' ? '-' : { value: m, label: BLEND_NAMES[m as BlendMode] })),
] as any;

const THUMB_W = 34, THUMB_H = 30;
const thumbCache = new WeakMap<Layer, { v: number; m: number; c: HTMLCanvasElement; mc: HTMLCanvasElement | null; dw: number }>();

function makeThumb(doc: Doc, src: HTMLCanvasElement, sx: number, sy: number, gray = false): HTMLCanvasElement {
  const s = Math.min(THUMB_W / doc.width, THUMB_H / doc.height);
  const c = createCanvas(Math.max(1, Math.round(doc.width * s)), Math.max(1, Math.round(doc.height * s)));
  const x = ctx2d(c);
  x.imageSmoothingQuality = 'medium';
  if (gray) { x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(gray ? alphaToGray(src) : src, sx * s, sy * s, src.width * s, src.height * s);
  return c;
}
function thumbsFor(doc: Doc, L: Layer) {
  const mv = L.mask ? (L.mask as any).__v ?? 0 : -1;
  let t = thumbCache.get(L);
  if (!t || t.v !== L.version || t.m !== mv || t.dw !== doc.width) {
    const c = L.kind === 'adjustment' ? createCanvas(1, 1) : makeThumb(doc, L.canvas, L.x, L.y);
    const mc = L.mask ? makeThumb(doc, L.mask, L.maskX, L.maskY, true) : null;
    t = { v: L.version, m: mv, c, mc, dw: doc.width };
    thumbCache.set(L, t);
  }
  return t;
}

const FX_NAMES: Record<string, string> = {
  dropShadow: 'Drop Shadow', innerShadow: 'Inner Shadow', outerGlow: 'Outer Glow', innerGlow: 'Inner Glow',
  stroke: 'Stroke', colorOverlay: 'Color Overlay', gradientOverlay: 'Gradient Overlay',
};

export const layersPanel: Panel = {
  id: 'layers', title: 'Layers', icon: 'p-layers',
  menu: () => {
    const d = app.doc;
    return [
      { label: 'New Layer...', action: () => newLayerDialog(), shortcut: 'Shift+Ctrl+N', disabled: !d },
      { label: 'Duplicate Layer', action: () => duplicateLayer(), disabled: !d },
      { label: 'Delete Layer', action: () => deleteLayers(), disabled: !d },
      { sep: true, label: '' },
      { label: 'Merge Down', action: () => mergeDown(), shortcut: 'Ctrl+E', disabled: !d },
      { label: 'Merge Visible', action: () => mergeVisible(), shortcut: 'Shift+Ctrl+E', disabled: !d },
      { label: 'Flatten Image', action: () => flattenImage(), disabled: !d },
      { sep: true, label: '' },
      { label: 'Blending Options...', action: () => openLayerStyleDialog('blending'), disabled: !d },
      { label: 'Create Clipping Mask', action: () => toggleClipping(), shortcut: 'Alt+Ctrl+G', disabled: !d },
    ];
  },
  build() {
    const blend = select({
      options: BLEND_OPTIONS(false),
      value: 'normal', title: 'Set the blending mode for the layer',
      onChange: (v) => { const d = app.doc, L = d?.active; if (d && L) setLayerProp(d, L, 'blend', v as BlendMode, 'Blending Change'); },
    });
    const pctField = (label: string, key: 'opacity' | 'fillOpacity', name: string, title: string) => {
      const n = numberInput({
        value: 100, min: 0, max: 100, unit: '%', width: 40,
        onChange: (v) => { const d = app.doc, L = d?.active; if (d && L) { setLayerPropLive(d, L, key, v / 100, name); flushPendingProp(); } },
      });
      const lbl = h('span', { class: 'field-label' }, label);
      scrubby(lbl, n, { min: 0, max: 100, onInput: (v) => { const d = app.doc, L = d?.active; if (d && L) setLayerPropLive(d, L, key, v / 100, name); } });
      const drop = h('button', { class: 'drop', title }, icon('chevron-down', 10));
      drop.addEventListener('click', () => {
        const L = app.doc?.active;
        if (!L) return;
        const s = slider({ value: Math.round(L[key] * 100), min: 0, max: 100, width: 150, onInput: (v) => { n.set(v); const d = app.doc; if (d && L) setLayerPropLive(d, L, key, v / 100, name); } });
        popover(drop, h('div', null, s.el), { align: 'right', onClose: flushPendingProp });
      });
      return { el: h('div', { class: 'opacity-field', title }, lbl, n.el, drop), n };
    };
    const op = pctField('Opacity:', 'opacity', 'Opacity Change', 'Set the master opacity for the layer');
    const fill = pctField('Fill:', 'fillOpacity', 'Fill Opacity Change', 'Set the interior opacity for the layer');

    const lock = (name: string, title: string, key: 'lockAlpha' | 'lockPixels' | 'lockPosition' | 'lockAll') => {
      const b = iconButton(name, title, () => { const d = app.doc, L = d?.active; if (d && L && !L.isBackground) setLayerProp(d, L, key, !L[key], 'Lock Change'); }, { size: 14 });
      return { b, key };
    };
    const locks = [lock('lock-alpha', 'Lock transparent pixels', 'lockAlpha'), lock('lock-pixels', 'Lock image pixels', 'lockPixels'), lock('lock-move', 'Lock position', 'lockPosition'), lock('lock', 'Lock all', 'lockAll')];

    const kindFilter = select({ options: [{ value: '', label: 'Kind' }, { value: 'raster', label: 'Pixel' }, { value: 'adjustment', label: 'Adjustment' }, { value: 'text', label: 'Type' }, { value: 'shape', label: 'Shape' }, { value: 'fill', label: 'Fill' }], value: '', width: 80, onChange: () => renderList() });
    const search = h('input', { class: 'ps-input', placeholder: 'Search layers', style: { flex: '1', minWidth: '0' } }) as HTMLInputElement;
    search.addEventListener('input', () => renderList());
    search.addEventListener('keydown', (e) => e.stopPropagation());

    const top = h('div', { class: 'layers-top' },
      h('div', { class: 'row' }, kindFilter.el, search),
      h('div', { class: 'row' }, blend.el, op.el),
      h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Lock:'), h('div', { class: 'lock-btns' }, ...locks.map((l) => l.b)), h('div', { style: { flex: '1' } }), fill.el));
    const list = h('div', { class: 'layer-list' });

    // footer
    const fxBtn = iconButton('fx', 'Add a layer style', () => {
      const r = fxBtn.getBoundingClientRect();
      contextMenu(r.left, r.top - 260, fxMenuItems());
    });
    const adjBtn = iconButton('adjust-layer', 'Create new fill or adjustment layer', () => {
      const r = adjBtn.getBoundingClientRect();
      const items: CtxItem[] = [
        { label: 'Solid Color...', action: () => newFillLayer('solid') },
        { label: 'Gradient...', action: () => newFillLayer('gradient') },
        { sep: true, label: '' },
        ...ADJUSTMENTS.filter((a) => !a.noLayer).map((a) => ({ label: `${a.name}...`, action: () => newAdjustmentLayer(a.kind) })),
      ];
      contextMenu(r.left, r.top - 22 * items.length, items);
    });
    const footer = h('div', { class: 'panel-footer' },
      iconButton('link', 'Link layers (not available)', () => {}),
      fxBtn,
      iconButton('mask', 'Add a mask (Alt: hide all)', (e) => addMask(e.altKey ? 'hide' : 'reveal')),
      adjBtn,
      iconButton('folder', 'Create a new group (groups the selected layers when several are selected)', () => { const d = app.doc; if (!d) return; if (d.selectedLayers.length > 1) groupLayers(); else newGroup(); }),
      iconButton('new-layer', 'Create a new layer', (e) => (e.altKey ? newLayerDialog() : newLayer())),
      iconButton('trash', 'Delete layer', () => deleteLayers()));
    const root = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, top, list, footer);

    let dragFrom: Layer | null = null;
    /** id of the layer whose name is being edited (0 = none) */
    let renaming = 0;
    let lastNameClick = { id: 0, t: 0 };
    function row(doc: Doc, L: Layer): HTMLElement {
      const t = thumbsFor(doc, L);
      const active = L.id === doc.activeId;
      const selected = doc.selectedIds.has(L.id) && !active;
      const eye = h('div', { class: `vis${L.visible ? '' : ' off'}`, title: 'Indicates layer visibility' }, icon('eye', 16));
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.altKey) { // solo
          const before = doc.captureState();
          const others = doc.layers.filter((l) => l !== L);
          const anyVisible = others.some((l) => l.visible);
          for (const l of others) l.visible = !anyVisible;
          L.visible = true;
          doc.invalidate();
          doc.commit('Show/Hide Layers', before);
        } else setLayerProp(doc, L, 'visible', !L.visible, L.visible ? 'Hide Layer' : 'Show Layer');
      });
      let thumbEl: HTMLElement;
      if (L.kind === 'group') {
        thumbEl = h('div', { class: 'thumb kind group-thumb', title: 'Group' }, icon('folder', 18));
      } else if (L.kind === 'adjustment') {
        const def = getAdjustment(L.adjustment?.kind ?? '');
        thumbEl = h('div', { class: 'thumb kind', title: def?.name ?? 'Adjustment' }, icon(def?.icon ?? 'adjust-layer', 18));
      } else if (L.kind === 'text') {
        thumbEl = h('div', { class: 'thumb kind', title: 'Type layer' }, icon('type', 18));
      } else if (L.kind === 'fill') {
        thumbEl = h('div', { class: 'thumb' }, t.c);
      } else {
        thumbEl = h('div', { class: 'thumb' }, t.c);
        if (L.kind === 'shape') thumbEl.title = 'Shape layer';
      }
      if (active && !doc.editMask && L.mask) thumbEl.classList.add('targeted');
      thumbEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) { loadFromLayer(doc, L, e.shiftKey ? (e.altKey ? 'intersect' : 'add') : e.altKey ? 'subtract' : 'new'); return; }
        doc.setActive(L);
        doc.editMask = false;
        doc.viewMask = false;
        bus.emit('layers', doc); doc.invalidate();
      });
      thumbEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (L.kind === 'text') { doc.setActive(L); setTool('type'); }
        else if (L.kind === 'fill') editFillLayer(L);
        else if (L.kind === 'adjustment') bus.emit('show-panel', 'properties');
        else if (L.kind === 'group') toggleCollapsed(L);
        else openLayerStyleDialog('blending');
      });
      let maskEl: HTMLElement | null = null;
      if (L.mask) {
        maskEl = h('div', { class: `thumb mask${L.maskEnabled ? '' : ' disabled'}${active && doc.editMask ? ' targeted' : ''}`, title: 'Layer mask' }, t.mc);
        maskEl.style.position = 'relative';
        maskEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.shiftKey) { toggleMask(); return; }
          if (e.ctrlKey || e.metaKey) { loadFromLayer(doc, L, 'new', true); return; }
          doc.setActive(L);
          if (e.altKey) { doc.viewMask = !doc.viewMask; doc.editMask = true; }
          else { doc.editMask = true; doc.viewMask = false; }
          bus.emit('layers', doc); doc.invalidate();
        });
        maskEl.addEventListener('dblclick', (e) => { e.stopPropagation(); bus.emit('show-panel', 'properties'); });
      }
      const editing = renaming === L.id;
      const name = h('div', { class: `lname${L.isBackground ? ' bg' : ''}`, title: editing ? '' : 'Double-click to rename' });
      if (editing) name.appendChild(renameInput(doc, L)); else name.textContent = L.name;
      // Selecting a layer rebuilds its row, so the browser's dblclick can miss; detect the
      // second click ourselves, keyed by layer rather than by DOM element.
      name.addEventListener('click', (e) => {
        if (editing || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        const now = performance.now();
        if (lastNameClick.id === L.id && now - lastNameClick.t < 500) { lastNameClick = { id: 0, t: 0 }; startRename(doc, L); }
        else lastNameClick = { id: L.id, t: now };
      });
      name.addEventListener('dblclick', (e) => { e.stopPropagation(); if (!editing) startRename(doc, L); });
      const badges = h('div', { class: 'badges' },
        hasActiveStyle(L) ? h('span', { title: 'Layer effects', style: { cursor: 'pointer' }, onclick: (e: Event) => { e.stopPropagation(); doc.setActive(L); openLayerStyleDialog('blending'); } }, icon('fx', 16)) : null,
        L.lockAll || L.lockPixels || L.lockPosition || L.lockAlpha || L.isBackground ? icon('lock', 11) : null);
      const depth = depthOf(doc, L);
      const twist = h('div', { class: 'twist', title: L.kind === 'group' ? (L.collapsed ? 'Expand group' : 'Collapse group') : '' },
        L.kind === 'group' ? icon(L.collapsed ? 'chevron-right' : 'chevron-down', 12) : null);
      if (L.kind === 'group') twist.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapsed(L); });
      const r = h('div', { class: `layer-row${active ? ' active' : ''}${selected ? ' selected' : ''}${L.kind === 'group' ? ' is-group' : ''}`, draggable: !L.isBackground && !editing },
        L.color ? h('div', { class: 'label-color', style: { background: L.color } }) : null,
        eye, h('div', { class: 'indent', style: { width: `${depth * 16}px` } }), twist,
        L.clipped ? h('div', { class: 'clip-arrow', title: 'Clipped to the layer below' }, '↳') : null,
        thumbEl, maskEl ? h('div', { class: 'chain' }, icon('link', 10)) : null, maskEl, name, badges);
      r.addEventListener('click', (e) => {
        if (e.altKey && !e.ctrlKey) { doc.setActive(L); toggleClipping(); return; }
        if (e.ctrlKey || e.metaKey) {
          if (doc.selectedIds.has(L.id) && doc.selectedIds.size > 1) { doc.selectedIds.delete(L.id); if (doc.activeId === L.id) doc.activeId = [...doc.selectedIds][0]; bus.emit('layers', doc); }
          else doc.setActive(L, true);
        } else if (e.shiftKey && doc.active) {
          const a = doc.indexOf(doc.active), b = doc.indexOf(L);
          const [lo, hi] = a < b ? [a, b] : [b, a];
          doc.selectedIds = new Set(doc.layers.slice(lo, hi + 1).map((l) => l.id));
          doc.activeId = L.id;
          bus.emit('layers', doc);
        } else {
          doc.setActive(L);
          if (!L.mask) doc.editMask = false;
        }
        doc.viewMask = false;
        doc.invalidate();
      });
      r.addEventListener('dblclick', () => { doc.setActive(L); if (L.kind !== 'adjustment' && L.kind !== 'group') openLayerStyleDialog('blending'); });
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        doc.setActive(L, doc.selectedIds.has(L.id));
        contextMenu(e.clientX, e.clientY, rowMenu(doc, L));
      });
      // drag & drop reorder
      r.addEventListener('dragstart', (e) => { dragFrom = L; e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/plain', 'layer'); });
      const clearDrop = () => list.querySelectorAll('.drop-above, .drop-below, .drop-into').forEach((x) => x.classList.remove('drop-above', 'drop-below', 'drop-into'));
      r.addEventListener('dragover', (e) => {
        if (!dragFrom || dragFrom === L || isInside(doc, L, dragFrom)) return;
        e.preventDefault();
        const rect = r.getBoundingClientRect();
        const f = (e.clientY - rect.top) / rect.height;
        // groups accept drops in their middle band ("into"); edges place above/below
        const zone = L.kind === 'group' && f > 0.25 && f < 0.75 ? 'drop-into' : f < 0.5 ? 'drop-above' : 'drop-below';
        clearDrop();
        r.classList.add(zone);
      });
      r.addEventListener('dragleave', () => r.classList.remove('drop-above', 'drop-below', 'drop-into'));
      r.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = dragFrom;
        dragFrom = null;
        const where = r.classList.contains('drop-into') ? 'into' : r.classList.contains('drop-above') ? 'above' : 'below';
        clearDrop();
        if (!from || from === L) return;
        // the list shows the top of the stack first, so "above" in the list = higher in the stack
        moveLayerTo(doc, from, L, where, 'Layer Order');
      });
      r.addEventListener('dragend', () => { dragFrom = null; clearDrop(); });

      if (L.style && hasActiveStyle(L)) {
        const fx = h('div', { class: 'fx-list', style: { paddingLeft: `${52 + depth * 16}px` } }, h('div', null, icon('eye', 12), 'Effects'),
          ...Object.entries(L.style).filter(([, v]: any) => v?.enabled).map(([k]) => h('div', { style: { paddingLeft: '18px' } }, FX_NAMES[k] ?? k)));
        fx.addEventListener('dblclick', () => { doc.setActive(L); openLayerStyleDialog('blending'); });
        return h('div', null, r, fx);
      }
      return r;
    }

    function rowMenu(doc: Doc, L: Layer): CtxItem[] {
      const grp = L.kind === 'group';
      return [
        { label: 'Blending Options...', action: () => openLayerStyleDialog('blending'), disabled: L.kind === 'adjustment' || grp },
        { label: grp ? 'Rename Group...' : 'Rename Layer...', shortcut: 'F2', action: () => startRename(doc, L) },
        { label: grp ? 'Duplicate Group...' : 'Duplicate Layer...', action: () => duplicateLayer(L) },
        { label: grp ? 'Delete Group' : 'Delete Layer', action: () => deleteLayers() },
        { sep: true, label: '' },
        { label: 'Group from Layers', shortcut: 'Ctrl+G', action: () => groupLayers(), disabled: L.isBackground },
        { label: 'Ungroup Layers', shortcut: 'Shift+Ctrl+G', action: () => ungroupLayers(), disabled: !grp && !L.parentId },
        ...(grp ? [{ label: 'Merge Group', shortcut: 'Ctrl+E', action: () => mergeDown() }] : []),
        { sep: true, label: '' },
        ...layerExportContextItems(),
        { sep: true, label: '' },
        { label: L.kind === 'text' ? 'Rasterize Type' : 'Rasterize Layer', action: () => rasterizeActive(), disabled: L.kind === 'raster' || L.kind === 'adjustment' },
        { label: 'Rasterize Layer Style', action: () => rasterizeStyle(), disabled: !hasActiveStyle(L) },
        { sep: true, label: '' },
        { label: L.mask ? (L.maskEnabled ? 'Disable Layer Mask' : 'Enable Layer Mask') : 'Add Layer Mask', action: () => (L.mask ? toggleMask() : addMask()) },
        { label: 'Apply Layer Mask', action: () => deleteMask(true), disabled: !L.mask || L.kind !== 'raster' },
        { label: 'Delete Layer Mask', action: () => deleteMask(false), disabled: !L.mask },
        { sep: true, label: '' },
        { label: L.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', action: () => toggleClipping(), disabled: doc.indexOf(L) === 0 },
        { sep: true, label: '' },
        { label: 'Copy Layer Style', action: () => copyLayerStyle(), disabled: !L.style },
        { label: 'Paste Layer Style', action: () => pasteLayerStyle() },
        { label: 'Clear Layer Style', action: () => clearLayerStyle(), disabled: !L.style },
        { sep: true, label: '' },
        ...Object.entries(LABEL_COLORS).map(([v, l]) => ({ label: l, checked: L.color === v, action: () => setLabelColor(L, v) })),
        { sep: true, label: '' },
        { label: 'Merge Down', action: () => mergeDown(), disabled: doc.indexOf(L) === 0 },
        { label: 'Merge Visible', action: () => mergeVisible() },
        { label: 'Flatten Image', action: () => flattenImage() },
      ];
    }

    const renderList = () => {
      clear(list);
      const doc = app.doc;
      if (!doc) { list.appendChild(h('div', { class: 'panel-empty' }, 'No document open')); return; }
      const kf = kindFilter.get(), q = search.value.trim().toLowerCase();
      const filtering = !!(kf || q);
      for (let i = doc.layers.length - 1; i >= 0; i--) {
        const L = doc.layers[i];
        if (kf && L.kind !== kf) continue;
        if (q && !L.name.toLowerCase().includes(q)) continue;
        // contents of collapsed groups are hidden (unless filtering)
        if (!filtering && ancestors(doc, L).some((a) => a.collapsed)) continue;
        list.appendChild(row(doc, L));
      }
    };
    let blendForGroup: boolean | null = null;
    const syncTop = () => {
      const L = app.doc?.active;
      const isGrp = L?.kind === 'group';
      if (isGrp !== blendForGroup) {
        blendForGroup = isGrp;
        blend.setOptions(BLEND_OPTIONS(isGrp));
      }
      blend.set(L?.blend ?? 'normal');
      op.n.set(Math.round((L?.opacity ?? 1) * 100));
      fill.n.set(Math.round((L?.fillOpacity ?? 1) * 100));
      for (const l of locks) l.b.classList.toggle('active', !!L && (L[l.key] || (L.isBackground && (l.key === 'lockAlpha' || l.key === 'lockPosition'))));
      (blend.el as HTMLSelectElement).disabled = !L || L.isBackground;
    };
    // ---------- renaming ----------
    function startRename(doc: Doc, L: Layer) {
      if (renaming === L.id) return;
      if (L.isBackground) convertBackground(L); // Photoshop: the Background becomes "Layer 0", then you name it
      for (const a of ancestors(doc, L)) a.collapsed = false;
      renaming = L.id;
      if (doc.activeId !== L.id) doc.setActive(L);
      renderList();
      syncTop();
      const inp = list.querySelector('.lname input') as HTMLInputElement | null;
      if (!inp) { renaming = 0; return; }
      inp.focus();
      inp.select();
      inp.scrollIntoView({ block: 'nearest' });
    }
    function renameInput(doc: Doc, L: Layer): HTMLInputElement {
      const inp = h('input', { class: 'ps-input rename-input', value: L.name, spellcheck: false, maxlength: 255 }) as HTMLInputElement;
      let finished = false;
      const finish = (save: boolean, next?: 1 | -1) => {
        if (finished) return;
        finished = true;
        renaming = 0;
        const v = inp.value.trim();
        if (save && v && v !== L.name) setLayerProp(doc, L, 'name', v, 'Rename Layer');
        else refresh();
        if (next) {
          // Tab / Shift+Tab continue renaming the next layer down / up, like Photoshop
          const shown = [...doc.layers].reverse().filter((l) => !ancestors(doc, l).some((a) => a.collapsed));
          const n = shown[shown.indexOf(L) + next];
          if (n && !n.isBackground) setTimeout(() => startRename(doc, n));
        }
      };
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        else if (ev.key === 'Tab') { ev.preventDefault(); finish(true, ev.shiftKey ? -1 : 1); }
      });
      inp.addEventListener('blur', () => finish(true));
      // keep clicks/drags inside the field from selecting or dragging the row
      for (const t of ['click', 'dblclick', 'mousedown', 'pointerdown', 'dragstart']) inp.addEventListener(t, (ev) => ev.stopPropagation());
      return inp;
    }
    setInlineRenamer((L) => {
      const doc = app.doc;
      if (!doc || !list.isConnected || list.offsetParent === null) return false; // panel hidden → use the dialog
      startRename(doc, L);
      return true;
    });

    // while a name is being edited, hold off re-rendering the list (it would destroy the field)
    const refresh = rafThrottle(() => {
      if (renaming && list.contains(document.activeElement)) return;
      renderList();
      syncTop();
    });
    bus.on('layers', refresh);
    bus.on('docs', refresh);
    bus.on('pixels', debounce(refresh, 150));
    bus.on('history', refresh);
    refresh();
    return root;
  },
};
void getTool;
