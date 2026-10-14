import path from 'path';
import type { TopSite, Visit } from '../shared';
import { JsonFile } from './store';
import { hostOf } from './util';

interface Aggregate { url: string; title: string; visits: number; last: number }
const MAX_VISITS = 20000;

/** Browsing history: a list of visits, newest last (private windows never add to it). */
export class History {
  private file: JsonFile<{ visits: Visit[] }>;
  private agg: Map<string, Aggregate> | null = null;

  constructor(dataDir: string) {
    this.file = new JsonFile(path.join(dataDir, 'history.json'), () => ({ visits: [] as Visit[] }));
  }

  get visits() { return this.file.data.visits; }

  add(url: string, title: string) {
    if (!/^(https?|file):/i.test(url)) return;
    const v = this.visits;
    const last = v[v.length - 1];
    if (last && last.url === url && Date.now() - last.time < 60000) {
      last.time = Date.now();
      if (title) last.title = title;
    } else v.push({ url, title: title || '', time: Date.now() });
    if (v.length > MAX_VISITS) v.splice(0, v.length - MAX_VISITS);
    this.changed();
  }

  setTitle(url: string, title: string) {
    const v = this.visits;
    for (let i = v.length - 1; i >= Math.max(0, v.length - 40); i--) {
      if (v[i].url === url) {
        if (title && v[i].title !== title) { v[i].title = title; this.changed(); }
        return;
      }
    }
  }

  /** One entry per URL with visit counts, for suggestions and top sites. */
  aggregate() {
    if (this.agg) return this.agg;
    const m = new Map<string, Aggregate>();
    for (const v of this.visits) {
      const a = m.get(v.url);
      if (a) { a.visits++; a.last = v.time; if (v.title) a.title = v.title; } else m.set(v.url, { url: v.url, title: v.title, visits: 1, last: v.time });
    }
    this.agg = m;
    return m;
  }

  /** Newest first, optionally filtered by text and older than `before`. */
  query(text = '', limit = 200, before = Infinity): Visit[] {
    const q = text.trim().toLowerCase();
    const out: Visit[] = [];
    const v = this.visits;
    for (let i = v.length - 1; i >= 0 && out.length < limit; i--) {
      const x = v[i];
      if (x.time >= before) continue;
      if (q && !(x.url.toLowerCase().includes(q) || x.title.toLowerCase().includes(q))) continue;
      out.push(x);
    }
    return out;
  }

  remove(entries: { url: string; time: number }[]) {
    const kill = new Set(entries.map((e) => e.url + '\n' + e.time));
    this.file.data.visits = this.visits.filter((v) => !kill.has(v.url + '\n' + v.time));
    this.changed();
  }

  clear() {
    this.file.data.visits = [];
    this.changed();
    this.file.flush();
  }

  /** Most visited sites (one tile per host, linking to its most visited page). */
  topSites(n: number, hidden: string[]): TopSite[] {
    const hosts = new Map<string, { total: number; best: Aggregate; last: number }>();
    for (const a of this.aggregate().values()) {
      if (!/^https?:/i.test(a.url)) continue;
      const host = hostOf(a.url).replace(/^www\./, '');
      if (!host || hidden.includes(host)) continue;
      const h = hosts.get(host);
      if (!h) hosts.set(host, { total: a.visits, best: a, last: a.last });
      else {
        h.total += a.visits;
        h.last = Math.max(h.last, a.last);
        if (a.visits > h.best.visits) h.best = a;
      }
    }
    return [...hosts.entries()]
      .sort((a, b) => b[1].total - a[1].total || b[1].last - a[1].last)
      .slice(0, n)
      .map(([host, h]) => ({ host, url: h.best.url, title: h.best.title || host }));
  }

  private changed() {
    this.agg = null;
    this.file.save(2000);
  }
  flush() { this.file.flush(); }
}
