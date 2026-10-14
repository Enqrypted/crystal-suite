// Settings: search, startup, appearance, privacy & protections, clearing data, site permissions,
// downloads, default browser and about.
import { prism, icon, esc, shell, $ } from './common';
import type { AboutInfo, AdblockInfo, Settings, SitePermission } from '../shared';

interface Info { settings: Settings; engines: Record<string, { name: string }>; about: AboutInfo; downloadDir: string }

const content = shell('settings', 'Settings');
let info: Info;
let adblock: AdblockInfo;
let permissions: SitePermission[] = [];
let defaultBrowser = { supported: false, registered: false, isDefault: false };

const sw = (key: keyof Settings) => `<button class="switch" role="switch" aria-checked="${!!info.settings[key]}" data-key="${key}"></button>`;
const row = (title: string, desc: string, control: string, id = '') => `<div class="set"${id ? ` id="${id}"` : ''}><div class="info"><b>${title}</b>${desc ? `<span>${desc}</span>` : ''}</div>${control}</div>`;
const PERM_NAMES: Record<string, string> = {
  camera: 'Camera', microphone: 'Microphone', geolocation: 'Location', notifications: 'Notifications', midi: 'MIDI', midiSysex: 'MIDI',
  'clipboard-read': 'Clipboard', 'display-capture': 'Screen sharing', 'idle-detection': 'Idle detection', 'window-management': 'Window management',
  'storage-access': 'Third-party cookies', 'top-level-storage-access': 'Third-party cookies', 'speaker-selection': 'Speakers',
};

function when(t: number) {
  if (!t) return 'never';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function render() {
  const s = info.settings;
  const a = info.about;
  content.innerHTML = `
    <div class="section-title" id="search">Search</div>
    <div class="card">
      ${row('Search engine', 'Used in the address bar and on the New Tab page.', `<select data-key="searchEngine">${Object.entries(info.engines).map(([id, e]) => `<option value="${id}"${id === s.searchEngine ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}</select>`)}
    </div>

    <div class="section-title" id="startup">On startup</div>
    <div class="card"><div class="set"><div class="radio">
      <label><input type="radio" name="startup" value="restore"${s.startup === 'restore' ? ' checked' : ''}> Continue where you left off</label>
      <label><input type="radio" name="startup" value="newtab"${s.startup === 'newtab' ? ' checked' : ''}> Open the New Tab page</label>
    </div></div></div>

    <div class="section-title" id="appearance">Appearance</div>
    <div class="card">
      ${row('Theme', 'Pages that support it switch to their dark or light design too.', `<select data-key="theme"><option value="system"${s.theme === 'system' ? ' selected' : ''}>Same as Windows</option><option value="light"${s.theme === 'light' ? ' selected' : ''}>Light</option><option value="dark"${s.theme === 'dark' ? ' selected' : ''}>Dark</option></select>`)}
      ${row('Show bookmarks bar', 'Ctrl+Shift+B', sw('bookmarksBar'))}
    </div>

    <div class="section-title" id="privacy">Privacy and protections</div>
    <div class="card">
      ${row('Block ads and trackers', `Uses the EasyList, EasyPrivacy and uBlock Origin filter lists. ${adblock.updating ? 'Updating the lists…' : adblock.ready ? `Lists updated ${when(adblock.updatedAt)}.` : 'Downloading the lists…'}${adblock.error ? ` <span style="color:var(--warn)">${esc(adblock.error)}</span>` : ''}`,
        `<button class="btn" id="update-lists"${adblock.updating ? ' disabled' : ''}>${icon('reload', 14)}Update lists</button>${sw('adblock')}`)}
      ${adblock.allowlist.length ? `<div class="set"><div class="info"><b>Sites where protections are off</b><span>Turn protections back on for a site with the shield in the toolbar, or remove it here.</span>
        <div class="chips">${adblock.allowlist.map((h) => `<span class="chip">${esc(h)}<button class="icon-btn" data-allow="${esc(h)}" title="Turn protections back on">${icon('close', 12)}</button></span>`).join('')}</div></div></div>` : ''}
      ${row('Block third-party cookies', 'Sites you visit can keep you signed in, but embedded content from other sites can\'t follow you around the web. Turned off for sites where you switch protections off.', sw('blockThirdPartyCookies'))}
      ${row('Always use secure connections', 'Upgrades sites to HTTPS. If a site doesn\'t support it, Prism opens it normally and marks it "Not secure".', sw('httpsUpgrade'))}
      ${row('Ask sites not to track you', 'Sends the Global Privacy Control and Do Not Track signals with every request.', sw('doNotTrack'))}
      ${row('Hide your IP address from WebRTC', 'Stops sites from discovering your local network address through video-call features.', sw('webrtcProtect'))}
      ${row('Clear browsing data when Prism closes', 'Deletes history, cookies, site data and the cache every time you close the last window.', sw('clearOnExit'))}
    </div>

    <div class="section-title" id="clear">Clear browsing data</div>
    <div class="card"><div class="set" style="display:block">
      <div class="checks">
        <label><input type="checkbox" data-clear="history" checked> Browsing history</label>
        <label><input type="checkbox" data-clear="cookies" checked> Cookies and site data</label>
        <label><input type="checkbox" data-clear="cache" checked> Cached images and files</label>
        <label><input type="checkbox" data-clear="downloads"> Download history</label>
      </div>
      <div style="display:flex;align-items:center;gap:14px;margin-top:14px">
        <button class="btn primary" id="clear-now">${icon('trash', 14)}Clear data</button><span id="clear-status" class="status-ok"></span>
      </div>
      <div class="dim" style="font-size:13px;margin-top:10px">Bookmarks, settings and downloaded files are kept. Private windows never save any of this.</div>
    </div></div>

    <div class="section-title" id="permissions">Site permissions</div>
    <div class="card">
      ${permissions.length ? permissions.map((p) => `<div class="set"><div class="info"><b>${esc(p.origin.replace(/^https?:\/\//, ''))}</b>
          <div class="chips">${Object.entries(p.permissions).map(([k, v]) => `<span class="chip ${v}">${esc(PERM_NAMES[k] || k)}: ${v === 'allow' ? 'Allowed' : 'Blocked'}<button class="icon-btn" data-perm="${esc(p.origin)}" data-key="${esc(k)}" title="Reset">${icon('close', 12)}</button></span>`).join('')}</div></div>
          <button class="btn" data-perm="${esc(p.origin)}">Reset all</button></div>`).join('')
        : row('No site permissions yet', 'When a site asks for your camera, microphone, location or notifications, your answer is remembered here.', '')}
    </div>

    <div class="section-title" id="downloads">Downloads</div>
    <div class="card">
      ${row('Location', `<span class="path">${esc(info.downloadDir)}</span>`, '<button class="btn" id="change-dir">Change…</button>')}
      ${row('Ask where to save each file', '', sw('askWhereToSave'))}
    </div>

    <div class="section-title" id="default">Default browser</div>
    <div class="card">
      ${defaultBrowser.supported ? row(defaultBrowser.isDefault ? `<span class="status-ok">Prism is your default browser</span>` : 'Make Prism your default browser',
        defaultBrowser.isDefault ? 'Links you open in other apps open in Prism.' : 'Prism registers itself with Windows, then Windows Settings opens so you can choose Prism under Web browser.',
        defaultBrowser.isDefault ? '' : '<button class="btn primary" id="make-default">Make default</button>')
        : row('Default browser', 'Not available on this system.', '')}
    </div>

    <div class="section-title" id="about">About Prism</div>
    <div class="card">
      ${row(`Prism ${esc(a.version)}`, `Chromium ${esc(a.chrome)} · Electron ${esc(a.electron)}${a.standalone ? '' : ' · part of Crystal Suite'}`, '')}
      ${row('Your privacy', 'Prism has no account, no telemetry and no ads. It never sends your history or browsing data anywhere. The only things it downloads on its own are the ad-blocking filter lists.', '')}
      ${row('Free and open source', `MIT licence. <a href="https://github.com/Enqrypted/crystal-suite" target="_blank">Source code</a> · <a href="https://github.com/Enqrypted/crystal-suite/issues" target="_blank">Report a problem</a>`, '')}
      ${row('Your data', `<span class="path">${esc(a.dataDir)}</span>`, '')}
    </div>`;
}

async function load() {
  [info, adblock, permissions, defaultBrowser] = await Promise.all([
    prism.call<Info>('settings'), prism.call<AdblockInfo>('adblock'), prism.call<SitePermission[]>('permissions'), prism.call('defaultBrowser'),
  ]);
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

content.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const sw = t.closest<HTMLElement>('.switch');
  if (sw) {
    const key = sw.dataset.key as keyof Settings;
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(on));
    await prism.call('setSetting', key, on);
    return;
  }
  if (t.closest('#update-lists')) { adblock = await prism.call('updateAdblock'); render(); return; }
  const allow = t.closest<HTMLElement>('[data-allow]');
  if (allow) { adblock = await prism.call('removeAllow', allow.dataset.allow); render(); return; }
  const perm = t.closest<HTMLElement>('[data-perm]');
  if (perm) { permissions = await prism.call('resetPermission', perm.dataset.perm, perm.dataset.key || ''); render(); return; }
  if (t.closest('#change-dir')) { info.downloadDir = await prism.call('chooseDownloadDir'); render(); return; }
  if (t.closest('#make-default')) { defaultBrowser = await prism.call('makeDefault'); render(); return; }
  if (t.closest('#clear-now')) {
    const opts: Record<string, boolean> = {};
    content.querySelectorAll<HTMLInputElement>('[data-clear]').forEach((c) => { opts[c.dataset.clear!] = c.checked; });
    const btn = $<HTMLButtonElement>('#clear-now');
    btn.disabled = true;
    await prism.call('clearData', opts);
    btn.disabled = false;
    $('#clear-status').textContent = 'Cleared.';
  }
});
content.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  if (t instanceof HTMLSelectElement && t.dataset.key) prism.call('setSetting', t.dataset.key, t.value);
  if (t instanceof HTMLInputElement && t.name === 'startup') prism.call('setSetting', 'startup', t.value);
});
prism.onUpdate((what) => { if (what === 'adblock' || what === 'settings') load(); });
// the default-browser choice is made in Windows Settings; refresh when the user comes back
window.addEventListener('focus', () => { prism.call('defaultBrowser').then((d) => { if (d.isDefault !== defaultBrowser.isDefault) { defaultBrowser = d; render(); } }); });

load().then(() => {
  const hash = location.hash.slice(1);
  const target = hash && document.getElementById(hash);
  if (target) {
    target.scrollIntoView({ block: 'start' });
    (target.nextElementSibling as HTMLElement | null)?.classList.add('flash');
  }
});
