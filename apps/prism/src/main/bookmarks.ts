import path from 'path';
import type { BookmarkItem } from '../shared';
import { JsonFile } from './store';
import { uid } from './util';

export class Bookmarks {
  private file: JsonFile<{ items: BookmarkItem[] }>;
  onChange: () => void = () => {};

  constructor(dataDir: string) {
    this.file = new JsonFile(path.join(dataDir, 'bookmarks.json'), () => ({ items: [] as BookmarkItem[] }));
  }

  list() { return this.file.data.items; }
  find(url: string) { return this.list().find((b) => b.url === url); }

  add(url: string, title: string) {
    const existing = this.find(url);
    if (existing) return existing;
    const b = { id: uid(), url, title: title || url, time: Date.now() };
    this.list().push(b);
    this.changed();
    return b;
  }
  /** Adds or removes a bookmark for the URL; returns whether it is bookmarked now. */
  toggle(url: string, title: string) {
    const b = this.find(url);
    if (b) { this.remove(b.id); return false; }
    this.add(url, title);
    return true;
  }
  update(id: string, patch: { title?: string; url?: string }) {
    const b = this.list().find((x) => x.id === id);
    if (!b) return;
    if (typeof patch.title === 'string') b.title = patch.title.slice(0, 500);
    if (typeof patch.url === 'string' && patch.url.trim()) b.url = patch.url.trim();
    this.changed();
  }
  remove(id: string) {
    this.file.data.items = this.list().filter((b) => b.id !== id);
    this.changed();
  }
  move(id: string, index: number) {
    const items = this.list();
    const i = items.findIndex((b) => b.id === id);
    if (i < 0) return;
    const [b] = items.splice(i, 1);
    items.splice(Math.max(0, Math.min(items.length, index)), 0, b);
    this.changed();
  }
  private changed() {
    this.file.save();
    this.onChange();
  }
  flush() { this.file.flush(); }
}
