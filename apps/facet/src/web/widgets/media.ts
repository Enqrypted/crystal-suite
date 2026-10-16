// The Spotify / now playing widget: album art, title, artist, a live progress bar and the controls.
import type { MediaWidget, Track } from '../../shared/types';
import { api } from '../lib/api';
import { h } from '../lib/dom';
import { G } from '../lib/glyphs';
import { glass, unglass } from '../lib/liquid';
import { live, mmss, onLive, positionOf, trackFor } from '../lib/live';

const SPOTIFY_GREEN = '#1ed760';

export class MediaCard {
  readonly el: HTMLElement;
  private w!: MediaWidget;
  private off: () => void;
  private timer = 0;
  private sig = '';
  private parts: Record<string, HTMLElement> = {};

  constructor(w: MediaWidget) {
    this.el = h('div', { class: 'media-card' });
    this.off = onLive('media', () => this.render());
    this.set(w);
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  set(w: MediaWidget) {
    this.w = w;
    this.sig = '';
    this.render();
  }

  destroy() { this.off(); clearInterval(this.timer); }

  private get track() { return trackFor(this.w.source); }

  private render() {
    const w = this.w, t = this.track;
    const spotify = !!t && /spotify/i.test(t.app);
    // the layout only changes with the track, the settings or the available controls
    const sig = JSON.stringify([w.size, w.bg, w.source, t?.title, t?.artist, t?.art, t?.canPrev, t?.canNext, t?.canSeek, !t]);
    if (sig !== this.sig) {
      this.sig = sig;
      this.build(t, spotify);
    }
    this.update(t);
  }

  private build(t: Track | null, spotify: boolean) {
    const w = this.w;
    const el = this.el;
    el.className = `media-card size-${w.size} bg-${w.bg}${t ? '' : ' idle'}${spotify || w.source === 'spotify' ? ' spotify' : ''}`;
    el.style.setProperty('--accent', spotify || w.source === 'spotify' ? SPOTIFY_GREEN : '#ffffff');
    el.replaceChildren();
    this.parts = {};
    if (w.bg === 'art') unglass(el); else glass(el, { dark: w.bg === 'dark', tintAlpha: w.bg === 'dark' ? 0.5 : 0.12 });
    if (w.bg === 'art') el.append(h('div', { class: 'mc-backdrop', style: t?.art ? `background-image:url("${t.art}")` : '' }));
    const open = () => api.launch('spotify');
    if (!t) {
      const btn = h('button', { type: 'button', class: 'mc-open', text: w.source === 'spotify' ? 'Open Spotify' : 'Nothing playing' });
      if (w.source === 'spotify') btn.addEventListener('click', open);
      el.append(h('div', { class: 'mc-art empty', html: G.note }),
        h('div', { class: 'mc-info' }, h('div', { class: 'mc-source', text: w.source === 'spotify' ? 'Spotify' : 'Now playing' }), h('div', { class: 'mc-title', text: w.source === 'spotify' ? 'Not playing' : 'Play something' }), btn));
      return;
    }
    const art = h('button', { type: 'button', class: 'mc-art', title: spotify ? 'Open Spotify' : t.app });
    if (t.art) art.append(h('img', { src: t.art, alt: '', draggable: 'false' }));
    else art.innerHTML = G.note;
    if (spotify) art.addEventListener('click', open);
    const title = h('div', { class: 'mc-title', title: t.title }, h('span', { text: t.title || 'Unknown' }));
    const artist = h('div', { class: 'mc-artist', text: t.artist || t.album || '' });
    const source = h('div', { class: 'mc-source', html: `${G.note}<span>${spotify ? 'Spotify' : appName(t.app)}</span>` });
    const fill = h('div', { class: 'mc-fill' });
    const bar = h('div', { class: `mc-bar${t.canSeek ? ' seek' : ''}` }, fill);
    const cur = h('span', { class: 'mc-time' });
    const left = h('span', { class: 'mc-time' });
    if (t.canSeek) {
      bar.addEventListener('click', (e) => {
        const r = bar.getBoundingClientRect();
        const ms = Math.round(((e.clientX - r.left) / r.width) * t.duration);
        api.mediaCmd(this.target(), 'seek', String(ms));
      });
    }
    const btn = (cls: string, html: string, cmd: () => void, enabled = true) => {
      const b = h('button', { type: 'button', class: `mc-btn ${cls}`, html, disabled: !enabled });
      b.addEventListener('click', (e) => { e.stopPropagation(); cmd(); });
      return b;
    };
    const play = btn('play', G.play, () => this.cmd('play-pause'));
    const shuffle = btn('shuffle', G.shuffle, () => this.cmd('shuffle', this.track?.shuffle ? '0' : '1'), t.shuffle !== null);
    const repeat = btn('repeat', G.repeat, () => {
      const order = ['None', 'List', 'Track'];
      this.cmd('repeat', order[(order.indexOf(this.track?.repeat ?? 'None') + 1) % 3]);
    }, t.repeat !== null);
    const controls = h('div', { class: 'mc-controls' },
      w.size === 's' ? '' : shuffle,
      btn('prev', G.prev, () => this.cmd('prev'), t.canPrev),
      play,
      btn('next', G.next, () => this.cmd('next'), t.canNext),
      w.size === 's' ? '' : repeat);
    const info = h('div', { class: 'mc-info' }, source, title, artist);
    if (w.size === 's') el.append(art, info, h('div', { class: 'mc-controls' }, play));
    else el.append(art, h('div', { class: 'mc-main' }, info, h('div', { class: 'mc-progress' }, bar, h('div', { class: 'mc-times' }, cur, left)), controls));
    Object.assign(this.parts, { fill, cur, left, play, shuffle, repeat, title });
    requestAnimationFrame(() => {
      // long titles scroll gently instead of being cut off
      const span = title.firstElementChild as HTMLElement | null;
      const over = span ? span.scrollWidth - title.clientWidth : 0;
      title.classList.toggle('marquee-text', over > 4);
      if (over > 4) title.style.setProperty('--over', `${-over - 16}px`);
    });
  }

  private target() { return this.w.source === 'spotify' ? 'spotify' : 'current'; }

  private cmd(cmd: string, arg?: string) { api.mediaCmd(this.target(), cmd, arg); }

  private update(t: Track | null) {
    const p = this.parts;
    if (!t || !p.play) return;
    const playing = t.status === 'Playing';
    p.play.innerHTML = playing ? G.pause : G.play;
    p.play.title = playing ? 'Pause' : 'Play';
    p.shuffle?.classList.toggle('on', !!t.shuffle);
    if (p.repeat) {
      p.repeat.classList.toggle('on', !!t.repeat && t.repeat !== 'None');
      p.repeat.innerHTML = t.repeat === 'Track' ? G.repeat1 : G.repeat;
    }
    this.el.classList.toggle('playing', playing);
    this.tick();
  }

  /** Moves the progress bar once a second (a gliding animation would keep Chromium drawing non-stop). */
  private tick() {
    const t = this.track, p = this.parts;
    if (!t || !p.fill) return;
    const pos = positionOf(t);
    p.fill.style.transform = `scaleX(${t.duration > 0 ? pos / t.duration : 0})`;
    if (p.cur) p.cur.textContent = mmss(pos);
    if (p.left) p.left.textContent = t.duration > 0 ? `-${mmss(t.duration - pos)}` : '';
  }
}

function appName(id: string) {
  const n = id.replace(/\.exe$/i, '').split(/[!_.]/).filter(Boolean);
  const best = n.find((x) => /^[A-Z]/.test(x) && x.length > 2) ?? n[0] ?? 'Media';
  return /chrome|msedge|firefox|prism|brave|opera/i.test(id) ? 'Browser' : best;
}

/** The tile that shows what's playing inside the Control Center. */
export function nowPlayingTile() {
  const el = h('div', { class: 'cc-media' });
  const render = () => {
    const t = live.media.current ?? live.media.spotify;
    el.replaceChildren();
    if (!t) {
      el.classList.add('idle');
      el.append(h('div', { class: 'cc-art', html: G.note }), h('div', { class: 'cc-mt' }, h('div', { class: 'cc-title', text: 'Not playing' }), h('div', { class: 'cc-artist', text: 'Spotify' })));
      el.onclick = () => api.launch('spotify');
      return;
    }
    el.classList.remove('idle');
    el.onclick = null;
    const target = live.media.current && t === live.media.current ? 'current' : 'spotify';
    const art = h('div', { class: 'cc-art' });
    if (t.art) art.append(h('img', { src: t.art, alt: '', draggable: 'false' })); else art.innerHTML = G.note;
    const b = (html: string, cmd: string, enabled = true) => {
      const x = h('button', { type: 'button', class: 'cc-mbtn', html, disabled: !enabled });
      x.addEventListener('click', (e) => { e.stopPropagation(); api.mediaCmd(target, cmd); });
      return x;
    };
    el.append(
      h('div', { class: 'cc-mtop' }, art, h('div', { class: 'cc-mt' }, h('div', { class: 'cc-title', text: t.title || 'Unknown' }), h('div', { class: 'cc-artist', text: t.artist || '' }))),
      h('div', { class: 'cc-mctl' }, b(G.prev, 'prev', t.canPrev), b(t.status === 'Playing' ? G.pause : G.play, 'play-pause'), b(G.next, 'next', t.canNext)),
    );
  };
  const off = onLive('media', render);
  render();
  return { el, destroy: off };
}
