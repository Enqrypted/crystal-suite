// The timeline: ruler, tracks and events drawn on canvas (a static layer plus a light overlay for the
// playhead, so playback only repaints a line). Vegas-style editing: drag events (Ctrl+drag copies),
// trim the edges, drag the top corners for fades, drag the top edge for volume/opacity, drag empty space
// for a time selection; snapping, ripple, markers, zoom and media drag & drop.
import { store } from '../core/store';
import { media, PEAKS_PER_SECOND } from '../core/media';
import { transport } from '../core/playback';
import * as edit from '../core/edit';
import {
  TRACK_COLORS, clipEnd, clipsOnTrack, curve, dbToGain, formatDb, gainToDb, maxLength, mediaOf, overlapMap, projectEnd, snapToFrame, uid,
  type Clip, type Overlaps, type Project, type Track,
} from '../core/model';
import { rulerLabel, timecode } from '../core/timecode';
import { h, clamp } from './dom';
import { contextMenu, type MenuItem } from './menu';

export const RULER_H = 46;
const LOOP_BAR = 11;
const HEADER_H = 15;
const EDGE = 6;
const SNAP_PX = 9;
const MIN_PPS = 0.02;
const MAX_PPS = 4000;

type Zone = 'body' | 'left' | 'right' | 'fadeIn' | 'fadeOut' | 'gain';
type Hit =
  | { kind: 'clip'; clip: Clip; track: Track; zone: Zone }
  | { kind: 'track'; track: Track }
  | { kind: 'none' };

interface DropGhost { start: number; length: number; trackId: string; video: boolean; audio: boolean }

export class Timeline {
  readonly el: HTMLElement;
  readonly right: HTMLElement;
  private ruler: HTMLCanvasElement;
  private rulerOverlay: HTMLCanvasElement;
  private tracks: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private hbar: HTMLElement;
  private hthumb: HTMLElement;
  private emptyHint: HTMLElement;
  pps = 60;
  scrollX = 0;
  scrollY = 0;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private staticDirty = true;
  private overlayDirty = true;
  private raf = 0;
  private snapLine: number | null = null;
  private dragLabel: { x: number; y: number; text: string } | null = null;
  private ghost: DropGhost | null = null;
  private overlaps: Map<string, Overlaps> = new Map();
  /** Called when vertical scroll or track layout changes (the headers follow). */
  onLayout: () => void = () => {};
  /** Resolves media dragged from the bin into items to place. */
  dragMedia: string[] | null = null;
  onOpenProperties: () => void = () => {};

  constructor() {
    this.ruler = h('canvas');
    this.rulerOverlay = h('canvas', { style: 'position:absolute;left:0;top:0;pointer-events:none' });
    this.tracks = h('canvas');
    this.overlay = h('canvas', { style: 'position:absolute;left:0;top:0;pointer-events:none' });
    this.hthumb = h('div', { class: 'thumb' });
    this.hbar = h('div', { class: 'hscroll' }, this.hthumb);
    this.emptyHint = h('div', { class: 'empty-hint', html: '<div><b>Drop video, audio or images here</b>or use File › Import Media (Ctrl+I)</div>' });
    const rulerWrap = h('div', { class: 'ruler-wrap' }, this.ruler, this.rulerOverlay);
    const tracksWrap = h('div', { class: 'tracks-wrap' }, this.tracks, this.overlay, this.emptyHint);
    this.right = h('div', { class: 'tl-right' }, rulerWrap, tracksWrap, this.hbar);
    this.el = this.right;
    new ResizeObserver(() => this.resize()).observe(tracksWrap);
    this.bindRuler();
    this.bindTracks(tracksWrap);
    this.bindScrollbar();
    store.on((topics) => {
      if (topics.has('project') || topics.has('selection') || topics.has('view') || topics.has('media')) this.invalidate();
      if (topics.has('project')) this.overlaps = overlapMap(store.project);
      if (topics.has('time')) { this.followPlayhead(); this.overlayDirty = true; this.schedule(); }
    });
  }

  // ---------- geometry ----------
  x(t: number) { return (t - this.scrollX) * this.pps; }
  t(x: number) { return x / this.pps + this.scrollX; }
  trackTops(p: Project = store.project) {
    const tops: number[] = [];
    let y = 0;
    for (const tr of p.tracks) { tops.push(y); y += tr.height; }
    return { tops, total: y };
  }
  private trackAtY(y: number): { track: Track; top: number; index: number } | null {
    const p = store.project;
    const { tops } = this.trackTops(p);
    const cy = y + this.scrollY;
    for (let i = 0; i < p.tracks.length; i++) if (cy >= tops[i] && cy < tops[i] + p.tracks[i].height) return { track: p.tracks[i], top: tops[i] - this.scrollY, index: i };
    return null;
  }
  get viewWidth() { return this.w; }

  private resize() {
    const wrap = this.tracks.parentElement!;
    this.dpr = window.devicePixelRatio || 1;
    this.w = wrap.clientWidth;
    this.hgt = wrap.clientHeight;
    for (const [c, ww, hh] of [[this.tracks, this.w, this.hgt], [this.overlay, this.w, this.hgt], [this.ruler, this.w, RULER_H], [this.rulerOverlay, this.w, RULER_H]] as const) {
      c.width = Math.max(1, Math.round(ww * this.dpr));
      c.height = Math.max(1, Math.round(hh * this.dpr));
      c.style.width = `${ww}px`;
      c.style.height = `${hh}px`;
    }
    this.clampScroll();
    this.invalidate();
  }

  invalidate() { this.staticDirty = true; this.overlayDirty = true; this.schedule(); }
  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.staticDirty) { this.staticDirty = false; this.drawRuler(); this.drawTracks(); this.updateScrollbar(); }
      if (this.overlayDirty) { this.overlayDirty = false; this.drawOverlay(); }
    });
  }

  private clampScroll() {
    const { total } = this.trackTops();
    this.scrollY = clamp(this.scrollY, 0, Math.max(0, total - this.hgt + 30));
    this.scrollX = Math.max(0, this.scrollX);
    this.onLayout();
  }

  // ---------- zoom & scroll ----------
  zoomTo(pps: number, anchorT = store.time, anchorX = this.x(store.time)) {
    pps = clamp(pps, MIN_PPS, MAX_PPS);
    if (anchorX < 0 || anchorX > this.w) anchorX = this.w / 2;
    this.pps = pps;
    this.scrollX = Math.max(0, anchorT - anchorX / pps);
    this.invalidate();
    store.emit('view');
  }
  zoom(factor: number, anchorT?: number, anchorX?: number) { this.zoomTo(this.pps * factor, anchorT, anchorX); }
  zoomFit() {
    const end = Math.max(projectEnd(store.project), 10);
    this.pps = clamp((this.w - 40) / end, MIN_PPS, MAX_PPS);
    this.scrollX = 0;
    this.invalidate();
    store.emit('view');
  }
  scrollBy(dx: number, dy: number) {
    this.scrollX = Math.max(0, this.scrollX + dx / this.pps);
    this.scrollY += dy;
    this.clampScroll();
    this.invalidate();
  }
  /** Keeps the playhead in view (pages forward during playback, like Vegas). */
  private followPlayhead() {
    const x = this.x(store.time);
    if (transport.playing) {
      if (x > this.w - 20 || x < 0) { this.scrollX = Math.max(0, store.time - 20 / this.pps); this.invalidate(); }
    } else if (x < 0 || x > this.w) {
      this.scrollX = Math.max(0, store.time - this.w * 0.4 / this.pps);
      this.invalidate();
    }
  }
  /** Brings a time into view without moving it if it is already visible. */
  reveal(t: number) {
    const x = this.x(t);
    if (x < 0 || x > this.w) { this.scrollX = Math.max(0, t - this.w * 0.3 / this.pps); this.invalidate(); }
  }

  // ---------- drawing ----------
  private tickStep() {
    const fps = store.project.fps;
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
    for (const s of steps) if (s * this.pps >= 74) return s;
    return 7200;
  }

  private drawRuler() {
    const c = this.ruler.getContext('2d')!;
    const p = store.project;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#1e1e23';
    c.fillRect(0, 0, this.w, RULER_H);
    // loop bar
    c.fillStyle = '#17171b';
    c.fillRect(0, 0, this.w, LOOP_BAR);
    if (p.loop) {
      const x0 = this.x(p.loop.start);
      const x1 = this.x(p.loop.end);
      c.fillStyle = store.view.loop ? '#4d5bd6' : '#3b3f6a';
      c.fillRect(x0, 0, x1 - x0, LOOP_BAR);
      c.fillStyle = '#c9ccff';
      c.beginPath(); c.moveTo(x0, 0); c.lineTo(x0 + 6, 0); c.lineTo(x0, LOOP_BAR); c.fill();
      c.beginPath(); c.moveTo(x1, 0); c.lineTo(x1 - 6, 0); c.lineTo(x1, LOOP_BAR); c.fill();
    }
    // ticks
    const step = this.tickStep();
    const minor = step >= 1 ? step / 5 : step / 2;
    const t0 = Math.floor(this.scrollX / minor) * minor;
    const t1 = this.t(this.w);
    c.strokeStyle = '#4a4a55';
    c.fillStyle = '#a5a5b0';
    c.font = '10.5px "Segoe UI", sans-serif';
    c.textBaseline = 'top';
    c.beginPath();
    for (let t = t0; t <= t1 + minor; t += minor) {
      const x = Math.round(this.x(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      c.moveTo(x, RULER_H);
      c.lineTo(x, RULER_H - (major ? 13 : 6));
      if (major) c.fillText(rulerLabel(Math.max(0, t), step, p.fps), x + 4, LOOP_BAR + 6);
    }
    c.stroke();
    // markers
    for (const m of p.markers) {
      const x = Math.round(this.x(m.time)) + 0.5;
      if (x < -60 || x > this.w + 10) continue;
      c.fillStyle = '#e8963c';
      c.beginPath(); c.moveTo(x, LOOP_BAR); c.lineTo(x + 9, LOOP_BAR + 5); c.lineTo(x, LOOP_BAR + 10); c.fill();
      c.fillStyle = '#ffd3a1';
      c.fillText(m.name, x + 12, LOOP_BAR + 1);
    }
    c.strokeStyle = '#2f2f36';
    c.beginPath(); c.moveTo(0, RULER_H - 0.5); c.lineTo(this.w, RULER_H - 0.5); c.stroke();
  }

  private drawTracks() {
    const c = this.tracks.getContext('2d')!;
    const p = store.project;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#16161a';
    c.fillRect(0, 0, this.w, this.hgt);
    const { tops } = this.trackTops(p);
    const step = this.tickStep();
    // track lanes
    p.tracks.forEach((tr, i) => {
      const y = tops[i] - this.scrollY;
      if (y > this.hgt || y + tr.height < 0) return;
      c.fillStyle = tr.id === store.activeTrack ? '#202027' : tr.kind === 'video' ? '#1b1b21' : '#19191e';
      c.fillRect(0, y, this.w, tr.height - 1);
      c.fillStyle = '#111114';
      c.fillRect(0, y + tr.height - 1, this.w, 1);
    });
    // grid
    c.strokeStyle = 'rgba(255,255,255,0.035)';
    c.beginPath();
    for (let t = Math.floor(this.scrollX / step) * step; t <= this.t(this.w); t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      c.moveTo(x, 0); c.lineTo(x, this.hgt);
    }
    c.stroke();
    // time selection
    if (p.loop) {
      c.fillStyle = 'rgba(110,130,255,0.10)';
      c.fillRect(this.x(p.loop.start), 0, (p.loop.end - p.loop.start) * this.pps, this.hgt);
    }
    // events
    const visibleT0 = this.scrollX;
    const visibleT1 = this.t(this.w);
    p.tracks.forEach((tr, i) => {
      const y = tops[i] - this.scrollY;
      if (y > this.hgt || y + tr.height < 0) return;
      for (const clip of clipsOnTrack(p, tr.id)) {
        if (clipEnd(clip) < visibleT0 || clip.start > visibleT1) continue;
        this.drawClip(c, p, tr, clip, y);
      }
      // crossfade marks on overlaps
      for (const clip of clipsOnTrack(p, tr.id)) {
        const o = this.overlaps.get(clip.id);
        if (!o?.before || !o.prev) continue;
        const x0 = this.x(clip.start);
        const x1 = this.x(clip.start + o.before);
        const top = y + 2 + HEADER_H;
        const bot = y + tr.height - 3;
        c.save();
        c.strokeStyle = 'rgba(255,255,255,0.75)';
        c.lineWidth = 1.2;
        c.beginPath();
        c.moveTo(x0, bot); c.lineTo(x1, top);
        c.moveTo(x0, top); c.lineTo(x1, bot);
        c.stroke();
        c.fillStyle = 'rgba(255,255,255,0.08)';
        c.fillRect(x0, top, x1 - x0, bot - top);
        c.restore();
      }
    });
    // markers
    c.strokeStyle = 'rgba(232,150,60,0.55)';
    c.setLineDash([3, 3]);
    c.beginPath();
    for (const m of p.markers) { const x = Math.round(this.x(m.time)) + 0.5; c.moveTo(x, 0); c.lineTo(x, this.hgt); }
    c.stroke();
    c.setLineDash([]);
    this.emptyHint.hidden = p.clips.length > 0;
  }

  private drawClip(c: CanvasRenderingContext2D, p: Project, tr: Track, clip: Clip, trackY: number) {
    const x = this.x(clip.start);
    const w = Math.max(1, clip.length * this.pps);
    const y = trackY + 2;
    const hh = tr.height - 5;
    const sel = store.selection.has(clip.id);
    const r = media.get(clip.mediaId);
    const offline = !!clip.mediaId && (!r || r.status === 'offline' || r.status === 'error');
    const color = TRACK_COLORS[tr.color % TRACK_COLORS.length];
    c.save();
    c.globalAlpha = clip.mute ? 0.45 : 1;
    c.beginPath();
    c.roundRect(x, y, w, hh, 4);
    c.clip();
    // body
    c.fillStyle = offline ? '#3a1820' : sel ? '#2c2c40' : '#24242c';
    c.fillRect(x, y, w, hh);
    const bodyY = y + HEADER_H;
    const bodyH = hh - HEADER_H;
    if (!offline && bodyH > 4) {
      if (clip.generator) this.drawGenerator(c, clip, x, bodyY, w, bodyH);
      else if (tr.kind === 'video' && store.view.thumbnails && r) this.drawThumbs(c, clip, x, bodyY, w, bodyH, r.item.width / Math.max(1, r.item.height));
      else if (tr.kind === 'audio' && store.view.waveforms && r) this.drawWave(c, clip, x, bodyY, w, bodyH, color, sel);
    }
    // header strip
    c.fillStyle = offline ? '#8c2435' : shade(color, sel ? 0.05 : -0.35);
    c.fillRect(x, y, w, HEADER_H);
    c.fillStyle = sel ? '#fff' : 'rgba(255,255,255,0.88)';
    c.font = '600 10.5px "Segoe UI", sans-serif';
    c.textBaseline = 'middle';
    const tags: string[] = [];
    if (clip.speed !== 1) tags.push(`${Math.round(clip.speed * 100)}%`);
    if (tr.kind === 'audio' && clip.gain !== 1) tags.push(formatDb(clip.gain));
    if (tr.kind === 'video' && clip.gain !== 1) tags.push(`${Math.round(clip.gain * 100)}%`);
    if (tr.kind === 'video' && hasFx(clip)) tags.push('FX');
    if (clip.mute) tags.push('muted');
    const label = (offline ? '⚠ Media offline — ' : '') + (clip.name || mediaOf(p, clip)?.name || '') + (tags.length ? `  ·  ${tags.join('  ·  ')}` : '');
    c.fillText(label, Math.max(x, 0) + 5, y + HEADER_H / 2 + 0.5);
    // fades (own fades; overlaps are drawn as crossfades)
    const o = this.overlaps.get(clip.id);
    const fadeIn = o?.before ? 0 : clip.fadeIn;
    const fadeOut = o?.after ? 0 : clip.fadeOut;
    this.drawFade(c, x, bodyY, fadeIn * this.pps, bodyH, clip.fadeInCurve, false);
    this.drawFade(c, x + w, bodyY, fadeOut * this.pps, bodyH, clip.fadeOutCurve, true);
    // volume / opacity line
    if (clip.gain !== 1) {
      const ly = bodyY + this.levelToFrac(tr, clip.gain) * bodyH;
      c.strokeStyle = 'rgba(120,200,255,0.9)';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, ly + 0.5); c.lineTo(x + w, ly + 0.5); c.stroke();
    }
    c.restore();
    // outline
    c.save();
    c.lineWidth = sel ? 1.6 : 1;
    c.strokeStyle = sel ? '#b6b6ff' : 'rgba(0,0,0,0.6)';
    c.beginPath();
    c.roundRect(x + 0.5, y + 0.5, w - 1, hh - 1, 4);
    c.stroke();
    // fade handles (Vegas puts them at the top corners)
    if (sel || clip.fadeIn || clip.fadeOut) {
      c.fillStyle = '#fff';
      if (w > 24) {
        c.fillRect(x + fadeIn * this.pps - 3, y + 1, 6, 4);
        c.fillRect(x + w - fadeOut * this.pps - 3, y + 1, 6, 4);
      }
    }
    c.restore();
  }

  private drawFade(c: CanvasRenderingContext2D, edgeX: number, y: number, fw: number, hh: number, kind: Clip['fadeInCurve'], out: boolean) {
    if (fw < 1) return;
    const n = Math.max(8, Math.min(60, Math.round(fw / 3)));
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const level = curve(k, kind);
      const px = out ? edgeX - fw + fw * (1 - k) : edgeX + fw * k;
      const py = y + hh - level * hh;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    // shade the faded-out area above the curve
    c.lineTo(out ? edgeX - fw : edgeX + fw, y);
    c.lineTo(edgeX, y);
    c.closePath();
    c.fillStyle = 'rgba(0,0,0,0.42)';
    c.fill();
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const level = curve(k, kind);
      const px = out ? edgeX - fw + fw * (1 - k) : edgeX + fw * k;
      const py = y + hh - level * hh;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 1.2;
    c.stroke();
  }

  private drawThumbs(c: CanvasRenderingContext2D, clip: Clip, x: number, y: number, w: number, hh: number, aspect: number) {
    const slot = Math.max(24, Math.round(hh * (aspect || 16 / 9)));
    const firstSlot = Math.max(0, Math.floor(-x / slot));
    const lastSlot = Math.min(Math.ceil(w / slot), Math.ceil((this.w - x) / slot));
    const step = (slot / this.pps) * clip.speed;
    for (let i = firstSlot; i < lastSlot; i++) {
      const sx = x + i * slot;
      const srcT = clip.offset + ((sx - x) / this.pps) * clip.speed;
      const bmp = media.thumbnail(clip.mediaId!, srcT, step);
      if (bmp) {
        const bw = Math.min(slot, x + w - sx);
        const scale = hh / bmp.height;
        c.drawImage(bmp, 0, 0, Math.min(bmp.width, bw / scale), bmp.height, sx, y, Math.min(bw, bmp.width * scale), hh);
      }
    }
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(x, y, w, hh);
  }

  private drawWave(c: CanvasRenderingContext2D, clip: Clip, x: number, y: number, w: number, hh: number, color: string, sel: boolean) {
    const r = media.get(clip.mediaId);
    const peaks = r?.peaks;
    if (!peaks) {
      c.fillStyle = 'rgba(255,255,255,0.25)';
      c.font = '10px "Segoe UI", sans-serif';
      c.fillText(r?.audioTrack ? 'Building waveform…' : '', Math.max(x, 0) + 6, y + hh / 2);
      return;
    }
    const mid = y + hh / 2;
    const amp = (hh / 2 - 2) * Math.min(4, clip.gain);
    const px0 = Math.max(0, Math.floor(x));
    const px1 = Math.min(this.w, Math.ceil(x + w));
    c.fillStyle = sel ? shade(color, 0.35) : shade(color, 0.1);
    c.beginPath();
    c.moveTo(px0, mid);
    const vals: number[] = [];
    for (let px = px0; px < px1; px++) {
      const t0 = clip.offset + ((px - x) / this.pps) * clip.speed;
      const t1 = clip.offset + ((px + 1 - x) / this.pps) * clip.speed;
      const i0 = Math.floor(t0 * PEAKS_PER_SECOND);
      const i1 = Math.max(i0 + 1, Math.ceil(t1 * PEAKS_PER_SECOND));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.filled; i++) if (peaks.data[i] > m) m = peaks.data[i];
      vals.push(Math.min(1, m));
      c.lineTo(px, mid - Math.min(hh / 2, m * amp));
    }
    for (let i = vals.length - 1; i >= 0; i--) c.lineTo(px0 + i, mid + Math.min(hh / 2, vals[i] * amp));
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(px0, mid, px1 - px0, 1);
  }

  private drawGenerator(c: CanvasRenderingContext2D, clip: Clip, x: number, y: number, w: number, hh: number) {
    if (clip.generator === 'solid') { c.fillStyle = clip.color || '#000'; c.fillRect(x, y, w, hh); return; }
    if (clip.generator === 'gradient') {
      const g = c.createLinearGradient(x, y, x + Math.min(w, 300), y + hh);
      g.addColorStop(0, clip.color || '#000'); g.addColorStop(1, clip.color2 || '#fff');
      c.fillStyle = g; c.fillRect(x, y, w, hh); return;
    }
    c.fillStyle = '#2a2440';
    c.fillRect(x, y, w, hh);
    c.fillStyle = clip.text?.color || '#fff';
    c.font = `700 ${Math.min(22, hh * 0.45)}px "Segoe UI", sans-serif`;
    c.textBaseline = 'middle';
    c.fillText('T', Math.max(x, 0) + 8, y + hh / 2);
    c.font = '11px "Segoe UI", sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.75)';
    c.fillText((clip.text?.text || '').split('\n')[0].slice(0, 80), Math.max(x, 0) + 28, y + hh / 2);
  }

  /** Where the level line sits (0 = top) for a gain/opacity value. */
  private levelToFrac(tr: Track, g: number) {
    if (tr.kind === 'video') return clamp(1 - g, 0, 1);
    const db = gainToDb(g);
    return isFinite(db) ? clamp(-db / 48, 0, 1) : 1;
  }
  private fracToLevel(tr: Track, f: number) {
    f = clamp(f, 0, 1);
    if (tr.kind === 'video') return Math.round((1 - f) * 100) / 100;
    return f >= 0.999 ? 0 : dbToGain(-f * 48);
  }

  private drawOverlay() {
    const p = store.project;
    // ruler playhead
    const rc = this.rulerOverlay.getContext('2d')!;
    rc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    rc.clearRect(0, 0, this.w, RULER_H);
    const px = Math.round(this.x(store.time)) + 0.5;
    rc.fillStyle = '#ff4d6d';
    rc.beginPath(); rc.moveTo(px - 6, RULER_H - 9); rc.lineTo(px + 6, RULER_H - 9); rc.lineTo(px, RULER_H - 1); rc.fill();
    rc.fillRect(px - 0.5, LOOP_BAR, 1, RULER_H - LOOP_BAR);
    // track area overlay
    const c = this.overlay.getContext('2d')!;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.hgt);
    if (this.ghost) {
      const g = this.ghost;
      const { tops } = this.trackTops(p);
      const vi = p.tracks.findIndex((t) => t.id === g.trackId);
      const gx = this.x(g.start);
      c.fillStyle = 'rgba(141,141,255,0.25)';
      c.strokeStyle = '#aaaaff';
      if (vi >= 0) {
        const tr = p.tracks[vi];
        c.fillRect(gx, tops[vi] - this.scrollY + 2, g.length * this.pps, tr.height - 5);
        c.strokeRect(gx + 0.5, tops[vi] - this.scrollY + 2.5, g.length * this.pps - 1, tr.height - 6);
      }
    }
    if (this.snapLine !== null) {
      const sx = Math.round(this.x(this.snapLine)) + 0.5;
      c.strokeStyle = '#7ef0ff';
      c.setLineDash([4, 3]);
      c.beginPath(); c.moveTo(sx, 0); c.lineTo(sx, this.hgt); c.stroke();
      c.setLineDash([]);
    }
    c.fillStyle = '#ff4d6d';
    c.fillRect(px - 0.5, 0, 1, this.hgt);
    if (this.dragLabel) {
      const l = this.dragLabel;
      c.font = '600 11px "Segoe UI", sans-serif';
      const tw = c.measureText(l.text).width + 12;
      const lx = clamp(l.x + 12, 2, this.w - tw - 2);
      c.fillStyle = 'rgba(20,20,26,0.92)';
      c.beginPath(); c.roundRect(lx, l.y - 22, tw, 18, 4); c.fill();
      c.fillStyle = '#fff';
      c.textBaseline = 'middle';
      c.fillText(l.text, lx + 6, l.y - 13);
    }
  }
  private overlayNow() { this.overlayDirty = true; this.schedule(); }

  // ---------- hit testing ----------
  hit(x: number, y: number): Hit {
    const row = this.trackAtY(y);
    if (!row) return { kind: 'none' };
    const p = store.project;
    const clips = clipsOnTrack(p, row.track.id).reverse(); // later clips are drawn on top
    // the clip actually under the mouse wins; a couple of pixels of slack only when there is none
    const inside = clips.filter((c) => x >= this.x(c.start) && x <= this.x(c.start) + c.length * this.pps);
    const near = inside.length ? inside : clips.filter((c) => x >= this.x(c.start) - 2 && x <= this.x(c.start) + c.length * this.pps + 2);
    for (const clip of near) {
      const cx = this.x(clip.start);
      const cw = clip.length * this.pps;
      const ly = y - row.top - 2;
      const edge = Math.min(EDGE, cw / 4);
      const o = this.overlaps.get(clip.id);
      const fi = (o?.before ? 0 : clip.fadeIn) * this.pps;
      const fo = (o?.after ? 0 : clip.fadeOut) * this.pps;
      let zone: Zone = 'body';
      if (ly < 9 && cw > 24 && Math.abs(x - (cx + fi)) < 7) zone = 'fadeIn';
      else if (ly < 9 && cw > 24 && Math.abs(x - (cx + cw - fo)) < 7) zone = 'fadeOut';
      else if (x <= cx + edge) zone = 'left';
      else if (x >= cx + cw - edge) zone = 'right';
      else if (ly < 5) zone = 'gain';
      return { kind: 'clip', clip, track: row.track, zone };
    }
    return { kind: 'track', track: row.track };
  }

  private cursorFor(h: Hit) {
    if (h.kind !== 'clip') return 'default';
    return { body: 'grab', left: 'ew-resize', right: 'ew-resize', fadeIn: 'col-resize', fadeOut: 'col-resize', gain: 'ns-resize' }[h.zone];
  }

  // ---------- snapping ----------
  private snapPoints(exclude: Set<string>) {
    const p = store.project;
    const pts: number[] = [0, store.time];
    for (const c of p.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c));
    for (const m of p.markers) pts.push(m.time);
    if (p.loop) pts.push(p.loop.start, p.loop.end);
    return pts;
  }
  /** Snaps one of `candidates` (times) to the nearest snap point; returns the time shift. */
  private snap(candidates: number[], points: number[], disable: boolean) {
    this.snapLine = null;
    if (!store.view.snapping || disable) return 0;
    let best = Infinity;
    let shift = 0;
    for (const t of candidates) {
      for (const pt of points) {
        const d = Math.abs(pt - t) * this.pps;
        if (d < SNAP_PX && d < best) { best = d; shift = pt - t; this.snapLine = pt; }
      }
    }
    return shift;
  }
  private q(t: number) { return store.view.quantize ? snapToFrame(t, store.project.fps) : t; }

  // ---------- ruler interaction ----------
  private bindRuler() {
    const el = this.ruler;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const p = store.project;
      // markers
      const marker = p.markers.find((m) => Math.abs(this.x(m.time) - x) < 6 && y >= LOOP_BAR && y < LOOP_BAR + 12);
      if (marker) {
        store.begin();
        const orig = marker.time;
        this.capture(e, (dx) => {
          const m = store.project.markers.find((mm) => mm.id === marker.id);
          if (m) { m.time = Math.max(0, this.q(orig + dx / this.pps)); store.live(); }
        }, () => store.end('Move Marker'));
        return;
      }
      if (y < LOOP_BAR) { this.loopDrag(e, x); return; }
      transport.seek(this.q(this.t(x)));
      this.capture(e, (_dx, _dy, ev) => {
        const xx = ev.clientX - rect.left;
        transport.seek(this.q(Math.max(0, this.t(xx))));
      });
    });
    el.addEventListener('dblclick', (e) => {
      const rect = el.getBoundingClientRect();
      if (e.clientY - rect.top < LOOP_BAR) { edit.setLoop(0, 0); return; }
      edit.addMarker(this.q(this.t(e.clientX - rect.left)));
    });
    el.addEventListener('contextmenu', (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = this.q(Math.max(0, this.t(x)));
      const marker = store.project.markers.find((m) => Math.abs(this.x(m.time) - x) < 6);
      const items: MenuItem[] = marker
        ? [{ label: 'Rename Marker…', run: () => this.renameMarker(marker.id) }, { label: 'Delete Marker', run: () => edit.removeMarker(marker.id) }]
        : [{ label: 'Insert Marker Here', key: 'M', run: () => edit.addMarker(t) }, { sep: true },
          { label: 'Clear Time Selection', enabled: () => !!store.project.loop, run: () => edit.setLoop(0, 0) },
          { label: 'Loop Playback', key: 'Q', checked: () => store.view.loop, run: () => store.setView('loop', !store.view.loop) }];
      contextMenu(e, items);
    });
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  private renameMarker(id: string) {
    const m = store.project.markers.find((x) => x.id === id);
    if (!m) return;
    const name = prompt('Marker name', m.name);
    if (name !== null) store.commit('Rename Marker', (p) => { const mm = p.markers.find((x) => x.id === id); if (mm) mm.name = name.slice(0, 60); });
  }

  private loopDrag(e: PointerEvent, x: number) {
    const p = store.project;
    const t = this.q(Math.max(0, this.t(x)));
    store.begin();
    let mode: 'start' | 'end' | 'move' | 'new' = 'new';
    const orig = p.loop ? { ...p.loop } : null;
    if (orig) {
      if (Math.abs(this.x(orig.start) - x) < 7) mode = 'start';
      else if (Math.abs(this.x(orig.end) - x) < 7) mode = 'end';
      else if (x > this.x(orig.start) && x < this.x(orig.end)) mode = 'move';
    }
    const points = this.snapPoints(new Set());
    this.capture(e, (dx) => {
      const pr = store.project;
      const d = dx / this.pps;
      if (mode === 'new') {
        const a = t;
        let b = this.q(Math.max(0, t + d));
        b += this.snap([b], points, false);
        pr.loop = b !== a ? { start: Math.min(a, b), end: Math.max(a, b) } : null;
      } else if (orig) {
        let s = orig.start;
        let en = orig.end;
        if (mode === 'start') s = this.q(Math.max(0, orig.start + d));
        else if (mode === 'end') en = this.q(Math.max(0, orig.end + d));
        else { const dd = this.q(Math.max(-orig.start, d)); s = orig.start + dd; en = orig.end + dd; }
        const shift = this.snap(mode === 'end' ? [en] : [s], points, false);
        if (mode === 'start') s += shift; else if (mode === 'end') en += shift; else { s += shift; en += shift; }
        pr.loop = { start: Math.min(s, en), end: Math.max(s, en) };
      }
      store.live();
      this.overlayNow();
    }, () => { this.snapLine = null; store.end('Time Selection'); this.overlayNow(); });
  }

  // ---------- track area interaction ----------
  private bindTracks(wrap: HTMLElement) {
    const el = this.tracks;
    const local = (e: MouseEvent) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const { x, y } = local(e);
      el.style.cursor = this.cursorFor(this.hit(x, y));
    });
    el.addEventListener('pointerdown', (e) => {
      const { x, y } = local(e);
      if (e.button === 1) { this.panDrag(e); return; }
      if (e.button !== 0) return;
      const hit = this.hit(x, y);
      if (hit.kind === 'none') { store.clearSelection(); return; }
      store.activeTrack = hit.track.id;
      if (hit.kind === 'track') { this.emptyDrag(e, x); return; }
      const { clip, zone } = hit;
      if (e.ctrlKey && zone === 'body') {
        // Ctrl+click toggles; Ctrl+drag copies (decided once the mouse moves)
        this.copyOrToggle(e, hit.clip, x, y);
        return;
      }
      if (!store.selection.has(clip.id)) store.select(edit.withGroups(store.project, [clip.id]), e.shiftKey);
      else store.emit('selection');
      if (zone === 'body') this.moveDrag(e, clip, x, y, false);
      else if (zone === 'left' || zone === 'right') this.trimDrag(e, clip, zone);
      else if (zone === 'fadeIn' || zone === 'fadeOut') this.fadeDrag(e, clip, zone);
      else if (zone === 'gain') this.gainDrag(e, clip, hit.track);
    });
    el.addEventListener('dblclick', (e) => {
      const { x, y } = local(e);
      const hit = this.hit(x, y);
      if (hit.kind === 'clip') { store.select(edit.withGroups(store.project, [hit.clip.id])); this.onOpenProperties(); }
    });
    el.addEventListener('contextmenu', (e) => {
      const { x, y } = local(e);
      const hit = this.hit(x, y);
      if (hit.kind === 'clip' && !store.selection.has(hit.clip.id)) store.select(edit.withGroups(store.project, [hit.clip.id]));
      contextMenu(e, this.contextItems(hit, this.q(this.t(x))));
    });
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // media dropped from the bin or from Explorer
    wrap.addEventListener('dragover', (e) => {
      const fromBin = e.dataTransfer?.types.includes('application/x-cut-media');
      const files = e.dataTransfer?.types.includes('Files');
      if (!fromBin && !files) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      const { x, y } = local(e);
      const row = this.trackAtY(y);
      const len = this.dragMedia ? this.mediaLength(this.dragMedia) : 5;
      let start = this.q(Math.max(0, this.t(x)));
      start += this.snap([start], this.snapPoints(new Set()), false);
      this.ghost = { start, length: len, trackId: row?.track.id ?? store.project.tracks[0]?.id ?? '', video: true, audio: true };
      this.overlayNow();
    });
    wrap.addEventListener('dragleave', (e) => {
      if (wrap.contains(e.relatedTarget as Node)) return;
      this.ghost = null; this.snapLine = null; this.overlayNow();
    });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      const g = this.ghost;
      this.ghost = null;
      this.snapLine = null;
      this.overlayNow();
      if (!g) return;
      this.onDrop(e, g.start, g.trackId);
    });
  }

  /** Set by the app: handles a drop of bin media ids or Explorer files at a time/track. */
  onDrop: (e: DragEvent, start: number, trackId: string) => void = () => {};

  private mediaLength(ids: string[]) {
    return ids.reduce((sum, id) => {
      const m = store.project.media.find((x) => x.id === id);
      return sum + (m ? (m.kind === 'image' ? edit.STILL_LENGTH : m.duration) : 0);
    }, 0) || 5;
  }

  private capture(e: PointerEvent, move: (dx: number, dy: number, ev: PointerEvent) => void, up?: (ev: PointerEvent) => void) {
    const sx = e.clientX;
    const sy = e.clientY;
    const target = e.target as Element;
    try { target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const onMove = (ev: PointerEvent) => move(ev.clientX - sx, ev.clientY - sy, ev);
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.dragLabel = null;
      up?.(ev);
      this.overlayNow();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private panDrag(e: PointerEvent) {
    const sx = this.scrollX;
    const sy = this.scrollY;
    this.capture(e, (dx, dy) => {
      this.scrollX = Math.max(0, sx - dx / this.pps);
      this.scrollY = sy - dy;
      this.clampScroll();
      this.invalidate();
    });
  }

  private emptyDrag(e: PointerEvent, x: number) {
    const t0 = this.q(Math.max(0, this.t(x)));
    let moved = false;
    if (!e.ctrlKey && !e.shiftKey) store.clearSelection();
    const points = this.snapPoints(new Set());
    store.begin();
    this.capture(e, (dx) => {
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      let t1 = this.q(Math.max(0, t0 + dx / this.pps));
      t1 += this.snap([t1], points, false);
      store.project.loop = t1 !== t0 ? { start: Math.min(t0, t1), end: Math.max(t0, t1) } : null;
      store.live();
      this.dragLabel = { x: this.x(t1), y: 40, text: `${timecode(Math.abs(t1 - t0), store.project.fps)}` };
      this.overlayNow();
    }, () => {
      this.snapLine = null;
      if (moved) store.end('Time Selection');
      else { store.cancelGesture(); transport.seek(t0); }
    });
  }

  private copyOrToggle(e: PointerEvent, clip: Clip, x: number, y: number) {
    let started = false;
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: PointerEvent) => {
      if (started || Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      started = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!store.selection.has(clip.id)) store.select(edit.withGroups(store.project, [clip.id]), true);
      this.moveDrag(e, clip, x, y, true);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!started) { for (const id of edit.withGroups(store.project, [clip.id])) store.selection.has(id) ? store.selection.delete(id) : store.selection.add(id); store.emit('selection'); }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Moves the selection in time and across tracks of the same kind. With `copy`, moves duplicates. */
  private moveDrag(e: PointerEvent, clip: Clip, _x: number, y: number, copy: boolean) {
    store.begin();
    const p0 = store.project;
    let ids = edit.withGroups(p0, store.selection);
    if (copy) {
      // duplicate the selection in place; the duplicates are what moves
      const map = new Map<string, string>();
      const groups = new Map<string, string>();
      for (const c of p0.clips.filter((x) => ids.has(x.id))) {
        const n: Clip = { ...structuredClone(c), id: uid() };
        if (c.groupId) { if (!groups.has(c.groupId)) groups.set(c.groupId, uid()); n.groupId = groups.get(c.groupId); }
        map.set(c.id, n.id);
        p0.clips.push(n);
      }
      ids = new Set(map.values());
      store.select(ids);
      clip = p0.clips.find((c) => c.id === map.get(clip.id)) ?? clip;
    }
    const orig = new Map(p0.clips.filter((c) => ids.has(c.id)).map((c) => [c.id, { start: c.start, trackId: c.trackId }]));
    const startRow = this.trackAtY(y);
    const points = this.snapPoints(ids);
    const kindLists = { video: p0.tracks.filter((t) => t.kind === 'video').map((t) => t.id), audio: p0.tracks.filter((t) => t.kind === 'audio').map((t) => t.id) };
    let moved = false;
    this.capture(e, (dx, dy, ev) => {
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      const p = store.project;
      const minStart = Math.min(...[...orig.values()].map((o) => o.start));
      let d = this.q(Math.max(-minStart, dx / this.pps));
      // snap the dragged clip's edges
      const o = orig.get(clip.id)!;
      const len = clip.length;
      d += this.snap([o.start + d, o.start + d + len], points, ev.shiftKey);
      d = Math.max(-minStart, d);
      // vertical: move by whole tracks within each kind
      let trackShift = 0;
      const row = this.trackAtY(ev.clientY - this.tracks.getBoundingClientRect().top);
      if (startRow && row && row.track.kind === startRow.track.kind) {
        const list = kindLists[row.track.kind];
        trackShift = list.indexOf(row.track.id) - list.indexOf(startRow.track.id);
        // all moved clips must land on an existing track
        for (const [, oo] of orig) {
          const tr = p.tracks.find((t) => t.id === oo.trackId);
          if (!tr) continue;
          const li = kindLists[tr.kind].indexOf(oo.trackId) + trackShift;
          if (li < 0 || li >= kindLists[tr.kind].length) { trackShift = 0; break; }
        }
      }
      for (const c of p.clips) {
        const oo = orig.get(c.id);
        if (!oo) continue;
        c.start = oo.start + d;
        const tr = p.tracks.find((t) => t.id === oo.trackId);
        if (tr && trackShift) c.trackId = kindLists[tr.kind][kindLists[tr.kind].indexOf(oo.trackId) + trackShift];
        else c.trackId = oo.trackId;
      }
      this.dragLabel = { x: this.x(clip.start), y: ev.clientY - this.tracks.getBoundingClientRect().top, text: timecode(clip.start, p.fps) };
      store.live();
      this.overlayNow();
    }, () => {
      this.snapLine = null;
      if (moved || copy) store.end(copy ? 'Copy Events' : 'Move Events');
      else store.cancelGesture();
    });
  }

  private trimDrag(e: PointerEvent, clip: Clip, zone: 'left' | 'right') {
    store.begin();
    const p0 = store.project;
    // grouped clips whose edge lines up with the dragged edge trim together
    const edgeT = zone === 'left' ? clip.start : clipEnd(clip);
    const ids = [...edit.withGroups(p0, [clip.id])].filter((id) => {
      const c = p0.clips.find((x) => x.id === id)!;
      return Math.abs((zone === 'left' ? c.start : clipEnd(c)) - edgeT) < 1e-3;
    });
    const orig = new Map(p0.clips.filter((c) => ids.includes(c.id)).map((c) => [c.id, structuredClone(c)]));
    const ripple = store.view.ripple && zone === 'right';
    const later = ripple ? p0.clips.filter((c) => !ids.includes(c.id) && ids.some((id) => { const o = orig.get(id)!; return c.trackId === o.trackId && c.start >= clipEnd(o) - 1e-6; })).map((c) => ({ id: c.id, start: c.start })) : [];
    const points = this.snapPoints(new Set([...ids, ...later.map((l) => l.id)]));
    const minLen = 1 / p0.fps;
    this.capture(e, (dx, _dy, ev) => {
      const p = store.project;
      let d = dx / this.pps;
      const o = orig.get(clip.id)!;
      const target = zone === 'left' ? o.start + d : clipEnd(o) + d;
      d += this.q(target) - target;
      d += this.snap([zone === 'left' ? o.start + d : clipEnd(o) + d], points, ev.shiftKey);
      let applied = d;
      for (const c of p.clips) {
        const oc = orig.get(c.id);
        if (!oc) continue;
        if (zone === 'left') {
          const media0 = oc.generator || mediaOf(p, oc)?.kind === 'image' ? -Infinity : oc.start - oc.offset / oc.speed;
          const ns = clamp(oc.start + d, Math.max(0, media0), clipEnd(oc) - minLen);
          applied = ns - oc.start;
          c.start = ns;
          c.length = clipEnd(oc) - ns;
          c.offset = Math.max(0, oc.offset + (ns - oc.start) * oc.speed);
        } else {
          const ne = clamp(clipEnd(oc) + d, oc.start + minLen, oc.start + maxLength(p, oc));
          applied = ne - clipEnd(oc);
          c.length = ne - oc.start;
        }
        c.fadeIn = Math.min(c.fadeIn, c.length);
        c.fadeOut = Math.min(c.fadeOut, c.length - c.fadeIn);
      }
      if (ripple) for (const l of later) { const c = p.clips.find((x) => x.id === l.id); if (c) c.start = Math.max(0, l.start + applied); }
      const now = p.clips.find((c) => c.id === clip.id)!;
      this.dragLabel = { x: this.x(zone === 'left' ? now.start : clipEnd(now)), y: 30, text: `${zone === 'left' ? 'In' : 'Out'} ${timecode(zone === 'left' ? now.start : clipEnd(now), p.fps)} · length ${timecode(now.length, p.fps)}` };
      store.live();
      this.overlayNow();
    }, () => { this.snapLine = null; store.end('Trim Event'); });
  }

  private fadeDrag(e: PointerEvent, clip: Clip, zone: 'fadeIn' | 'fadeOut') {
    store.begin();
    const ids = [...edit.withGroups(store.project, [clip.id])];
    const o = structuredClone(clip);
    this.capture(e, (dx, _dy, ev) => {
      const p = store.project;
      let v = (zone === 'fadeIn' ? o.fadeIn : o.fadeOut) + (zone === 'fadeIn' ? dx : -dx) / this.pps;
      v = this.q(Math.max(0, v));
      for (const c of p.clips) {
        if (!ids.includes(c.id)) continue;
        if (zone === 'fadeIn') c.fadeIn = Math.min(v, c.length - c.fadeOut);
        else c.fadeOut = Math.min(v, c.length - c.fadeIn);
      }
      this.dragLabel = { x: ev.clientX - this.tracks.getBoundingClientRect().left, y: 30, text: `Fade ${zone === 'fadeIn' ? 'in' : 'out'}: ${timecode(v, p.fps)}` };
      store.live();
      this.overlayNow();
    }, () => store.end(zone === 'fadeIn' ? 'Fade In' : 'Fade Out'));
  }

  private gainDrag(e: PointerEvent, clip: Clip, track: Track) {
    store.begin();
    const ids = store.selection.has(clip.id) ? [...store.selection] : [clip.id];
    const sameKind = ids.filter((id) => { const c = store.project.clips.find((x) => x.id === id); return c && store.project.tracks.find((t) => t.id === c.trackId)?.kind === track.kind; });
    const startFrac = this.levelToFrac(track, clip.gain);
    const rowH = track.height - 5 - HEADER_H;
    this.capture(e, (_dx, dy, ev) => {
      const f = startFrac + (dy * (ev.shiftKey ? 0.2 : 1)) / rowH;
      const g = this.fracToLevel(track, f);
      for (const c of store.project.clips) if (sameKind.includes(c.id)) c.gain = g;
      this.dragLabel = { x: ev.clientX - this.tracks.getBoundingClientRect().left, y: 30, text: track.kind === 'video' ? `Opacity ${Math.round(g * 100)}%` : `Volume ${formatDb(g)}` };
      store.live();
      this.overlayNow();
    }, () => store.end(track.kind === 'video' ? 'Event Opacity' : 'Event Volume'));
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = this.tracks.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (e.ctrlKey || e.altKey) { this.zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, this.t(x), x); return; }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.scrollBy(e.deltaX || e.deltaY, 0); return; }
    const { total } = this.trackTops();
    if (total > this.hgt) this.scrollBy(0, e.deltaY);
    else this.scrollBy(e.deltaY, 0);
  }

  // ---------- horizontal scrollbar ----------
  private bindScrollbar() {
    this.hthumb.addEventListener('pointerdown', (e) => {
      const len = this.contentLength();
      const sx = this.scrollX;
      this.hthumb.classList.add('drag');
      this.capture(e, (dx) => {
        this.scrollX = clamp(sx + (dx / this.hbar.clientWidth) * len, 0, len);
        this.invalidate();
      }, () => this.hthumb.classList.remove('drag'));
    });
    this.hbar.addEventListener('pointerdown', (e) => {
      if (e.target !== this.hbar) return;
      const len = this.contentLength();
      const f = (e.clientX - this.hbar.getBoundingClientRect().left) / this.hbar.clientWidth;
      this.scrollX = Math.max(0, f * len - this.w / this.pps / 2);
      this.invalidate();
    });
  }
  private contentLength() { return Math.max(projectEnd(store.project) + 10, this.t(this.w) - 0, this.w / this.pps); }
  private updateScrollbar() {
    const len = this.contentLength();
    const vis = this.w / this.pps;
    const bw = this.hbar.clientWidth;
    this.hthumb.style.left = `${(this.scrollX / len) * bw}px`;
    this.hthumb.style.width = `${Math.max(24, (vis / len) * bw)}px`;
  }

  // ---------- context menu ----------
  private contextItems(hit: Hit, t: number): MenuItem[] {
    const sel = store.selectedClips();
    if (hit.kind === 'clip') {
      const isAudio = hit.track.kind === 'audio';
      return [
        { label: 'Split at Cursor', key: 'S', run: () => edit.split() },
        { label: 'Split Here', run: () => edit.split(t) },
        { sep: true },
        { label: 'Cut', key: 'Ctrl+X', run: () => edit.cutSelection() },
        { label: 'Copy', key: 'Ctrl+C', run: () => edit.copySelection() },
        { label: 'Delete', key: 'Delete', run: () => edit.deleteSelection() },
        { sep: true },
        { label: 'Mute Event', checked: () => hit.clip.mute, run: () => store.commit('Mute Event', (p) => { const v = !hit.clip.mute; for (const c of p.clips) if (store.selection.has(c.id)) c.mute = v; }) },
        {
          label: 'Fade Type', submenu: () => (['smooth', 'linear', 'fast', 'slow'] as const).map((k) => ({
            label: { smooth: 'Smooth', linear: 'Linear', fast: 'Fast', slow: 'Slow' }[k], checked: () => hit.clip.fadeInCurve === k,
            run: () => store.commit('Fade Type', (p) => { for (const c of p.clips) if (store.selection.has(c.id)) { c.fadeInCurve = k; c.fadeOutCurve = k; } }),
          })),
        },
        ...(isAudio ? [{ label: 'Normalize', run: () => edit.normalizeSelection() }] : []),
        { label: hit.clip.groupId ? 'Remove from Group' : 'Group', key: hit.clip.groupId ? 'U' : 'G', run: () => (hit.clip.groupId ? edit.ungroupSelection() : edit.groupSelection()), enabled: () => !!hit.clip.groupId || sel.length > 1 },
        { sep: true },
        { label: 'Properties…', run: () => this.onOpenProperties() },
      ];
    }
    return [
      { label: 'Paste', key: 'Ctrl+V', run: () => { transport.seek(t); edit.paste(); } },
      { label: 'Insert Marker', key: 'M', run: () => edit.addMarker(t) },
      { sep: true },
      { label: 'Insert Video Track', key: 'Ctrl+Shift+Q', run: () => edit.insertTrack('video') },
      { label: 'Insert Audio Track', key: 'Ctrl+Q', run: () => edit.insertTrack('audio') },
      { sep: true },
      { label: 'Insert Text', run: () => edit.addGenerator('text', t) },
      { label: 'Insert Solid Color', run: () => edit.addGenerator('solid', t) },
    ];
  }
}

function hasFx(c: Clip) {
  const f = c.fx;
  return f.brightness !== 1 || f.contrast !== 1 || f.saturation !== 1 || f.hue !== 0 || f.blur > 0 || f.grayscale > 0 || f.sepia > 0 || f.invert > 0;
}

/** Lightens (k > 0) or darkens (k < 0) a #rrggbb colour. */
export function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const f = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  r = f(r); g = f(g); b = f(b);
  return `rgb(${r},${g},${b})`;
}
