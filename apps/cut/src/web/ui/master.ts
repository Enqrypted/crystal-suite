// Master bus: stereo peak meters with peak hold, and the master volume fader.
import { store } from '../core/store';
import { audio } from '../core/audio';
import { transport } from '../core/playback';
import { dbToGain, formatDb, gainToDb } from '../core/model';
import { h, clamp } from './dom';

const FLOOR = -60;
const toFrac = (lin: number) => { const db = gainToDb(lin); return isFinite(db) ? clamp((db - FLOOR) / -FLOOR, 0, 1) : 0; };

export class Master {
  readonly el: HTMLElement;
  private bars: { lvl: HTMLElement; peak: HTMLElement; value: number; hold: number; holdAt: number }[] = [];
  private vol: HTMLElement;
  private faderHandle: HTMLElement;
  private meterBox: HTMLElement;

  constructor() {
    const meters = h('div', { class: 'meters' });
    const scale = h('div', { class: 'scale' });
    for (const db of [0, -6, -12, -24, -36, -48]) scale.append(h('span', { style: `top:${(1 - (db - FLOOR) / -FLOOR) * 100}%` }, String(db)));
    meters.append(scale);
    for (let i = 0; i < 2; i++) {
      const lvl = h('div', { class: 'lvl' });
      const peak = h('div', { class: 'peak' });
      meters.append(h('div', { class: 'meter' }, lvl, peak));
      this.bars.push({ lvl, peak, value: 0, hold: 0, holdAt: 0 });
    }
    this.faderHandle = h('div', { class: 'h' });
    const fader = h('div', { class: 'vfader', title: 'Master volume (double-click: 0 dB)' }, this.faderHandle);
    meters.append(fader);
    this.meterBox = meters;
    this.vol = h('div', { class: 'vol', title: 'Master volume' });
    this.el = h('div', { class: 'master' }, h('div', { class: 'panel-head' }, h('span', { class: 'title' }, 'Master')), meters, this.vol);
    const fromY = (y: number) => {
      const r = fader.getBoundingClientRect();
      const f = clamp(1 - (y - r.top) / r.height, 0, 1);
      return f <= 0.01 ? 0 : dbToGain(f * 72 - 60);
    };
    fader.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      store.begin();
      fader.setPointerCapture(e.pointerId);
      const set = (y: number) => { store.project.masterVolume = fromY(y); store.live(); this.renderFader(); };
      set(e.clientY);
      const move = (ev: PointerEvent) => set(ev.clientY);
      const up = () => { fader.removeEventListener('pointermove', move); fader.removeEventListener('pointerup', up); store.end('Master Volume'); };
      fader.addEventListener('pointermove', move);
      fader.addEventListener('pointerup', up);
    });
    fader.addEventListener('dblclick', () => store.commit('Master Volume', (p) => { p.masterVolume = 1; }));
    store.on((t) => { if (t.has('project')) this.renderFader(); if (t.has('transport') && transport.playing) this.loop(); });
    this.renderFader();
    this.paint();
  }

  private renderFader() {
    const g = store.project.masterVolume;
    const db = gainToDb(g);
    const f = isFinite(db) ? clamp((db + 60) / 72, 0, 1) : 0;
    this.faderHandle.style.top = `${(1 - f) * 100}%`;
    this.vol.textContent = formatDb(g);
  }

  private loop = () => {
    this.paint();
    if (transport.playing || this.bars.some((b) => b.value > 0.001)) requestAnimationFrame(this.loop);
  };

  private paint() {
    const levels = transport.playing ? audio.levels() : [0, 0];
    const now = performance.now();
    const hpx = this.meterBox.clientHeight;
    this.bars.forEach((b, i) => {
      const v = toFrac(levels[i]);
      b.value = v > b.value ? v : Math.max(0, b.value - 0.025); // fast attack, smooth release
      if (v >= b.hold || now - b.holdAt > 1500) { b.hold = v; b.holdAt = now; }
      b.lvl.style.height = `${b.value * 100}%`;
      b.lvl.style.setProperty('--h', `${hpx}px`);
      b.peak.style.bottom = `${b.hold * 100}%`;
      b.peak.style.background = b.hold > 0.98 ? '#ff5c6c' : '#fff';
    });
  }
}
