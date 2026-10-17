// The Onyx window: what is being recorded and the save buttons, what to record, the clips, and settings.
import { LENGTHS, RESOLUTIONS, type Clip, type Mode, type Recording, type Settings, type State, type WindowChoice } from '../shared/types';

interface Native {
  init(): Promise<State>;
  settings(patch: Partial<Settings>): Promise<State>;
  save(id: string, seconds: number): Promise<{ ok: boolean; path?: string; error?: string }>;
  clips(): Promise<Clip[]>;
  thumb(path: string): Promise<string | null>;
  windows(): Promise<WindowChoice[]>;
  pickWindow(hwnd: string): Promise<State>;
  rule(exe: string, kind: 'always' | 'never' | 'none'): Promise<State>;
  hotkeyCapture(on: boolean): Promise<void>;
  setHotkey(accel: string): Promise<{ ok: boolean; error?: string }>;
  folderDialog(): Promise<State>;
  openFolder(): Promise<string>;
  reveal(path: string): Promise<void>;
  open(path: string): Promise<string>;
  trash(path: string): Promise<boolean>;
  onState(cb: (s: State) => void): void;
  onClipsChanged(cb: () => void): void;
}

const native = (window as unknown as { onyxNative: Native }).onyxNative;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

let state: State;
let clips: Clip[] = [];
let shownClips = 12;
let windows: WindowChoice[] | null = null;
let hotkeyError = '';
let capturing = false;

// ---------- formatting ----------

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const lengthShort = (s: number) => (s < 60 ? `${s}s` : `${s / 60}m`);
const lengthWord = (s: number) => (s < 60 ? 'seconds' : s === 60 ? 'minute' : 'minutes');
const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`);
const resName = (h: number) => (h === 0 ? 'Native (the game\'s own size)' : h === 2160 ? '2160p (4K)' : h === 1440 ? '1440p' : h === 1080 ? '1080p (Full HD)' : `${h}p`);

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(ms), today = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today, ${time}`;
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday, ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' }) + `, ${time}`;
}

const keysHtml = (accel: string) => accel.split('+').map((k) => `<kbd>${esc(k)}</kbd>`).join(' ');

// ---------- header + status ----------

function renderPill() {
  const pill = $('pill'), st = state.status;
  const n = state.recordings.filter((r) => r.phase === 'recording').length;
  const cls = st === 'recording' ? 'rec' : st === 'error' ? 'err' : st === 'off' ? 'off' : 'wait';
  const text = st === 'recording' ? (n > 1 ? `Recording ${n} games` : n ? 'Recording' : 'Starting…') : st === 'error' ? 'Not recording' : st === 'off' ? 'Off' : 'Waiting for a game';
  pill.className = `pill ${cls}`;
  pill.innerHTML = `<span class="dot"></span>${text}`;
}

function encoderText(r: Recording) {
  if (!r.encoder) return '';
  if (r.hardware) {
    const gpu = r.gpu.replace(/^(NVIDIA|AMD|Intel\(R\))\s+/i, '').replace(/\(TM\)|\(R\)/g, '');
    const brand = /nvidia/i.test(r.encoder) ? 'NVENC' : /amd|radeon/i.test(r.encoder) ? 'AMF' : /intel|quick ?sync/i.test(r.encoder) ? 'Quick Sync' : 'GPU';
    return `${brand} · ${gpu.trim()}`;
  }
  return '<span class="warn">Software encoding (no GPU encoder found)</span>';
}

/** One status card: what it records, and its save buttons. */
interface Card {
  key: string; id: string; cls: string; label: string; name: string; sub: string; meta: string; msg: string; err: boolean;
  can: boolean; saving: boolean; buffered: number; bytes: number; live: boolean;
}

function cards(): Card[] {
  const s = state.settings, recs = state.recordings;
  if (!recs.length) {
    let label = 'Waiting', name = 'No game running', msg = '';
    if (state.status === 'off') { label = 'Instant replay is off'; name = 'Not recording'; msg = 'Turn instant replay on to keep the last two minutes of your games ready to save.'; }
    else if (state.status === 'error') { label = 'Not recording'; name = 'Recording couldn\'t start'; }
    else {
      name = s.mode === 'auto' ? 'Waiting for a game' : s.mode === 'window' ? (s.window ? `${s.window.name} isn't open` : 'Choose a window below') : 'Waiting';
      msg = s.mode === 'auto' ? 'Start a game and Onyx begins recording it in the background (every game that\'s open, each on its own). Nothing is saved until you ask.' : '';
    }
    if (state.message) msg = state.message;
    return [{ key: 'idle', id: '', cls: state.status === 'error' ? 'err' : '', label, name, sub: '', meta: '', msg, err: state.status === 'error', can: false, saving: false, buffered: 0, bytes: 0, live: false }];
  }
  const many = recs.length > 1;
  return recs.map((r, i) => {
    const on = r.phase === 'recording';
    let meta = '';
    if (on) {
      meta = [`${r.width}×${r.height}`, `${r.fps} fps`, encoderText(r), r.kbps ? `${(r.kbps / 1000).toFixed(r.kbps < 10000 ? 1 : 0)} Mbit/s` : '']
        .filter(Boolean).map((x) => `<span>${x}</span>`).join('');
      // fewer frames than asked for: the game shows fewer, or the PC can't keep up (0 = minimized or not changing)
      if (r.live.fps > 0 && r.live.buffered > 3 && r.live.fps < r.fps * 0.8) meta += `<span class="warn">getting ${Math.round(r.live.fps)} of ${r.fps} fps</span>`;
      if (r.live.dropped > 0) meta += `<span class="warn">${r.live.dropped} frames skipped</span>`;
    }
    const label = !on ? 'Starting' : r.kind === 'screen' && s.mode === 'screen' ? 'Recording your screen' : many && r.front ? 'Recording · in front' : 'Recording';
    // two windows of one game: their titles tell them apart
    const sub = recs.some((o) => o !== r && o.name === r.name) && r.title !== r.name ? r.title : '';
    const msg = r.message || (i === 0 && state.message ? state.message : '');
    return {
      key: r.id, id: r.id, cls: on ? 'rec' : '', label, name: r.name, sub, meta, msg, err: false, can: on && !r.saving,
      saving: r.saving, buffered: on ? Math.min(r.live.buffered, 120) : 0, bytes: r.live.bytes, live: on,
    };
  });
}

function cardTop(c: Card, first: boolean) {
  const s = state.settings;
  const hint = !first ? '' : state.hotkeyOk ? `or press ${keysHtml(s.hotkey)} in game` : `<span class="s-error">The hotkey ${esc(s.hotkey)} is taken by another program. Pick another in settings.</span>`;
  return `
      <div class="state">
        <div class="state-label"><span class="dot"></span>${esc(c.label)}</div>
        <div class="state-name">${esc(c.name)}</div>
        ${c.sub ? `<div class="state-sub">${esc(c.sub)}</div>` : ''}
        ${c.meta ? `<div class="state-meta">${c.meta}</div>` : ''}
        ${c.msg ? `<div class="state-msg ${c.err ? 'err' : ''}">${esc(c.msg)}</div>` : ''}
      </div>
      <div class="saves">
        <div class="save-row">${LENGTHS.map((n) => `<button type="button" class="save" data-save="${n}" ${c.can ? '' : 'disabled'} title="Save the last ${n < 60 ? `${n} seconds` : n === 60 ? 'minute' : `${n / 60} minutes`}"><b>${lengthShort(n)}</b><small>${c.saving ? '…' : 'save'}</small></button>`).join('')}</div>
        ${hint ? `<div class="save-hint">${hint}</div>` : ''}
      </div>`;
}

function cardBuf(c: Card) {
  if (!c.live) return '';
  return `
    <div class="buffer">
      <div class="buffer-bar"><i style="width:${(c.buffered / 120) * 100}%"></i></div>
      <div class="buffer-text"><span>${c.buffered >= 119.5 ? 'The last 2 minutes are ready to save' : `${mmss(c.buffered)} of 2:00 recorded`}</span><span>${c.bytes ? `${mb(c.bytes)} in memory` : ''}</span></div>
    </div>`;
}

function renderHero() {
  const box = $('hero'), list = cards();
  // one card per recording, kept (not rebuilt) while it lasts: the status comes every second, and a button
  // mid-click must survive it
  const keep = new Set(list.map((c) => c.key));
  for (const el of [...box.children] as HTMLElement[]) if (!keep.has(el.dataset.key!)) el.remove();
  list.forEach((c, i) => {
    let el = box.querySelector<HTMLElement>(`:scope > [data-key="${CSS.escape(c.key)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.dataset.key = c.key;
      el.innerHTML = '<div class="hero-top"></div><div class="hero-buf"></div>';
    }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null);
    el.className = `hero ${c.cls}`;
    const top = cardTop(c, i === 0), buf = cardBuf(c);
    const topEl = el.querySelector<HTMLElement>('.hero-top')!, bufEl = el.querySelector<HTMLElement>('.hero-buf')!;
    if (topEl.dataset.html !== top) {
      topEl.dataset.html = top;
      topEl.innerHTML = top;
      topEl.querySelectorAll<HTMLButtonElement>('[data-save]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        await native.save(c.id, Number(b.dataset.save));
      }));
    }
    if (bufEl.dataset.html !== buf) {
      const bar = bufEl.querySelector<HTMLElement>('.buffer-bar i');
      if (bar && buf) {
        // keep the bar element so its width animates
        bar.style.width = `${(c.buffered / 120) * 100}%`;
        bufEl.querySelector('.buffer-text')!.outerHTML = buf.slice(buf.indexOf('<div class="buffer-text">'), buf.lastIndexOf('</div>'));
      } else bufEl.innerHTML = buf;
      bufEl.dataset.html = buf;
    }
  });
}

// ---------- source ----------

function renderMode() {
  $('mode').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.settings.mode));
}

async function loadWindows() {
  windows = await native.windows();
  renderSource();
}

function renderSource() {
  const s = state.settings, box = $('source');
  if (s.mode === 'auto') {
    const list = [...(windows ?? [])].sort((a, b) => Number(b.game) - Number(a.game));
    box.innerHTML = `
      <div class="note">Onyx records every game that's open, each in its own replay buffer: games Windows knows, games started from Steam, Epic, Riot, Battle.net, EA, Ubisoft or GOG, Roblox and Roblox Studio, Minecraft, and anything else running fullscreen. Browsers, video players and other everyday apps are left alone.</div>
      <div class="list-head"><span>Open windows — tell Onyx which ones are games</span><button type="button" class="btn ghost small" id="refresh">Refresh</button></div>
      <div class="list">${list.length ? list.map((w) => {
        const name = w.exe.split('\\').pop()!.toLowerCase();
        const rule = s.always.includes(name) ? 'always' : s.never.includes(name) ? 'never' : 'none';
        return `<div class="win" data-exe="${esc(w.exe)}">
          <div class="win-icon">${w.icon ? `<img src="${w.icon}" alt="">` : ''}</div>
          <div class="win-text"><div class="win-title">${esc(w.title)}</div><div class="win-sub">${esc(name)}${w.game ? ' · <span class="yes">recorded as a game</span>' : ''}</div></div>
          <div class="rule" title="Is ${esc(name)} a game?">
            <button type="button" data-rule="none" class="${rule === 'none' ? 'on' : ''}">Auto</button>
            <button type="button" data-rule="always" class="always ${rule === 'always' ? 'on' : ''}">Game</button>
            <button type="button" data-rule="never" class="never ${rule === 'never' ? 'on' : ''}">Not a game</button>
          </div>
        </div>`;
      }).join('') : `<div class="empty">${windows ? 'No open windows.' : 'Looking…'}</div>`}</div>`;
    box.querySelectorAll<HTMLElement>('.win').forEach((row) => row.querySelectorAll<HTMLButtonElement>('[data-rule]').forEach((b) => b.addEventListener('click', async () => {
      apply(await native.rule(row.dataset.exe!, b.dataset.rule as 'always' | 'never' | 'none'));
      loadWindows();
    })));
  } else if (s.mode === 'window') {
    const list = windows ?? [];
    const chosen = s.window;
    box.innerHTML = `
      <div class="list-head"><span>${chosen ? `Recording <b>${esc(chosen.name)}</b> whenever it's open` : 'Pick the window to record'}</span><button type="button" class="btn ghost small" id="refresh">Refresh</button></div>
      <div class="list">${list.length ? list.map((w) => {
        const on = !!chosen && (chosen.hwnd ? chosen.hwnd === w.hwnd : chosen.exe.toLowerCase() === w.exe.toLowerCase());
        return `<button type="button" class="win ${on ? 'on' : ''}" data-hwnd="${esc(w.hwnd)}">
          <div class="win-icon">${w.icon ? `<img src="${w.icon}" alt="">` : ''}</div>
          <div class="win-text"><div class="win-title">${esc(w.title)}</div><div class="win-sub">${esc(w.exe.split('\\').pop()!)}</div></div>
          ${on ? '<span class="tag">Chosen</span>' : w.game ? '<span class="tag dim">Game</span>' : ''}
        </button>`;
      }).join('') : `<div class="empty">${windows ? 'No open windows.' : 'Looking…'}</div>`}</div>`;
    box.querySelectorAll<HTMLButtonElement>('[data-hwnd]').forEach((b) => b.addEventListener('click', async () => {
      apply(await native.pickWindow(b.dataset.hwnd!));
      renderSource();
    }));
  } else {
    const primary = state.displays.find((d) => d.primary);
    const sel = s.display && state.displays.some((d) => d.id === s.display) ? s.display : primary?.id;
    box.innerHTML = `
      <div class="note">Records everything on the screen you choose, games or not.</div>
      <div class="list">${state.displays.map((d) => `
        <button type="button" class="win ${d.id === sel ? 'on' : ''}" data-display="${esc(d.id)}">
          <div class="win-icon"><svg viewBox="0 0 16 16" width="16" height="16"><rect x="2" y="3" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 13.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></div>
          <div class="win-text"><div class="win-title">${esc(d.label)}</div><div class="win-sub">${d.width}×${d.height}${d.primary ? ' · main display' : ''}</div></div>
          ${d.id === sel ? '<span class="tag">Chosen</span>' : ''}
        </button>`).join('')}</div>`;
    box.querySelectorAll<HTMLButtonElement>('[data-display]').forEach((b) => b.addEventListener('click', async () => {
      apply(await native.settings({ display: b.dataset.display! }));
      renderSource();
    }));
  }
  $('refresh')?.addEventListener('click', () => loadWindows());
}

// ---------- clips ----------

async function loadClips() {
  clips = await native.clips();
  renderClips();
}

function renderClips() {
  const box = $('clips');
  $('clip-count').textContent = clips.length ? String(clips.length) : '';
  if (!clips.length) {
    box.innerHTML = `<div class="empty">No clips yet. While a game is recording, press ${keysHtml(state.settings.hotkey)} and pick how much to keep.</div>`;
    return;
  }
  const list = clips.slice(0, shownClips);
  box.innerHTML = list.map((c, i) => `
    <button type="button" class="clip" data-i="${i}">
      <div class="thumb"><div class="ph"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/></svg></div>
        ${c.duration ? `<span class="dur">${mmss(c.duration)}</span>` : ''}
        <div class="play"><span><svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg></span></div>
      </div>
      <div class="clip-info"><div class="clip-game">${esc(c.game)}</div><div class="clip-sub">${ago(c.mtime)} · ${mb(c.size)}${c.height ? ` · ${c.height}p` : ''}</div></div>
    </button>`).join('') + (clips.length > shownClips ? '<button type="button" class="btn ghost more" id="more">Show more</button>' : '');
  box.querySelectorAll<HTMLButtonElement>('.clip').forEach((el) => {
    const c = list[Number(el.dataset.i)];
    el.addEventListener('click', () => play(c));
    thumbs.observe(el);
  });
  $('more')?.addEventListener('click', () => { shownClips += 24; renderClips(); });
}

/** Stills are made (by Windows) only for the clips scrolled into view. */
const thumbs = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target as HTMLElement;
    thumbs.unobserve(el);
    const c = clips[Number(el.dataset.i)];
    if (!c) continue;
    native.thumb(c.path).then((url) => {
      if (!url || !el.isConnected) return;
      const ph = el.querySelector('.ph');
      const img = new Image();
      img.alt = '';
      img.src = url;
      ph?.replaceWith(img);
    });
  }
}, { rootMargin: '200px' });

let playing: Clip | null = null;

function play(c: Clip) {
  playing = c;
  $('player-title').textContent = c.game;
  $('player-sub').textContent = `${ago(c.mtime)} · ${mb(c.size)}${c.width ? ` · ${c.width}×${c.height}` : ''}`;
  const v = $<HTMLVideoElement>('player-video');
  v.src = 'file:///' + c.path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
  $('player').hidden = false;
  v.play().catch(() => {});
}

function closePlayer() {
  const v = $<HTMLVideoElement>('player-video');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('player').hidden = true;
  playing = null;
}

// ---------- settings ----------

function toggle(id: string, title: string, sub: string, on: boolean) {
  return `<button type="button" class="toggle" id="${id}"><span class="t-text"><span>${title}</span>${sub ? `<span class="t-sub">${sub}</span>` : ''}</span><span class="switch ${on ? 'on' : ''}"><span class="knob"></span></span></button>`;
}

function seg(id: string, options: [string, string][], value: string) {
  return `<div class="seg" id="${id}">${options.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === value ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function renderSettings() {
  const s = state.settings;
  $('settings').innerHTML = `
    <div class="s-group">
      <div class="master">${toggle('t-enabled', 'Instant replay', s.enabled ? 'Keeping the last 2 minutes ready' : 'Off — nothing is recorded', s.enabled)}</div>
    </div>
    <div class="s-group">
      <div class="s-title">Video</div>
      <div class="s-field"><span class="s-label">Save clips at</span>
        <select id="s-res">${RESOLUTIONS.map((h) => `<option value="${h}" ${h === s.resolution ? 'selected' : ''}>${resName(h)}</option>`).join('')}</select>
        <span class="s-help">Games bigger than this are scaled down; smaller ones keep their size. Changing it starts the replay over.</span>
      </div>
      <div class="s-field"><span class="s-label">Frame rate</span>${seg('s-fps', [['30', '30 fps'], ['60', '60 fps']], String(s.fps))}</div>
      <div class="s-field"><span class="s-label">Quality</span>${seg('s-quality', [['0', 'Standard'], ['1', 'High'], ['2', 'Ultra']], String(s.quality))}
        <span class="s-help">Higher quality makes bigger files and uses more memory while recording.</span>
      </div>
    </div>
    <div class="s-group">
      <div class="s-title">Sound</div>
      ${toggle('t-system', 'Game and PC sound', 'Everything you hear', s.systemAudio)}
      ${toggle('t-mic', 'Microphone', 'Your voice, mixed in', s.mic)}
    </div>
    <div class="s-group">
      <div class="s-title">Hotkey</div>
      <button type="button" class="hotkey ${capturing ? 'capturing' : ''}" id="s-hotkey">${capturing ? 'Press the new keys… (Esc to cancel)' : keysHtml(s.hotkey)}</button>
      ${hotkeyError ? `<div class="s-error">${esc(hotkeyError)}</div>` : !state.hotkeyOk ? `<div class="s-error">Another program is using ${esc(s.hotkey)}. Click to choose different keys.</div>` : '<div class="s-help">Opens the clip picker in game. Press it again for a longer clip, or 1–4; Tab picks the game when several are recording. It saves after a moment.</div>'}
    </div>
    <div class="s-group">
      <div class="s-title">Saving</div>
      <div class="s-field"><span class="s-label">Clips folder</span>
        <div class="path"><span title="${esc(state.folder)}">${esc(state.folder)}</span><button type="button" class="btn ghost small" id="s-folder">Change…</button></div>
      </div>
      ${toggle('t-sound', 'Sound when a clip is saved', '', s.sound)}
    </div>
    ${state.standalone ? '' : `<div class="s-group">${toggle('t-startup', 'Start with Windows', 'In the tray, ready when you play', s.startup)}</div>`}
    <div class="s-group about">Onyx ${esc(state.version)} · part of Crystal Suite</div>`;
  const flip = (id: string, key: keyof Settings) => $(id)?.addEventListener('click', async () => apply(await native.settings({ [key]: !s[key] } as Partial<Settings>)));
  flip('t-enabled', 'enabled');
  flip('t-system', 'systemAudio');
  flip('t-mic', 'mic');
  flip('t-sound', 'sound');
  flip('t-startup', 'startup');
  $<HTMLSelectElement>('s-res').addEventListener('change', async (e) => apply(await native.settings({ resolution: Number((e.target as HTMLSelectElement).value) })));
  const segs = (id: string, fn: (v: string) => Partial<Settings>) => $(id).querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', async () => apply(await native.settings(fn(b.dataset.v!)))));
  segs('s-fps', (v) => ({ fps: Number(v) as 30 | 60 }));
  segs('s-quality', (v) => ({ quality: Number(v) as 0 | 1 | 2 }));
  $('s-folder').addEventListener('click', async () => { apply(await native.folderDialog()); loadClips(); });
  $('s-hotkey').addEventListener('click', () => { if (!capturing) startCapture(); });
}

// ---------- hotkey capture ----------

const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

function startCapture() {
  capturing = true;
  hotkeyError = '';
  native.hotkeyCapture(true);
  renderSettings();
}

function stopCapture() {
  capturing = false;
  native.hotkeyCapture(false);
  renderSettings();
}

function accelOf(e: KeyboardEvent): string | null {
  if (MOD_KEYS.has(e.key)) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[];
  let key = '';
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else if (/^Numpad\d$/.test(c)) key = 'num' + c.slice(6);
  else key = ({ Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Pause: 'Pause', PrintScreen: 'PrintScreen' } as Record<string, string>)[c] ?? '';
  if (!key) return null;
  return [...mods, key].join('+');
}

window.addEventListener('keydown', async (e) => {
  if (capturing) {
    e.preventDefault();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) { stopCapture(); return; }
    const accel = accelOf(e);
    if (!accel) return;
    // a lone letter or number would fire while typing in game chat
    if (!/^(Ctrl|Alt|Super)\+|^Shift\+F\d|^F\d{1,2}$|^Pause$|^PrintScreen$|^Insert$|^Home$|^End$|^PageUp$|^PageDown$/.test(accel)) {
      hotkeyError = 'Use Ctrl, Alt or a function key, so the hotkey doesn\'t fire while you type.';
      renderSettings();
      return;
    }
    const r = await native.setHotkey(accel);
    capturing = false;
    hotkeyError = r.ok ? '' : r.error || 'That hotkey can\'t be used.';
    await native.hotkeyCapture(false);
    apply(await native.init());
    return;
  }
  if (e.key === 'Escape' && !$('player').hidden) closePlayer();
});

// ---------- wiring ----------

let lastSettings = '';
let lastSource = '';

function apply(s: State) {
  state = s;
  renderPill();
  renderHero();
  renderMode();
  const key = JSON.stringify([s.settings, s.hotkeyOk, s.folder, s.standalone]);
  if (key !== lastSettings && !capturing) { lastSettings = key; renderSettings(); }
  const src = JSON.stringify([s.settings.mode, s.settings.window, s.settings.display, s.settings.always, s.settings.never, s.displays]);
  if (src !== lastSource) { lastSource = src; renderSource(); }
}

$('mode').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', async () => {
  const mode = b.dataset.mode as Mode;
  if (mode === state.settings.mode) return;
  apply(await native.settings({ mode }));
  if (mode !== 'screen') loadWindows();
}));
$('open-folder').addEventListener('click', () => native.openFolder());
$('player-close').addEventListener('click', closePlayer);
$('player').addEventListener('click', (e) => { if (e.target === $('player')) closePlayer(); });
$('player-reveal').addEventListener('click', () => { if (playing) native.reveal(playing.path); });
$('player-trash').addEventListener('click', async () => {
  if (!playing) return;
  const p = playing.path;
  closePlayer();
  if (await native.trash(p)) { clips = clips.filter((c) => c.path !== p); renderClips(); }
});

native.onState((s) => apply(s));
native.onClipsChanged(() => loadClips());
window.addEventListener('focus', () => { loadClips(); if (state.settings.mode !== 'screen') loadWindows(); });

(async () => {
  apply(await native.init());
  await loadClips();
  document.body.classList.add('ready');
  loadWindows();
  // "2 min ago" stays true
  setInterval(() => { if (clips.length) renderClips(); }, 60000);
})();
