import { getDomain } from 'tldts-experimental';

export const isWeb = (u: string) => /^https?:/i.test(u);

export function safeUrl(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}
export const hostOf = (u: string) => safeUrl(u)?.hostname ?? '';
export function originOf(u: string) {
  const x = safeUrl(u);
  return x && x.origin !== 'null' ? x.origin : '';
}
/** Registrable domain ("news.bbc.co.uk" -> "bbc.co.uk"). */
export const siteOf = (host: string) => getDomain(host) || host;

export function isThirdParty(requestUrl: string, topUrl: string) {
  const a = hostOf(requestUrl);
  const b = hostOf(topUrl);
  if (!a || !b) return false;
  return siteOf(a) !== siteOf(b);
}

/** Hosts that commonly serve plain HTTP on purpose (dev servers, routers, intranet names). */
export function isLocalHost(host: string) {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') ||
    host.startsWith('[') || !host.includes('.') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Address-bar form of a URL: no scheme for http(s), no trailing slash on bare hosts. */
export function prettyUrl(url: string) {
  const u = safeUrl(url);
  if (!u || !/^https?:$/.test(u.protocol)) return url;
  let s = url.replace(/^https?:\/\//i, '');
  if (u.pathname === '/' && !u.search && !u.hash) s = s.replace(/\/$/, '');
  try { s = decodeURI(s); } catch { /* keep encoded */ }
  return s;
}
