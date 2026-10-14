// Prism's error pages. A failed navigation commits Chromium's (empty) error document at the failed
// URL, so history and the address bar stay right; Prism then draws its own page into it. Buttons are
// links to prism://retry / prism://proceed, which the tab intercepts (and checks the one-time token).
import { hostOf } from './util';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function isCertError(code: number) {
  return code <= -200 && code > -300;
}

function describeError(code: number, desc: string, url: string) {
  const host = hostOf(url) || url;
  const h = `<b>${esc(host)}</b>`;
  if (isCertError(code)) return { title: 'Your connection is not private', body: `Attackers might be trying to steal your information from ${h} (for example, passwords, messages, or credit cards).`, icon: 'warn' };
  switch (code) {
    case -106: return { title: 'No internet', body: 'Check your network cables, modem and router, or reconnect to Wi-Fi.', icon: 'offline' };
    case -105: case -137: return { title: "This site can't be reached", body: `Check if there is a typo in ${h}. Its server's address could not be found.`, icon: 'globe' };
    case -102: return { title: "This site can't be reached", body: `${h} refused to connect.`, icon: 'globe' };
    case -118: case -7: return { title: "This site can't be reached", body: `${h} took too long to respond.`, icon: 'globe' };
    case -101: case -100: case -109: return { title: "This site can't be reached", body: `The connection to ${h} was interrupted.`, icon: 'globe' };
    case -21: return { title: 'Your connection was interrupted', body: 'A network change was detected.', icon: 'offline' };
    case -27: return { title: 'This page has been blocked', body: `${h} doesn't allow itself to be shown here.`, icon: 'warn' };
    case -20: return { title: 'This page has been blocked', body: `Prism blocked ${h}.`, icon: 'warn' };
    case -300: return { title: "This address isn't valid", body: 'Check the address and try again.', icon: 'globe' };
    case -301: return { title: "This address isn't supported", body: 'Prism cannot open this kind of address.', icon: 'globe' };
    default: return { title: "This page isn't working", body: `${h} couldn't be loaded.`, icon: 'globe' };
  }
}

const ICONS: Record<string, string> = {
  globe: '<circle cx="24" cy="24" r="18"/><path d="M6 24h36M24 6c6 6 6 30 0 36M24 6c-6 6-6 30 0 36"/>',
  offline: '<path d="M8 18c9-8 23-8 32 0M14 25c6-5 14-5 20 0M20 32c2-2 6-2 8 0"/><path d="M8 8l32 32"/>',
  warn: '<path d="M24 6l20 36H4z"/><path d="M24 19v11M24 35v1"/>',
};

/** JavaScript that replaces the error document's contents. */
export function errorPageScript(code: number, desc: string, url: string, token: string) {
  const d = describeError(code, desc, url);
  const cert = isCertError(code);
  const proceed = `prism://proceed/?t=${token}`;
  const retry = `prism://retry/?t=${token}`;
  const back = `prism://back/?t=${token}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(hostOf(url) || 'Error')}</title><style>
    :root { color-scheme: light dark; --bg: #fff; --fg: #202124; --dim: #5f6368; --accent: #6a4cf5; --warn: #d93025; }
    @media (prefers-color-scheme: dark) { :root { --bg: #1c1b22; --fg: #e8e8ee; --dim: #a6a6b4; --accent: #a78bfa; --warn: #f28b82; } }
    html, body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 "Segoe UI", system-ui, sans-serif; }
    main { max-width: 600px; margin: 14vh auto 0; padding: 0 28px; }
    svg { width: 56px; height: 56px; fill: none; stroke: ${cert ? 'var(--warn)' : 'var(--dim)'}; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
    h1 { font-size: 26px; font-weight: 500; margin: 22px 0 10px; }
    p { color: var(--dim); margin: 0 0 8px; } p b { color: var(--fg); font-weight: 600; }
    code { font-size: 12px; color: var(--dim); }
    .row { display: flex; gap: 12px; margin-top: 30px; align-items: center; flex-wrap: wrap; }
    a.btn { background: var(--accent); color: #fff; text-decoration: none; padding: 9px 22px; border-radius: 20px; font-weight: 500; }
    a.link { color: var(--dim); font-size: 13px; }
  </style></head><body><main>
    <svg viewBox="0 0 48 48">${ICONS[d.icon]}</svg>
    <h1>${esc(d.title)}</h1><p>${d.body}</p><code>${esc(desc || 'ERR_FAILED')}</code>
    <div class="row">${cert ? `<a class="btn" href="${back}">Back to safety</a><a class="link" href="${proceed}">Continue to ${esc(hostOf(url))} (unsafe)</a>` : `<a class="btn" href="${retry}">Reload</a>`}</div>
  </main></body></html>`;
  return `document.open(); document.write(${JSON.stringify(html)}); document.close(); void 0;`;
}
