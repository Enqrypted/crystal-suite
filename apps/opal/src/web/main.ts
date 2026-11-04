// Opal: a photo viewer. Opens a photo, steps through its folder (arrows, filmstrip, grid), zooms, turns, shows
// the photo's details, runs slideshows, deletes to the Recycle Bin, copies, and saves converted copies.
import './styles.css';
import { DecodeError, PhotoCache, type Photo } from './decode';
import { convertFolder, renderUpright, saveCopy, type CopyOptions } from './convert';
import { jpegOrientation, rotateOrientation, setJpegOrientation } from './exif';
import { icon } from './icons';
import { renderInfo } from './info';
import { baseName, dirName, extOf, isHeif, native, type PhotoEntry } from './native';
import { forgetThumbs, observeThumb, thumbUrl } from './thumbs';
import { alertBox, modal, toast } from './ui/dialog';
import { clamp, clear, h, isTyping } from './ui/dom';
import { closeMenus, comboOf, contextMenu, popup, type MenuItem } from './ui/menu';
import { Viewer, type WheelMode } from './viewer';

// ---------- settings ----------
interface Settings {
  sort: 'name' | 'date' | 'size'; desc: boolean; filmstrip: boolean; info: boolean; wheel: WheelMode;
  confirmDelete: boolean; slideSeconds: number; copy: Partial<CopyOptions>;
}
const settings: Settings = { sort: 'name', desc: false, filmstrip: true, info: false, wheel: 'zoom', confirmDelete: true, slideSeconds: 4, copy: {} };
const saveSettings = () => native.setSettings({ ...settings });

// ---------- state ----------
let folder = '';
let files: PhotoEntry[] = [];
let index = -1;
let photo: Photo | null = null;
let loadToken = 0;
/** Turns not saved to the file (all formats but JPEG, and JPEGs while the save is pending). */
const rotations = new Map<string, number>();
const cache = new PhotoCache(5);
const THUMB = 320;
const isJpeg = (p: string) => /^(jpg|jpeg|jfif|jpe)$/.test(extOf(p));
const current = () => (index >= 0 ? files[index] : undefined);

// ---------- layout ----------
const btn = (ic: string, title: string, run: () => void, cls = '') => {
  const b = h('button', { class: `tb ${cls}`, title }, icon(ic));
  b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
  return b;
};

const titleName = h('span', { class: 'name' });
const titleCount = h('span', { class: 'count' });
const zoomLabel = h('button', { class: 'tb zoom-label', title: 'Fit to window / actual size (0 / 1)' }, '100%');
zoomLabel.addEventListener('click', () => { if (viewer.isFitted && viewer.fitScale < 1) viewer.zoomTo(1); else viewer.fit(); });

const bInfo = btn('info', 'Details (I)', () => toggleInfo());
const bFilm = btn('film', 'Filmstrip (F)', () => toggleFilmstrip());
const bFull = btn('full', 'Full screen (F11)', () => toggleFullscreen());
const bMore = btn('more', 'More', () => { const r = bMore.getBoundingClientRect(); popup(moreMenu(), r.right - 260, r.bottom + 4); });

const top = h('header', { class: 'top' },
  h('div', { class: 'tl' }, h('div', { class: 'badge', title: 'Opal' }, 'Op'), h('div', { class: 'title' }, titleName, titleCount)),
  h('div', { class: 'tc photo-only' },
    btn('zoomOut', 'Zoom out (−)', () => viewer.step(-1)), zoomLabel, btn('zoomIn', 'Zoom in (+)', () => viewer.step(1)),
    btn('fit', 'Fit to window (0)', () => viewer.fit())),
  h('div', { class: 'tr' },
    h('span', { class: 'photo-only grp' },
      btn('rotLeft', 'Rotate left (Ctrl+L)', () => rotate(-90)), btn('rotRight', 'Rotate right (Ctrl+R)', () => rotate(90)),
      btn('trash', 'Delete (Del)', () => deleteCurrent()), h('span', { class: 'sep' }),
      bInfo, bFilm, btn('grid', 'All photos in this folder (G)', () => toggleGrid()), btn('play', 'Slideshow (F5)', () => startSlideshow())),
    bFull, bMore));

const stage = h('div', { class: 'stage' });
const prevBtn = h('button', { class: 'nav-btn prev', title: 'Previous (←)' }, icon('left', 28));
const nextBtn = h('button', { class: 'nav-btn next', title: 'Next (→)' }, icon('right', 28));
prevBtn.addEventListener('click', () => go(-1));
nextBtn.addEventListener('click', () => go(1));
const spinner = h('div', { class: 'spinner', hidden: true });
const message = h('div', { class: 'msg', hidden: true });
stage.append(prevBtn, nextBtn, spinner, message);
const infoPanel = h('aside', { class: 'info', hidden: true });
const film = h('div', { class: 'film', hidden: true });
const filmRow = h('div', { class: 'film-row' });
film.append(filmRow);
const grid = h('div', { class: 'grid-view', hidden: true });
const start = h('div', { class: 'start', hidden: true });
const main = h('div', { class: 'main' }, stage, infoPanel);
const app = document.getElementById('app')!;
app.append(top, main, film, grid, start);

const viewer = new Viewer(stage);
viewer.onChange = () => { zoomLabel.textContent = `${Math.round(viewer.scale * 100)}%`; };
viewer.onNavigate = (d) => go(d);

// ---------- loading and showing ----------
function updateChrome() {
  const e = current();
  titleName.textContent = e ? e.name : '';
  titleCount.textContent = e && files.length > 1 ? `${index + 1} of ${files.length}` : '';
  native.setTitle(e ? `${e.name} – Opal` : 'Opal');
  prevBtn.hidden = index <= 0;
  nextBtn.hidden = index < 0 || index >= files.length - 1;
  app.classList.toggle('has-photo', !!e);
  updateFilmVisibility();
  filmRow.querySelectorAll('.cell.on').forEach((c) => c.classList.remove('on'));
  const cell = filmRow.children[index] as HTMLElement | undefined;
  if (cell) { cell.classList.add('on'); scrollIntoViewH(film, cell); }
}

function scrollIntoViewH(scroller: HTMLElement, el: HTMLElement) {
  const left = el.offsetLeft - scroller.clientWidth / 2 + el.offsetWidth / 2;
  scroller.scrollTo({ left, behavior: Math.abs(scroller.scrollLeft - left) > scroller.clientWidth * 2 ? 'auto' : 'smooth' });
}

let spinTimer = 0;
function setBusy(on: boolean) {
  clearTimeout(spinTimer);
  if (on) spinTimer = window.setTimeout(() => { spinner.hidden = false; }, 180);
  else spinner.hidden = true;
}

function setPhoto(p: Photo, e: PhotoEntry, keepView: boolean) {
  const prev = photo;
  photo = p;
  cache.shown = p;
  message.hidden = true;
  app.classList.remove('failed');
  viewer.show(p, rotations.get(e.path) ?? 0, keepView);
  // the photo it replaced is gone from the cache (deleted, saved, evicted): free it once it's off screen
  if (prev && prev !== p && !cache.holds(prev)) setTimeout(() => prev.dispose(), 300);
  if (!p.preview) setBusy(false);
  if (settings.info) renderInfo(infoPanel, p, e, viewer.rotation);
}

function showError(e: PhotoEntry, err: unknown) {
  setBusy(false);
  viewer.show(null);
  photo = null;
  cache.shown = null;
  app.classList.add('failed');
  clear(message);
  message.append(icon('image', 40), h('div', { class: 'msg-title' }, 'Opal can’t show this photo'),
    h('div', { class: 'msg-text' }, err instanceof DecodeError ? err.message : 'Something went wrong while opening it.'), h('div', { class: 'msg-file' }, e.name));
  message.hidden = false;
  if (settings.info) renderInfo(infoPanel, null, null, 0);
}

async function showIndex(i: number, fade = false) {
  if (!files.length) { showStart(); return; }
  index = clamp(i, 0, files.length - 1);
  const e = files[index];
  const token = ++loadToken;
  cache.current = e.path;
  updateChrome();
  setBusy(true);
  if (fade) { stage.classList.add('fading'); await new Promise((r) => setTimeout(r, 220)); }
  try {
    const p = await cache.get(e, (preview) => { if (token === loadToken) setPhoto(preview, e, false); });
    if (token !== loadToken) return;
    setPhoto(p, e, !!photo && photo.path === e.path && photo.preview);
  } catch (err) {
    if (token === loadToken) showError(e, err);
  } finally {
    if (fade && token === loadToken) stage.classList.remove('fading');
  }
  // the photos either side decode in the background, so the next step is instant
  if (token === loadToken) for (const d of [1, -1, 2]) { const n = files[index + d]; if (n) cache.warm(n); }
}

function go(d: number, wrap = false) {
  if (!files.length) return;
  let i = index + d;
  if (wrap) i = (i + files.length) % files.length;
  if (i < 0 || i >= files.length || i === index) return;
  showIndex(i, slideshow);
}

const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortFiles(list: PhotoEntry[]) {
  const by = settings.sort === 'date' ? (a: PhotoEntry, b: PhotoEntry) => a.mtime - b.mtime || coll.compare(a.name, b.name)
    : settings.sort === 'size' ? (a: PhotoEntry, b: PhotoEntry) => a.size - b.size || coll.compare(a.name, b.name)
      : (a: PhotoEntry, b: PhotoEntry) => coll.compare(a.name, b.name);
  const out = [...list].sort(by);
  return settings.desc ? out.reverse() : out;
}

let opening = false;
/** Opens a photo and the folder around it. */
async function openPath(p: string) {
  opening = true;
  const r = await native.list(p);
  if (r.folder.toLowerCase() !== folder.toLowerCase()) { cache.clear(); rotations.clear(); }
  folder = r.folder;
  files = sortFiles(r.files);
  let i = files.findIndex((f) => f.path.toLowerCase() === p.toLowerCase());
  if (i < 0) {
    // a photo with an unusual name (or hidden): show it anyway, first
    const st = await native.stat(p);
    if (!st) { toast(`${baseName(p)} can’t be found.`); return; }
    files.unshift({ path: p, name: baseName(p), size: st.size, mtime: st.mtime });
    i = 0;
  }
  hideStart();
  buildFilmstrip();
  if (!grid.hidden) buildGrid();
  showIndex(i);
  native.addRecent(p);
  opening = false;
}

/** The folder changed on disk (or a sort changed): keep showing the same photo if it's still there. */
async function relist() {
  const keep = current();
  if (!folder) return;
  const r = await native.list(keep?.path || folder);
  files = sortFiles(r.files);
  buildFilmstrip();
  if (!grid.hidden) buildGrid();
  if (!files.length) { showStart(); return; }
  const i = keep ? files.findIndex((f) => f.path === keep.path) : -1;
  if (i >= 0) {
    index = i;
    const now = files[i];
    if (keep && (now.mtime !== keep.mtime || now.size !== keep.size)) { forgetThumbs(now.path); showIndex(i); } else updateChrome();
  } else showIndex(Math.min(Math.max(index, 0), files.length - 1));
}
native.onFolderChanged((f) => { if (f.toLowerCase() === folder.toLowerCase()) relist(); });

// ---------- filmstrip and grid ----------
function cellFor(e: PhotoEntry, i: number, cls: string) {
  const cell = h('div', { class: cls, title: e.name }, h('img', { alt: '', draggable: 'false' }));
  cell.addEventListener('click', () => { if (cls === 'gcell') toggleGrid(false); showIndex(i); });
  cell.addEventListener('contextmenu', (ev) => { contextMenu(ev, [{ label: 'Open', run: () => showIndex(i) }, { label: 'Show in folder', run: () => native.showInFolder(e.path) }]); });
  if (cls === 'gcell') cell.append(h('span', { class: 'gname' }, e.name));
  observeThumb(cell, e, THUMB);
  return cell;
}

function buildFilmstrip() {
  clear(filmRow);
  files.forEach((e, i) => filmRow.append(cellFor(e, i, 'cell')));
  updateFilmVisibility();
}
function updateFilmVisibility() { film.hidden = !settings.filmstrip || files.length < 2 || !app.classList.contains('has-photo'); }

function buildGrid() {
  clear(grid);
  const head = h('div', { class: 'grid-head' }, h('b', {}, baseName(folder) || folder), h('span', {}, `${files.length} photo${files.length === 1 ? '' : 's'}`), h('div', { class: 'spacer' }));
  const close = btn('close', 'Back to the photo (Esc)', () => toggleGrid(false));
  head.append(close);
  const cells = h('div', { class: 'grid-cells' });
  files.forEach((e, i) => { const c = cellFor(e, i, 'gcell'); if (i === index) c.classList.add('on'); cells.append(c); });
  grid.append(head, cells);
}

function toggleGrid(on = grid.hidden) {
  if (on && !files.length) return;
  grid.hidden = !on;
  app.classList.toggle('gridding', on);
  if (on) {
    buildGrid();
    const cur = grid.querySelector('.gcell.on') as HTMLElement | null;
    cur?.scrollIntoView({ block: 'center' });
  }
}

function toggleFilmstrip() {
  settings.filmstrip = !settings.filmstrip;
  saveSettings();
  updateFilmVisibility();
  bFilm.classList.toggle('on', settings.filmstrip);
  if (!film.hidden) updateChrome();
}

function toggleInfo(on = !settings.info) {
  settings.info = on;
  saveSettings();
  infoPanel.hidden = !on;
  bInfo.classList.toggle('on', on);
  if (on) renderInfo(infoPanel, photo, photo ? current() ?? null : null, viewer.rotation);
}

// ---------- actions ----------
const rotTimers = new Map<string, number>();
let rotateHintShown = false;

function rotate(deg: number) {
  const e = current();
  if (!e || !photo) return;
  const r = (((rotations.get(e.path) ?? 0) + deg) % 360 + 360) % 360;
  if (r) rotations.set(e.path, r); else rotations.delete(e.path);
  viewer.setRotation(r);
  if (settings.info) renderInfo(infoPanel, photo, e, r);
  if (isJpeg(e.path)) {
    // a JPEG is turned in the file itself, losslessly (only its orientation value changes)
    clearTimeout(rotTimers.get(e.path));
    rotTimers.set(e.path, window.setTimeout(() => saveRotation(e.path), 700));
  } else if (!rotateHintShown) {
    rotateHintShown = true;
    toast(`${extOf(e.path).toUpperCase()} files can’t be turned in place, so this turn is only in Opal. To keep it, use Save a copy (Ctrl+S).`, 5200);
  }
}

async function saveRotation(path: string) {
  rotTimers.delete(path);
  const r = rotations.get(path) ?? 0;
  if (!r) return;
  try {
    const bytes = await native.read(path);
    const out = setJpegOrientation(bytes, rotateOrientation(jpegOrientation(bytes), r));
    if (!out) { toast('This JPEG’s rotation can’t be saved in place. Save a copy (Ctrl+S) to keep it turned.', 4500); return; }
    const err = await native.write(path, out);
    if (err) { toast(`Couldn’t save the rotation: ${err}`, 4500); return; }
  } catch (e) { toast(`Couldn’t save the rotation: ${(e as Error).message}`, 4500); return; }
  // turned again while saving: that part is still to do
  const left = (((rotations.get(path) ?? 0) - r) % 360 + 360) % 360;
  if (left) rotations.set(path, left); else rotations.delete(path);
  const st = await native.stat(path);
  const e = files.find((f) => f.path === path);
  if (e && st) { e.size = st.size; e.mtime = st.mtime; }
  cache.drop(path);
  forgetThumbs(path);
  const i = files.findIndex((f) => f.path === path);
  if (i >= 0 && filmRow.children[i]) { const cell = filmRow.children[i] as HTMLElement; cell.querySelector('img')!.classList.remove('loaded'); observeThumb(cell, files[i], THUMB); }
  // reload the turned file; it looks the same as the turned view, so nothing jumps
  if (current()?.path === path) showIndex(index);
  if (left) rotTimers.set(path, window.setTimeout(() => saveRotation(path), 700));
}

async function deleteCurrent() {
  const e = current();
  if (!e) return;
  if (settings.confirmDelete) {
    const dont = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const body = h('div', {}, h('p', { class: 'lead' }, `${e.name} will be moved to the Recycle Bin.`), h('label', { class: 'check' }, dont, 'Don’t ask me again'));
    const r = await modal('Delete this photo?', body, [{ label: 'Cancel', value: '' }, { label: 'Delete', value: 'yes', primary: true }], { width: 400 });
    if (r !== 'yes') return;
    if (dont.checked) { settings.confirmDelete = false; saveSettings(); }
  }
  const err = await native.trash(e.path);
  if (err) { toast(`Couldn’t delete: ${err}`, 4000); return; }
  cache.drop(e.path);
  forgetThumbs(e.path);
  rotations.delete(e.path);
  const i = files.indexOf(e);
  if (i >= 0) files.splice(i, 1);
  buildFilmstrip();
  if (!grid.hidden) buildGrid();
  if (!files.length) { showStart(); return; }
  showIndex(Math.min(i, files.length - 1));
}

async function fullPhoto(): Promise<Photo | null> {
  const e = current();
  if (!e || !photo) return null;
  if (!photo.preview) return photo;
  try { return await cache.get(e); } catch { return null; }
}

async function copyPhoto() {
  const p = await fullPhoto();
  if (!p) return;
  toast('Copying…', 60000);
  const c = renderUpright(p, viewer.rotation);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  c.width = c.height = 0;
  const ok = blob && (await native.copyImage(new Uint8Array(await blob.arrayBuffer())));
  toast(ok ? 'Copied' : 'Couldn’t copy the photo');
}

async function saveACopy() {
  const p = await fullPhoto();
  if (!p) return;
  const r = await saveCopy(p, viewer.rotation, settings.copy);
  if (r) { settings.copy = r; saveSettings(); }
}

async function convertAll() {
  if (!files.some((f) => isHeif(f.path))) { toast('There are no HEIC photos in this folder.'); return; }
  const n = await convertFolder(files, folder, settings.copy);
  if (n) relist();
}

async function editInPhoton() {
  const e = current();
  if (!e) return;
  if (isHeif(e.path)) { toast('Photon can’t open HEIC photos yet. Save a copy as JPEG (Ctrl+S) and edit that.', 4500); return; }
  if (!(await native.edit(e.path))) toast('Editing in Photon works when Opal runs from Crystal Suite.', 4000);
}

// ---------- full screen and slideshow ----------
let fullscreen = false;
let slideshow = false;
let slidePaused = false;
let slideTimer = 0;
let fsForSlideshow = false;

native.onFullscreen((on) => {
  fullscreen = on;
  document.body.classList.toggle('fs', on);
  bFull.replaceChildren(icon(on ? 'unfull' : 'full'));
  bFull.title = on ? 'Exit full screen (F11)' : 'Full screen (F11)';
  if (!on && slideshow) stopSlideshow();
});
function toggleFullscreen() { native.setFullscreen(!fullscreen); }

function startSlideshow() {
  if (files.length < 1 || slideshow) return;
  slideshow = true;
  slidePaused = false;
  document.body.classList.add('slideshow');
  toggleGrid(false);
  if (!fullscreen) { fsForSlideshow = true; native.setFullscreen(true); }
  toast('Slideshow – Space pauses, Esc ends', 2200);
  scheduleSlide();
}
function scheduleSlide() {
  clearTimeout(slideTimer);
  if (slideshow && !slidePaused) slideTimer = window.setTimeout(() => { go(1, true); scheduleSlide(); }, settings.slideSeconds * 1000);
}
function stopSlideshow() {
  if (!slideshow) return;
  slideshow = false;
  clearTimeout(slideTimer);
  document.body.classList.remove('slideshow');
  if (fsForSlideshow && fullscreen) native.setFullscreen(false);
  fsForSlideshow = false;
}

// chrome hides itself in full screen until the mouse moves
let idleTimer = 0;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (fullscreen) idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 2200);
});

// ---------- start screen ----------
async function showStart() {
  index = -1;
  if (photo && !cache.holds(photo)) photo.dispose();
  photo = null;
  cache.shown = null;
  viewer.show(null);
  message.hidden = true;
  setBusy(false);
  toggleGrid(false);
  updateChrome();
  updateFilmVisibility();
  clear(start);
  const open = h('button', { class: 'btn primary big' }, icon('open', 20), 'Open a photo');
  open.addEventListener('click', () => openDialog());
  const wrap = h('div', { class: 'start-in' },
    h('div', { class: 'logo' }, 'Op'), h('h1', {}, 'Opal'), h('p', { class: 'sub' }, 'HEIC, JPEG, PNG, WebP, AVIF, GIF and more. Drop a photo here or open one.'), open);
  const recent = await native.recent();
  if (recent.length) {
    const list = h('div', { class: 'recent' });
    for (const r of recent.slice(0, 8)) {
      const st = await native.stat(r.path);
      if (!st) continue;
      const e: PhotoEntry = { path: r.path, name: baseName(r.path), size: st.size, mtime: st.mtime };
      const card = h('button', { class: 'rcard', title: r.path }, h('div', { class: 'rthumb' }, h('img', { alt: '' })), h('div', { class: 'rname' }, baseName(dirName(r.path)) || dirName(r.path)), h('div', { class: 'rsub' }, e.name));
      card.addEventListener('click', () => openPath(r.path));
      thumbUrl(e, THUMB).promise.then((u) => { if (u) { const img = card.querySelector('img')!; img.src = u; img.onload = () => img.classList.add('loaded'); } });
      list.append(card);
    }
    if (list.children.length) wrap.append(h('div', { class: 'recent-head' }, 'Recent'), list);
  }
  const d = await native.defaultStatus().catch(() => null);
  const about = await native.about();
  if (d?.supported && !d.isDefault && !about.standalone) {
    const link = h('a', { class: 'link', href: '#' }, 'Make Opal your default photo viewer');
    link.addEventListener('click', (ev) => { ev.preventDefault(); native.makeDefault(); });
    wrap.append(h('div', { class: 'start-foot' }, link));
  }
  if (current()) return; // a photo opened meanwhile
  start.append(wrap);
  start.hidden = false;
  app.classList.add('empty');
}
function hideStart() { start.hidden = true; app.classList.remove('empty'); }

async function openDialog() {
  const p = await native.openDialog();
  if (p) openPath(p);
}

// ---------- menus ----------
function moreMenu(): MenuItem[] {
  const has = () => !!current() && !!photo;
  const sort = (s: Settings['sort']): MenuItem => ({ label: { name: 'Name', date: 'Date modified', size: 'Size' }[s], checked: () => settings.sort === s, run: () => { settings.sort = s; saveSettings(); relist(); } });
  return [
    { label: 'Open…', key: 'Ctrl+O', run: () => openDialog() },
    { label: 'Save a copy…', key: 'Ctrl+S', enabled: has, run: () => saveACopy() },
    { label: 'Convert HEIC photos in this folder…', enabled: () => files.some((f) => isHeif(f.path)), run: () => convertAll() },
    { sep: true },
    { label: 'Copy', key: 'Ctrl+C', enabled: has, run: () => copyPhoto() },
    { label: 'Edit in Photon', key: 'Ctrl+E', enabled: has, run: () => editInPhoton() },
    { label: 'Show in folder', enabled: () => !!current(), run: () => native.showInFolder(current()!.path) },
    { sep: true },
    { label: 'Sort by', submenu: () => [sort('name'), sort('date'), sort('size'), { sep: true }, { label: 'Descending', checked: () => settings.desc, run: () => { settings.desc = !settings.desc; saveSettings(); relist(); } }] },
    { label: 'Mouse wheel', submenu: () => (['zoom', 'navigate'] as WheelMode[]).map((m) => ({ label: m === 'zoom' ? 'Zooms' : 'Goes to the next or previous photo', checked: () => settings.wheel === m, run: () => { settings.wheel = m; viewer.wheelMode = m; saveSettings(); } })) },
    { label: 'Slideshow speed', submenu: () => [2, 4, 8, 15].map((s) => ({ label: `${s} seconds`, checked: () => settings.slideSeconds === s, run: () => { settings.slideSeconds = s; saveSettings(); } })) },
    { label: 'Ask before deleting', checked: () => settings.confirmDelete, run: () => { settings.confirmDelete = !settings.confirmDelete; saveSettings(); } },
    { sep: true },
    { label: 'Make Opal your default photo viewer…', run: async () => { if (!(await native.makeDefault())) toast('That needs Opal installed from Crystal Suite.'); } },
    { label: 'About Opal', run: () => about() },
  ];
}

function photoMenu(): MenuItem[] {
  const has = () => !!photo;
  return [
    { label: 'Copy', key: 'Ctrl+C', enabled: has, run: () => copyPhoto() },
    { label: 'Save a copy…', key: 'Ctrl+S', enabled: has, run: () => saveACopy() },
    { sep: true },
    { label: 'Rotate right', key: 'Ctrl+R', enabled: has, run: () => rotate(90) },
    { label: 'Rotate left', key: 'Ctrl+L', enabled: has, run: () => rotate(-90) },
    { sep: true },
    { label: 'Edit in Photon', key: 'Ctrl+E', enabled: has, run: () => editInPhoton() },
    { label: 'Show in folder', enabled: () => !!current(), run: () => native.showInFolder(current()!.path) },
    { label: 'Details', key: 'I', checked: () => settings.info, run: () => toggleInfo() },
    { sep: true },
    { label: 'Delete', key: 'Del', enabled: () => !!current(), run: () => deleteCurrent() },
  ];
}
stage.addEventListener('contextmenu', (e) => { if (current()) contextMenu(e, photoMenu()); });

async function about() {
  const a = await native.about();
  await alertBox('About Opal', `Opal ${a.version} – a photo viewer from Crystal Suite.\n\nHEIC photos are decoded with libheif and libde265 (LGPL 3.0), which ship as separate files in Opal’s folder. Photo details are read with exifr (MIT).\n\nElectron ${a.electron} · Chromium ${a.chrome}`);
}

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (isTyping() || document.querySelector('.modal-back')) return;
  const combo = comboOf(e);
  const has = !!current();
  const run = (fn: () => void) => { e.preventDefault(); closeMenus(); fn(); };
  if (slideshow) {
    if (combo === 'Escape') return run(() => stopSlideshow());
    if (combo === 'Space') return run(() => { slidePaused = !slidePaused; toast(slidePaused ? 'Paused' : 'Playing', 1000); scheduleSlide(); });
    if (combo === 'ArrowRight' || combo === 'ArrowLeft') return run(() => { go(combo === 'ArrowRight' ? 1 : -1, true); scheduleSlide(); });
    return;
  }
  switch (combo) {
    case 'ArrowRight': case 'ArrowLeft': case 'ArrowUp': case 'ArrowDown': {
      if (!grid.hidden) return;
      // zoomed in, the arrows look around the photo; otherwise left/right step through the folder
      if (viewer.zoomedIn) { const s = 90; return run(() => viewer.pan(combo === 'ArrowLeft' ? s : combo === 'ArrowRight' ? -s : 0, combo === 'ArrowUp' ? s : combo === 'ArrowDown' ? -s : 0)); }
      if (combo === 'ArrowRight') return run(() => go(1));
      if (combo === 'ArrowLeft') return run(() => go(-1));
      return;
    }
    case 'PageDown': case 'Space': return run(() => go(1));
    case 'PageUp': case 'Backspace': return run(() => go(-1));
    case 'Home': return run(() => showIndex(0));
    case 'End': return run(() => showIndex(files.length - 1));
    case '+': case '=': case 'Ctrl+=': case 'Ctrl++': case 'Shift++': return run(() => viewer.step(1));
    case '-': case 'Ctrl+-': return run(() => viewer.step(-1));
    case '0': case 'Ctrl+0': return run(() => viewer.fit());
    case '1': case 'Ctrl+1': return run(() => viewer.zoomTo(1));
    case 'Ctrl+R': return has ? run(() => rotate(90)) : undefined;
    case 'Ctrl+L': case 'Ctrl+Shift+R': return has ? run(() => rotate(-90)) : undefined;
    case 'Delete': return has ? run(() => deleteCurrent()) : undefined;
    case 'Ctrl+C': return has ? run(() => copyPhoto()) : undefined;
    case 'Ctrl+S': case 'Ctrl+Shift+S': return has ? run(() => saveACopy()) : undefined;
    case 'Ctrl+E': return has ? run(() => editInPhoton()) : undefined;
    case 'Ctrl+O': return run(() => openDialog());
    case 'Ctrl+W': return run(() => window.close());
    case 'I': case 'Alt+Enter': return has ? run(() => toggleInfo()) : undefined;
    case 'F': return has ? run(() => toggleFilmstrip()) : undefined;
    case 'G': return has ? run(() => toggleGrid()) : undefined;
    case 'F5': return has ? run(() => startSlideshow()) : undefined;
    case 'F11': return run(() => toggleFullscreen());
    case 'Enter': return !grid.hidden ? undefined : run(() => toggleFullscreen());
    case 'Escape':
      if (!grid.hidden) return run(() => toggleGrid(false));
      if (fullscreen) return run(() => native.setFullscreen(false));
      return;
  }
});

// ---------- drag and drop ----------
window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; app.classList.add('dropping'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) app.classList.remove('dropping'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  app.classList.remove('dropping');
  const f = e.dataTransfer?.files?.[0];
  const p = f ? native.pathForFile(f) : '';
  if (p) openPath(p);
});

// ---------- start ----------
native.onOpen((p) => { stopSlideshow(); openPath(p); });
(async () => {
  Object.assign(settings, await native.settings());
  viewer.wheelMode = settings.wheel;
  bFilm.classList.toggle('on', settings.filmstrip);
  bInfo.classList.toggle('on', settings.info);
  infoPanel.hidden = !settings.info;
  // a photo passed on the command line arrives right after load: don't flash the start screen first
  setTimeout(() => { if (!current() && !opening) showStart(); }, 150);
})();
(window as unknown as { opal: unknown }).opal = { openPath, showIndex, viewer, state: () => ({ folder, files, index, photo, rotations: [...rotations] }), rotate, go, toggleGrid, toggleInfo, startSlideshow, stopSlideshow };
