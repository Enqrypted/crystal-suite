import { app, APP_NAME, SUITE_NAME, APP_VERSION } from './app';
import { bus } from './core/bus';
import { MenuItem, SEP } from './ui/menutypes';
import { TopMenu } from './ui/menubar';
import { h } from './ui/dom';
import { toast } from './ui/widgets';
import { openDialog, promptDialog } from './dialogs/dialog';
import * as io from './ops/io';
import * as edit from './ops/editops';
import * as img from './ops/imageops';
import * as lay from './ops/layerops';
import * as sel from './ops/selectops';
import { adjustmentMenuItems, autoMenuItems } from './dialogs/adjustdialogs';
import { filterMenuItems } from './dialogs/filterdialogs';
import { layerStyleMenuItems } from './dialogs/layerstyle';
import { exportMenuItems, exportAsDialog, quickExportLayerPng } from './ops/export';
import { ADJUSTMENTS } from './core/adjustments';
import { alignLayers, cropDocument, TransformTool } from './tools/transform';
import { togglePanel, isPanelVisible } from './ui/dock';
import type { Viewport } from './ui/viewport';
import { HISTORY_LIMIT } from './core/document';
import { flattenLayers } from './core/compositor';
import { canvasToBlob } from './core/util';

export interface MenuContext {
  viewport: Viewport;
  setRulers(on: boolean): void;
  screenMode(mode?: number): void;
  resetWorkspace(): void;
  applyTheme(): void;
  shortcutsDialog(): void;
}

const hasDoc = () => !!app.doc;
const hasSel = () => !!app.doc?.selection;
const hasLayer = () => !!app.doc?.active;

export function buildMenus(ctx: MenuContext): TopMenu[] {
  const v = ctx.viewport;
  const panel = (id: string, label: string, shortcut?: string): MenuItem => ({ label, shortcut, checked: () => isPanelVisible(id), action: () => togglePanel(id) });

  const file: TopMenu = {
    label: 'File', items: () => [
      { label: 'New...', shortcut: 'Ctrl+N', action: () => io.newDocumentDialog() },
      { label: 'Open...', shortcut: 'Ctrl+O', action: () => io.openFiles() },
      {
        label: 'Open Recent', submenu: () => {
          const r = io.recentFiles();
          if (!r.length) return [{ label: '(No recent files)', enabled: () => false }];
          return [
            ...r.map((f, i): MenuItem => ({
              label: `${i + 1}. ${f.name}`,
              enabled: () => !!f.path && io.isElectron,
              action: () => f.path && io.openPath(f.path),
            })),
            SEP, { label: 'Clear Recent File List', action: () => io.clearRecent() },
          ];
        },
      },
      SEP,
      { label: 'Close', shortcut: 'Ctrl+W', enabled: hasDoc, action: () => io.closeDoc() },
      { label: 'Close All', shortcut: 'Alt+Ctrl+W', enabled: hasDoc, action: async () => { for (const d of [...app.docs]) if (!(await io.closeDoc(d))) break; } },
      SEP,
      { label: 'Save', shortcut: 'Ctrl+S', enabled: hasDoc, action: () => io.save() },
      { label: 'Save As...', shortcut: 'Shift+Ctrl+S', enabled: hasDoc, action: () => io.saveAs() },
      { label: 'Revert', shortcut: 'F12', enabled: () => !!app.doc?.snapshots.length, action: () => { const d = app.doc!; d.restoreSnapshot(d.snapshots[0]); } },
      SEP,
      {
        label: 'Export', enabled: hasDoc, submenu: () => exportMenuItems(),
      },
      SEP,
      { label: 'Place Embedded...', enabled: hasDoc, action: () => io.placeEmbedded() },
      SEP,
      { label: 'Print...', shortcut: 'Ctrl+P', enabled: hasDoc, action: () => printDoc() },
      SEP,
      { label: 'Exit', shortcut: 'Ctrl+Q', action: () => window.close() },
    ],
  };

  const editMenu: TopMenu = {
    label: 'Edit', items: () => {
      const d = app.doc;
      const undoName = d && d.canUndo ? d.history[d.historyIndex - 1].name : '';
      const redoName = d && d.canRedo ? d.history[d.historyIndex].name : '';
      return [
        { label: `Undo ${undoName}`.trim(), shortcut: 'Ctrl+Z', enabled: () => !!app.doc?.canUndo, action: () => app.doc?.undo() },
        { label: `Redo ${redoName}`.trim(), shortcut: 'Shift+Ctrl+Z', enabled: () => !!app.doc?.canRedo, action: () => app.doc?.redo() },
        { label: 'Toggle Last State', shortcut: 'Alt+Ctrl+Z', enabled: hasDoc, action: () => { const dd = app.doc!; if (dd.canRedo) dd.redo(); else dd.undo(); } },
        SEP,
        { label: 'Cut', shortcut: 'Ctrl+X', enabled: hasSel, action: () => edit.cut() },
        { label: 'Copy', shortcut: 'Ctrl+C', enabled: hasDoc, action: () => edit.copy(false) },
        { label: 'Copy Merged', shortcut: 'Shift+Ctrl+C', enabled: hasDoc, action: () => edit.copy(true) },
        { label: 'Paste', shortcut: 'Ctrl+V', bind: false, action: () => edit.paste(false) },
        { label: 'Paste Special', submenu: [{ label: 'Paste in Place', shortcut: 'Shift+Ctrl+V', action: () => edit.paste(true) }] },
        { label: 'Clear', shortcut: 'Delete', enabled: hasDoc, action: () => edit.clearSelection(), bind: false },
        SEP,
        { label: 'Fill...', shortcut: 'Shift+F5', enabled: hasDoc, action: () => edit.fillDialog() },
        { label: 'Stroke...', enabled: hasDoc, action: () => edit.strokeDialog() },
        { label: 'Content-Aware Fill...', enabled: hasSel, action: () => edit.contentAwareFill() },
        SEP,
        { label: 'Free Transform', shortcut: 'Ctrl+T', enabled: hasLayer, action: () => edit.startTransform('free') },
        {
          label: 'Transform', enabled: hasLayer, submenu: [
            { label: 'Scale', action: () => edit.startTransform('scale') },
            { label: 'Rotate', action: () => edit.startTransform('rotate') },
            { label: 'Skew', action: () => edit.startTransform('skew') },
            { label: 'Distort', action: () => edit.startTransform('distort') },
            { label: 'Perspective', action: () => edit.startTransform('perspective') },
            SEP,
            { label: 'Rotate 180°', action: () => edit.transformImmediate('rot180') },
            { label: 'Rotate 90° Clockwise', action: () => edit.transformImmediate('rot90') },
            { label: 'Rotate 90° Counter Clockwise', action: () => edit.transformImmediate('rot-90') },
            SEP,
            { label: 'Flip Horizontal', action: () => edit.transformImmediate('flipH') },
            { label: 'Flip Vertical', action: () => edit.transformImmediate('flipV') },
          ],
        },
        SEP,
        {
          label: 'Purge', submenu: [
            { label: 'Clipboard', action: () => { app.clipboard = null; toast('Clipboard purged'); } },
            { label: 'Histories', enabled: hasDoc, action: () => { const dd = app.doc!; dd.history.splice(0, dd.historyIndex); dd.history.splice(dd.historyIndex - dd.historyIndex); dd.history = []; dd.historyIndex = 0; dd.historyBaseName = 'Purged'; bus.emit('history', dd); toast('History purged'); } },
            { label: 'All', action: () => { app.clipboard = null; for (const dd of app.docs) { dd.history = []; dd.historyIndex = 0; dd.historyBaseName = 'Purged'; bus.emit('history', dd); } toast('Purged'); } },
          ],
        },
        SEP,
        { label: 'Keyboard Shortcuts...', shortcut: 'Alt+Shift+Ctrl+K', action: () => ctx.shortcutsDialog() },
        { label: 'Preferences...', shortcut: 'Ctrl+K', action: () => edit.preferencesDialog(ctx.applyTheme) },
      ];
    },
  };

  const image: TopMenu = {
    label: 'Image', items: () => [
      {
        label: 'Mode', submenu: [
          { label: 'Grayscale', enabled: hasDoc, action: () => convertGrayscale() },
          { label: 'RGB Color', checked: () => true, enabled: () => false },
          SEP,
          { label: '8 Bits/Channel', checked: () => true, enabled: () => false },
        ],
      },
      SEP,
      { label: 'Adjustments', enabled: hasDoc, submenu: () => adjustmentMenuItems() },
      SEP,
      ...autoMenuItems(),
      SEP,
      { label: 'Image Size...', shortcut: 'Alt+Ctrl+I', enabled: hasDoc, action: () => img.imageSizeDialog() },
      { label: 'Canvas Size...', shortcut: 'Alt+Ctrl+C', enabled: hasDoc, action: () => img.canvasSizeDialog() },
      {
        label: 'Image Rotation', enabled: hasDoc, submenu: [
          { label: '180°', action: () => img.rotateCanvas(app.doc!, 180) },
          { label: '90° Clockwise', action: () => img.rotateCanvas(app.doc!, 90) },
          { label: '90° Counter Clockwise', action: () => img.rotateCanvas(app.doc!, -90) },
          { label: 'Arbitrary...', action: () => img.arbitraryRotateDialog() },
          SEP,
          { label: 'Flip Canvas Horizontal', action: () => img.rotateCanvas(app.doc!, 0, 'h') },
          { label: 'Flip Canvas Vertical', action: () => img.rotateCanvas(app.doc!, 0, 'v') },
        ],
      },
      { label: 'Crop', enabled: hasSel, action: () => { const d = app.doc!; const b = d.selectionBounds(); if (b) cropDocument(d, b, true); } },
      { label: 'Trim...', enabled: hasDoc, action: () => img.trimDialog() },
      { label: 'Reveal All', enabled: hasDoc, action: () => img.revealAll() },
      SEP,
      { label: 'Duplicate...', enabled: hasDoc, action: async () => { const n = await promptDialog('Duplicate Image', 'As:', `${app.doc!.name.replace(/\.[^.]+$/, '')} copy`); if (n) img.duplicateImage(n); } },
    ],
  };

  const layer: TopMenu = {
    label: 'Layer', items: () => [
      {
        label: 'New', enabled: hasDoc, submenu: [
          { label: 'Layer...', shortcut: 'Shift+Ctrl+N', action: () => lay.newLayerDialog() },
          { label: 'Layer (no dialog)', shortcut: 'Alt+Shift+Ctrl+N', action: () => lay.newLayer() },
          { label: 'Group...', action: () => lay.newGroup() },
          { label: 'Layer From Background...', enabled: () => !!app.doc?.active?.isBackground, action: () => lay.convertBackground(app.doc!.active!) },
          SEP,
          { label: 'Layer via Copy', shortcut: 'Ctrl+J', action: () => lay.layerVia(false) },
          { label: 'Layer via Cut', shortcut: 'Shift+Ctrl+J', action: () => lay.layerVia(true) },
        ],
      },
      { label: 'Duplicate Layer...', enabled: hasLayer, action: () => lay.duplicateLayer() },
      { label: 'Export As...', enabled: () => !!app.doc?.active && app.doc.active.kind !== 'adjustment', action: () => exportAsDialog('layers') },
      { label: 'Quick Export as PNG', enabled: () => !!app.doc?.active && app.doc.active.kind !== 'adjustment', action: () => quickExportLayerPng() },
      { label: 'Delete', enabled: hasLayer, submenu: [{ label: 'Layer', action: () => lay.deleteLayers() }] },
      SEP,
      { label: 'Rename Layer...', shortcut: 'F2', enabled: hasLayer, action: () => lay.renameLayer() },
      { label: 'Layer Style', enabled: hasLayer, submenu: () => layerStyleMenuItems() },
      SEP,
      { label: 'New Fill Layer', enabled: hasDoc, submenu: [{ label: 'Solid Color...', action: () => lay.newFillLayer('solid') }, { label: 'Gradient...', action: () => lay.newFillLayer('gradient') }] },
      { label: 'New Adjustment Layer', enabled: hasDoc, submenu: () => ADJUSTMENTS.filter((a) => !a.noLayer).map((a) => ({ label: `${a.name}...`, action: () => lay.newAdjustmentLayer(a.kind) })) },
      SEP,
      {
        label: 'Layer Mask', enabled: hasLayer, submenu: [
          { label: 'Reveal All', action: () => lay.addMask('reveal') },
          { label: 'Hide All', action: () => lay.addMask('hide') },
          { label: 'Reveal Selection', enabled: hasSel, action: () => lay.addMask('selection') },
          { label: 'Hide Selection', enabled: hasSel, action: () => lay.addMask('hideSelection') },
          SEP,
          { label: 'Delete', enabled: () => !!app.doc?.active?.mask, action: () => lay.deleteMask(false) },
          { label: 'Apply', enabled: () => !!app.doc?.active?.mask, action: () => lay.deleteMask(true) },
          SEP,
          { label: app.doc?.active?.maskEnabled === false ? 'Enable' : 'Disable', enabled: () => !!app.doc?.active?.mask, action: () => lay.toggleMask() },
        ],
      },
      { label: app.doc?.active?.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', shortcut: 'Alt+Ctrl+G', enabled: hasLayer, action: () => lay.toggleClipping() },
      SEP,
      {
        label: 'Rasterize', enabled: hasLayer, submenu: [
          { label: 'Type', enabled: () => app.doc?.active?.kind === 'text', action: () => lay.rasterizeActive() },
          { label: 'Shape', enabled: () => app.doc?.active?.kind === 'shape', action: () => lay.rasterizeActive() },
          { label: 'Fill Content', enabled: () => app.doc?.active?.kind === 'fill', action: () => lay.rasterizeActive() },
          { label: 'Layer Style', action: () => lay.rasterizeStyle() },
          SEP,
          { label: 'Layer', action: () => lay.rasterizeActive() },
        ],
      },
      SEP,
      {
        label: 'Arrange', enabled: hasLayer, submenu: [
          { label: 'Bring to Front', shortcut: 'Shift+Ctrl+]', action: () => lay.arrange('front') },
          { label: 'Bring Forward', shortcut: 'Ctrl+]', action: () => lay.arrange('forward') },
          { label: 'Send Backward', shortcut: 'Ctrl+[', action: () => lay.arrange('backward') },
          { label: 'Send to Back', shortcut: 'Shift+Ctrl+[', action: () => lay.arrange('back') },
        ],
      },
      {
        label: 'Align', enabled: hasLayer, submenu: [
          { label: 'Top Edges', action: () => alignLayers('top') }, { label: 'Vertical Centers', action: () => alignLayers('vcenter') },
          { label: 'Bottom Edges', action: () => alignLayers('bottom') }, SEP,
          { label: 'Left Edges', action: () => alignLayers('left') }, { label: 'Horizontal Centers', action: () => alignLayers('hcenter') },
          { label: 'Right Edges', action: () => alignLayers('right') },
        ],
      },
      SEP,
      { label: 'Group Layers', shortcut: 'Ctrl+G', enabled: hasLayer, action: () => lay.groupLayers() },
      { label: 'Ungroup Layers', shortcut: 'Shift+Ctrl+G', enabled: () => !!app.doc?.active && (app.doc.active.kind === 'group' || !!app.doc.active.parentId), action: () => lay.ungroupLayers() },
      SEP,
      { label: 'Lock Layers...', shortcut: 'Ctrl+/', enabled: hasLayer, action: () => { const d = app.doc!, L = d.active!; lay.setLayerProp(d, L, 'lockAll', !L.lockAll, 'Lock Change'); } },
      SEP,
      { label: app.doc?.active?.kind === 'group' ? 'Merge Group' : 'Merge Down', shortcut: 'Ctrl+E', enabled: hasLayer, action: () => lay.mergeDown() },
      { label: 'Merge Visible', shortcut: 'Shift+Ctrl+E', enabled: hasDoc, action: () => lay.mergeVisible() },
      { label: 'Stamp Visible', shortcut: 'Alt+Shift+Ctrl+E', enabled: hasDoc, action: () => lay.stampVisible() },
      { label: 'Flatten Image', enabled: hasDoc, action: () => lay.flattenImage() },
    ],
  };

  const type: TopMenu = {
    label: 'Type', items: () => [
      { label: 'Panels', submenu: [panel('character', 'Character Panel'), panel('paragraph', 'Paragraph Panel')] },
      SEP,
      { label: 'Rasterize Type Layer', enabled: () => app.doc?.active?.kind === 'text', action: () => lay.rasterizeActive() },
    ],
  };

  const select: TopMenu = {
    label: 'Select', items: () => [
      { label: 'All', shortcut: 'Ctrl+A', enabled: hasDoc, action: () => sel.selectAll() },
      { label: 'Deselect', shortcut: 'Ctrl+D', enabled: hasSel, action: () => sel.deselect() },
      { label: 'Reselect', shortcut: 'Shift+Ctrl+D', enabled: hasDoc, action: () => sel.reselect() },
      { label: 'Inverse', shortcut: 'Shift+Ctrl+I', enabled: hasDoc, action: () => sel.inverse() },
      SEP,
      { label: 'All Layers', shortcut: 'Alt+Ctrl+A', enabled: hasDoc, action: () => { const d = app.doc!; d.selectedIds = new Set(d.layers.map((l) => l.id)); bus.emit('layers', d); } },
      { label: 'Deselect Layers', enabled: hasDoc, action: () => { const d = app.doc!; d.selectedIds = new Set([d.activeId]); bus.emit('layers', d); } },
      SEP,
      { label: 'Color Range...', enabled: hasDoc, action: () => sel.colorRangeDialog() },
      { label: 'Subject', enabled: hasDoc, action: () => sel.selectSubject() },
      SEP,
      { label: 'Select and Mask...', shortcut: 'Alt+Ctrl+R', enabled: hasSel, action: () => sel.selectAndMaskDialog() },
      {
        label: 'Modify', enabled: hasSel, submenu: [
          { label: 'Border...', action: () => sel.modifyDialog('border') },
          { label: 'Smooth...', action: () => sel.modifyDialog('smooth') },
          { label: 'Expand...', action: () => sel.modifyDialog('expand') },
          { label: 'Contract...', action: () => sel.modifyDialog('contract') },
          { label: 'Feather...', shortcut: 'Shift+F6', action: () => sel.modifyDialog('feather') },
        ],
      },
      SEP,
      { label: 'Transform Selection', enabled: hasSel, action: () => TransformTool.startSelection() },
      SEP,
      { label: 'Grow', enabled: hasSel, action: () => sel.grow(false) },
      { label: 'Similar', enabled: hasSel, action: () => sel.grow(true) },
      SEP,
      { label: 'Load Selection...', enabled: hasDoc, action: () => sel.loadSelectionDialog() },
      { label: 'Save Selection...', enabled: hasSel, action: () => sel.saveSelectionDialog() },
      SEP,
      { label: 'Edit in Quick Mask Mode', checked: () => !!app.doc?.quickMask, enabled: hasDoc, action: () => sel.toggleQuickMask() },
    ],
  };

  const filter: TopMenu = {
    label: 'Filter', items: () => [
      { label: app.lastFilter ? `Last Filter (${app.lastFilter.name.replace(/\.\.\.$/, '')})` : 'Last Filter', shortcut: 'Alt+Ctrl+F', enabled: () => !!app.lastFilter && hasDoc(), action: () => app.lastFilter?.run() },
      SEP,
      ...filterMenuItems(),
    ],
  };

  const view: TopMenu = {
    label: 'View', items: () => [
      { label: 'Zoom In', shortcut: 'Ctrl++', enabled: hasDoc, action: () => v.zoomStep(1) },
      { label: 'Zoom Out', shortcut: 'Ctrl+-', enabled: hasDoc, action: () => v.zoomStep(-1) },
      { label: 'Fit on Screen', shortcut: 'Ctrl+0', enabled: hasDoc, action: () => v.fit() },
      { label: '100%', shortcut: 'Ctrl+1', enabled: hasDoc, action: () => v.actualPixels() },
      { label: '200%', enabled: hasDoc, action: () => v.setZoom(2) },
      { label: 'Fill Screen', enabled: hasDoc, action: () => v.fillScreen() },
      SEP,
      {
        label: 'Screen Mode', submenu: [
          { label: 'Standard Screen Mode', action: () => ctx.screenMode(0) },
          { label: 'Full Screen Mode With Menu Bar', action: () => ctx.screenMode(1) },
          { label: 'Full Screen Mode', action: () => ctx.screenMode(2) },
        ],
      },
      SEP,
      {
        label: 'Show', submenu: [
          { label: 'Grid', shortcut: "Ctrl+'", checked: () => app.prefs.showGrid, action: () => { app.prefs.showGrid = !app.prefs.showGrid; app.savePrefs(); v.requestRender(); } },
          { label: 'Guides', shortcut: 'Ctrl+;', checked: () => app.prefs.showGuides, action: () => { app.prefs.showGuides = !app.prefs.showGuides; app.savePrefs(); v.requestRender(); } },
          { label: 'Pixel Grid', checked: () => app.prefs.showPixelGrid, action: () => { app.prefs.showPixelGrid = !app.prefs.showPixelGrid; app.savePrefs(); v.requestRender(); } },
          { label: 'Layer Mask as Overlay', shortcut: '\\', bind: false, checked: () => !!app.doc?.maskOverlay, action: () => { const d = app.doc; if (d) { d.maskOverlay = !d.maskOverlay; d.invalidate(); } } },
        ],
      },
      { label: 'Rulers', shortcut: 'Ctrl+R', checked: () => app.prefs.showRulers, action: () => ctx.setRulers(!app.prefs.showRulers) },
      SEP,
      { label: 'Snap', shortcut: 'Shift+Ctrl+;', checked: () => app.prefs.snap, action: () => { app.prefs.snap = !app.prefs.snap; app.savePrefs(); } },
      SEP,
      { label: 'New Guide...', enabled: hasDoc, action: () => newGuideDialog() },
      { label: 'Clear Guides', enabled: () => !!app.doc?.guides.length, action: () => { app.doc!.guides = []; v.requestRender(); } },
    ],
  };

  const win: TopMenu = {
    label: 'Window', items: () => [
      { label: 'Workspace', submenu: [{ label: 'Reset Essentials', action: () => ctx.resetWorkspace() }] },
      SEP,
      panel('adjustments', 'Adjustments'),
      panel('brush-settings', 'Brush Settings', 'F5'),
      panel('brushes', 'Brushes'),
      panel('channels', 'Channels'),
      panel('character', 'Character'),
      panel('color', 'Color', 'F6'),
      panel('gradients', 'Gradients'),
      panel('histogram', 'Histogram'),
      panel('history', 'History'),
      panel('info', 'Info', 'F8'),
      panel('layers', 'Layers', 'F7'),
      panel('navigator', 'Navigator'),
      panel('paragraph', 'Paragraph'),
      panel('paths', 'Paths'),
      panel('properties', 'Properties'),
      panel('swatches', 'Swatches'),
      SEP,
      ...app.docs.map((d, i): MenuItem => ({ label: `${i + 1} ${d.name}`, checked: () => app.doc === d, action: () => app.setActiveDoc(d) })),
    ],
  };

  const help: TopMenu = {
    label: 'Help', items: () => [
      { label: `${APP_NAME} Help / Keyboard Shortcuts`, shortcut: 'F1', action: () => ctx.shortcutsDialog() },
      SEP,
      { label: `About ${APP_NAME}...`, action: () => aboutDialog() },
    ],
  };

  return [file, editMenu, image, layer, type, select, filter, view, win, help];
}

async function printDoc() {
  const d = app.doc; if (!d) return;
  const blob = await canvasToBlob(flattenLayers(d, d.layers), 'image/png');
  const url = URL.createObjectURL(blob);
  const w = window.open('', '_blank');
  if (!w) { toast('Popup blocked'); return; }
  w.document.write(`<title>${d.name}</title><img src="${url}" style="max-width:100%" onload="setTimeout(()=>print(),200)">`);
}

function convertGrayscale() {
  const d = app.doc; if (!d) return;
  const before = d.captureState();
  for (const L of d.layers) {
    if (L.kind !== 'raster') continue;
    const x = L.canvas.getContext('2d')!;
    const id = x.getImageData(0, 0, L.canvas.width, L.canvas.height);
    for (let i = 0; i < id.data.length; i += 4) { const g = id.data[i] * 0.299 + id.data[i + 1] * 0.587 + id.data[i + 2] * 0.114; id.data[i] = id.data[i + 1] = id.data[i + 2] = g; }
    const c = document.createElement('canvas'); c.width = L.canvas.width; c.height = L.canvas.height;
    c.getContext('2d')!.putImageData(id, 0, 0);
    L.canvas = c; L.touch();
  }
  d.commit('Grayscale', before);
}

async function newGuideDialog() {
  const d = app.doc; if (!d) return;
  const pos = await promptDialog('New Guide', 'Position (px) — prefix with "v" for vertical, e.g. v200:', 'h100');
  if (!pos) return;
  const vert = pos.trim().toLowerCase().startsWith('v');
  const n = parseFloat(pos.replace(/[^\d.-]/g, ''));
  if (!isFinite(n)) return;
  d.guides.push({ dir: vert ? 'v' : 'h', pos: n });
  app.prefs.showGuides = true;
  d.invalidate();
}

function aboutDialog() {
  openDialog({
    title: `About ${APP_NAME}`, width: 460, noCancel: true,
    content: h('div', { class: 'col', style: { alignItems: 'center', textAlign: 'center', gap: '10px', padding: '8px 0' } },
      h('div', { class: 'app-badge', style: { width: '64px', height: '64px', fontSize: '28px', borderRadius: '12px', borderWidth: '3px' } }, 'Ph'),
      h('div', { style: { fontSize: '20px', color: 'var(--text-strong)' } }, `${APP_NAME} ${APP_VERSION}`),
      h('div', { class: 'field-label' }, `Part of ${SUITE_NAME} — a free, open-source creative suite.`),
      h('div', { class: 'field-label' }, 'Runs entirely on your computer. No account, no subscription, no cloud.'),
      h('div', { class: 'field-label', style: { fontSize: '11px' } }, `History states: ${HISTORY_LIMIT.value}. PSD support by ag-psd (MIT).`)),
  });
}
