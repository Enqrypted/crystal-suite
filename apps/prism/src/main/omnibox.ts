// Address bar: turning typed text into a URL or a search, and suggestions from history and bookmarks.
import { pathToFileURL } from 'url';
import { parse } from 'tldts-experimental';
import type { Suggestion } from '../shared';
import type { History } from './history';
import type { Bookmarks } from './bookmarks';
import { prettyUrl } from './util';

const KNOWN_SCHEMES = new Set(['http', 'https', 'file', 'prism', 'view-source', 'about', 'data', 'blob', 'mailto', 'ftp']);

export function inputToUrl(text: string, searchUrl: string): { url: string; search: boolean } {
  const t = text.trim();
  if (!t) return { url: '', search: false };
  const search = { url: searchUrl.replace('%s', encodeURIComponent(t)), search: true };
  if (/^[a-z]:[\\/]/i.test(t) || t.startsWith('\\\\')) return { url: pathToFileURL(t).href, search: false }; // Windows path
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t)?.[1]?.toLowerCase();
  if (scheme && !/^[a-z0-9.-]+:\d{1,5}([/?#]|$)/i.test(t)) { // "localhost:3000" is host:port, not a scheme
    if (scheme === 'javascript') return search;
    if (KNOWN_SCHEMES.has(scheme) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return { url: t, search: false };
    if (!/\s/.test(t) && scheme.length > 1) return { url: t, search: false }; // e.g. magnet:, tel: (asks before opening)
  }
  if (/\s/.test(t)) return search;
  const m = /^([^/?#:@]+|\[[0-9a-f:.]+\])(:\d{1,5})?([/?#].*)?$/i.exec(t);
  if (m) {
    const host = m[1].toLowerCase();
    if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return { url: `http://${t}`, search: false };
    const p = parse(host);
    if (p.isIcann && p.domain) return { url: `https://${t}`, search: false };
    if (host.includes('.') && (m[2] || m[3])) return { url: `https://${t}`, search: false };
    if (m[2] && /^[a-z0-9-]+$/.test(host)) return { url: `http://${t}`, search: false }; // intranet:8080
  }
  return search;
}

export function suggest(text: string, history: History, bookmarks: Bookmarks, engine: { name: string; url: string }): Suggestion[] {
  const t = text.trim();
  if (!t) return [];
  const resolved = inputToUrl(t, engine.url);
  const searchRow: Suggestion = { kind: 'search', title: t, sub: `${engine.name} search`, url: engine.url.replace('%s', encodeURIComponent(t)), fill: t };
  const out: Suggestion[] = [resolved.search ? searchRow : { kind: 'url', title: prettyUrl(resolved.url), sub: 'Open', url: resolved.url, fill: t }];
  const tokens = t.toLowerCase().split(/\s+/).filter(Boolean);
  const now = Date.now();
  const scored: { s: Suggestion; score: number }[] = [];
  const seen = new Set<string>([out[0].url]);
  const consider = (url: string, title: string, visits: number, last: number, bookmarked: boolean) => {
    if (seen.has(url)) return;
    const bare = url.replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
    const hay = bare + ' ' + title.toLowerCase();
    if (!tokens.every((k) => hay.includes(k))) return;
    let score = Math.min(60, visits * 4);
    if (bare.startsWith(tokens[0])) score += 60;
    else if (title.toLowerCase().startsWith(tokens[0])) score += 25;
    if (bookmarked) score += 40;
    if (now - last < 86400000) score += 20;
    else if (now - last < 7 * 86400000) score += 10;
    score -= Math.min(20, bare.length / 10); // prefer shorter, more general URLs
    seen.add(url);
    scored.push({ s: { kind: bookmarked ? 'bookmark' : 'history', title: title || prettyUrl(url), sub: prettyUrl(url), url, fill: prettyUrl(url) }, score });
  };
  for (const b of bookmarks.list()) consider(b.url, b.title, 1, b.time, true);
  for (const a of history.aggregate().values()) consider(a.url, a.title, a.visits, a.last, false);
  scored.sort((a, b) => b.score - a.score);
  out.push(...scored.slice(0, 6).map((x) => x.s));
  if (!resolved.search) out.push(searchRow);
  return out;
}
