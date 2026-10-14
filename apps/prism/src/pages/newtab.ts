// New Tab page: a search box and the sites you visit most. Nothing else.
import { prism, icon, esc, favicon, fixIcons, $ } from './common';

interface Site { url: string; title: string; host: string; icon: string }

const style = document.createElement('style');
style.textContent = `
  body { display: grid; place-items: start center; min-height: 100vh; }
  .ntp { width: min(680px, 92vw); padding-top: 18vh; display: flex; flex-direction: column; align-items: center; }
  .logo { display: flex; align-items: center; gap: 12px; font-size: 34px; font-weight: 300; margin-bottom: 30px; letter-spacing: .5px; }
  .logo img { width: 52px; height: 52px; }
  form { width: 100%; height: 50px; border-radius: 25px; background: var(--input); border: 1px solid var(--line); display: flex; align-items: center; gap: 12px; padding: 0 20px; color: var(--dim); }
  form:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  form input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: 16px; }
  .sites { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; width: 100%; margin-top: 34px; }
  .site { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 8px 14px; border-radius: 12px; color: var(--fg); }
  .site:hover { background: var(--hover); text-decoration: none; }
  .site .tile { width: 48px; height: 48px; border-radius: 50%; background: var(--input); display: grid; place-items: center; }
  .site .tile .letter { width: 30px !important; height: 30px !important; font-size: 15px; }
  .site .name { font-size: 13px; max-width: 100%; text-align: center; }
  .site .rm { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; opacity: 0; }
  .site:hover .rm { opacity: 1; }
  .hint { grid-column: 1 / -1; text-align: center; color: var(--faint); font-size: 13px; padding: 10px; }
  footer { margin-top: 40px; font-size: 13px; }
  footer a { color: var(--dim); display: inline-flex; align-items: center; gap: 6px; }
  footer a .ic { color: var(--accent); }
`;
document.head.appendChild(style);

prism.call('settings').then(({ settings, engines }) => {
  const engine = engines[settings.searchEngine]?.name || 'the web';
  document.body.innerHTML = `<div class="ntp">
    <div class="logo"><img src="/favicon.png" alt=""><span>Prism</span></div>
    <form id="search">${icon('search', 18)}<input id="q" placeholder="Search ${esc(engine)} or type a URL" autocomplete="off" spellcheck="false" /></form>
    <div id="sites" class="sites"></div>
    <footer><a href="prism://settings/#privacy">${icon('shield', 15)}Ads and trackers are blocked</a></footer>
  </div>`;
  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>('#q').value.trim();
    if (q) prism.call('navigate', q);
  });
  loadSites();
});

async function loadSites() {
  const sites = await prism.call<Site[]>('topSites');
  renderSites(sites);
}

function renderSites(sites: Site[]) {
  const el = $('#sites');
  el.innerHTML = sites.length
    ? sites.map((s) => `<a class="site" href="${esc(s.url)}" title="${esc(s.title)}\n${esc(s.url)}">
        <span class="tile">${favicon(s.url, s.icon, 24)}</span>
        <span class="name ellipsis">${esc(s.title.length > 40 ? s.host : s.title)}</span>
        <button class="icon-btn rm" data-host="${esc(s.host)}" title="Don't show this site">${icon('close', 14)}</button></a>`).join('')
    : '<div class="hint">Sites you visit often will show up here.</div>';
  fixIcons(el);
}

document.addEventListener('click', async (e) => {
  const rm = (e.target as HTMLElement).closest<HTMLElement>('.rm');
  if (!rm) return;
  e.preventDefault();
  renderSites(await prism.call<Site[]>('hideTopSite', rm.dataset.host));
});
