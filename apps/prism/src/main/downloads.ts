import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { shell, type DownloadItem } from 'electron';
import type { DownloadRecord } from '../shared';
import { JsonFile } from './store';
import { uid } from './util';

const MAX_RECORDS = 300;

/** Picks "name.ext", "name (1).ext", ... so a download never overwrites an existing file. */
function uniquePath(dir: string, name: string) {
  const safe = (name || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'download';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let p = path.join(dir, safe);
  for (let i = 1; fs.existsSync(p) || fs.existsSync(p + '.crdownload'); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

export class Downloads extends EventEmitter {
  private file: JsonFile<{ items: DownloadRecord[] }>;
  /** Downloads from private windows are listed until Prism closes but never saved. */
  private ephemeral: DownloadRecord[] = [];
  private live = new Map<string, DownloadItem>();
  unseen = false;

  constructor(dataDir: string) {
    super();
    this.file = new JsonFile(path.join(dataDir, 'downloads.json'), () => ({ items: [] as DownloadRecord[] }));
    for (const r of this.file.data.items) if (r.state === 'progressing') r.state = 'interrupted'; // from a previous run
  }

  handle(item: DownloadItem, opts: { dir: string; ask: boolean; isPrivate: boolean }) {
    const id = uid();
    if (!opts.ask) {
      fs.mkdirSync(opts.dir, { recursive: true });
      item.setSavePath(uniquePath(opts.dir, item.getFilename()));
    }
    const rec: DownloadRecord = {
      id, url: item.getURL(), filename: item.getFilename(), path: item.getSavePath(),
      state: 'progressing', received: 0, total: item.getTotalBytes(), time: Date.now(), paused: false,
    };
    (opts.isPrivate ? this.ephemeral : this.file.data.items).unshift(rec);
    if (this.file.data.items.length > MAX_RECORDS) this.file.data.items.length = MAX_RECORDS;
    this.live.set(id, item);
    this.unseen = true;
    item.on('updated', (_e, state) => {
      rec.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      rec.paused = item.isPaused();
      const p = item.getSavePath();
      if (p) { rec.path = p; rec.filename = path.basename(p); }
      this.changed(false);
    });
    item.once('done', (_e, state) => {
      rec.state = state;
      rec.received = item.getReceivedBytes();
      rec.paused = false;
      const p = item.getSavePath();
      if (p) { rec.path = p; rec.filename = path.basename(p); }
      this.live.delete(id);
      this.changed(true);
    });
    this.changed(true);
  }

  list(): DownloadRecord[] {
    return [...this.ephemeral, ...this.file.data.items]
      .sort((a, b) => b.time - a.time)
      .map((r) => ({ ...r, exists: r.state === 'completed' ? fs.existsSync(r.path) : undefined }));
  }
  private find(id: string) { return this.ephemeral.find((r) => r.id === id) || this.file.data.items.find((r) => r.id === id); }

  /** Number of running downloads and their combined progress (-1 when sizes are unknown). */
  summary() {
    let received = 0;
    let total = 0;
    let unknown = false;
    for (const item of this.live.values()) {
      received += item.getReceivedBytes();
      const t = item.getTotalBytes();
      if (t > 0) total += t; else unknown = true;
    }
    return { active: this.live.size, progress: this.live.size && !unknown && total ? received / total : -1, unseen: this.unseen };
  }

  open(id: string) { const r = this.find(id); if (r && r.state === 'completed') shell.openPath(r.path); }
  show(id: string) { const r = this.find(id); if (r && r.path) shell.showItemInFolder(r.path); }
  cancel(id: string) { this.live.get(id)?.cancel(); }
  pause(id: string) { this.live.get(id)?.pause(); this.changed(true); }
  resume(id: string) { const i = this.live.get(id); if (i && i.canResume()) i.resume(); this.changed(true); }
  remove(id: string) {
    if (this.live.has(id)) return;
    this.ephemeral = this.ephemeral.filter((r) => r.id !== id);
    this.file.data.items = this.file.data.items.filter((r) => r.id !== id);
    this.changed(true);
  }
  clear() {
    this.ephemeral = this.ephemeral.filter((r) => this.live.has(r.id));
    this.file.data.items = this.file.data.items.filter((r) => this.live.has(r.id));
    this.changed(true);
  }
  urlOf(id: string) { return this.find(id)?.url || ''; }
  markSeen() { if (this.unseen) { this.unseen = false; this.emit('change'); } }

  private lastEmit = 0;
  private changed(force: boolean) {
    this.file.save(force ? 300 : 3000);
    const now = Date.now();
    if (force || now - this.lastEmit > 250) { this.lastEmit = now; this.emit('change'); }
  }
  flush() { this.file.flush(); }
}
