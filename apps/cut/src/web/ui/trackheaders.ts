// Track headers (left of the timeline): name, mute/solo, volume & pan (audio) or level (video),
// colour, reordering and height. Rows are kept per track so sliders keep working while values change.
import { store } from '../core/store';
import * as edit from '../core/edit';
import { TRACK_COLORS, formatDb, type Track } from '../core/model';
import { h, clamp } from './dom';
import { icon } from './icons';
import { Slider, dbMap, linMap, panFormat } from './slider';
import { contextMenu } from './menu';
import type { Timeline } from './timeline';

interface Row { el: HTMLElement; track: Track; sliders: { key: 'volume' | 'pan'; s: Slider }[]; name: HTMLElement; mute: HTMLElement; solo: HTMLElement; stripe: HTMLElement; sig: string }

export class TrackHeaders {
  readonly el: HTMLElement;
  private rows = new Map<string, Row>();

  constructor(private tl: Timeline) {
    this.el = h('div', { class: 'headers' });
    this.el.addEventListener('wheel', (e) => { e.preventDefault(); this.tl.scrollBy(0, e.deltaY); }, { passive: false });
    this.el.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.track')) return;
      contextMenu(e, [
        { label: 'Insert Video Track', key: 'Ctrl+Shift+Q', run: () => edit.insertTrack('video') },
        { label: 'Insert Audio Track', key: 'Ctrl+Q', run: () => edit.insertTrack('audio') },
      ]);
    });
    tl.onLayout = () => this.position();
    store.on((t) => { if (t.has('project') || t.has('selection') || t.has('view')) this.render(); });
    this.render();
  }

  private render() {
    const p = store.project;
    const ids = new Set(p.tracks.map((t) => t.id));
    for (const [id, r] of this.rows) if (!ids.has(id)) { r.el.remove(); this.rows.delete(id); }
    const counters = { video: 0, audio: 0 };
    for (const tr of p.tracks) {
      counters[tr.kind]++;
      let r = this.rows.get(tr.id);
      const sig = `${tr.kind}|${tr.height}`;
      if (!r || r.sig !== sig) { r?.el.remove(); r = this.build(tr); r.sig = sig; this.rows.set(tr.id, r); this.el.append(r.el); }
      this.update(r, tr, counters[tr.kind]);
    }
    this.position();
  }

  private position() {
    let y = -this.tl.scrollY;
    for (const tr of store.project.tracks) {
      const r = this.rows.get(tr.id);
      if (r) { r.el.style.top = `${y}px`; r.el.style.height = `${tr.height}px`; }
      y += tr.height;
    }
  }

  private build(tr: Track): Row {
    const id = tr.id;
    const stripe = h('div', { class: 'stripe' });
    const name = h('div', { class: 'name', title: 'Double-click to rename' });
    const mute = h('button', { class: 'tbtn mute', title: 'Mute track' }, 'M');
    const solo = h('button', { class: 'tbtn solo', title: 'Solo track' }, 'S');
    const row1 = h('div', { class: 'row1' }, name, mute, solo);
    const body = h('div', { class: 'body' }, row1);
    const sliders: Row['sliders'] = [];
    if (tr.kind === 'audio') {
      if (tr.height >= 52) {
        const val = h('span', { class: 'val' });
        const s = new Slider({ value: tr.volume, ...dbMap, format: formatDb, reset: 1, onBegin: () => store.begin(), onInput: (nv) => { const t = store.project.tracks.find((x) => x.id === id); if (t) { t.volume = nv; store.live(); } }, onEnd: () => store.end('Track Volume') }, val);
        body.append(h('div', { class: 'knob' }, h('span', { class: 'lbl' }, 'Vol'), s.el, val));
        sliders.push({ key: 'volume', s });
      }
      if (tr.height >= 70) {
        const val = h('span', { class: 'val' });
        const s = new Slider({ value: tr.pan, ...linMap(-1, 1), format: panFormat, reset: 0, center: true, onBegin: () => store.begin(), onInput: (nv) => { const t = store.project.tracks.find((x) => x.id === id); if (t) { t.pan = Math.abs(nv) < 0.02 ? 0 : nv; store.live(); } }, onEnd: () => store.end('Track Pan') }, val);
        body.append(h('div', { class: 'knob' }, h('span', { class: 'lbl' }, 'Pan'), s.el, val));
        sliders.push({ key: 'pan', s });
      }
    } else if (tr.height >= 52) {
      const val = h('span', { class: 'val' });
      const s = new Slider({ value: tr.volume, ...linMap(0, 1), format: (v) => `${Math.round(v * 100)}%`, reset: 1, onBegin: () => store.begin(), onInput: (nv) => { const t = store.project.tracks.find((x) => x.id === id); if (t) { t.volume = Math.round(nv * 100) / 100; store.live(); } }, onEnd: () => store.end('Track Level') }, val);
      body.append(h('div', { class: 'knob' }, h('span', { class: 'lbl' }, 'Level'), s.el, val));
      sliders.push({ key: 'volume', s });
    }
    const resize = h('div', { class: 'resize' });
    const el = h('div', { class: 'track' }, stripe, body, resize);
    el.addEventListener('pointerdown', () => { store.activeTrack = id; store.emit('selection'); });
    mute.addEventListener('click', () => edit.updateTrack(id, 'Mute Track', (t) => { t.mute = !t.mute; }));
    solo.addEventListener('click', () => edit.updateTrack(id, 'Solo Track', (t) => { t.solo = !t.solo; }));
    name.addEventListener('dblclick', () => this.rename(id, name));
    resize.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = store.project.tracks.find((x) => x.id === id);
      if (!t) return;
      const start = t.height;
      const sy = e.clientY;
      resize.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        t.height = clamp(Math.round(start + ev.clientY - sy), 30, 260);
        store.emit('project');
      };
      const up = () => { resize.removeEventListener('pointermove', move); resize.removeEventListener('pointerup', up); store.setDirty(true); };
      resize.addEventListener('pointermove', move);
      resize.addEventListener('pointerup', up);
    });
    el.addEventListener('contextmenu', (e) => {
      const t = store.project.tracks.find((x) => x.id === id);
      if (!t) return;
      contextMenu(e, [
        { label: 'Rename', run: () => this.rename(id, name) },
        { label: 'Track Color', submenu: () => TRACK_COLORS.map((c, i) => ({ label: ['Indigo', 'Teal', 'Orange', 'Pink', 'Green', 'Purple', 'Blue', 'Yellow'][i], checked: () => t.color === i, run: () => edit.updateTrack(id, 'Track Color', (x) => { x.color = i; }) })) },
        { sep: true },
        { label: 'Move Up', run: () => edit.moveTrack(id, -1) },
        { label: 'Move Down', run: () => edit.moveTrack(id, 1) },
        { sep: true },
        { label: 'Insert Video Track', key: 'Ctrl+Shift+Q', run: () => edit.insertTrack('video') },
        { label: 'Insert Audio Track', key: 'Ctrl+Q', run: () => edit.insertTrack('audio') },
        { label: 'Delete Track', run: () => edit.deleteTrack(id) },
      ]);
    });
    return { el, track: tr, sliders, name, mute, solo, stripe, sig: '' };
  }

  private update(r: Row, tr: Track, n: number) {
    r.track = tr;
    r.el.classList.toggle('active', tr.id === store.activeTrack);
    const color = TRACK_COLORS[tr.color % TRACK_COLORS.length];
    r.stripe.style.background = color;
    const stripeHtml = `<span>${n}</span>${icon(tr.kind === 'video' ? 'video' : 'audio', 13)}`;
    if (r.stripe.innerHTML !== stripeHtml) r.stripe.innerHTML = stripeHtml;
    if (r.name.textContent !== tr.name && !r.name.querySelector('input')) r.name.textContent = tr.name;
    r.mute.classList.toggle('on', tr.mute);
    r.solo.classList.toggle('on', tr.solo);
    for (const { key, s } of r.sliders) if (!store.inGesture) s.set(tr[key]);
  }

  private rename(id: string, nameEl: HTMLElement) {
    const t = store.project.tracks.find((x) => x.id === id);
    if (!t) return;
    const input = h('input', { class: 'rename', value: t.name }) as HTMLInputElement;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const done = (save: boolean) => {
      if (finished) return;
      finished = true;
      input.replaceWith(nameEl);
      if (save && input.value.trim() && input.value !== t.name) edit.updateTrack(id, 'Rename Track', (x) => { x.name = input.value.trim().slice(0, 40); });
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
  }
}
