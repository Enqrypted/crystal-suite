// The Facet window: your widgets with live editors, settings, and Organize Desktop.
import type { Category, ClockWidget, DesktopEntry, FolderWidget, OrganizeGroup, State, Widget } from '../shared/types';
import { api } from './lib/api';
import { h, clear } from './lib/dom';
import { ClockView, FACES } from './lib/clock';
import { clockEditor, folderEditor } from './lib/editors';
import { toggle, segmented } from './lib/controls';
import { ICONS, itemImage } from './lib/ui';

let state: State;
let selected = 'settings';
const listEl = document.getElementById('list')!;
const detailEl = document.getElementById('detail')!;
let detailFor = '';
let preview: ClockView | null = null;
let stageObserver: ResizeObserver | null = null;

const describe = (w: Widget) => w.type === 'clock'
  ? `Clock · ${FACES.find((f) => f.id === w.face)?.label ?? ''}`
  : `${w.style === 'panel' ? 'Panel' : 'Folder'} · ${w.items.length} item${w.items.length === 1 ? '' : 's'}`;
const titleOf = (w: Widget) => (w.type === 'clock' ? 'Clock' : w.name);

function renderList() {
  clear(listEl);
  listEl.append(h('div', { class: 'list-head', text: 'On your desktop' }));
  if (!state.widgets.length) listEl.append(h('div', { class: 'list-empty', text: 'No widgets yet. Add a folder or a clock above.' }));
  const multi = state.displays.length > 1;
  for (const w of state.widgets) {
    const disp = state.displays.find((d) => d.id === w.display);
    const icon = h('div', { class: `row-icon ${w.type}` });
    if (w.type === 'clock') icon.innerHTML = ICONS.clock;
    else {
      const mini = h('div', { class: 'row-mini' });
      for (let i = 0; i < 4; i++) mini.append(w.items[i] ? itemImage(w.items[i].path, 'rm') : h('div', { class: 'rm empty' }));
      icon.append(mini);
    }
    const row = h('button', { type: 'button', class: `row${selected === w.id ? ' on' : ''}` }, icon,
      h('div', { class: 'row-text' }, h('div', { class: 'row-title', text: titleOf(w) }), h('div', { class: 'row-sub', text: describe(w) + (multi ? ` · ${disp?.label ?? 'Main display'}` : '') })));
    row.addEventListener('click', () => select(w.id));
    listEl.append(row);
  }
  listEl.append(h('div', { class: 'grow' }));
  const settingsRow = h('button', { type: 'button', class: `row row-settings${selected === 'settings' ? ' on' : ''}` }, h('div', { class: 'row-icon', html: ICONS.gear }), h('div', { class: 'row-text' }, h('div', { class: 'row-title', text: 'Settings' })));
  settingsRow.addEventListener('click', () => select('settings'));
  listEl.append(settingsRow);
}

function select(id: string) {
  selected = id;
  renderList();
  renderDetail(true);
  const w = state.widgets.find((x) => x.id === id);
  if (w) api.command({ kind: 'flash', id });
}

function renderDetail(force = false) {
  const w = state.widgets.find((x) => x.id === selected);
  if (!w && selected !== 'settings') selected = 'settings';
  const key = w ? `${w.id}` : 'settings';
  if (!force && key === detailFor) {
    // keep the editor (and any field being typed in); refresh what's derived from the state
    if (w?.type === 'folder') refreshItems(w);
    if (selected === 'settings') renderSettings();
    return;
  }
  detailFor = key;
  preview?.destroy();
  preview = null;
  stageObserver?.disconnect();
  stageObserver = null;
  clear(detailEl);
  if (!w) { renderSettings(); return; }
  if (w.type === 'clock') renderClock(structuredClone(w));
  else renderFolder(structuredClone(w));
}

function head(title: string, sub: string, actions: HTMLElement[]) {
  return h('div', { class: 'd-head' }, h('div', {}, h('h2', { text: title }), h('div', { class: 'd-sub', text: sub })), h('div', { class: 'd-actions' }, ...actions));
}

function removeButton(w: Widget) {
  const b = h('button', { type: 'button', class: 'btn ghost danger', html: `${ICONS.trash}<span>Remove</span>` });
  b.addEventListener('click', () => {
    if (w.type === 'folder' && w.items.length && !confirm(`Remove the folder "${w.name}"? Your files and apps are not deleted.`)) return;
    api.remove(w.id);
  });
  return b;
}

function renderClock(w: ClockWidget) {
  preview = new ClockView(w);
  const inner = h('div', { class: 'stage-inner' }, preview.el);
  const stage = h('div', { class: 'stage' }, inner);
  // the preview shows the clock at its real size, scaled down only when it doesn't fit
  const fit = () => {
    inner.style.transform = '';
    const k = Math.min(1, (stage.clientWidth - 40) / Math.max(1, inner.offsetWidth), (stage.clientHeight - 40) / Math.max(1, inner.offsetHeight));
    inner.style.transform = k < 1 ? `scale(${k})` : '';
  };
  stageObserver = new ResizeObserver(fit);
  stageObserver.observe(stage);
  stageObserver.observe(preview.el);
  const editor = clockEditor(w, () => { preview!.set({ ...w }); preview!.el.classList.toggle('glass', w.bg !== 'none'); api.put(w); });
  preview.el.classList.toggle('glass', w.bg !== 'none');
  detailEl.append(
    head('Clock', 'Changes show on your desktop as you make them.', [removeButton(w)]),
    h('div', { class: 'clock-layout' }, stage, h('div', { class: 'card' }, editor)),
  );
}

let itemsEl: HTMLElement | null = null;

function renderFolder(w: FolderWidget) {
  itemsEl = h('div', { class: 'items' });
  const add = (kind: 'files' | 'folder') => async () => { const p = await api.pick(kind); if (p.length) api.addItems(w.id, p); };
  const b1 = h('button', { type: 'button', class: 'btn', html: `${ICONS.plus}<span>Apps or files…</span>` });
  const b2 = h('button', { type: 'button', class: 'btn', html: `${ICONS.folder}<span>Folder…</span>` });
  const b3 = h('button', { type: 'button', class: 'btn', html: `${ICONS.desktop}<span>From desktop…</span>` });
  const b4 = h('button', { type: 'button', class: 'btn ghost', html: `${ICONS.sort}<span>Sort A–Z</span>` });
  b1.addEventListener('click', add('files'));
  b2.addEventListener('click', add('folder'));
  b3.addEventListener('click', () => desktopPicker(w.id));
  b4.addEventListener('click', () => {
    const f = state.widgets.find((x) => x.id === w.id) as FolderWidget | undefined;
    if (!f) return;
    f.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    api.put(f);
  });
  const itemsCard = h('div', { class: 'card items-card' },
    h('div', { class: 'card-head' }, h('div', { class: 'fl', text: 'Shortcuts' }), h('div', { class: 'tools' }, b1, b2, b3, b4)),
    itemsEl);
  // drop files from Explorer onto the list
  itemsCard.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); itemsCard.classList.add('drop'); } });
  itemsCard.addEventListener('dragleave', (e) => { if (!itemsCard.contains(e.relatedTarget as Node)) itemsCard.classList.remove('drop'); });
  itemsCard.addEventListener('drop', (e) => {
    itemsCard.classList.remove('drop');
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => api.pathForFile(f)).filter(Boolean);
    if (files.length) { e.preventDefault(); api.addItems(w.id, files); }
  });
  const editor = folderEditor(w, () => {
    // merge appearance changes into the latest state (items may have changed meanwhile)
    const cur = state.widgets.find((x) => x.id === w.id) as FolderWidget | undefined;
    if (!cur) return;
    const { items: _items, ...look } = w;
    api.put({ ...cur, ...look, items: cur.items });
    detailEl.querySelector('h2')!.textContent = w.name;
  });
  const open = h('button', { type: 'button', class: 'btn ghost', html: `${ICONS.open}<span>Show on desktop</span>` });
  open.addEventListener('click', () => api.command({ kind: 'flash', id: w.id }));
  detailEl.append(
    head(w.name, 'Drop apps, shortcuts, files or folders here, or onto the folder on your desktop.', [open, removeButton(w)]),
    h('div', { class: 'folder-layout' }, itemsCard, h('div', { class: 'card' }, editor)),
  );
  refreshItems(w);
}

function refreshItems(w: FolderWidget) {
  if (!itemsEl) return;
  const sig = JSON.stringify(w.items);
  if (itemsEl.dataset.sig === sig) return;
  itemsEl.dataset.sig = sig;
  clear(itemsEl);
  if (!w.items.length) { itemsEl.append(h('div', { class: 'items-empty', html: `${ICONS.plus}<div>This folder is empty</div><span>Add apps, files or folders with the buttons above, or drag them in from Explorer or your desktop.</span>` })); return; }
  for (const it of w.items) {
    const name = h('input', { type: 'text', class: 'item-name', value: it.name, spellcheck: 'false', maxlength: '80' }) as HTMLInputElement;
    name.addEventListener('change', () => {
      const f = state.widgets.find((x) => x.id === w.id) as FolderWidget | undefined;
      const item = f?.items.find((x) => x.id === it.id);
      if (!f || !item || !name.value.trim()) { name.value = it.name; return; }
      item.name = name.value.trim();
      api.put(f);
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    const reveal = h('button', { type: 'button', class: 'icon-btn', title: 'Show in folder', html: ICONS.reveal });
    reveal.addEventListener('click', () => api.reveal(it.path));
    const del = h('button', { type: 'button', class: 'icon-btn', title: 'Remove from folder', html: ICONS.close });
    del.addEventListener('click', () => {
      const f = state.widgets.find((x) => x.id === w.id) as FolderWidget | undefined;
      if (!f) return;
      f.items = f.items.filter((x) => x.id !== it.id);
      api.put(f);
    });
    const launch = h('button', { type: 'button', class: 'item-icon', title: 'Open' }, itemImage(it.path));
    launch.addEventListener('click', () => api.open(it.path));
    itemsEl.append(h('div', { class: 'item' }, launch, h('div', { class: 'item-text' }, name, h('div', { class: 'item-path', text: it.path })), reveal, del));
  }
}

function renderSettings() {
  const s = state.settings;
  const build = () => {
    const body = h('div', { class: 'settings' });
    const opt = (title: string, sub: string, control: HTMLElement) => h('div', { class: 'opt' }, h('div', { class: 'opt-text' }, h('div', { class: 'opt-title', text: title }), h('div', { class: 'opt-sub', text: sub })), control);
    const sw = (value: boolean, fn: (v: boolean) => void) => { const t = toggle('', value, fn); t.classList.add('bare'); return t; };
    if (!state.standalone) body.append(opt('Start with Windows', 'Your folders and clock appear as soon as you sign in.', sw(s.startup, (v) => api.settings({ startup: v }))));
    body.append(
      opt('Windows desktop icons', state.iconsVisible === null ? 'Available when Facet’s helper is running.' : 'Hide them once your shortcuts live in folders — your files stay where they are.',
        state.iconsVisible === null ? h('span', { class: 'muted', text: 'Unavailable' }) : sw(state.iconsVisible, (v) => api.desktopIcons(v))),
      opt('Lock widgets', 'Stops folders and clocks from being moved by accident.', sw(s.lock, (v) => api.settings({ lock: v }))),
      opt('Glass', 'The frosted look of folders and panels.', segmented([{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }] as const, s.glass, (glass) => api.settings({ glass }))),
      opt('Names under icons', 'Show folder and shortcut names on the desktop.', sw(s.labels, (v) => api.settings({ labels: v }))),
    );
    const quit = h('button', { type: 'button', class: 'btn ghost', text: 'Quit Facet' });
    quit.addEventListener('click', () => api.quit());
    return h('div', {},
      head('Settings', `Facet ${state.version} · keeps running in the system tray (the arrow next to the Windows clock).`, [quit]),
      h('div', { class: 'card' }, body),
      h('p', { class: 'note', html: 'Right-click a folder or clock on your desktop for more options. Click a folder to open it, drag to move it, and drop files on it to add shortcuts.' }),
    );
  };
  clear(detailEl);
  detailEl.append(build());
}

// ---------- Organize Desktop ----------

const CATS: { id: Category; name: string }[] = [
  { id: 'apps', name: 'Apps' }, { id: 'games', name: 'Games' }, { id: 'folders', name: 'Folders' }, { id: 'documents', name: 'Documents' },
  { id: 'pictures', name: 'Pictures' }, { id: 'videos', name: 'Videos' }, { id: 'music', name: 'Music' }, { id: 'archives', name: 'Archives' },
  { id: 'web', name: 'Web' }, { id: 'other', name: 'Other' },
];

async function organize() {
  const entries: DesktopEntry[] = await api.desktop();
  const inFolders = new Set(state.widgets.flatMap((w) => (w.type === 'folder' ? w.items.map((i) => i.path.toLowerCase()) : [])));
  const fresh = entries.filter((e) => !inFolders.has(e.path.toLowerCase()));
  const groups = CATS.map((c) => ({ ...c, items: fresh.filter((e) => e.category === c.id), on: true, label: c.name, style: 'tile' as const }))
    .filter((g) => g.items.length);
  const sheet = h('div', { class: 'sheet' });
  const scrim = h('div', { class: 'scrim' }, sheet);
  document.body.append(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  let hideIcons = state.iconsVisible === true;
  const hide = toggle('Hide the Windows desktop icons afterwards', hideIcons, (v) => { hideIcons = v; });
  const create = h('button', { type: 'button', class: 'btn primary' });
  const cancel = h('button', { type: 'button', class: 'btn', text: 'Cancel' });
  cancel.addEventListener('click', close);
  const count = () => { const n = groups.filter((g) => g.on).length; create.textContent = n ? `Create ${n} folder${n === 1 ? '' : 's'}` : 'Create folders'; create.toggleAttribute('disabled', !n); };
  const list = h('div', { class: 'org-list' });
  for (const g of groups) {
    const check = h('button', { type: 'button', class: 'check on', html: ICONS.check });
    const name = h('input', { type: 'text', class: 'text org-name', value: g.label, maxlength: '60', spellcheck: 'false' }) as HTMLInputElement;
    name.addEventListener('input', () => { g.label = name.value.trim() || g.name; });
    const icons = h('div', { class: 'org-icons' }, ...g.items.slice(0, 10).map((e) => itemImage(e.path, 'oi')));
    if (g.items.length > 10) icons.append(h('span', { class: 'more', text: `+${g.items.length - 10}` }));
    const card = h('div', { class: 'org' }, check, h('div', { class: 'org-main' }, h('div', { class: 'org-top' }, name, h('span', { class: 'muted', text: `${g.items.length} item${g.items.length === 1 ? '' : 's'}` })), icons));
    check.addEventListener('click', () => { g.on = !g.on; check.classList.toggle('on', g.on); card.classList.toggle('off', !g.on); count(); });
    list.append(card);
  }
  create.addEventListener('click', async () => {
    const plan: OrganizeGroup[] = groups.filter((g) => g.on).map((g) => ({ name: g.label, paths: g.items.map((e) => e.path), style: g.style }));
    create.setAttribute('disabled', '');
    await api.organize(plan, hideIcons);
    close();
  });
  sheet.append(
    h('h2', { text: 'Organize your desktop' }),
    h('p', { class: 'd-sub', text: groups.length
      ? 'Facet sorts what’s on your desktop into folders. Nothing is moved or deleted: the folders hold shortcuts to your files, and you can rename them here or later.'
      : entries.length ? 'Everything on your desktop is already in a Facet folder.' : 'Your desktop is empty — nothing to organize.' }),
    list,
    groups.length ? hide : '',
    h('div', { class: 'btns' }, cancel, ...(groups.length ? [create] : [])),
  );
  count();
}

async function desktopPicker(folderId: string) {
  const f = state.widgets.find((x) => x.id === folderId) as FolderWidget | undefined;
  if (!f) return;
  const entries: DesktopEntry[] = await api.desktop();
  const have = new Set(f.items.map((i) => i.path.toLowerCase()));
  const chosen = new Set<string>();
  const sheet = h('div', { class: 'sheet wide' });
  const scrim = h('div', { class: 'scrim' }, sheet);
  document.body.append(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  const add = h('button', { type: 'button', class: 'btn primary', text: 'Add', disabled: true });
  const cancel = h('button', { type: 'button', class: 'btn', text: 'Cancel' });
  cancel.addEventListener('click', close);
  const grid = h('div', { class: 'pick-grid' });
  for (const e of entries) {
    const already = have.has(e.path.toLowerCase());
    const b = h('button', { type: 'button', class: `pick${already ? ' have' : ''}`, disabled: already, title: e.path }, itemImage(e.path), h('div', { class: 'name', text: e.name }), h('span', { class: 'tick', html: ICONS.check }));
    b.addEventListener('click', () => {
      if (chosen.has(e.path)) chosen.delete(e.path); else chosen.add(e.path);
      b.classList.toggle('on', chosen.has(e.path));
      add.textContent = chosen.size ? `Add ${chosen.size}` : 'Add';
      add.toggleAttribute('disabled', !chosen.size);
    });
    grid.append(b);
  }
  add.addEventListener('click', async () => { await api.addItems(folderId, [...chosen]); close(); });
  sheet.append(h('h2', { text: `Add to ${f.name}` }), h('p', { class: 'd-sub', text: 'Pick shortcuts and files from your desktop.' }), entries.length ? grid : h('p', { class: 'muted', text: 'Your desktop is empty.' }), h('div', { class: 'btns' }, cancel, add));
}

// ---------- header ----------

document.getElementById('add-folder')!.addEventListener('click', async () => { const id = await api.add('folder'); if (id) setTimeout(() => select(id), 50); });
document.getElementById('add-clock')!.addEventListener('click', async () => { const id = await api.add('clock'); if (id) setTimeout(() => select(id), 50); });
document.getElementById('organize')!.addEventListener('click', organize);

(async () => {
  api.onState((s: State) => {
    state = s;
    renderList();
    renderDetail();
  });
  api.onCommand((c) => { if (c.kind === 'organize') organize(); });
  const init = await api.init();
  state = init.state;
  if (state.widgets.length && !state.widgets.some((w) => w.type === 'folder')) selected = 'settings';
  renderList();
  renderDetail(true);
  document.body.classList.add('ready');
})();
