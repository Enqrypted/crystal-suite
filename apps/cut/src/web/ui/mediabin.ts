// Project Media: everything imported into the project. Drag items to the timeline, double-click to add
// at the cursor, relink files that went missing.
import { store } from '../core/store';
import { media } from '../core/media';
import * as edit from '../core/edit';
import { native, fileName } from '../core/native';
import { shortTime } from '../core/timecode';
import { h, clear } from './dom';
import { icon } from './icons';
import { contextMenu } from './menu';
import { confirm } from './dialog';
import type { MediaItem } from '../core/model';

export class MediaBin {
  readonly el: HTMLElement;
  private grid: HTMLElement;
  private count: HTMLElement;
  private selected: string | null = null;
  private sig = '';
  /** Set by the app. */
  onImport: () => void = () => {};
  onDragMedia: (ids: string[] | null) => void = () => {};
  onImportFiles: (paths: string[]) => void = () => {};

  constructor() {
    this.count = h('span', { class: 'count' });
    const importBtn = h('button', { class: 'small-btn', html: `<span style="display:inline-flex;gap:6px;align-items:center">${icon('import', 14)}Import Media…</span>` });
    importBtn.addEventListener('click', () => this.onImport());
    this.grid = h('div', { class: 'bin' });
    this.el = h('div', {}, h('div', { class: 'bin-tools' }, importBtn, this.count), this.grid);
    this.el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); this.el.classList.add('drop-target'); } });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop-target'));
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop-target');
      const files = [...(e.dataTransfer?.files ?? [])].map((f) => native.pathForFile(f)).filter(Boolean);
      if (!files.length) return;
      e.preventDefault();
      this.onImportFiles(files);
    });
    store.on((t) => { if (t.has('project') || t.has('media')) this.render(); });
    this.render();
  }

  private render() {
    const list = store.project.media;
    const sig = list.map((m) => `${m.id}:${media.get(m.id)?.status}:${!!media.get(m.id)?.poster}:${m.path}`).join('|') + this.selected;
    this.count.textContent = list.length ? `${list.length} item${list.length === 1 ? '' : 's'}` : '';
    if (sig === this.sig) return;
    this.sig = sig;
    clear(this.grid);
    if (!list.length) {
      this.grid.append(h('div', { class: 'bin-empty', style: 'grid-column:1/-1', html: '<b>No media yet</b>Import video, audio or images, or drag files from Explorer into this panel or straight onto the timeline.' }));
      return;
    }
    for (const m of list) this.grid.append(this.item(m));
  }

  private item(m: MediaItem) {
    const r = media.get(m.id);
    const offline = !r || r.status === 'offline' || r.status === 'error';
    const thumb = h('div', { class: 'thumb' });
    if (r?.poster) {
      const c = h('canvas') as HTMLCanvasElement;
      c.width = r.poster.width;
      c.height = r.poster.height;
      c.getContext('2d')!.drawImage(r.poster, 0, 0);
      thumb.append(c);
    } else thumb.innerHTML = offline ? `${icon('close', 22)}` : icon(m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : 'film', 26);
    thumb.append(h('span', { class: 'kind', html: icon(m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : m.hasAudio ? 'film' : 'video', 13) }));
    if (m.kind !== 'image') thumb.append(h('span', { class: 'dur' }, shortTime(m.duration)));
    const sub = offline ? 'Offline — double-click to relink'
      : m.kind === 'audio' ? `${(m.sampleRate / 1000).toFixed(1)} kHz · ${m.channels === 1 ? 'mono' : 'stereo'}`
        : m.kind === 'image' ? `${m.width}×${m.height} image` : `${m.width}×${m.height} · ${+m.fps.toFixed(2)} fps`;
    const el = h('div', { class: `mitem${offline ? ' offline' : ''}${this.selected === m.id ? ' sel' : ''}`, draggable: offline ? 'false' : 'true', title: m.path },
      thumb, h('div', { class: 'meta' }, h('div', { class: 'nm' }, m.name), h('div', { class: 'sub' }, sub)));
    el.addEventListener('click', () => { this.selected = m.id; this.grid.querySelectorAll('.mitem.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); });
    el.addEventListener('dblclick', () => (offline ? this.relink(m) : edit.addMedia([m], store.time, store.activeTrack)));
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('application/x-cut-media', m.id);
      e.dataTransfer!.effectAllowed = 'copy';
      this.onDragMedia([m.id]);
    });
    el.addEventListener('dragend', () => this.onDragMedia(null));
    el.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Add at Cursor', enabled: () => !offline, run: () => edit.addMedia([m], store.time, store.activeTrack) },
      { label: 'Relink File…', run: () => this.relink(m) },
      { label: 'Show in Folder', enabled: () => !offline, run: () => native.showInFolder(m.path) },
      { sep: true },
      { label: 'Remove from Project…', run: () => this.remove(m) },
    ]));
    return el;
  }

  private async relink(m: MediaItem) {
    const paths = await native.openMedia();
    if (!paths[0]) return;
    await media.relink(m.id, paths[0]);
    store.commit('Relink Media', (p) => { const x = p.media.find((y) => y.id === m.id); if (x) { x.path = paths[0]; x.name = fileName(paths[0]); } });
  }

  private async remove(m: MediaItem) {
    const used = store.project.clips.filter((c) => c.mediaId === m.id).length;
    if (used && !(await confirm('Remove media', `"${m.name}" is used by ${used} event${used === 1 ? '' : 's'} on the timeline. Remove it and those events?`, 'Remove'))) return;
    edit.removeMedia(m.id);
    media.release(m.id);
  }
}
