import './styles.css';
import './core/adjustments-impl';
import { app, APP_NAME, SUITE_NAME } from './app';
import { bus } from './core/bus';
import { HISTORY_LIMIT } from './core/document';
import { h, clear } from './ui/dom';
import { icon } from './ui/icons';
import { Viewport } from './ui/viewport';
import { buildMenubar, collectShortcuts, eventCombo, displayShortcut } from './ui/menubar';
import { buildToolbar, buildOptionsBar } from './ui/toolbar';
import { panelGroup, iconStrip, showPanel } from './ui/dock';
import { contextMenu, toast, numberInput, CtxItem } from './ui/widgets';
import { openDialog, isDialogOpen } from './dialogs/dialog';
import { installColorPicker } from './dialogs/colorpicker';
import { initTools } from './tools';
import { currentTool, getTool, setTool, toolByKey, TOOLS } from './tools/tool';
import { setNavViewport } from './tools/nav';
import { buildMenus } from './menus';
import { layersPanel } from './panels/layers';
import { propertiesPanel, adjustmentsPanel } from './panels/properties';
import { colorPanel, swatchesPanel, gradientsPanel } from './panels/color';
import { historyPanel } from './panels/history';
import {
  navigatorPanel, infoPanel, histogramPanel, channelsPanel, pathsPanel, characterPanel, paragraphPanel, brushesPanel,
  brushSettingsPanel, setPanelsViewport,
} from './panels/more';
import * as io from './ops/io';
import * as edit from './ops/editops';
import * as sel from './ops/selectops';
import * as lay from './ops/layerops';
import { fmtBytes } from './ops/imageops';
import { BrushBase } from './tools/paint';
import { TransformTool } from './tools/transform';

document.documentElement.dataset.theme = app.prefs.theme;
HISTORY_LIMIT.value = app.prefs.historyStates;
document.title = APP_NAME;
initTools();
installColorPicker();

// ---------- layout ----------
const viewport = new Viewport();
(window as any).photonViewport = viewport;
setNavViewport(viewport);
setPanelsViewport(viewport);

const appEl = h('div', { id: 'app' });
document.body.appendChild(appEl);

let screenMode = 0;
function setScreenMode(m = (screenMode + 1) % 3) {
  screenMode = m;
  appEl.classList.toggle('fullscreen', m === 2);
  appEl.classList.toggle('hide-tabs', m >= 1);
  tabs.style.display = m >= 1 ? 'none' : '';
  status.style.display = m === 2 ? 'none' : '';
  if (m === 2) { appEl.classList.add('hide-panels'); document.documentElement.requestFullscreen?.().catch(() => {}); toast('Full Screen Mode — press F or Esc to exit'); }
  else { appEl.classList.remove('hide-panels'); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }
  setTimeout(() => viewport.resize(), 50);
}
function setRulers(on: boolean) {
  app.prefs.showRulers = on;
  app.savePrefs();
  viewport.setRulers(on);
}
function applyTheme() {
  document.documentElement.dataset.theme = app.prefs.theme;
  viewport.updateTheme();
  app.savePrefs();
}

const menus = buildMenus({
  viewport, setRulers, screenMode: (m) => setScreenMode(m), applyTheme,
  resetWorkspace: () => { document.querySelectorAll('.panel-group').forEach((g) => { (g as HTMLElement).style.display = ''; g.classList.remove('collapsed'); }); appEl.classList.remove('hide-panels'); setScreenMode(0); toast('Workspace reset'); },
  shortcutsDialog: () => shortcutsDialog(),
});
const titleText = h('span', { class: 'title-text' });
const menubar = buildMenubar(menus, [h('div', { class: 'app-badge', title: `${APP_NAME} — ${SUITE_NAME}` }, 'Ph')], [titleText]);
const optionsbar = buildOptionsBar();
const toolbar = buildToolbar(() => setScreenMode());

// document tabs
const tabs = h('div', { class: 'doc-tabs' });
function renderTabs() {
  clear(tabs);
  for (const d of app.docs) {
    const L = d.active;
    const label = `${d.name}${d.isDirty ? '*' : ''} @ ${Math.round(d.zoom * 1000) / 10}% (${d.quickMask ? 'Quick Mask' : L ? (d.editMask && L.mask ? `${L.name}, Layer Mask` : L.name) : ''}, RGB/8)`;
    const close = h('button', { class: 'doc-tab-close', title: 'Close' }, icon('close', 10));
    close.addEventListener('click', (e) => { e.stopPropagation(); io.closeDoc(d); });
    const t = h('div', { class: `doc-tab${d === app.doc ? ' active' : ''}`, title: label }, h('span', { class: 'name' }, label), close);
    t.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); io.closeDoc(d); } else app.setActiveDoc(d); });
    tabs.appendChild(t);
  }
  const d = app.doc;
  titleText.textContent = d ? `${d.name}${d.isDirty ? '*' : ''}` : '';
  document.title = d ? `${d.name}${d.isDirty ? '*' : ''} @ ${Math.round(d.zoom * 100)}% - ${APP_NAME}` : `${APP_NAME} — ${SUITE_NAME}`;
}

// status bar
const zoomField = numberInput({ value: 100, min: 1, max: 3200, step: 1, decimals: 2, unit: '%', width: 56, onChange: (v) => viewport.setZoom(v / 100) });
zoomField.input.classList.add('zoom-input');
const docInfo = h('span');
const toolHint = h('span', { style: { marginLeft: 'auto', color: 'var(--text-3)' } });
const status = h('div', { class: 'statusbar' }, zoomField.el, docInfo, toolHint);
function renderStatus() {
  const d = app.doc;
  zoomField.set(d ? Math.round(d.zoom * 10000) / 100 : 100);
  docInfo.textContent = d ? `${d.width} px × ${d.height} px (${d.resolution} ppi)   Doc: ${fmtBytes(d.width * d.height * 4)}/${fmtBytes(d.width * d.height * 4 * d.layers.length)}` : '';
  const t = currentTool();
  toolHint.textContent = t ? t.name : '';
}

// welcome screen
const welcome = h('div', { class: 'welcome' });
function renderWelcome() {
  clear(welcome);
  welcome.style.display = app.docs.length ? 'none' : 'flex';
  if (app.docs.length) return;
  const presets = [
    { n: 'Default', w: 1920, h: 1080 }, { n: 'Square', w: 2048, h: 2048 }, { n: 'Instagram Story', w: 1080, h: 1920 },
    { n: 'A4 @300ppi', w: 2480, h: 3508 }, { n: 'YouTube Thumb', w: 1280, h: 720 }, { n: '4K UHD', w: 3840, h: 2160 },
  ];
  const recent = io.recentFiles().filter((r) => r.path && io.isElectron).slice(0, 6);
  welcome.append(
    h('h1', null, h('div', { class: 'app-badge' }, 'Ph'), `Welcome to ${APP_NAME}`),
    h('div', { class: 'hint' }, `${SUITE_NAME} · free, open source, and fully offline — no account needed.`),
    h('div', { class: 'actions' },
      h('button', { class: 'big-btn', onclick: () => io.newDocumentDialog() }, icon('new-doc', 30), 'New file', h('span', { class: 'hint' }, displayShortcut('Ctrl+N'))),
      h('button', { class: 'big-btn', onclick: () => io.openFiles() }, icon('open', 30), 'Open', h('span', { class: 'hint' }, displayShortcut('Ctrl+O')))),
    h('div', { class: 'presets' }, ...presets.map((p) => h('button', {
      class: 'preset', onclick: () => io.newDocument({ name: `Untitled-${app.untitledCounter++}`, width: p.w, height: p.h, resolution: 72, background: 'white' }),
    }, h('b', null, p.n), `${p.w} × ${p.h} px`))),
    recent.length ? h('div', { class: 'col', style: { alignItems: 'center' } }, h('div', { class: 'hint' }, 'Recent'),
      ...recent.map((r) => h('a', { href: '#', style: { color: 'var(--accent-2)' }, onclick: (e: Event) => { e.preventDefault(); io.openPath(r.path!); } }, r.name))) : '',
    h('div', { class: 'hint' }, 'Tip: drag & drop images or PSD files anywhere in this window, or paste an image with Ctrl+V.'));
}

const dropHint = h('div', { class: 'drop-hint' }, 'Drop to open — or drop onto an open document to place it as a layer');
const canvasHost = h('div', { style: { position: 'relative', flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } }, viewport.el, welcome, dropHint);
viewport.el.style.flex = '1';
const docarea = h('div', { class: 'docarea' }, tabs, canvasHost, status);

// panels
const dock = h('div', { class: 'dock' },
  panelGroup([colorPanel, swatchesPanel, gradientsPanel], { height: 232 }),
  panelGroup([propertiesPanel, adjustmentsPanel], { height: 250 }),
  panelGroup([layersPanel, channelsPanel, pathsPanel], { grow: true }));
const strip = iconStrip([[historyPanel], [navigatorPanel, infoPanel, histogramPanel], [characterPanel, paragraphPanel], [brushesPanel, brushSettingsPanel]]);

appEl.append(menubar, optionsbar, h('div', { class: 'main' }, toolbar, docarea, strip, dock));
setRulers(app.prefs.showRulers);

bus.on('docs', () => { renderTabs(); renderStatus(); renderWelcome(); });
bus.on('layers', renderTabs);
bus.on('history', renderTabs);
bus.on('view', () => { renderTabs(); renderStatus(); });
bus.on('tool', renderStatus);
renderTabs(); renderStatus(); renderWelcome();

// ---------- canvas context menu ----------
viewport.onContextMenu = (p) => {
  const d = app.doc;
  if (!d) return;
  const items: CtxItem[] = d.selection ? [
    { label: 'Deselect', action: () => sel.deselect() },
    { label: 'Select Inverse', action: () => sel.inverse() },
    { label: 'Feather...', action: () => sel.modifyDialog('feather') },
    { label: 'Select and Mask...', action: () => sel.selectAndMaskDialog() },
    { label: 'Transform Selection', action: () => TransformTool.startSelection() },
    { sep: true, label: '' },
    { label: 'Save Selection...', action: () => sel.saveSelectionDialog() },
    { sep: true, label: '' },
    { label: 'Layer via Copy', action: () => lay.layerVia(false) },
    { label: 'Layer via Cut', action: () => lay.layerVia(true) },
    { label: 'New Layer...', action: () => lay.newLayerDialog() },
    { sep: true, label: '' },
    { label: 'Free Transform', action: () => edit.startTransform() },
    { label: 'Fill...', action: () => edit.fillDialog() },
    { label: 'Stroke...', action: () => edit.strokeDialog() },
    { label: 'Content-Aware Fill...', action: () => edit.contentAwareFill() },
  ] : [
    { label: 'Select All', action: () => sel.selectAll() },
    { label: 'Paste', action: () => edit.paste() },
    { sep: true, label: '' },
    { label: 'New Layer...', action: () => lay.newLayerDialog() },
    { label: 'Duplicate Layer', action: () => lay.duplicateLayer() },
    { label: 'Free Transform', action: () => edit.startTransform() },
    { label: 'Flip Horizontal', action: () => edit.transformImmediate('flipH') },
    { label: 'Flip Vertical', action: () => edit.transformImmediate('flipV') },
    { sep: true, label: '' },
    { label: 'Fill...', action: () => edit.fillDialog() },
  ];
  contextMenu((p.e as MouseEvent).clientX, (p.e as MouseEvent).clientY, items);
};

// ---------- keyboard ----------
const shortcuts = collectShortcuts(menus);
let pasteFallback = 0;
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
};
window.addEventListener('keydown', (e) => {
  if (isDialogOpen() || isTyping(e.target)) return;
  const tool = currentTool();
  const combo = eventCombo(e);
  // a busy tool (transform, crop, text, polygon lasso...) gets keys first
  if (tool && (tool.busy || ['Arrow', 'Delete', 'Backspace'].some((k) => e.key.startsWith(k)) || e.key === 'Enter' || e.key === 'Escape')) {
    if (tool.keydown(e, viewport)) { e.preventDefault(); return; }
  }
  if (e.code === 'Space' && !e.repeat) {
    if (!viewport.tempTool) {
      viewport.tempTool = e.ctrlKey || e.metaKey ? getTool('zoom') : e.altKey ? getTool('zoom') : getTool('hand');
      if (viewport.tempTool && e.altKey) (viewport.tempTool as any).zoomOut = true;
      viewport.updateCursor();
    }
    e.preventDefault();
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); return; }
  if (combo === 'Ctrl+V') {
    // the paste event carries images from other apps; fall back if the shell doesn't send one
    clearTimeout(pasteFallback);
    pasteFallback = window.setTimeout(() => edit.paste(false), 150);
    return;
  }
  // arrow keys nudge the selection outline while a selection tool is active
  if (e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey && tool && ['marquee', 'lasso', 'wand'].includes(tool.group) && app.doc?.selection) {
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    sel.nudgeSelection(e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
    return;
  }
  const item = shortcuts.get(combo);
  if (item) {
    e.preventDefault();
    if (!item.enabled || item.enabled()) item.action?.();
    return;
  }
  const d = app.doc;
  // modifier combos not in menus
  if (combo === 'Alt+Backspace' || combo === 'Alt+Delete') { e.preventDefault(); edit.fillWith('fg'); return; }
  if (combo === 'Ctrl+Backspace' || combo === 'Ctrl+Delete') { e.preventDefault(); edit.fillWith('bg'); return; }
  if (combo === 'Alt+Shift+Backspace') { e.preventDefault(); edit.fillWith('fg', 1, 'normal', true); return; }
  if (/^Ctrl\+[2-5]$/.test(combo) && d) { e.preventDefault(); d.channelView = (['rgb', 'r', 'g', 'b'] as const)[Number(combo.slice(-1)) - 2]; d.invalidate(); bus.emit('channels', d); return; }
  if (combo === 'Ctrl+Tab' || combo === 'Ctrl+Shift+Tab') {
    e.preventDefault();
    if (app.docs.length > 1 && d) { const i = app.docs.indexOf(d); app.setActiveDoc(app.docs[(i + (e.shiftKey ? -1 : 1) + app.docs.length) % app.docs.length]); }
    return;
  }
  if (e.ctrlKey || e.metaKey || (e.altKey && e.key !== 'Alt')) return;
  // single keys
  const k = e.key;
  if (k === 'Tab') { e.preventDefault(); appEl.classList.toggle('hide-panels'); setTimeout(() => viewport.resize(), 30); return; }
  if (k === 'Escape' && screenMode === 2) { setScreenMode(0); return; }
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); edit.clearSelection(); return; }
  if (k === '[' || k === ']' || k === '{' || k === '}') {
    const t = tool;
    if (!t) return;
    if (k === '{' || k === '}') { if (t.hardness !== null) t.hardness = (t.hardness ?? 0) + (k === '}' ? 0.25 : -0.25); }
    else if (t.size !== null) {
      const s = t.size ?? 10;
      const step = s < 10 ? 1 : s < 100 ? 10 : s < 200 ? 25 : s < 300 ? 50 : 100;
      t.size = Math.max(1, s + (k === ']' ? step : -step));
    }
    viewport.requestRender();
    return;
  }
  if (/^[0-9]$/.test(k) && tool instanceof BrushBase) {
    tool.setOpts({ opacity: k === '0' ? 1 : Number(k) / 10 });
    toast(`Opacity ${k === '0' ? 100 : Number(k) * 10}%`, 900);
    return;
  }
  if (k === '\\' && d) { d.maskOverlay = !d.maskOverlay; d.invalidate(); return; }
  const up = k.toUpperCase();
  if (up === 'D' && !e.shiftKey) { app.resetColors(); return; }
  if (up === 'X' && !e.shiftKey) { app.swapColors(); return; }
  if (up === 'Q' && !e.shiftKey) { sel.toggleQuickMask(); return; }
  if (up === 'F' && !e.shiftKey) { setScreenMode(); return; }
  if (/^[A-Z]$/.test(up)) {
    if (tool?.busy) tool.commit();
    toolByKey(up, e.shiftKey);
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && viewport.tempTool) {
    (viewport.tempTool as any).zoomOut = false;
    viewport.tempTool = null;
    viewport.updateCursor();
  }
  currentTool()?.keyup(e, viewport);
});
window.addEventListener('blur', () => { viewport.tempTool = null; });

// paste images from the system clipboard
document.addEventListener('paste', (e) => {
  clearTimeout(pasteFallback);
  if (isDialogOpen() || isTyping(e.target)) return;
  if (edit.handlePasteEvent(e)) { e.preventDefault(); return; }
  edit.paste(false);
});

// ---------- drag & drop ----------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; dropHint.classList.add('show'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropHint.classList.remove('show'); });
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  dragDepth = 0;
  dropHint.classList.remove('show');
  const files = Array.from(e.dataTransfer.files);
  const overCanvas = viewport.el.contains(e.target as Node) && !!app.doc;
  for (const f of files) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    const data = await f.arrayBuffer();
    if (overCanvas && ext !== 'psd' && ext !== 'phtn') {
      try {
        const bmp = await createImageBitmap(new Blob([data]));
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d')!.drawImage(bmp, 0, 0);
        edit.pasteCanvas(c, undefined, f.name.replace(/\.[^.]+$/, ''));
      } catch { await io.openFileData(f.name, data); }
    } else await io.openFileData(f.name, data, undefined, (f as any).path || undefined);
  }
});

// ---------- unsaved changes ----------
window.addEventListener('beforeunload', (e) => {
  if (app.docs.some((d) => d.isDirty)) { e.preventDefault(); e.returnValue = ''; }
});

// Electron: files passed on the command line / "Open with"
const nativeBridge = (window as any).photonNative;
nativeBridge?.onOpenPaths?.((paths: string[]) => paths.forEach((p) => io.openPath(p)));

// ---------- shortcuts dialog ----------
function shortcutsDialog() {
  const rows: HTMLElement[] = [];
  rows.push(h('h4', null, 'Tools'));
  const seen = new Set<string>();
  for (const t of TOOLS) {
    if (!t.key || t.group === 'transform-hidden') continue;
    rows.push(h('span', null, t.name), h('span', { class: 'kbd' }, t.key));
    seen.add(t.id);
  }
  rows.push(h('h4', null, 'Menus'));
  for (const [combo, it] of shortcuts) rows.push(h('span', null, it.label ?? ''), h('span', { class: 'kbd' }, displayShortcut(combo)));
  rows.push(h('h4', null, 'Other'));
  const other: [string, string][] = [
    ['Hand tool (temporary)', 'Space'], ['Zoom in (temporary)', 'Ctrl+Space'], ['Brush size', '[  ]'], ['Brush hardness', 'Shift+[  ]'],
    ['Opacity of painting tools', '1 … 0'], ['Default colors', 'D'], ['Swap colors', 'X'], ['Quick Mask', 'Q'], ['Screen mode', 'F'],
    ['Hide panels', 'Tab'], ['Fill with foreground', 'Alt+Backspace'], ['Fill with background', 'Ctrl+Backspace'],
    ['Sample color while painting', 'Alt+click'], ['Straight line', 'Shift+click'], ['Next document', 'Ctrl+Tab'],
    ['Channels RGB/R/G/B', 'Ctrl+2…5'], ['Mask overlay', '\\'], ['Nudge (Move tool)', 'Arrows / Shift+Arrows'],
  ];
  for (const [a, b] of other) rows.push(h('span', null, a), h('span', { class: 'kbd' }, displayShortcut(b)));
  openDialog({ title: 'Keyboard Shortcuts', width: 560, noCancel: true, content: h('div', { class: 'shortcut-table' }, ...rows) });
}

// keep theme-dependent canvases in sync
bus.on('tool', () => viewport.updateCursor());
window.addEventListener('resize', () => viewport.resize());
showPanel('layers');
(window as any).photon = { app, setTool, io };
console.log(`${APP_NAME} ready`);
