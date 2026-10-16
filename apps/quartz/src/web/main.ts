// Quartz's window: the menu bar, document tabs, toolbar, sidebar and a viewer for each open PDF, plus the
// start screen (open, recent files, common tasks) when nothing is open.
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import './styles.css';
import { DocTab, HIGHLIGHT_COLORS, type Tool } from './doc';
import { Sidebar } from './sidebar';
import { organize } from './organize';
import { signDialog } from './sign';
import { printDoc } from './print';
import { combineDialog, defaultAppDialog, exportImagesDialog, exportText, propertiesDialog, splitDialog } from './tools';
import { icon } from './icons';
import { h, clear, isTyping } from './ui/dom';
import { buildMenubar, comboOf, contextMenu, findShortcut, popup, closeMenus, type MenuItem, type TopMenu } from './ui/menu';
import { modal, alertBox, toast } from './ui/dialog';
import { baseName, native, type Recent } from './native';

// ---------- settings ----------
const settings = {
  sidebar: true, night: false,
  inkColor: '#e5484d', inkThickness: 3, inkOpacity: 1,
  textColor: '#111111', textSize: 14,
  highlightColor: '#FFF16B',
  ...(() => { try { return JSON.parse(localStorage.getItem('quartz.settings') || '{}'); } catch { return {}; } })(),
};
const persist = () => { try { localStorage.setItem('quartz.settings', JSON.stringify(settings)); } catch { /* private storage */ } };

const INK_COLORS = ['#111111', '#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#8e4ec6', '#ffffff'];
const TEXT_COLORS = ['#111111', '#e5484d', '#0090ff', '#30a46c', '#8e4ec6', '#ffffff'];
const HL_COLORS = HIGHLIGHT_COLORS.split(',').map((s) => s.split('=') as [string, string]);
const TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 72];

// ---------- state ----------
const tabs: DocTab[] = [];
let active: DocTab | null = null;
let recent: Recent[] = [];
const has = () => !!active?.pdf;

// ---------- layout ----------
const app = document.getElementById('app')!;
const brand = h('div', { class: 'brand' }, h('span', { class: 'badge' }, 'Qz'), 'Quartz');
const docLabel = h('div', { class: 'doc' });
const tabBar = h('div', { class: 'tabbar' });

const tb = (name: string, title: string, run: () => void, label?: string, cls = '') => {
  const b = h('button', { class: `tb ${cls}`, type: 'button', title, html: icon(name) + (label ? `<span>${label}</span>` : '') }) as HTMLButtonElement;
  b.addEventListener('click', run);
  return b;
};
const sep = () => h('span', { class: 'tb-sep' });

const sidebarBtn = tb('sidebar', 'Sidebar (F4)', () => toggleSidebar());
const prevBtn = tb('up', 'Previous page', () => active?.goTo(active.page - 1));
const nextBtn = tb('down', 'Next page', () => active?.goTo(active.page + 1));
const pageInput = h('input', { class: 'page-in', type: 'text', title: 'Page (Ctrl+G)', spellcheck: 'false' }) as HTMLInputElement;
const pageTotal = h('span', { class: 'page-total' });
const zoomOutBtn = tb('zoomOut', 'Zoom out (Ctrl+-)', () => active?.zoomStep(-1));
const zoomInBtn = tb('zoomIn', 'Zoom in (Ctrl+=)', () => active?.zoomStep(1));
const zoomBtn = h('button', { class: 'tb zoom-btn', type: 'button', title: 'Zoom' }, h('span', {}, '100%'), h('span', { class: 'caret', html: icon('down', 14) })) as HTMLButtonElement;
zoomBtn.addEventListener('click', () => { const r = zoomBtn.getBoundingClientRect(); closeMenus(); popup(zoomItems(), r.left, r.bottom + 4); });

const TOOL_BTNS: [Tool, HTMLButtonElement][] = [
  ['select', tb('select', 'Select text, links and form fields (V)', () => setTool('select'))],
  ['hand', tb('hand', 'Hand: drag to scroll (H)', () => setTool('hand'))],
  ['highlight', tb('highlight', 'Highlight (U)', () => setTool('highlight'), 'Highlight')],
  ['draw', tb('draw', 'Draw (D)', () => setTool('draw'), 'Draw')],
  ['text', tb('text', 'Add text (T)', () => setTool('text'), 'Text')],
  ['image', tb('image', 'Add an image (I)', () => addImage(), 'Image')],
];
const signBtn = tb('sign', 'Sign (S)', () => sign(), 'Sign');
const organizeBtn = tb('organize', 'Organize pages (Ctrl+Shift+O)', () => runOrganize(), 'Organize');
const searchBtn = tb('search', 'Find (Ctrl+F)', () => openFind());
const printBtn = tb('print', 'Print (Ctrl+P)', () => active && printDoc(active));
const undoBtn = tb('undo', 'Undo (Ctrl+Z)', () => active?.undo());
const redoBtn = tb('redo', 'Redo (Ctrl+Y)', () => active?.redo());
const saveBtn = tb('save', 'Save (Ctrl+S)', () => save(), 'Save', 'save-btn');

const toolbar = h('div', { class: 'toolbar' },
  h('div', { class: 'tb-left' }, sidebarBtn, sep(), prevBtn, nextBtn, pageInput, pageTotal, sep(), zoomOutBtn, zoomBtn, zoomInBtn),
  h('div', { class: 'tb-center' }, TOOL_BTNS[0][1], TOOL_BTNS[1][1], sep(), ...TOOL_BTNS.slice(2).map(([, b]) => b), signBtn),
  h('div', { class: 'tb-right' }, organizeBtn, searchBtn, printBtn, sep(), undoBtn, redoBtn, saveBtn));
const optbar = h('div', { class: 'optbar', hidden: true });

const sidebar = new Sidebar();
const stack = h('div', { class: 'stack' });
const home = h('div', { class: 'home' });
// find bar
const findInput = h('input', { type: 'text', placeholder: 'Find in document', spellcheck: 'false' }) as HTMLInputElement;
const findCount = h('span', { class: 'find-count' });
const caseBtn = h('button', { class: 'tb tiny', type: 'button', title: 'Match case' }, 'Aa') as HTMLButtonElement;
const wordBtn = h('button', { class: 'tb tiny', type: 'button', title: 'Whole words only', html: '<u>ab</u>' }) as HTMLButtonElement;
const findbar = h('div', { class: 'findbar', hidden: true }, h('span', { class: 'find-ic', html: icon('search', 16) }), findInput, findCount, caseBtn, wordBtn,
  tb('up', 'Previous (Shift+Enter)', () => find(true, true)), tb('down', 'Next (Enter)', () => find(true)), tb('close', 'Close (Esc)', () => closeFind()));
const viewer = h('div', { class: 'viewer' }, stack, home, findbar);
const main = h('div', { class: 'main' }, sidebar.el, viewer);
const dropHint = h('div', { class: 'drop-hint' }, h('div', {}, icon('file', 40), h('b', {}, 'Drop to open')));

// ---------- menus ----------
const menus: TopMenu[] = [
  {
    label: 'File', items: () => [
      { label: 'Open…', key: 'Ctrl+O', run: openDialog },
      { label: 'Open recent', enabled: () => recent.length > 0, submenu: () => [
        ...recent.slice(0, 12).map((r): MenuItem => ({ label: r.name, run: () => openPaths([r.path]) })),
        { sep: true }, { label: 'Clear list', run: async () => { for (const r of recent) await native.removeRecent(r.path); await loadRecent(); } },
      ] },
      { sep: true },
      { label: 'Save', key: 'Ctrl+S', enabled: has, run: () => save() },
      { label: 'Save as…', key: 'Ctrl+Shift+S', enabled: has, run: () => save(active, true) },
      { label: 'Export pages as images…', enabled: has, run: () => exportImagesDialog(active!) },
      { label: 'Save text as…', enabled: has, run: () => exportText(active!) },
      { sep: true },
      { label: 'Print…', key: 'Ctrl+P', enabled: has, run: () => printDoc(active!) },
      { sep: true },
      { label: 'Properties…', key: 'Ctrl+D', enabled: has, run: () => propertiesDialog(active!) },
      { label: 'Show in folder', enabled: () => !!active?.path, run: () => native.showInFolder(active!.path!) },
      { sep: true },
      { label: 'Close tab', key: 'Ctrl+W / Ctrl+F4', enabled: () => !!active, run: () => closeTab(active!) },
      { label: 'Exit', run: () => window.close() },
    ],
  },
  {
    label: 'Edit', items: () => [
      { label: 'Undo', key: 'Ctrl+Z', enabled: () => !!active?.canUndo, run: () => active?.undo() },
      { label: 'Redo', key: 'Ctrl+Y / Ctrl+Shift+Z', enabled: () => !!active?.canRedo, run: () => active?.redo() },
      { sep: true },
      { label: 'Copy', key: 'Ctrl+C', enabled: () => !!selectedText(), run: () => document.execCommand('copy') },
      { label: 'Highlight selection', enabled: () => has() && !!selectedText(), run: () => highlightSelection() },
      { sep: true },
      { label: 'Find…', key: 'Ctrl+F', enabled: has, run: () => openFind() },
      { label: 'Find next', key: 'F3', enabled: () => has() && !!findInput.value, run: () => find(true) },
      { label: 'Find previous', key: 'Shift+F3', enabled: () => has() && !!findInput.value, run: () => find(true, true) },
      { sep: true },
      { label: 'Go to page…', key: 'Ctrl+G', enabled: has, run: () => { pageInput.focus(); pageInput.select(); } },
    ],
  },
  {
    label: 'View', items: () => [
      { label: 'Sidebar', key: 'F4', checked: () => settings.sidebar, run: () => toggleSidebar() },
      { label: 'Night mode', key: 'Ctrl+Shift+N', checked: () => settings.night, run: () => toggleNight() },
      { sep: true },
      { label: 'Zoom in', key: 'Ctrl+= / Ctrl++', enabled: has, run: () => active?.zoomStep(1) },
      { label: 'Zoom out', key: 'Ctrl+-', enabled: has, run: () => active?.zoomStep(-1) },
      { label: 'Actual size', key: 'Ctrl+1', enabled: has, run: () => active?.setZoom('page-actual') },
      { label: 'Fit width', key: 'Ctrl+2', enabled: has, run: () => active?.setZoom('page-width') },
      { label: 'Fit page', key: 'Ctrl+0', enabled: has, run: () => active?.setZoom('page-fit') },
      { sep: true },
      { label: 'Page layout', enabled: has, submenu: layoutItems },
      { label: 'Rotate view', key: 'Ctrl+R', enabled: has, run: () => active?.rotateView() },
      { sep: true },
      { label: 'First page', key: 'Home', enabled: has, run: () => active?.goTo(1) },
      { label: 'Last page', key: 'End', enabled: has, run: () => active?.goTo(active.pageCount) },
      { sep: true },
      { label: 'Next tab', key: 'Ctrl+Tab', enabled: () => tabs.length > 1, run: () => cycleTab(1) },
      { label: 'Previous tab', key: 'Ctrl+Shift+Tab', enabled: () => tabs.length > 1, run: () => cycleTab(-1) },
    ],
  },
  {
    label: 'Tools', items: () => [
      { label: 'Select', key: 'V', enabled: has, checked: () => active?.tool === 'select', run: () => setTool('select') },
      { label: 'Hand', key: 'H', enabled: has, checked: () => active?.tool === 'hand', run: () => setTool('hand') },
      { label: 'Highlight', key: 'U', enabled: has, checked: () => active?.tool === 'highlight', run: () => setTool('highlight') },
      { label: 'Draw', key: 'D', enabled: has, checked: () => active?.tool === 'draw', run: () => setTool('draw') },
      { label: 'Add text', key: 'T', enabled: has, checked: () => active?.tool === 'text', run: () => setTool('text') },
      { label: 'Add image…', key: 'I', enabled: has, run: () => addImage() },
      { label: 'Sign…', key: 'S', enabled: has, run: () => sign() },
      { sep: true },
      { label: 'Organize pages…', key: 'Ctrl+Shift+O', enabled: has, run: () => runOrganize() },
      { label: 'Combine files…', run: () => combineDialog(active?.pdf ? active : null, openNew) },
      { label: 'Split document…', enabled: has, run: () => splitDialog(active!) },
      { sep: true },
      { label: 'Make Quartz the default PDF app…', run: () => defaultAppDialog() },
    ],
  },
  {
    label: 'Help', items: () => [
      { label: 'Keyboard shortcuts', key: 'F1', run: shortcutsDialog },
      { label: 'About Quartz', run: aboutDialog },
    ],
  },
];

app.append(buildMenubar(menus, brand, docLabel), tabBar, toolbar, optbar, main, dropHint);

// ---------- documents ----------
async function openDialog() {
  const paths = await native.openDialog();
  if (paths.length) await openPaths(paths);
}

async function openPaths(paths: string[]) {
  let first: DocTab | null = null;
  for (const p of paths) {
    const t = await openPath(p);
    first ??= t;
  }
  if (first) activate(first);
  return first;
}

async function openPath(p: string): Promise<DocTab | null> {
  const open = tabs.find((t) => t.path?.toLowerCase() === p.toLowerCase());
  if (open) { activate(open); return open; }
  let bytes: Uint8Array;
  try { bytes = await native.read(p); } catch (e) {
    await alertBox('Couldn’t open', `${baseName(p)} couldn’t be read.\n\n${(e as Error).message}`);
    await native.removeRecent(p);
    loadRecent();
    return null;
  }
  return addTab(bytes, p);
}

/** A new, unsaved document (combined files, extracted pages); `background` keeps the current tab in front. */
function openNew(bytes: Uint8Array, name: string, background = false) {
  addTab(bytes, null, name, { unsaved: true, background });
}

async function addTab(bytes: Uint8Array, path: string | null, name?: string, opts: { unsaved?: boolean; background?: boolean } = {}): Promise<DocTab | null> {
  const t = new DocTab(bytes, path, name);
  t.askPassword = (wrong) => askPassword(t.name, wrong);
  t.onChange = () => { if (t === active) refresh(); else renderTabs(); };
  t.el.tabIndex = -1;
  t.el.classList.add('loading');
  stack.append(t.el);
  tabs.push(t);
  if (opts.background && active) renderTabs();
  else activate(t);
  try {
    await t.start();
  } catch (e) {
    const i = tabs.indexOf(t);
    if (i >= 0) tabs.splice(i, 1);
    if (active === t) activate(tabs[Math.min(i, tabs.length - 1)] ?? null);
    t.destroy();
    renderTabs();
    const msg = String((e as Error)?.message ?? e);
    if (!/destroy|abort|cancel/i.test(msg)) await alertBox('Couldn’t open', `${t.name} isn’t a PDF Quartz can read, or the file is damaged.\n\n${msg}`);
    return null;
  }
  t.el.classList.remove('loading');
  applyDefaults(t);
  if (opts.unsaved) t.pagesChanged = true;
  wireViewer(t);
  if (t.path) native.addRecent({ path: t.path, name: t.name, pages: t.pageCount }).then(loadRecent);
  if (t === active) { t.el.focus({ preventScroll: true }); refresh(); }
  else renderTabs();
  return t;
}

function wireViewer(t: DocTab) {
  t.el.addEventListener('contextmenu', (e) => viewerMenu(e, t));
}

function activate(t: DocTab | null) {
  if (active && active !== t) {
    active.el.classList.remove('active');
    active.park();
    if (!findbar.hidden) closeFind();
  }
  active = t;
  if (t) {
    t.el.classList.add('active');
    t.unpark();
    refit(t);
  }
  home.hidden = !!t;
  if (!t) renderHome();
  refresh();
}

function cycleTab(dir: number) {
  if (tabs.length < 2 || !active) return;
  activate(tabs[(tabs.indexOf(active) + dir + tabs.length) % tabs.length]);
}

async function closeTab(t: DocTab): Promise<boolean> {
  if (t.modified) {
    activate(t);
    const v = await modal('Save changes?', h('div', { class: 'msg' }, `Do you want to save your changes to ${t.name}?`), [
      { label: 'Don’t save', value: 'discard' }, { label: 'Cancel', value: '' }, { label: 'Save', value: 'save', primary: true },
    ]);
    if (!v) return false;
    if (v === 'save' && !(await save(t))) return false;
  }
  const i = tabs.indexOf(t);
  if (i < 0) return true;
  tabs.splice(i, 1);
  if (active === t) activate(tabs[i] ?? tabs[i - 1] ?? null);
  t.destroy();
  renderTabs();
  return true;
}

async function save(t: DocTab | null = active, as = false): Promise<boolean> {
  if (!t?.pdf) return false;
  if (!as && t.path && !t.modified) { toast('No changes to save'); return true; }
  let target = t.path;
  if (as || !target) {
    const suggested = t.path ?? (/\.pdf$/i.test(t.name) ? t.name : `${t.name}.pdf`);
    target = await native.saveDialog(suggested, 'pdf');
    if (!target) return false;
  }
  try {
    const bytes = await t.currentBytes();
    const err = await native.write(target, bytes);
    if (err) throw new Error(err);
    t.saved(bytes, target);
    native.addRecent({ path: target, name: t.name, pages: t.pageCount }).then(loadRecent);
    toast(`Saved ${t.name}`);
    return true;
  } catch (e) {
    await alertBox('Couldn’t save', (e as Error).message);
    return false;
  }
}

function askPassword(name: string, wrong: boolean): Promise<string | null> {
  const input = h('input', { type: 'password', class: 'wide-in', placeholder: 'Password' }) as HTMLInputElement;
  const body = h('div', {}, h('p', { class: `msg${wrong ? ' err' : ''}` }, wrong ? 'That password isn’t right. Try again.' : `${name} is password-protected. Enter its password to open it.`), input);
  return modal('Password required', body, [{ label: 'Cancel', value: '' }, { label: 'Open', value: 'ok', primary: true, disabled: () => !input.value }], { width: 420 })
    .then((v) => (v === 'ok' ? input.value : null));
}

// ---------- tools ----------
function setTool(tool: Tool) {
  const t = active;
  if (!t?.pdf) return;
  t.setTool(tool);
  if (tool !== 'select' && tool !== 'hand') getSelection()?.removeAllRanges();
}

function applyDefaults(t: DocTab) {
  try {
    t.setParam('inkColor', settings.inkColor);
    t.setParam('inkThickness', settings.inkThickness);
    t.setParam('inkOpacity', settings.inkOpacity);
    t.setParam('textColor', settings.textColor);
    t.setParam('textSize', settings.textSize);
    t.setParam('highlightColor', settings.highlightColor);
  } catch { /* editor not available for this document */ }
}

function setParam(kind: 'inkColor' | 'inkThickness' | 'inkOpacity' | 'textColor' | 'textSize' | 'highlightColor', value: string | number) {
  (settings as Record<string, unknown>)[kind] = value;
  persist();
  try { active?.setParam(kind, value); } catch { /* ignore */ }
}

async function addImage() {
  const t = active;
  if (!t?.pdf) return;
  const p = await native.imageDialog();
  if (!p) return;
  const bytes = await native.read(p);
  const ext = (p.split('.').pop() || '').toLowerCase();
  const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  await placePicture(t, new File([bytes as BlobPart], baseName(p), { type }));
}

/** Adds a picture at a sensible size: its pixels at screen resolution, at most about a third of a page wide. */
async function placePicture(t: DocTab, file: File) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  let size: { w: number; h: number } | undefined;
  try {
    await img.decode();
    const w = img.naturalWidth * 0.75, hgt = img.naturalHeight * 0.75;
    const k = Math.min(1, 260 / Math.max(w, hgt, 1));
    if (w && hgt) size = { w: w * k, h: hgt * k };
  } catch { toast('That picture couldn’t be read.'); return; } finally { URL.revokeObjectURL(url); }
  t.addImage(file, size);
  toast('Drag the picture into place — its corners resize it');
}

async function sign() {
  if (active?.pdf) await signDialog(active);
}

async function runOrganize(t: DocTab | null = active) {
  if (!t?.pdf) return;
  if (t.encrypted) { await alertBox('Organize pages', 'This PDF is password-protected, so its pages can’t be rearranged. You can still read, fill and annotate it.'); return; }
  closeFind();
  t.park();
  app.classList.add('organizing');
  await organize(t, main, (bytes, name) => openNew(bytes, name, true));
  app.classList.remove('organizing');
  if (t === active) t.unpark();
  refresh();
}

function selectedText() {
  const s = getSelection();
  return s && !s.isCollapsed ? s.toString().trim() : '';
}

function highlightSelection() {
  try { active?.uiManager?.highlightSelection?.('context_menu'); } catch { /* nothing selected */ }
}

// ---------- find ----------
let matchCase = false;
let wholeWord = false;
function find(again = false, previous = false) {
  const t = active;
  if (!t?.pdf) return;
  if (!findInput.value) { t.closeSearch(); refresh(); return; }
  t.search(findInput.value, { again, previous, caseSensitive: matchCase, entireWord: wholeWord });
}
function openFind() {
  if (!active?.pdf) return;
  findbar.hidden = false;
  const sel = selectedText();
  if (sel && sel.length < 80 && !sel.includes('\n')) { findInput.value = sel; find(); }
  findInput.focus();
  findInput.select();
}
function closeFind() {
  if (findbar.hidden) return;
  findbar.hidden = true;
  active?.closeSearch();
  active?.el.focus({ preventScroll: true });
  refresh();
}
findInput.addEventListener('input', () => find());
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); find(true, e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
caseBtn.addEventListener('click', () => { matchCase = !matchCase; caseBtn.classList.toggle('on', matchCase); find(); });
wordBtn.addEventListener('click', () => { wholeWord = !wholeWord; wordBtn.classList.toggle('on', wholeWord); find(); });

// ---------- view ----------
function toggleSidebar() {
  settings.sidebar = !settings.sidebar;
  persist();
  refresh();
}
function toggleNight() {
  settings.night = !settings.night;
  persist();
  refresh();
}
function refit(t: DocTab | null) {
  if (!t?.pdf || !t.viewer) return;
  const v = t.viewer.currentScaleValue;
  if (v === 'auto' || v === 'page-width' || v === 'page-fit') t.viewer.currentScaleValue = v;
}
let fitTimer = 0;
new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = window.setTimeout(() => refit(active), 60); }).observe(viewer);

function zoomItems(): MenuItem[] {
  const t = active;
  if (!t?.pdf) return [];
  const v = t.viewer.currentScaleValue;
  const named = (label: string, value: 'auto' | 'page-actual' | 'page-fit' | 'page-width') => ({ label, checked: () => v === value, run: () => t.setZoom(value) });
  return [
    named('Automatic', 'auto'), named('Actual size', 'page-actual'), named('Fit page', 'page-fit'), named('Fit width', 'page-width'),
    { sep: true },
    ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => ({ label: `${z * 100}%`, checked: () => String(z) === v, run: () => t.setZoom(z) })),
  ];
}

function layoutItems(): MenuItem[] {
  const t = active;
  if (!t?.pdf) return [];
  const vw = t.viewer as unknown as { scrollMode: number; spreadMode: number };
  const set = (scroll: number, spread: number) => () => { vw.scrollMode = scroll; vw.spreadMode = spread; };
  const is = (scroll: number, spread: number) => () => vw.scrollMode === scroll && vw.spreadMode === spread;
  return [
    { label: 'Continuous', checked: is(0, 0), run: set(0, 0) },
    { label: 'Single page', checked: is(3, 0), run: set(3, 0) },
    { label: 'Two pages', checked: is(0, 1), run: set(0, 1) },
    { label: 'Two pages with cover', checked: is(0, 2), run: set(0, 2) },
    { label: 'Side by side (scroll right)', checked: is(1, 0), run: set(1, 0) },
    { label: 'Wrapped', checked: is(2, 0), run: set(2, 0) },
  ];
}

function viewerMenu(e: MouseEvent, t: DocTab) {
  if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]')) return;
  const text = selectedText();
  const items: MenuItem[] = [];
  if (text) {
    items.push({ label: 'Copy', key: 'Ctrl+C', run: () => document.execCommand('copy') },
      { label: 'Highlight', run: () => highlightSelection() },
      { label: `Find “${text.length > 24 ? `${text.slice(0, 24)}…` : text}”`, run: () => { findInput.value = text; findbar.hidden = false; find(); } },
      { sep: true });
  }
  items.push(
    { label: 'Select tool', checked: () => t.tool === 'select', run: () => setTool('select') },
    { label: 'Hand tool', checked: () => t.tool === 'hand', run: () => setTool('hand') },
    { sep: true },
    { label: 'Zoom in', run: () => t.zoomStep(1) }, { label: 'Zoom out', run: () => t.zoomStep(-1) },
    { label: 'Fit width', run: () => t.setZoom('page-width') }, { label: 'Fit page', run: () => t.setZoom('page-fit') },
    { sep: true },
    { label: 'Rotate view', run: () => t.rotateView() },
    { label: 'Print…', run: () => printDoc(t) },
    { label: 'Properties…', run: () => propertiesDialog(t) },
  );
  contextMenu(e, items);
}

// page box
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const n = parseInt(pageInput.value, 10);
    if (active?.pdf && n > 0) active.goTo(n);
    active?.el.focus({ preventScroll: true });
  } else if (e.key === 'Escape') active?.el.focus({ preventScroll: true });
});
pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('blur', () => refresh());

// ---------- rendering ----------
let lastTitle = '';
function refresh() {
  const t = active;
  app.classList.toggle('empty', !t);
  app.classList.toggle('no-sidebar', !settings.sidebar);
  app.classList.toggle('night', settings.night);
  sidebarBtn.classList.toggle('on', settings.sidebar);
  renderTabs();
  sidebar.update(t?.pdf ? t : null);
  const ready = !!t?.pdf;
  for (const b of [prevBtn, nextBtn, zoomOutBtn, zoomInBtn, zoomBtn, signBtn, organizeBtn, searchBtn, printBtn, saveBtn, ...TOOL_BTNS.map(([, b]) => b)]) b.disabled = !ready;
  pageInput.disabled = !ready;
  if (t && ready) {
    if (document.activeElement !== pageInput) pageInput.value = String(t.page);
    pageTotal.textContent = `/ ${t.pageCount}`;
    prevBtn.disabled = t.page <= 1;
    nextBtn.disabled = t.page >= t.pageCount;
    (zoomBtn.firstChild as HTMLElement).textContent = `${Math.round(t.scale * 100)}%`;
    for (const [tool, b] of TOOL_BTNS) b.classList.toggle('on', t.tool === tool);
    undoBtn.disabled = !t.canUndo;
    redoBtn.disabled = !t.canRedo;
    saveBtn.classList.toggle('primary', t.modified);
  } else {
    pageInput.value = '';
    pageTotal.textContent = '';
    undoBtn.disabled = redoBtn.disabled = true;
    saveBtn.classList.remove('primary');
  }
  renderOptbar();
  renderFindCount();
  docLabel.replaceChildren(...(t ? [h('b', {}, t.name), t.modified ? h('span', { class: 'mod' }, ' • edited') : ''] : []));
  const title = t ? `${t.modified ? '• ' : ''}${t.name} — Quartz` : 'Quartz';
  if (title !== lastTitle) { lastTitle = title; native.setTitle(title); }
}

let tabsSig = '';
function renderTabs() {
  const sig = tabs.map((t) => `${t.id}:${t.name}:${t.modified}:${t === active}:${!!t.pdf}`).join('|');
  if (sig === tabsSig) return;
  tabsSig = sig;
  clear(tabBar);
  for (const t of tabs) {
    const close = h('button', { class: 'dt-close', type: 'button', title: 'Close (Ctrl+W)', html: icon('close', 13) });
    const el = h('div', { class: `dtab${t === active ? ' on' : ''}${t.modified ? ' mod' : ''}`, title: t.path ?? t.name },
      h('span', { class: 'dt-ic', html: icon('file', 15) }), h('span', { class: 'dt-name' }, t.name), h('span', { class: 'dt-dot' }), close);
    el.addEventListener('pointerdown', (e) => { if (e.button === 0 && !(e.target as HTMLElement).closest('.dt-close')) activate(t); });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    close.addEventListener('click', () => closeTab(t));
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Close', run: () => closeTab(t) },
      { label: 'Close other tabs', enabled: () => tabs.length > 1, run: async () => { for (const o of tabs.filter((x) => x !== t)) if (!(await closeTab(o))) break; } },
      { sep: true },
      { label: 'Show in folder', enabled: () => !!t.path, run: () => native.showInFolder(t.path!) },
      { label: 'Copy file path', enabled: () => !!t.path, run: () => navigator.clipboard.writeText(t.path!) },
    ]));
    tabBar.append(el);
  }
  const plus = h('button', { class: 'dt-plus', type: 'button', title: 'Open (Ctrl+O)', html: icon('plus', 16) });
  plus.addEventListener('click', openDialog);
  tabBar.append(plus);
}

let optFor = '';
function renderOptbar() {
  const t = active;
  const tool = t?.pdf && !app.classList.contains('organizing') ? t.tool : null;
  const show = tool === 'highlight' || tool === 'draw' || tool === 'text' || tool === 'image';
  optbar.hidden = !show;
  if (!show || optFor === tool) return;
  optFor = tool!;
  clear(optbar);
  const swatches = (colors: string[], current: () => string, pick: (c: string) => void, titles?: string[]) => {
    const wrap = h('div', { class: 'swatches' });
    const mark = () => wrap.querySelectorAll<HTMLElement>('.sw').forEach((b) => b.classList.toggle('on', b.dataset.c!.toLowerCase() === current().toLowerCase()));
    colors.forEach((c, i) => {
      const b = h('button', { class: 'sw', type: 'button', 'data-c': c, title: titles?.[i] ?? c, style: `--c:${c}` });
      b.addEventListener('click', () => { pick(c); mark(); });
      wrap.append(b);
    });
    mark();
    return wrap;
  };
  const custom = (current: () => string, pick: (c: string) => void) => {
    const inp = h('input', { type: 'color', value: current(), title: 'Any colour' }) as HTMLInputElement;
    inp.addEventListener('input', () => pick(inp.value));
    return inp;
  };
  const slider = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, set: (v: number) => void) => {
    const out = h('span', { class: 'sl-val' }, fmt(value));
    const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
    r.addEventListener('input', () => { out.textContent = fmt(Number(r.value)); set(Number(r.value)); });
    return h('label', { class: 'opt' }, h('span', { class: 'opt-l' }, label), r, out);
  };
  const hint = (s: string) => h('span', { class: 'opt-hint' }, s);
  if (tool === 'highlight') {
    optbar.append(h('span', { class: 'opt-l' }, 'Colour'),
      swatches(HL_COLORS.map(([, c]) => c), () => settings.highlightColor, (c) => setParam('highlightColor', c), HL_COLORS.map(([n]) => n[0].toUpperCase() + n.slice(1))),
      hint('Select text to highlight it, or drag across any part of the page'));
  } else if (tool === 'draw') {
    optbar.append(h('span', { class: 'opt-l' }, 'Colour'),
      swatches(INK_COLORS, () => settings.inkColor, (c) => setParam('inkColor', c)), custom(() => settings.inkColor, (c) => setParam('inkColor', c)),
      slider('Size', 1, 20, 1, settings.inkThickness, (v) => `${v}`, (v) => setParam('inkThickness', v)),
      slider('Opacity', 10, 100, 5, Math.round(settings.inkOpacity * 100), (v) => `${v}%`, (v) => setParam('inkOpacity', v / 100)),
      hint('Drag on the page to draw'));
  } else if (tool === 'text') {
    const size = h('select', {}, ...TEXT_SIZES.map((s) => h('option', { value: String(s), selected: s === settings.textSize }, `${s} pt`))) as HTMLSelectElement;
    size.addEventListener('change', () => setParam('textSize', Number(size.value)));
    optbar.append(h('span', { class: 'opt-l' }, 'Colour'),
      swatches(TEXT_COLORS, () => settings.textColor, (c) => setParam('textColor', c)), custom(() => settings.textColor, (c) => setParam('textColor', c)),
      h('label', { class: 'opt' }, h('span', { class: 'opt-l' }, 'Size'), size),
      hint('Click where the text goes · click outside to finish'));
  } else {
    const more = h('button', { class: 'small-btn', type: 'button' }, 'Add another image…');
    more.addEventListener('click', () => addImage());
    const sig = h('button', { class: 'small-btn', type: 'button' }, 'Add a signature…');
    sig.addEventListener('click', () => sign());
    optbar.append(more, sig, hint('Drag pictures to move them, use the corners to resize, Delete removes the selected one'));
  }
}
function renderFindCount() {
  const f = active?.find;
  findCount.classList.toggle('none', f?.state === 'notfound');
  if (!f || !findInput.value) findCount.textContent = '';
  else if (f.state === 'notfound') findCount.textContent = 'No matches';
  else if (f.state === 'pending' && !f.total) findCount.textContent = 'Searching…';
  else findCount.textContent = f.total ? `${f.current} of ${f.total}${f.state === 'wrapped' ? ' ↻' : ''}` : '';
}

// ---------- start screen ----------
async function loadRecent() {
  recent = await native.recent().catch(() => []);
  if (!active) renderHome();
}

let homeDefault: boolean | null = null;
function renderHome() {
  clear(home);
  const openBtn = h('button', { class: 'btn primary big', type: 'button', html: `${icon('open', 18)}<span>Open a PDF</span>` });
  openBtn.addEventListener('click', openDialog);
  const card = (ic: string, title: string, sub: string, run: () => void) => {
    const c = h('button', { class: 'task', type: 'button' }, h('span', { class: 'task-ic', html: icon(ic, 22) }), h('b', {}, title), h('span', {}, sub));
    c.addEventListener('click', run);
    return c;
  };
  const pickThen = (fn: (t: DocTab) => unknown) => async () => {
    const paths = await native.openDialog();
    if (!paths.length) return;
    const t = await openPaths(paths.slice(0, 1));
    if (t?.pdf) fn(t);
  };
  const recentList = h('div', { class: 'recent' });
  if (!recent.length) recentList.append(h('div', { class: 'recent-empty' }, 'PDFs you open show up here.'));
  for (const r of recent.slice(0, 14)) {
    const dir = r.path.slice(0, r.path.length - baseName(r.path).length).replace(/[\\/]$/, '');
    const x = h('button', { class: 'rc-x', type: 'button', title: 'Remove from list', html: icon('close', 13) });
    const row = h('div', { class: 'rc', title: r.path },
      h('span', { class: 'rc-ic', html: icon('file', 20) }),
      h('span', { class: 'rc-main' }, h('b', {}, r.name), h('span', {}, dir)),
      h('span', { class: 'rc-meta' }, `${r.pages ? `${r.pages} p · ` : ''}${ago(r.at)}`), x);
    row.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.rc-x')) openPaths([r.path]); });
    x.addEventListener('click', async () => { await native.removeRecent(r.path); loadRecent(); });
    recentList.append(row);
  }
  const defaultLink = h('button', { class: 'linkish', type: 'button', hidden: homeDefault !== false }, 'Make Quartz your default PDF app');
  defaultLink.addEventListener('click', () => defaultAppDialog().then(checkDefault));
  home.append(h('div', { class: 'home-in' },
    h('div', { class: 'hero' },
      h('div', { class: 'logo' }, 'Qz'),
      h('div', {}, h('h1', {}, 'Quartz'), h('p', {}, 'Read, fill, sign and edit PDFs — free, on your PC.')),
      h('div', { class: 'hero-actions' }, openBtn, h('span', { class: 'hint' }, 'or drop PDF files anywhere'))),
    h('div', { class: 'tasks' },
      card('sign', 'Fill & sign', 'Fill in forms and add your signature', pickThen((t) => signDialog(t))),
      card('organize', 'Organize pages', 'Reorder, rotate, delete or add pages', pickThen((t) => runOrganize(t))),
      card('merge', 'Combine files', 'Merge several PDFs into one', () => combineDialog(null, openNew)),
      card('split', 'Split a PDF', 'Break a document into smaller files', pickThen((t) => splitDialog(t)))),
    h('div', { class: 'home-h' }, h('span', {}, 'Recent'), defaultLink),
    recentList));
}

async function checkDefault() {
  const s = await native.defaultStatus().catch(() => null);
  homeDefault = s ? s.isDefault || !s.supported : null;
  if (!active) renderHome();
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) { const d = Math.floor(s / 86400); return d === 1 ? 'yesterday' : `${d} days ago`; }
  return new Date(t).toLocaleDateString();
}

// ---------- dialogs ----------
function shortcutsDialog() {
  const rows: [string, string][] = [
    ['Ctrl+O', 'Open'], ['Ctrl+S / Ctrl+Shift+S', 'Save / Save as'], ['Ctrl+P', 'Print'], ['Ctrl+W', 'Close tab'], ['Ctrl+Tab', 'Next tab'],
    ['Ctrl+F, F3', 'Find, find next'], ['Ctrl+G', 'Go to page'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
    ['Ctrl+= / Ctrl+-', 'Zoom in / out'], ['Ctrl+wheel', 'Zoom around the pointer'], ['Ctrl+0 / 1 / 2', 'Fit page / actual size / fit width'],
    ['V / H', 'Select / hand tool'], ['U / D / T', 'Highlight / draw / text'], ['I / S', 'Add image / sign'],
    ['Ctrl+Shift+O', 'Organize pages'], ['F4', 'Sidebar'], ['Ctrl+Shift+N', 'Night mode'], ['Delete', 'Delete the selected annotation'],
  ];
  const grid = h('div', { class: 'keys' });
  for (const [k, d] of rows) grid.append(h('kbd', {}, k), h('span', {}, d));
  modal('Keyboard shortcuts', grid, [{ label: 'Close', value: '', primary: true }], { width: 520 });
}

async function aboutDialog() {
  const a = await native.about().catch(() => null);
  const body = h('div', { class: 'about' },
    h('div', { class: 'logo' }, 'Qz'),
    h('div', {},
      h('h2', {}, 'Quartz'),
      h('p', {}, `Version ${a?.version ?? '?'} · part of Crystal Suite`),
      h('p', { class: 'dim' }, 'A free PDF reader and editor. PDF rendering and annotation by PDF.js (Apache-2.0, Mozilla); page editing by pdf-lib (MIT).'),
      h('p', { class: 'dim' }, `Electron ${a?.electron ?? ''} · Chromium ${a?.chrome ?? ''}`)));
  modal('About Quartz', body, [{ label: 'Close', value: '', primary: true }], { width: 460 });
}

// ---------- keyboard ----------
// keys PDF.js handles itself while an editing tool is on
const EDITOR_KEYS = new Set(['Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Backspace', 'Delete', 'Enter', 'Space', 'Escape',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Ctrl+ArrowLeft', 'Ctrl+ArrowRight', 'Ctrl+ArrowUp', 'Ctrl+ArrowDown']);
// while typing in a field, Ctrl/Alt shortcuts and function keys still work, except the ones that edit text
const TEXT_EDITING = /^Ctrl\+(Shift\+)?(A|C|V|X|Z|Y|Backspace|Delete|Insert|Home|End|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/;
const worksWhileTyping = (e: KeyboardEvent, combo: string) =>
  /^(Shift\+)?F\d+$/.test(combo) || ((e.ctrlKey || e.altKey) && !TEXT_EDITING.test(combo));

addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-back, .organizer')) return;
  const combo = comboOf(e);
  const t = active;
  if (t?.editing && EDITOR_KEYS.has(combo)) {
    // page-level undo/redo still works when PDF.js has nothing to undo
    if (combo === 'Ctrl+Z' && !t.canUndoEdit && t.canUndo) { e.preventDefault(); t.undo(); }
    else if ((combo === 'Ctrl+Y' || combo === 'Ctrl+Shift+Z') && !t.canRedoEdit && t.canRedo) { e.preventDefault(); t.redo(); }
    return;
  }
  if (combo === 'Escape') {
    if (!findbar.hidden) { e.preventDefault(); closeFind(); }
    return;
  }
  if (isTyping() && !worksWhileTyping(e, combo)) return;
  if (combo === 'Ctrl+C') return; // the browser copies the selection
  const item = findShortcut(menus, combo);
  if (item?.run && (item.enabled?.() ?? true)) {
    e.preventDefault();
    item.run();
  }
});

// ---------- drag & drop ----------
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; app.classList.add('dropping'); } });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; app.classList.remove('dropping'); } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  dragDepth = 0;
  app.classList.remove('dropping');
  if (!hasFiles(e)) return;
  const taken = e.defaultPrevented;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name)).map((f) => native.pathForFile(f)).filter(Boolean);
  if (pdfs.length) { openPaths(pdfs); return; }
  // pictures dropped on a document are added to it (unless PDF.js already took them)
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (images.length && active?.pdf && !taken) images.forEach((f) => placePicture(active!, f));
  else if (files.length && !images.length) toast('Quartz opens PDF files');
});

// closing the window with unsaved documents asks first (see the main process)
addEventListener('beforeunload', (e) => {
  if (tabs.some((t) => t.modified)) { e.preventDefault(); e.returnValue = ''; }
});

native.onOpen((paths) => { openPaths(paths); });

// ---------- start ----------
refresh();
renderHome();
loadRecent();
checkDefault();
