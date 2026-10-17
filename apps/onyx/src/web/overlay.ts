// The in-game overlay page: shows the clip-length picker and notices as the main process asks.
import type { OverlayMessage } from '../shared/types';

const native = (window as unknown as {
  onyxNative: { onOverlay(cb: (m: OverlayMessage) => void): void; overlayHover(on: boolean): void; overlayAction(): Promise<void> };
}).onyxNative;
const card = document.getElementById('card')!;
let hideTimer = 0;

const label = (s: number) => (s < 60 ? `${s}s` : `${s / 60}m`);
const long = (s: number) => (s < 60 ? 'seconds' : s === 60 ? 'minute' : 'minutes');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const keys = (accel: string) => accel.split('+').map((k) => `<kbd>${esc(k)}</kbd>`).join('');

const ICONS = {
  ok: '<svg viewBox="0 0 20 20"><path d="M5 10.5l3.2 3.2L15 6.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  busy: '<svg viewBox="0 0 20 20" class="spin"><path d="M10 3a7 7 0 1 1-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  note: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9v5M10 6.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  error: '<svg viewBox="0 0 20 20"><path d="M10 5.5v5.5M10 14.2v.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.3 1.5H14v6.5H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
};

function show() {
  clearTimeout(hideTimer);
  card.classList.remove('hiding');
  requestAnimationFrame(() => card.classList.add('show'));
}

function hide() {
  card.classList.add('hiding');
  card.classList.remove('show', 'clickable');
  setHover(false);
  hideTimer = window.setTimeout(() => { card.innerHTML = ''; }, 220);
}

// A notice with a button (Show in folder) can be clicked. The window lets clicks through to the game, but the
// page still sees the pointer move: over the notice it asks for the clicks, off it gives them back.
let hovering = false;
function setHover(on: boolean) {
  if (on === hovering) return;
  hovering = on;
  card.classList.toggle('hover', on);
  native.overlayHover(on);
}
document.addEventListener('mousemove', (e) => setHover(card.classList.contains('clickable') && card.contains(e.target as Node)));
document.addEventListener('mouseleave', () => setHover(false));
card.addEventListener('click', () => {
  if (!card.classList.contains('clickable')) return;
  setHover(false);
  native.overlayAction();
});

function picker(m: Extract<OverlayMessage, { kind: 'picker' }>) {
  const fresh = !card.querySelector('.lengths') || !card.classList.contains('show');
  const game = m.games[m.game] ?? { name: 'Recording', sub: '', buffered: 0 };
  const short = (s: number) => game.buffered > 0 && game.buffered + 1 < s;
  const many = m.games.length > 1;
  card.innerHTML = `
    <div class="head">
      <div class="rec"><span class="dot"></span><span class="game">${esc(many ? `${m.games.length} games recording` : game.name)}</span></div>
      <div class="title">Save a clip</div>
    </div>
    ${many ? `<div class="games">${m.games.map((g, i) => `
      <div class="gm${i === m.game ? ' on' : ''}"><b>${esc(g.name)}</b>${g.sub ? `<small>${esc(g.sub)}</small>` : ''}</div>`).join('')}
    </div>` : ''}
    <div class="lengths">${m.lengths.map((s, i) => `
      <div class="len${i === m.index ? ' on' : ''}${short(s) ? ' short' : ''}">
        <span class="key">${i + 1}</span><b>${label(s)}</b><small>${short(s) ? `${Math.floor(game.buffered)}s so far` : long(s)}</small>
      </div>`).join('')}
    </div>
    <div class="bar"><i></i></div>
    <div class="hint">${many ? '<span><kbd>Tab</kbd> game</span>' : ''}<span>${keys(m.hotkey)} longer</span><span><kbd>1</kbd>–<kbd>4</kbd> pick</span><span><kbd>Enter</kbd> save now</span><span><kbd>Esc</kbd> cancel</span></div>`;
  // the countdown to saving the highlighted length
  card.querySelector<HTMLElement>('.bar i')!.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: m.ms, easing: 'linear', fill: 'forwards' });
  if (fresh) show();
}

function toast(m: Extract<OverlayMessage, { kind: 'toast' }>) {
  const icon = m.tone === 'ok' ? ICONS.ok : m.tone === 'error' ? ICONS.error : m.title.endsWith('…') ? ICONS.busy : ICONS.note;
  card.innerHTML = `<div class="toast ${m.tone}"><div class="badge">${icon}</div><div class="t-text"><div class="t-title">${esc(m.title)}</div>${m.sub ? `<div class="t-sub">${esc(m.sub)}</div>` : ''}</div>${m.action ? `<span class="act">${ICONS.folder}${esc(m.action)}</span>` : ''}</div>`;
  card.classList.toggle('clickable', !!m.action);
  if (!m.action) setHover(false);
  show();
  if (m.chime) chime();
}

/** Two soft notes: heard even when a game in exclusive fullscreen hides the overlay. */
function chime() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    for (const [f, at] of [[1318.5, 0], [1760, 0.09]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, now + at);
      g.gain.linearRampToValueAtTime(0.07, now + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(now + at);
      o.stop(now + at + 0.34);
    }
    setTimeout(() => ctx.close(), 800);
  } catch { /* no audio device */ }
}

native.onOverlay((m) => {
  if (m.kind !== 'toast') { card.classList.remove('clickable'); setHover(false); }
  if (m.kind === 'picker') picker(m);
  else if (m.kind === 'toast') toast(m);
  else hide();
});
