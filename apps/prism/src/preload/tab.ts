// Preload for web page tabs (sandboxed). On prism:// pages it exposes the internal-page API; on web
// pages it asks the main process for the ad blocker's element-hiding rules: once at start, then for
// the classes / ids / links that appear in the page (same approach as Ghostery's Electron preload).
import { contextBridge, ipcRenderer } from 'electron';

interface Features { classes: string[]; ids: string[]; hrefs: string[] }

if (location.protocol === 'prism:') {
  contextBridge.exposeInMainWorld('prism', {
    call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('prism:page', method, ...args),
    onUpdate: (cb: (what: string) => void) => { ipcRenderer.on('prism:page-update', (_e, what: string) => cb(what)); },
  });
} else if ((location.protocol === 'http:' || location.protocol === 'https:') && window === window.top) {
  const IGNORED = new Set(['br', 'head', 'link', 'meta', 'script', 'style', 's']);
  const inject = (features?: Features) => { ipcRenderer.invoke('prism:cosmetics', location.href, features).catch(() => {}); };
  inject();
  window.addEventListener('DOMContentLoaded', () => {
    const known = { classes: new Set<string>(), ids: new Set<string>(), hrefs: new Set<string>() };
    const collect = (roots: Element[]) => {
      const f: Features = { classes: [], ids: [], hrefs: [] };
      for (const root of roots) {
        if (!root.isConnected) continue;
        for (const el of [root, ...Array.from(root.querySelectorAll('[id],[class],[href]'))]) {
          if (IGNORED.has(el.nodeName.toLowerCase())) continue;
          const id = el.getAttribute('id');
          if (id && !known.ids.has(id)) { known.ids.add(id); f.ids.push(id); }
          for (const c of Array.from(el.classList)) if (!known.classes.has(c)) { known.classes.add(c); f.classes.push(c); }
          const href = el.getAttribute('href');
          if (href && !known.hrefs.has(href)) { known.hrefs.add(href); f.hrefs.push(href); }
        }
      }
      if (f.classes.length || f.ids.length || f.hrefs.length) inject(f);
    };
    collect([document.documentElement]);
    let pending = new Set<Element>();
    let wait: ReturnType<typeof setTimeout> | undefined;
    let maxWait: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(wait);
      clearTimeout(maxWait);
      wait = maxWait = undefined;
      const roots = [...pending];
      pending = new Set();
      collect(roots);
    };
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') { if (m.target.nodeType === 1) pending.add(m.target as Element); }
        else for (const n of Array.from(m.addedNodes)) if (n.nodeType === 1) pending.add(n as Element);
      }
      if (pending.size > 512) { flush(); return; }
      clearTimeout(wait);
      wait = setTimeout(flush, 25);
      if (maxWait === undefined) maxWait = setTimeout(flush, 1000);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'id', 'href'], childList: true, subtree: true });
  }, { once: true });
}
