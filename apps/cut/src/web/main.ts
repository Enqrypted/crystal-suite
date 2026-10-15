// Cut — a Vegas-style video editor. This file builds the window: menus, toolbar, timeline, docked panels,
// transport, keyboard shortcuts and file handling.
import './styles.css';
import { store } from './core/store';
import { media } from './core/media';
import { transport } from './core/playback';
import * as edit from './core/edit';
import * as project from './core/project';
import { native, fileName } from './core/native';
import { clipEnd, projectEnd, snapToFrame, type MediaItem } from './core/model';
import { timecode, parseTime } from './core/timecode';
import { h, isTyping, clamp } from './ui/dom';
import { icon } from './ui/icons';
import { buildMenubar, comboOf, findShortcut, type MenuItem, type TopMenu } from './ui/menu';
import { Timeline } from './ui/timeline';
import { TrackHeaders } from './ui/trackheaders';
import { Preview } from './ui/preview';
import { MediaBin } from './ui/mediabin';
import { Properties } from './ui/properties';
import { Generators } from './ui/generators';
import { Master } from './ui/master';
import { Slider } from './ui/slider';
import * as dialogs from './ui/dialogs';
import { modal, confirm, alertBox, toast } from './ui/dialog';

const app = document.getElementById('app')!;

// ---------- panels ----------
const timeline = new Timeline();
const headers = new TrackHeaders(timeline);
const preview = new Preview();
const bin = new MediaBin();
const props = new Properties();
const gens = new Generators();
const master = new Master();

// ---------- file actions ----------
async function confirmDiscard() {
  if (!store.dirty) return true;
  const v = await modal('Save changes?', h('div', { style: 'color:var(--dim)' }, `Do you want to save the changes to "${store.project.name}"?`), [
    { label: "Don't Save", value: 'discard' }, { label: 'Cancel', value: '' }, { label: 'Save', value: 'save', primary: true },
  ]);
  if (v === 'save') return project.save().catch((e) => { alertBox('Save failed', e.message); return false; });
  return v === 'discard';
}
async function newProject() {
  if (!(await confirmDiscard())) return;
  transport.pause();
  project.newDocument();
  native.autosave(null);
}
async function openProject(path?: string | null) {
  if (!(await confirmDiscard())) return;
  path ??= await native.openProject();
  if (!path) return;
  transport.pause();
  try {
    await project.open(path);
    timeline.zoomFit();
    status(`Opened ${fileName(path)}`);
  } catch (e) { alertBox('Open Project', (e as Error).message); }
}
async function save(as = false) {
  try { if (await project.save(as)) status(`Saved ${store.path}`); } catch (e) { alertBox('Save failed', (e as Error).message); }
}

/** Imports files; with `place`, also puts them on the timeline at a time/track. */
async function importMedia(paths?: string[], place?: { at: number; trackId: string | null }) {
  paths ??= await native.openMedia();
  if (!paths?.length) return;
  status(`Importing ${paths.length} file${paths.length === 1 ? '' : 's'}…`);
  const wasEmpty = !store.project.clips.length && !store.project.media.length;
  const { items, failed } = await media.import(paths);
  if (failed.length) alertBox('Some files could not be imported', failed.map((f) => `${fileName(f.path)} — ${f.error}`).join('\n'));
  if (!items.length) { status('Nothing imported'); return; }
  if (place) edit.addMedia(items, place.at, place.trackId);
  else { edit.addToBin(items); showTab('media'); toast(`Imported ${items.length} item${items.length === 1 ? '' : 's'} — drag to the timeline or double-click to add at the cursor.`); }
  status(`Imported ${items.length} item${items.length === 1 ? '' : 's'}`);
  if (wasEmpty) await offerMatch(items);
  if (place && wasEmpty) timeline.zoomFit();
}

/** Like Vegas: offer to match the project to the first video's size and frame rate. */
async function offerMatch(items: MediaItem[]) {
  const v = items.find((m) => m.kind === 'video' && m.width && m.height);
  const p = store.project;
  if (!v) return;
  const fps = Math.round(v.fps * 1000) / 1000;
  if (v.width === p.width && v.height === p.height && Math.abs(fps - p.fps) < 0.01) return;
  const ok = await confirm('Match project settings?', `Set the project to match "${v.name}": ${v.width}×${v.height} at ${+fps.toFixed(3)} fps? (Currently ${p.width}×${p.height}, ${+p.fps.toFixed(3)} fps.)`, 'Match', 'Keep');
  if (ok) edit.matchProject(v);
}

// ---------- navigation helpers ----------
const frame = () => 1 / store.project.fps;
const stepFrames = (n: number) => transport.seek(Math.max(0, snapToFrame(store.time, store.project.fps) + n * frame()));
function editPoints() {
  const p = store.project;
  const pts = new Set<number>([0, projectEnd(p)]);
  for (const c of p.clips) { pts.add(c.start); pts.add(clipEnd(c)); }
  for (const m of p.markers) pts.add(m.time);
  return [...pts].sort((a, b) => a - b);
}
const nextEdit = () => { const t = editPoints().find((x) => x > store.time + 1e-4); if (t !== undefined) { transport.seek(t); timeline.reveal(t); } };
const prevEdit = () => { const t = editPoints().reverse().find((x) => x < store.time - 1e-4); if (t !== undefined) { transport.seek(t); timeline.reveal(t); } };
function setLoopEdge(which: 'start' | 'end') {
  const p = store.project;
  const t = snapToFrame(store.time, p.fps);
  const cur = p.loop ?? { start: which === 'start' ? t : 0, end: which === 'end' ? t : projectEnd(p) };
  if (which === 'start') edit.setLoop(t, Math.max(t, cur.end)); else edit.setLoop(Math.min(t, cur.start), t);
}

// ---------- menus ----------
const sel = () => store.selection.size > 0;
const hasClips = () => store.project.clips.length > 0;
const toggleView = (k: 'snapping' | 'quantize' | 'ripple' | 'thumbnails' | 'waveforms' | 'loop') => () => store.setView(k, !store.view[k]);
let recent: string[] = [];
const menus: TopMenu[] = [
  {
    label: 'File', items: () => [
      { label: 'New Project', key: 'Ctrl+N', run: newProject },
      { label: 'Open Project…', key: 'Ctrl+O', run: () => openProject() },
      { label: 'Recent Projects', enabled: () => recent.length > 0, submenu: () => recent.map((r) => ({ label: fileName(r), run: () => openProject(r) })) },
      { sep: true },
      { label: 'Save', key: 'Ctrl+S', run: () => save() },
      { label: 'Save As…', key: 'Ctrl+Shift+S', run: () => save(true) },
      { sep: true },
      { label: 'Import Media…', key: 'Ctrl+I', run: () => importMedia() },
      { label: 'Render As…', key: 'Ctrl+M', enabled: hasClips, run: () => dialogs.renderAs() },
      { sep: true },
      { label: 'Project Properties…', key: 'Alt+Enter', run: () => dialogs.projectProperties() },
      { sep: true },
      { label: 'Exit', key: 'Alt+F4', run: () => window.close() },
    ],
  },
  {
    label: 'Edit', items: () => [
      { label: `Undo ${store.undoLabel}`.trim(), key: 'Ctrl+Z', enabled: () => !!store.undoLabel, run: () => store.undo() },
      { label: `Redo ${store.redoLabel}`.trim(), key: 'Ctrl+Y / Ctrl+Shift+Z', enabled: () => !!store.redoLabel, run: () => store.redo() },
      { sep: true },
      { label: 'Cut', key: 'Ctrl+X', enabled: sel, run: () => edit.cutSelection() },
      { label: 'Copy', key: 'Ctrl+C', enabled: sel, run: () => edit.copySelection() },
      { label: 'Paste', key: 'Ctrl+V', run: () => edit.paste() },
      { label: 'Delete', key: 'Delete', enabled: sel, run: () => edit.deleteSelection() },
      { sep: true },
      { label: 'Split', key: 'S', enabled: hasClips, run: () => edit.split() },
      { label: 'Select All', key: 'Ctrl+A', run: () => edit.selectAll() },
      { label: 'Deselect', key: 'Escape', run: () => store.clearSelection() },
      { sep: true },
      { label: 'Group', key: 'G', enabled: () => store.selection.size > 1, run: () => edit.groupSelection() },
      { label: 'Ungroup', key: 'U', enabled: sel, run: () => edit.ungroupSelection() },
      { label: 'Normalize Audio', enabled: sel, run: () => edit.normalizeSelection() },
      { sep: true },
      { label: 'Auto Ripple', key: 'Ctrl+L', checked: () => store.view.ripple, run: toggleView('ripple') },
      { label: 'Enable Snapping', key: 'F8', checked: () => store.view.snapping, run: toggleView('snapping') },
      { label: 'Quantize to Frames', key: 'Ctrl+F8', checked: () => store.view.quantize, run: toggleView('quantize') },
    ],
  },
  {
    label: 'View', items: () => [
      { label: 'Zoom In', key: 'ArrowUp', run: () => timeline.zoom(1.5) },
      { label: 'Zoom Out', key: 'ArrowDown', run: () => timeline.zoom(1 / 1.5) },
      { label: 'Zoom to Fit', key: '`', run: () => timeline.zoomFit() },
      { sep: true },
      { label: 'Event Thumbnails', checked: () => store.view.thumbnails, run: toggleView('thumbnails') },
      { label: 'Audio Waveforms', checked: () => store.view.waveforms, run: toggleView('waveforms') },
      { label: 'Preview Quality', submenu: () => (['auto', 'full', 'half', 'quarter'] as const).map((q) => ({ label: { auto: 'Auto', full: 'Best (Full)', half: 'Good (Half)', quarter: 'Draft (Quarter)' }[q], checked: () => store.view.previewQuality === q, run: () => store.setView('previewQuality', q) })) },
      { sep: true },
      { label: 'Project Media', run: () => showTab('media') },
      { label: 'Properties', run: () => showTab('props') },
      { label: 'Generators & Transitions', run: () => showTab('gens') },
    ],
  },
  {
    label: 'Insert', items: () => [
      { label: 'Video Track', key: 'Ctrl+Shift+Q', run: () => edit.insertTrack('video') },
      { label: 'Audio Track', key: 'Ctrl+Q', run: () => edit.insertTrack('audio') },
      { sep: true },
      { label: 'Marker', key: 'M', run: () => edit.addMarker() },
      { sep: true },
      { label: 'Text', run: () => edit.addGenerator('text') },
      { label: 'Solid Color', run: () => edit.addGenerator('solid') },
      { label: 'Gradient', run: () => edit.addGenerator('gradient') },
    ],
  },
  {
    label: 'Playback', items: () => [
      { label: transport.playing ? 'Stop' : 'Play', key: 'Space', enabled: hasClips, run: () => transport.toggle() },
      { label: 'Play / Pause', key: 'Enter', enabled: hasClips, run: () => transport.togglePause() },
      { label: 'Loop Playback', key: 'Q', checked: () => store.view.loop, run: toggleView('loop') },
      { sep: true },
      { label: 'Go to Start', key: 'Home', run: () => transport.seek(0) },
      { label: 'Go to End', key: 'End', run: () => transport.seek(projectEnd(store.project)) },
      { label: 'Previous Edit Point', key: 'Ctrl+ArrowLeft', run: prevEdit },
      { label: 'Next Edit Point', key: 'Ctrl+ArrowRight', run: nextEdit },
      { label: 'Previous Frame', key: 'ArrowLeft', run: () => stepFrames(-1) },
      { label: 'Next Frame', key: 'ArrowRight', run: () => stepFrames(1) },
      { sep: true },
      { label: 'Selection Start at Cursor', key: 'I', run: () => setLoopEdge('start') },
      { label: 'Selection End at Cursor', key: 'O', run: () => setLoopEdge('end') },
      { label: 'Clear Time Selection', enabled: () => !!store.project.loop, run: () => edit.setLoop(0, 0) },
    ],
  },
  {
    label: 'Help', items: () => [
      { label: 'Keyboard Shortcuts', key: 'F1', run: () => dialogs.shortcuts() },
      { label: 'About Cut', run: () => dialogs.about() },
    ],
  },
];
// keys handled directly (not shown in menus)
const extraKeys: Record<string, () => void> = {
  J: () => transport.seek(Math.max(0, transport.now() - 1)),
  K: () => transport.pause(),
  L: () => { if (!transport.playing) transport.play(); },
  'Alt+ArrowLeft': () => stepFrames(-1),
  'Alt+ArrowRight': () => stepFrames(1),
  'Ctrl+Shift+Z': () => store.redo(),
  'Shift+ArrowLeft': () => stepFrames(-10),
  'Shift+ArrowRight': () => stepFrames(10),
};

// ---------- layout ----------
const brand = h('div', { class: 'brand' }, h('span', { class: 'badge' }, 'Ct'), 'Cut');
const docName = h('div', { class: 'doc' });
const menubar = buildMenubar(menus, brand, docName);

const tb = (name: string, title: string, run: () => void, extra = '') => {
  const b = h('button', { class: `tb ${extra}`, title, html: icon(name, 17), tabindex: -1 });
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard focus on the editor (Space = play)
  b.addEventListener('click', run);
  return b;
};
const undoBtn = tb('undo', 'Undo (Ctrl+Z)', () => store.undo());
const redoBtn = tb('redo', 'Redo (Ctrl+Y)', () => store.redo());
const snapBtn = tb('magnet', 'Enable snapping (F8)', toggleView('snapping'));
const rippleBtn = tb('ripple', 'Auto ripple (Ctrl+L)', toggleView('ripple'));
const renderBtn = h('button', { class: 'tb primary', title: 'Render As (Ctrl+M)', html: `${icon('render', 17)}Render`, tabindex: -1 });
renderBtn.addEventListener('mousedown', (e) => e.preventDefault());
renderBtn.addEventListener('click', () => dialogs.renderAs());
const toolbar = h('div', { class: 'toolbar' },
  tb('new', 'New project (Ctrl+N)', newProject), tb('open', 'Open project (Ctrl+O)', () => openProject()), tb('save', 'Save (Ctrl+S)', () => save()),
  h('div', { class: 'tb-sep' }),
  tb('import', 'Import media (Ctrl+I)', () => importMedia()),
  h('div', { class: 'tb-sep' }),
  undoBtn, redoBtn,
  h('div', { class: 'tb-sep' }),
  tb('cut', 'Cut (Ctrl+X)', () => edit.cutSelection()), tb('copy', 'Copy (Ctrl+C)', () => edit.copySelection()), tb('paste', 'Paste (Ctrl+V)', () => edit.paste()), tb('trash', 'Delete (Delete)', () => edit.deleteSelection()),
  h('div', { class: 'tb-sep' }),
  tb('split', 'Split at cursor (S)', () => edit.split()), snapBtn, rippleBtn,
  h('div', { class: 'tb-sep' }),
  tb('text', 'Insert text', () => edit.addGenerator('text')), tb('marker', 'Insert marker (M)', () => edit.addMarker()),
  h('div', { class: 'spacer' }),
  tb('gear', 'Project properties (Alt+Enter)', () => dialogs.projectProperties()),
  renderBtn);

// time display (click to type a time)
const timeDisplay = h('div', { class: 'time-display', title: 'Cursor position — click to go to a time' });
timeDisplay.addEventListener('click', () => {
  if (timeDisplay.querySelector('input')) return;
  const input = h('input', { value: timecode(store.time, store.project.fps) }) as HTMLInputElement;
  timeDisplay.textContent = '';
  timeDisplay.append(input);
  input.focus();
  input.select();
  const done = (go: boolean) => {
    const t = parseTime(input.value, store.project.fps);
    input.remove();
    if (go && t !== null) { transport.seek(t); timeline.reveal(t); }
    renderTime();
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(false));
});
const renderTime = () => { if (!timeDisplay.querySelector('input')) timeDisplay.textContent = timecode(store.time, store.project.fps); };

const tlLeft = h('div', { class: 'tl-left' }, timeDisplay, headers.el);
const timelinePane = h('div', { class: 'timeline-pane' }, tlLeft, timeline.el);

// transport bar
const playBtn = tb('play', 'Play (Space)', () => transport.togglePause(), 'play');
const loopBtn = tb('loop', 'Loop playback (Q)', toggleView('loop'));
const selInfo = h('span', { class: 'info' });
const zoomSlider = new Slider({
  value: timeline.pps,
  toPos: (v) => Math.log(v / 0.02) / Math.log(4000 / 0.02),
  fromPos: (pos) => 0.02 * Math.pow(4000 / 0.02, pos),
  format: () => '', reset: 60,
  onInput: (v) => timeline.zoomTo(v),
});
const transportBar = h('div', { class: 'transport' },
  loopBtn,
  tb('start', 'Go to start (Home)', () => transport.seek(0)),
  tb('prev', 'Previous frame (←)', () => stepFrames(-1)),
  playBtn,
  tb('pause', 'Pause (Enter)', () => transport.pause()),
  tb('stop', 'Stop (Space) — returns to the start position', () => transport.stop()),
  tb('next', 'Next frame (→)', () => stepFrames(1)),
  tb('end', 'Go to end (End)', () => transport.seek(projectEnd(store.project))),
  selInfo,
  h('div', { class: 'spacer' }),
  h('div', { class: 'zoom' }, tb('zoomOut', 'Zoom out (↓)', () => timeline.zoom(1 / 1.5)), zoomSlider.el, tb('zoomIn', 'Zoom in (↑)', () => timeline.zoom(1.5)), tb('fit', 'Zoom to fit (`)', () => timeline.zoomFit())));

// dock: tabs on the left, preview in the middle, master meter on the right
const tabDefs = [
  { id: 'media', label: 'Project Media', icon: 'film', body: bin.el },
  { id: 'props', label: 'Properties', icon: 'fx', body: props.el },
  { id: 'gens', label: 'Generators & Transitions', icon: 'transition', body: gens.el },
] as const;
const tabBar = h('div', { class: 'tabs' });
const tabBody = h('div', { class: 'panel-body' });
let activeTab = localStorage.getItem('cut.tab') || 'media';
function showTab(id: string) {
  activeTab = id;
  localStorage.setItem('cut.tab', id);
  tabBar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.id === id));
  tabBody.replaceChildren(tabDefs.find((t) => t.id === id)?.body ?? bin.el);
}
for (const t of tabDefs) {
  const el = h('div', { class: 'tab', html: `${icon(t.icon, 14)}${t.label}` });
  el.dataset.id = t.id;
  el.addEventListener('click', () => showTab(t.id));
  tabBar.append(el);
}
showTab(activeTab);
timeline.onOpenProperties = () => showTab('props');
preview.onFormatClick = () => dialogs.projectProperties();
const leftPanel = h('div', { class: 'panel' }, tabBar, tabBody);
const splitV = h('div', { class: 'splitter-v' });
const dock = h('div', { class: 'dock' }, leftPanel, splitV, preview.el, master.el);
const splitH = h('div', { class: 'splitter-h' });
const main = h('div', { class: 'main' }, dock, splitH, transportBar, timelinePane);

const statusMsg = h('span', { class: 'msg' }, 'Ready');
const statusAudio = h('span');
const statusProject = h('span');
const statusbar = h('div', { class: 'statusbar' }, statusMsg, statusAudio, statusProject);
app.append(menubar, toolbar, main, statusbar);

let statusTimer = 0;
function status(text: string) {
  statusMsg.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => { statusMsg.textContent = 'Ready'; }, 6000);
}

// splitters (sizes remembered)
const savedTop = Number(localStorage.getItem('cut.topH')) || 0;
if (savedTop) main.style.setProperty('--top-h', `${savedTop}px`);
const savedLeft = Number(localStorage.getItem('cut.dockLeft')) || 0;
if (savedLeft) dock.style.setProperty('--dock-left', `${savedLeft}px`);
splitH.addEventListener('pointerdown', (e) => {
  const start = dock.getBoundingClientRect().height;
  const sy = e.clientY;
  splitH.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const hgt = clamp(start + (ev.clientY - sy), 180, main.clientHeight - 230);
    main.style.setProperty('--top-h', `${hgt}px`);
    localStorage.setItem('cut.topH', String(Math.round(hgt)));
  };
  const up = () => { splitH.removeEventListener('pointermove', move); splitH.removeEventListener('pointerup', up); };
  splitH.addEventListener('pointermove', move);
  splitH.addEventListener('pointerup', up);
});
splitV.addEventListener('pointerdown', (e) => {
  const start = leftPanel.getBoundingClientRect().width;
  const sx = e.clientX;
  splitV.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const w = clamp(start + ev.clientX - sx, 260, dock.clientWidth - 360);
    dock.style.setProperty('--dock-left', `${w}px`);
    localStorage.setItem('cut.dockLeft', String(Math.round(w)));
  };
  const up = () => { splitV.removeEventListener('pointermove', move); splitV.removeEventListener('pointerup', up); };
  splitV.addEventListener('pointermove', move);
  splitV.addEventListener('pointerup', up);
});

// ---------- timeline drops ----------
bin.onImport = () => importMedia();
bin.onImportFiles = (paths) => importMedia(paths);
bin.onDragMedia = (ids) => { timeline.dragMedia = ids; };
timeline.onDrop = (e, start, trackId) => {
  const id = e.dataTransfer?.getData('application/x-cut-media');
  if (id) {
    const m = store.project.media.find((x) => x.id === id);
    if (m) edit.addMedia([m], start, trackId);
    timeline.dragMedia = null;
    return;
  }
  const files = [...(e.dataTransfer?.files ?? [])].map((f) => native.pathForFile(f)).filter(Boolean);
  if (files.length) importMedia(files, { at: start, trackId });
};
// files dropped anywhere else go to the bin
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])].map((f) => native.pathForFile(f)).filter(Boolean);
  if (files.length) importMedia(files);
});

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-back') || isTyping()) return;
  const combo = comboOf(e);
  if (combo === 'Space') { e.preventDefault(); transport.toggle(); return; }
  const extra = extraKeys[combo];
  if (extra) { e.preventDefault(); extra(); return; }
  const item: MenuItem | null = findShortcut(menus, combo);
  if (item && item.run && (!item.enabled || item.enabled())) { e.preventDefault(); item.run(); }
});

// ---------- state → chrome ----------
store.on((t) => {
  if (t.has('time')) renderTime();
  if (t.has('project') || t.has('file')) {
    const name = store.project.name || 'Untitled';
    docName.innerHTML = `<b>${name.replace(/[<>&]/g, '')}</b>${store.dirty ? ' •' : ''}`;
    native.setTitle(`${name}${store.dirty ? '*' : ''} - Cut`);
    undoBtn.disabled = !store.undoLabel;
    redoBtn.disabled = !store.redoLabel;
    undoBtn.title = store.undoLabel ? `Undo ${store.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    redoBtn.title = store.redoLabel ? `Redo ${store.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    statusProject.textContent = `${store.project.width}×${store.project.height} · ${+store.project.fps.toFixed(3)} fps · ${timecode(projectEnd(store.project), store.project.fps)}`;
    project.scheduleAutosave();
    transport.projectChanged();
  }
  if (t.has('view')) {
    snapBtn.classList.toggle('on', store.view.snapping);
    rippleBtn.classList.toggle('on', store.view.ripple);
    loopBtn.classList.toggle('on', store.view.loop);
    zoomSlider.set(timeline.pps);
    timeline.invalidate();
  }
  if (t.has('transport')) {
    playBtn.innerHTML = icon(transport.playing ? 'pause' : 'play', 17);
    playBtn.title = transport.playing ? 'Pause (Enter)' : 'Play (Space)';
  }
  if (t.has('selection') || t.has('project')) {
    const n = store.selection.size;
    const loop = store.project.loop;
    selInfo.textContent = [n ? `${n} event${n === 1 ? '' : 's'} selected` : '', loop ? `Selection ${timecode(loop.start, store.project.fps)} – ${timecode(loop.end, store.project.fps)} (${timecode(loop.end - loop.start, store.project.fps)})` : ''].filter(Boolean).join('   ·   ');
  }
  if (t.has('media')) {
    const decoding = store.project.media.map((m) => media.get(m.id)).filter((r) => r?.audioTrack && r.audioProgress < 1);
    statusAudio.textContent = decoding.length ? `Reading audio… ${Math.round((decoding.reduce((a, r) => a + r!.audioProgress, 0) / decoding.length) * 100)}%` : '';
  }
});
store.emit('project', 'view', 'transport', 'time', 'file');

// unsaved changes: the main process asks before closing
window.addEventListener('beforeunload', (e) => {
  if (store.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// files opened from Explorer / the launcher
native.onOpen(async (req) => {
  if (req.project) await openProject(req.project);
  if (req.media?.length) await importMedia(req.media, { at: projectEnd(store.project), trackId: null });
});

// startup: offer recovery, load recent list
(async () => {
  recent = await native.recent();
  const rec = await native.recovery();
  if (rec) {
    const ok = await confirm('Recover project?', 'Cut did not close properly last time. Do you want to recover the unsaved project?', 'Recover', 'Discard');
    if (ok) { await project.recover(rec).catch((e) => alertBox('Recovery failed', e.message)); timeline.zoomFit(); }
  }
  setInterval(async () => { recent = await native.recent(); }, 30000);
})();

// handy for debugging and automated tests
Object.assign(window, { cut: { store, media, transport, edit, project, timeline, preview, importMedia } });
void master; void props; void gens;
