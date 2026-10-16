// The desktop layer: one transparent page per display showing that display's widgets. The window is
// click-through except over what this page reports as hit areas (see reportRects).
import type { ControlWidget, MediaWidget, RecentWidget, ClockWidget, DeskCommand, DesktopEntry, DisplayInfo, FolderItem, FolderWidget, HitRect, State, Wall, Widget, Category } from '../shared/types';
import { api } from './lib/api';
import { h, clamp, clear } from './lib/dom';
import { applyWall, applyCachedWall, alignGlass } from './lib/glass';
import { ClockView } from './lib/clock';
import { editorFor, TITLES } from './lib/editors';
import { initLive } from './lib/live';
import { MediaCard } from './widgets/media';
import { ControlCenter } from './widgets/control';
import { RecentList } from './widgets/recent';
import { closeOverlays, ICONS, itemImage, menu, modal, popover, type MenuItem } from './lib/ui';
import { glass, unglass, refreshWithin, hasSource } from './lib/liquid';

const displayId = new URLSearchParams(location.search).get('display') || '';
const layer = document.getElementById('layer')!;
const overlays = document.getElementById('overlays')!;
let state: State;
let display: DisplayInfo | null = null;
const views = new Map<string, View>();
let dragging = 0; // widgets or items being dragged (keeps the whole layer clickable)

// ---------- hit areas ----------

let rectsQueued = false;
function reportRects() {
  if (rectsQueued) return;
  rectsQueued = true;
  requestAnimationFrame(() => {
    rectsQueued = false;
    const rects: HitRect[] = [];
    for (const [id, v] of views) {
      const r = v.el.getBoundingClientRect();
      if (r.width && r.height) rects.push({ id, x: Math.floor(r.left) - 2, y: Math.floor(r.top) - 2, w: Math.ceil(r.width) + 4, h: Math.ceil(r.height) + 4 });
    }
    api.rects(rects, modal.count > 0 || dragging > 0);
  });
}
modal.changed = reportRects;
addEventListener('resize', () => { for (const v of views.values()) v.place(); reportRects(); });

// files dragged from Explorer onto anything but a folder: refuse (never navigate to the file)
addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; });
addEventListener('drop', (e) => e.preventDefault());

// ---------- widgets ----------

const effectiveDisplay = (w: Widget) => (state.displays.some((d) => d.id === w.display) ? w.display : state.displays.find((d) => d.primary)?.id);

abstract class View {
  el!: HTMLElement;
  constructor(public w: Widget) {}
  abstract update(w: Widget): void;
  /** Keeps the widget inside the display. */
  place() {
    const el = this.el;
    const x = clamp(this.w.x, 0, Math.max(0, innerWidth - el.offsetWidth));
    const y = clamp(this.w.y, 0, Math.max(0, innerHeight - el.offsetHeight));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.el.querySelectorAll<HTMLElement>('.glass').forEach(alignGlass);
    refreshWithin(this.el);
  }
  destroy() { this.el.remove(); }
  abstract menu(): MenuItem[];
  click(_e: PointerEvent) {}
}

/** Drag to move (unless locked); a press without movement is a click. */
function movable(view: View, handle: HTMLElement) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-nodrag], button, input, .vslider, .mc-bar')) return;
    const sx = e.clientX, sy = e.clientY;
    // a selected widget drags the whole selection along
    const group = selected.has(view.w.id) && selected.size > 1 ? [...selected].map((id) => views.get(id)!).filter(Boolean) : [view];
    const starts = group.map((v) => ({ v, ox: v.el.offsetLeft, oy: v.el.offsetTop }));
    let moved = false;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 5) return;
      if (state.settings.lock) return;
      if (!moved) {
        moved = true;
        dragging++;
        if (group.length === 1) select(new Set());
        group.forEach((v) => v.el.classList.add('moving'));
        reportRects();
        closeOverlays();
      }
      // the group keeps its shape: one offset, limited so every member stays on the display
      let dx = m.clientX - sx, dy = m.clientY - sy;
      for (const s of starts) {
        dx = clamp(dx, -s.ox, innerWidth - s.v.el.offsetWidth - s.ox);
        dy = clamp(dy, -s.oy, innerHeight - s.v.el.offsetHeight - s.oy);
      }
      for (const s of starts) { s.v.w.x = Math.round(s.ox + dx); s.v.w.y = Math.round(s.oy + dy); s.v.place(); }
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      if (moved) {
        dragging--;
        for (const s of starts) {
          s.v.el.classList.remove('moving');
          s.v.w.display = displayId;
          api.put(s.v.w);
        }
        reportRects();
      } else if (u.type === 'pointerup') { select(new Set()); view.click(u); }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
  view.el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if ((e.target as HTMLElement).closest('[data-item]')) return; // items have their own menu
    menu(view.menu(), e.clientX, e.clientY);
  });
}

// ---------- selection box (the desktop's own is gone while Windows' icons are hidden) ----------

const selected = new Set<string>();

function select(ids: Set<string>) {
  selected.clear();
  for (const id of ids) selected.add(id);
  for (const [id, v] of views) v.el.classList.toggle('selected', selected.has(id));
}

let marquee: { x: number; y: number; box: HTMLElement | null } | null = null;

/** Drags that start on the empty desktop, reported by the helper (the layer never takes those clicks). */
function onMarquee(m: { phase: 'start' | 'move' | 'end'; x: number; y: number }) {
  if (m.phase === 'start') { marquee = { x: m.x, y: m.y, box: null }; return; }
  if (!marquee) return;
  const x0 = Math.min(marquee.x, m.x), y0 = Math.min(marquee.y, m.y);
  const w = Math.abs(m.x - marquee.x), hgt = Math.abs(m.y - marquee.y);
  if (!marquee.box && (w > 3 || hgt > 3)) {
    marquee.box = h('div', { class: 'marquee' });
    overlays.append(marquee.box);
  }
  if (marquee.box) {
    Object.assign(marquee.box.style, { left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${hgt}px` });
    const ids = new Set<string>();
    for (const [id, v] of views) {
      const r = v.el.getBoundingClientRect();
      if (r.right > x0 && r.left < x0 + w && r.bottom > y0 && r.top < y0 + hgt) ids.add(id);
    }
    select(ids);
  }
  if (m.phase === 'end') {
    if (!marquee.box) select(new Set()); // a click on the desktop clears the selection
    else {
      const box = marquee.box;
      box.classList.add('out');
      setTimeout(() => box.remove(), 180);
    }
    marquee = null;
  }
}

const commonMenu = (): MenuItem[] => [
  { sep: true },
  { label: 'New Folder', icon: 'plus', run: () => api.add('folder') },
  { label: 'New Clock', icon: 'clock', run: () => api.add('clock') },
  { label: 'New Spotify Widget', icon: 'plus', run: () => api.add('media') },
  { label: 'New Control Center', icon: 'plus', run: () => api.add('control') },
  { label: 'New Recent Folders', icon: 'plus', run: () => api.add('recent') },
  { label: 'Facet…', icon: 'gear', run: () => api.home() },
];

/** Spotify, Control Center and Recent folders: a card that follows live data. */
class LiveView extends View {
  private card: MediaCard | ControlCenter | RecentList;
  private config = '';
  constructor(w: MediaWidget | ControlWidget | RecentWidget) {
    super(w);
    this.card = w.type === 'media' ? new MediaCard(w) : w.type === 'control' ? new ControlCenter(w) : new RecentList(w, () => state.settings.glass === 'dark');
    this.el = h('div', { class: `widget live ${w.type}` }, this.card.el);
    movable(this, this.el);
    layer.append(this.el);
    this.update(w);
  }
  update(w: Widget) {
    this.w = w;
    // rebuilding is only needed when the widget's own settings change (not when it moves)
    const { x: _x, y: _y, display: _d, ...rest } = w;
    const config = JSON.stringify([rest, state.settings.glass]);
    if (config !== this.config) { this.config = config; (this.card as { set(w: Widget): void }).set(w); }
    this.place();
    reportRects();
  }
  destroy() { this.card.destroy(); super.destroy(); }
  menu(): MenuItem[] {
    const extra: MenuItem[] = this.w.type === 'media' ? [{ label: 'Open Spotify', icon: 'open', run: () => api.launch('spotify') }]
      : this.w.type === 'recent' ? [{ label: 'Open File Explorer', icon: 'open', run: () => api.open(this.recentHome()) }] : [];
    return [
      ...extra,
      { label: 'Customize…', icon: 'edit', run: () => customize(this) },
      { label: `Remove ${TITLES[this.w.type]}`, icon: 'trash', danger: true, run: () => api.remove(this.w.id) },
      ...commonMenu(),
    ];
  }
  private recentHome() { return 'shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}'; }
}

class ClockWidgetView extends View {
  private clock: ClockView;
  constructor(w: ClockWidget) {
    super(w);
    this.clock = new ClockView(w);
    this.el = h('div', { class: 'widget clock-widget' }, this.clock.el);
    movable(this, this.el);
    layer.append(this.el);
    this.update(w);
  }
  update(w: Widget) {
    this.w = w;
    const c = w as ClockWidget;
    this.clock.set(c);
    this.clock.el.classList.toggle('glass', c.bg !== 'none');
    if (c.bg === 'none') unglass(this.clock.el);
    else glass(this.clock.el, { dark: c.bg === 'dark' });
    this.place();
    reportRects();
  }
  destroy() { this.clock.destroy(); super.destroy(); }
  menu(): MenuItem[] {
    return [
      { label: 'Customize…', icon: 'edit', run: () => customize(this) },
      { label: 'Remove Clock', icon: 'trash', danger: true, run: () => api.remove(this.w.id) },
      ...commonMenu(),
    ];
  }
}

const TILE = { s: 64, m: 80, l: 104 };
const ICON = { s: 40, m: 52, l: 68 };

class FolderView extends View {
  private sig = '';
  private grid: ItemGrid | null = null;
  constructor(w: FolderWidget) {
    super(w);
    this.el = h('div', { class: 'widget folder' });
    this.el.dataset.folder = w.id;
    movable(this, this.el);
    dropTarget(this.el, () => this.f, () => undefined);
    layer.append(this.el);
    this.update(w);
  }
  get f() { return this.w as FolderWidget; }
  update(w: Widget) {
    this.w = w;
    const f = this.f;
    const sig = JSON.stringify([f.style, f.size, f.cols, f.rows, f.tint, f.name, f.items, state.settings.labels]);
    if (sig !== this.sig) {
      this.sig = sig;
      this.el.className = `widget folder ${f.style} size-${f.size}`;
      this.el.style.setProperty('--tint', f.tint ? hexA(f.tint, 0.42) : '');
      clear(this.el);
      if (f.style === 'tile') this.buildTile(f);
      else this.buildPanel(f);
    }
    const surface = this.el.querySelector<HTMLElement>(':scope > .tile, :scope > .panel');
    if (surface) glass(surface, glassOpts(f));
    this.place();
    reportRects();
  }
  private buildTile(f: FolderWidget) {
    const size = TILE[f.size];
    const mini = h('div', { class: 'mini' });
    for (let i = 0; i < 9; i++) {
      const it = f.items[i];
      mini.append(it ? itemImage(it.path, 'mi-img') : h('div', { class: 'mi-img empty' }));
    }
    this.grid = null;
    this.el.style.setProperty('--tile', `${size}px`);
    const tile = h('div', { class: 'tile glass' }, mini);
    this.el.append(tile, h('div', { class: 'label', text: f.name }));
    sheen(tile);
  }
  private buildPanel(f: FolderWidget) {
    const icon = ICON[f.size];
    this.el.style.setProperty('--icon', `${icon}px`);
    this.el.style.setProperty('--cols', String(f.cols));
    this.el.style.setProperty('--rows', String(f.rows));
    this.grid = new ItemGrid(f, { addTile: false });
    const panel = h('div', { class: 'panel glass' }, h('div', { class: 'ph' }, h('span', { class: 'pname', text: f.name })), this.grid.el);
    this.el.append(panel);
    sheen(panel);
  }
  click() { if (this.f.style === 'tile') openFolder(this); }
  menu(): MenuItem[] {
    const f = this.f;
    return [
      ...(f.style === 'tile' ? [{ label: 'Open', icon: 'open' as const, run: () => openFolder(this) }] : []),
      { label: 'Add Apps or Files…', icon: 'plus', run: () => addFrom('files', f) },
      { label: 'Add a Folder…', icon: 'folder', run: () => addFrom('folder', f) },
      { label: 'Add from Desktop…', icon: 'desktop', run: () => pickFromDesktop(f) },
      { sep: true },
      { label: 'Customize…', icon: 'edit', run: () => customize(this) },
      { label: 'Sort A–Z', icon: 'sort', disabled: f.items.length < 2, run: () => { f.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })); api.put(f); } },
      { label: 'Remove Folder…', icon: 'trash', danger: true, run: () => removeFolder(f) },
      ...commonMenu(),
    ];
  }
}

/** Folder glass: clear or dark (Settings), optionally tinted. */
const glassOpts = (f: FolderWidget) => ({ tint: f.tint || undefined, dark: state.settings.glass === 'dark' || undefined });

/** A soft highlight that follows the pointer across a glass surface. */
function sheen(el: HTMLElement) {
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
  });
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ---------- folder items (panels and open folders) ----------

class ItemGrid {
  readonly el: HTMLElement;
  constructor(public f: FolderWidget, private opts: { addTile: boolean }) {
    this.el = h('div', { class: 'grid' });
    this.el.dataset.nodrag = '';
    dropTarget(this.el, () => this.f, (e) => this.indexAt(e.clientX, e.clientY));
    this.render();
  }
  render() {
    clear(this.el);
    for (const it of this.f.items) this.el.append(this.cell(it));
    if (this.opts.addTile) {
      const add = h('button', { type: 'button', class: 'cell add', title: 'Add apps, files or folders' }, h('div', { class: 'img', html: ICONS.plus }), h('div', { class: 'name', text: 'Add' }));
      add.addEventListener('click', (e) => menu([
        { label: 'Apps or Files…', icon: 'plus', run: () => addFrom('files', this.f) },
        { label: 'A Folder…', icon: 'folder', run: () => addFrom('folder', this.f) },
        { label: 'From the Desktop…', icon: 'desktop', run: () => pickFromDesktop(this.f) },
      ], e.clientX, e.clientY));
      this.el.append(add);
    }
    if (!this.f.items.length && !this.opts.addTile) this.el.append(h('div', { class: 'empty-note', text: 'Drop apps or files here' }));
  }
  private cell(it: FolderItem) {
    const c = h('div', { class: 'cell', title: it.path }, itemImage(it.path), h('div', { class: 'name', text: it.name }));
    c.dataset.item = it.id;
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu([
        { label: 'Open', icon: 'open', run: () => launch(it) },
        { label: 'Show in Folder', icon: 'reveal', run: () => api.reveal(it.path) },
        { label: 'Rename…', icon: 'rename', run: () => renameItem(this.f, it, c) },
        { sep: true },
        { label: 'Remove from Folder', icon: 'trash', danger: true, run: () => { this.f.items = this.f.items.filter((x) => x.id !== it.id); api.put(this.f); } },
      ], e.clientX, e.clientY);
    });
    c.addEventListener('pointerdown', (e) => this.press(e, it, c));
    return c;
  }
  /** Index of the cell under a point (for drops and reordering). */
  indexAt(x: number, y: number) {
    const cells = [...this.el.querySelectorAll<HTMLElement>('.cell[data-item]')];
    let best = cells.length, bestD = Infinity;
    cells.forEach((c, i) => {
      const r = c.getBoundingClientRect();
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < bestD) { bestD = d; best = x > r.left + r.width / 2 && y > r.top ? i + 1 : i; }
    });
    return best;
  }
  /** Click to open; drag to reorder, or onto another folder to move it there. */
  private press(e: PointerEvent, it: FolderItem, cell: HTMLElement) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('input')) return;
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    let ghost: HTMLElement | null = null;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      if (!ghost) {
        if (Math.hypot(m.clientX - sx, m.clientY - sy) < 6 || state.settings.lock) return;
        dragging++;
        reportRects();
        const r = cell.getBoundingClientRect();
        ghost = cell.cloneNode(true) as HTMLElement;
        ghost.classList.add('drag-ghost');
        ghost.style.width = `${r.width}px`;
        overlays.append(ghost);
        cell.classList.add('placeholder');
      }
      ghost.style.left = `${m.clientX}px`;
      ghost.style.top = `${m.clientY}px`;
      // live reorder inside this grid
      const over = this.el.getBoundingClientRect();
      if (m.clientX >= over.left && m.clientX <= over.right && m.clientY >= over.top && m.clientY <= over.bottom) {
        const cells = [...this.el.querySelectorAll<HTMLElement>('.cell[data-item]')];
        const from = cells.indexOf(cell);
        let to = this.indexAt(m.clientX, m.clientY);
        if (to > from) to--;
        if (to !== from && to >= 0) {
          const ref = cells.filter((c) => c !== cell)[to] ?? null;
          this.el.insertBefore(cell, ref ?? this.el.querySelector('.cell.add'));
        }
      }
      document.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
      folderAt(m.clientX, m.clientY, this.f.id)?.classList.add('drop-hover');
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      if (!ghost) { if (u.type === 'pointerup' && cell.contains(u.target as Node)) launch(it); return; }
      dragging--;
      ghost.remove();
      cell.classList.remove('placeholder');
      document.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
      const target = folderAt(u.clientX, u.clientY, this.f.id);
      if (target) {
        // moved into another folder
        api.addItems(target.dataset.folder!, [it.path]);
        this.f.items = this.f.items.filter((x) => x.id !== it.id);
      } else {
        const order = [...this.el.querySelectorAll<HTMLElement>('.cell[data-item]')].map((c) => c.dataset.item);
        this.f.items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      }
      api.put(this.f);
      reportRects();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }
}

/** Another folder widget under the point (ignores the one being dragged from). */
function folderAt(x: number, y: number, except: string): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const f = (el as HTMLElement).closest<HTMLElement>('.widget.folder');
    if (f && f.dataset.folder !== except) return f;
  }
  return null;
}

function dropTarget(el: HTMLElement, folder: () => FolderWidget, index: (e: DragEvent) => number | undefined) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'link';
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget as Node)) el.classList.remove('drop-hover'); });
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drop-hover');
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const n = await api.addItems(folder().id, files, index(e));
    toast(n ? `Added ${n} item${n === 1 ? '' : 's'} to ${folder().name}` : `Already in ${folder().name}`);
  });
}

async function launch(it: FolderItem) {
  const err = await api.open(it.path);
  if (err) toast(`Couldn't open ${it.name}: ${err}`);
}

async function addFrom(kind: 'files' | 'folder', f: FolderWidget) {
  const paths = await api.pick(kind);
  if (paths.length) await api.addItems(f.id, paths);
}

function removeFolder(f: FolderWidget) {
  if (!f.items.length) { api.remove(f.id); return; }
  const v = views.get(f.id);
  const body = h('div', { class: 'confirm' },
    h('p', { text: `"${f.name}" holds ${f.items.length} shortcut${f.items.length === 1 ? '' : 's'}. Removing the folder doesn't delete any of your files or apps.` }));
  const yes = h('button', { type: 'button', class: 'btn danger', text: 'Remove Folder' });
  const no = h('button', { type: 'button', class: 'btn', text: 'Cancel' });
  body.append(h('div', { class: 'btns' }, no, yes));
  const close = popover(v?.el.getBoundingClientRect() ?? new DOMRect(innerWidth / 2, innerHeight / 2, 0, 0), 'Remove folder?', body);
  no.addEventListener('click', close);
  yes.addEventListener('click', () => { close(); api.remove(f.id); });
}

// ---------- typing (renaming) ----------

/** The layer normally never takes focus; ask for it while a text field is being edited. */
function withKeyboard(input: HTMLInputElement, done: () => void) {
  api.keyboard(true).then(() => setTimeout(() => { input.focus(); input.select(); }, 30));
  const finish = () => {
    input.removeEventListener('blur', finish);
    api.keyboard(false);
    done();
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); input.blur(); } });
}

function renameItem(f: FolderWidget, it: FolderItem, cell: HTMLElement) {
  const name = cell.querySelector<HTMLElement>('.name')!;
  const input = h('input', { type: 'text', class: 'name-input', value: it.name, maxlength: '80', spellcheck: 'false' }) as HTMLInputElement;
  name.replaceWith(input);
  input.dataset.nodrag = '';
  withKeyboard(input, () => {
    const v = input.value.trim();
    if (v && v !== it.name) { it.name = v; api.put(f); }
    input.replaceWith(name);
    name.textContent = it.name;
  });
}

// ---------- open folder (iOS style) ----------

let openState: { f: FolderWidget; grid: ItemGrid; title: HTMLInputElement; close: () => void } | null = null;

function openFolder(view: FolderView) {
  closeOverlays();
  openState?.close();
  const f = view.f;
  const from = view.el.querySelector('.tile')!.getBoundingClientRect();
  const grid = new ItemGrid(f, { addTile: true });
  const cols = clamp(Math.ceil(Math.sqrt(f.items.length + 1)), 3, 5);
  const title = h('input', { type: 'text', class: 'fo-title', value: f.name, maxlength: '60', spellcheck: 'false', title: 'Click to rename' }) as HTMLInputElement;
  const panel = h('div', { class: 'fo-panel glass' }, grid.el);
  panel.style.setProperty('--cols', String(cols));
  const sheet = h('div', { class: 'fo-sheet' }, title, panel);
  const bg = h('div', { class: 'fo-bg' });
  const root = h('div', { class: 'fo' }, bg, sheet);
  overlays.append(root);
  modal.count++;
  modal.changed();

  // centre the folder over its tile, inside the display
  const r = sheet.getBoundingClientRect();
  const cx = clamp(from.left + from.width / 2, r.width / 2 + 16, innerWidth - r.width / 2 - 16);
  const cy = clamp(from.top + from.height / 2, r.height / 2 + 16, innerHeight - r.height / 2 - 16);
  sheet.style.left = `${cx - r.width / 2}px`;
  sheet.style.top = `${cy - r.height / 2}px`;
  alignGlass(panel);
  glass(panel, { ...glassOpts(f), tintAlpha: f.tint ? 0.3 : state.settings.glass === 'dark' ? 0.42 : 0.12 });
  // grow out of the tile
  const p = panel.getBoundingClientRect();
  const k = from.width / p.width;
  sheet.style.transformOrigin = `${p.left - (cx - r.width / 2) + p.width / 2}px ${p.top - (cy - r.height / 2) + p.height / 2}px`;
  sheet.style.transform = `translate(${from.left + from.width / 2 - (p.left + p.width / 2)}px, ${from.top + from.height / 2 - (p.top + p.height / 2)}px) scale(${k})`;
  sheet.style.opacity = '0';
  view.el.classList.add('opened');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.classList.add('in');
    sheet.style.transform = '';
    sheet.style.opacity = '';
  }));

  title.addEventListener('pointerdown', () => {
    if (document.activeElement === title) return;
    withKeyboard(title, () => {
      const v = title.value.trim();
      if (!v) title.value = f.name;
      else if (v !== f.name) { f.name = v; api.put(f); }
    });
  });

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && document.activeElement !== title) close(); };
  addEventListener('keydown', onKey);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    removeEventListener('keydown', onKey);
    if (document.activeElement === title) title.blur();
    closeOverlays();
    const to = views.get(f.id)?.el.querySelector('.tile')?.getBoundingClientRect() ?? from;
    const pr = panel.getBoundingClientRect();
    root.classList.remove('in');
    sheet.style.transform = `translate(${to.left + to.width / 2 - (pr.left + pr.width / 2)}px, ${to.top + to.height / 2 - (pr.top + pr.height / 2)}px) scale(${to.width / pr.width})`;
    sheet.style.opacity = '0';
    setTimeout(() => {
      root.remove();
      views.get(f.id)?.el.classList.remove('opened');
      modal.count = Math.max(0, modal.count - 1);
      modal.changed();
    }, 260);
    openState = null;
  };
  bg.addEventListener('pointerdown', (e) => { e.preventDefault(); close(); });
  bg.addEventListener('contextmenu', (e) => e.preventDefault());
  openState = { f, grid, title, close };
}

// ---------- pickers and editors ----------

const CATEGORY_LABEL: Record<Category, string> = {
  apps: 'Apps', games: 'Games', folders: 'Folders', documents: 'Documents', pictures: 'Pictures',
  videos: 'Videos', music: 'Music', archives: 'Archives', web: 'Web links', other: 'Other',
};

async function pickFromDesktop(f: FolderWidget) {
  const entries: DesktopEntry[] = await api.desktop();
  const have = new Set(f.items.map((i) => i.path.toLowerCase()));
  const chosen = new Set<string>();
  const add = h('button', { type: 'button', class: 'btn primary', text: 'Add', disabled: true });
  const cancel = h('button', { type: 'button', class: 'btn', text: 'Cancel' });
  const list = h('div', { class: 'pick-list' });
  const groups = new Map<Category, DesktopEntry[]>();
  for (const e of entries) groups.set(e.category, [...(groups.get(e.category) ?? []), e]);
  const refresh = () => { add.textContent = chosen.size ? `Add ${chosen.size}` : 'Add'; add.toggleAttribute('disabled', !chosen.size); };
  if (!entries.length) list.append(h('div', { class: 'empty-note', text: 'Your desktop is empty.' }));
  for (const [cat, items] of groups) {
    const grid = h('div', { class: 'pick-grid' });
    for (const e of items) {
      const already = have.has(e.path.toLowerCase());
      const b = h('button', { type: 'button', class: `pick${already ? ' have' : ''}`, title: already ? 'Already in this folder' : e.path, disabled: already },
        itemImage(e.path), h('div', { class: 'name', text: e.name }), h('span', { class: 'tick', html: ICONS.check }));
      b.addEventListener('click', () => {
        if (chosen.has(e.path)) chosen.delete(e.path); else chosen.add(e.path);
        b.classList.toggle('on', chosen.has(e.path));
        refresh();
      });
      grid.append(b);
    }
    list.append(h('div', { class: 'pick-cat', text: CATEGORY_LABEL[cat] }), grid);
  }
  const body = h('div', { class: 'picker-sheet' }, list, h('div', { class: 'btns' }, cancel, add));
  const anchor = (openState?.f.id === f.id ? overlays.querySelector('.fo-panel') : views.get(f.id)?.el)?.getBoundingClientRect() ?? new DOMRect(innerWidth / 2, innerHeight / 2, 0, 0);
  const close = popover(anchor, `Add to ${f.name}`, body);
  cancel.addEventListener('click', close);
  add.addEventListener('click', async () => { close(); await api.addItems(f.id, [...chosen]); });
}

function customize(view: View) {
  const w = structuredClone(view.w) as Widget;
  const save = () => api.put(w);
  let typing = false;
  const body: HTMLElement = editorFor(w, () => { view.update({ ...w } as Widget); save(); }, {
    onNameFocus: (on) => {
      if (on && !typing) { typing = true; api.keyboard(true).then(() => setTimeout(() => body.querySelector<HTMLInputElement>('input.text')?.focus(), 30)); }
      if (!on && typing) { typing = false; api.keyboard(false); }
    },
  });
  popover(view.el.getBoundingClientRect(), TITLES[w.type], body, () => { if (w.type === 'folder') api.keyboard(false); });
}

// ---------- toast ----------

let toastTimer = 0;
function toast(text: string) {
  let el = document.querySelector<HTMLElement>('.toast');
  if (!el) { el = h('div', { class: 'toast' }); document.body.append(el); }
  el.textContent = text;
  el.classList.add('in');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('in'), 3200);
}

// ---------- state ----------

function render() {
  document.documentElement.classList.toggle('glass-dark', state.settings.glass === 'dark');
  document.documentElement.style.setProperty('--accent', state.accent || '#0078d4');
  document.documentElement.classList.toggle('no-labels', !state.settings.labels);
  document.documentElement.classList.toggle('locked', state.settings.lock);
  const mine = state.widgets.filter((w) => effectiveDisplay(w) === displayId);
  const ids = new Set(mine.map((w) => w.id));
  for (const [id, v] of views) if (!ids.has(id)) { v.destroy(); views.delete(id); }
  for (const w of mine) {
    const v = views.get(w.id);
    if (v && v.w.type === w.type) {
      if (!v.el.classList.contains('moving')) v.update(w);
    } else {
      v?.destroy();
      views.set(w.id, w.type === 'clock' ? new ClockWidgetView(w) : w.type === 'folder' ? new FolderView(w) : new LiveView(w));
    }
  }
  for (const id of [...selected]) if (!views.has(id)) selected.delete(id);
  for (const [id, v] of views) v.el.classList.toggle('selected', selected.has(id));
  // an open folder follows changes (items added, renamed elsewhere)
  if (openState) {
    const f = mine.find((w) => w.id === openState!.f.id) as FolderWidget | undefined;
    if (!f) openState.close();
    else {
      openState.f = f;
      openState.grid.f = f;
      openState.grid.render();
      if (document.activeElement !== openState.title) openState.title.value = f.name;
    }
  }
  reportRects();
}

function command(c: DeskCommand) {
  const v = views.get(c.id);
  if (!v) return;
  if (c.kind === 'customize') customize(v);
  if (c.kind === 'open' && v instanceof FolderView) openFolder(v);
  if (c.kind === 'flash') { v.el.classList.remove('flash'); void v.el.offsetWidth; v.el.classList.add('flash'); }
}

(async () => {
  // the wallpaper as processed last time: the glass is there with the first frame
  const cached = applyCachedWall(displayId);
  const reveal = () => { document.body.classList.remove('starting'); reportRects(); };
  setTimeout(reveal, 700);
  cached.then(() => { if (hasSource()) reveal(); });
  api.onWall((w: Wall) => cached.then(() => applyWall(w, displayId)).then(reveal));
  api.onMarquee(onMarquee);
  (window as unknown as { facetDebug: object }).facetDebug = { marquee: onMarquee, selected }; // for tests
  api.onState((s: State) => { state = s; render(); });
  api.onCommand((c) => { if (c.kind !== 'organize') command(c); });
  const init = await api.init();
  state = init.state;
  initLive(init);
  display = init.display;
  void display;
  render();
  await cached;
  applyWall(init.wall, displayId).then(() => { if (init.wall) reveal(); });
})();
