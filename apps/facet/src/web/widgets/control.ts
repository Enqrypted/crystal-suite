// The Control Center: connectivity toggles, now playing, time, system load, brightness and volume
// sliders, and quick buttons - glass tiles on a 4-column grid, like on an iPhone.
import type { ControlWidget, SysState } from '../../shared/types';
import { api } from '../lib/api';
import { h, clamp } from '../lib/dom';
import { G } from '../lib/glyphs';
import { glass } from '../lib/liquid';
import { live, onLive } from '../lib/live';
import { nowPlayingTile } from './media';

const CELL = { s: 60, m: 72, l: 86 };

export class ControlCenter {
  readonly el: HTMLElement;
  private w!: ControlWidget;
  private offs: (() => void)[] = [];
  private timer = 0;
  private parts: Record<string, HTMLElement> = {};
  private sliders: { brightness?: VSlider; volume?: VSlider } = {};
  private media: { el: HTMLElement; destroy: () => void } | null = null;
  private battery: { level: number; charging: boolean } | null = null;

  constructor(w: ControlWidget) {
    this.el = h('div', { class: 'cc' });
    this.offs.push(onLive('sys', () => this.update()));
    this.set(w);
    this.timer = window.setInterval(() => this.clock(), 1000);
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; charger?: unknown; addEventListener: (e: string, f: () => void) => void }> };
    nav.getBattery?.().then((b) => {
      // desktops report a full, charging "battery" that isn't there
      const real = !(b.charging && b.level === 1);
      if (!real) return;
      const read = () => { this.battery = { level: b.level, charging: b.charging }; this.update(); };
      b.addEventListener('levelchange', read);
      b.addEventListener('chargingchange', read);
      read();
    }).catch(() => {});
  }

  set(w: ControlWidget) {
    this.w = w;
    this.build();
  }

  destroy() {
    this.offs.forEach((f) => f());
    this.media?.destroy();
    clearInterval(this.timer);
  }

  private build() {
    const w = this.w;
    this.media?.destroy();
    this.el.className = `cc size-${w.size}`;
    this.el.style.setProperty('--cell', `${CELL[w.size]}px`);
    this.el.replaceChildren();
    const tile = (cls: string, ...kids: (HTMLElement | string)[]) => {
      const t = h('div', { class: `cc-tile ${cls}` }, ...kids);
      return t;
    };
    const toggle = (key: 'wifi' | 'bluetooth' | 'nightlight' | 'dark', icon: string, label: string, settings: string) => {
      const b = h('button', { type: 'button', class: `cc-toggle t-${key}`, title: label, html: icon });
      b.addEventListener('click', () => {
        const s = live.sys;
        if (!s) return;
        const cur = s[key];
        if (cur === null) { api.launch(settings); return; }
        api.sysSet(key, !cur);
      });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); api.launch(settings); });
      this.parts[key] = b;
      return b;
    };
    const conn = tile('cc-conn',
      toggle('wifi', G.wifi, 'Wi-Fi', 'network'),
      toggle('bluetooth', G.bluetooth, 'Bluetooth', 'bluetooth'),
      toggle('nightlight', G.nightlight, 'Night light', 'nightlight'),
      toggle('dark', G.dark, 'Dark mode', 'settings'));
    this.parts.net = h('div', { class: 'cc-net' });
    conn.append(this.parts.net);

    this.media = nowPlayingTile();
    const media = tile('cc-np', this.media.el);

    this.parts.time = h('div', { class: 'cc-time' });
    this.parts.date = h('div', { class: 'cc-date' });
    const time = tile('cc-clock', this.parts.time, this.parts.date);

    const meter = (key: string, icon: string, label: string) => {
      const fill = h('div', { class: 'cc-meter-fill' });
      const val = h('span', { class: 'cc-meter-val' });
      this.parts[`${key}Fill`] = fill;
      this.parts[`${key}Val`] = val;
      return h('div', { class: `cc-meter m-${key}`, title: label }, h('span', { class: 'cc-meter-ic', html: icon }), h('div', { class: 'cc-meter-bar' }, fill), val);
    };
    const stats = tile('cc-stats', meter('cpu', G.cpu, 'Processor'), meter('ram', G.memory, 'Memory'), meter('bat', G.battery, 'Battery'));
    this.parts.stats = stats;
    stats.addEventListener('click', () => api.launch('taskmgr'));
    stats.title = 'Task Manager';

    this.sliders.brightness = new VSlider(G.sun, 'Brightness', 15, (v) => api.sysSet('brightness', v), () => api.launch('display'));
    this.sliders.volume = new VSlider(G.speaker, 'Volume', 0, (v) => api.sysSet('volume', v), () => {
      const s = live.sys;
      if (s) api.sysSet('mute', !s.muted);
    });
    const bright = tile('cc-slider-tile cc-bright', this.sliders.brightness.el);
    const vol = tile('cc-slider-tile cc-vol', this.sliders.volume.el);

    const button = (icon: string, label: string, what: string) => {
      const b = h('button', { type: 'button', class: 'cc-tile cc-btn', title: label, html: icon });
      b.addEventListener('click', () => api.launch(what));
      return b;
    };
    this.el.append(conn, media, time, stats, bright, vol,
      button(G.snip, 'Screenshot', 'snip'), button(G.calc, 'Calculator', 'calc'), button(G.lock, 'Lock', 'lock'), button(G.gear, 'Settings', 'settings'));
    for (const t of this.el.querySelectorAll<HTMLElement>('.cc-tile')) glass(t, { dark: true, tintAlpha: 0.4 });
    this.clock();
    this.update();
  }

  private clock() {
    const now = new Date();
    const time = now.toLocaleTimeString(undefined, { hour: this.w.hour24 ? '2-digit' : 'numeric', minute: '2-digit', hour12: !this.w.hour24 }).replace(/\s?[AP]M$/i, '');
    if (this.parts.time && this.parts.time.textContent !== time) this.parts.time.textContent = time;
    const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (this.parts.date && this.parts.date.textContent !== date) this.parts.date.textContent = date;
  }

  private update() {
    const s: SysState | null = live.sys;
    const p = this.parts;
    if (!s) { this.el.classList.add('loading'); return; }
    this.el.classList.remove('loading');
    const on = (k: string, v: boolean | null) => { p[k]?.classList.toggle('on', !!v); p[k]?.classList.toggle('na', v === null); };
    on('wifi', s.wifi);
    on('bluetooth', s.bluetooth);
    on('nightlight', s.nightlight);
    on('dark', s.dark);
    if (p.wifi) p.wifi.innerHTML = s.net && !s.net.wifi ? G.ethernet : G.wifi;
    if (p.wifi) p.wifi.title = s.net ? `${s.net.wifi ? 'Wi-Fi' : 'Network'}: ${s.net.name}` : s.wifi === false ? 'Wi-Fi is off' : 'Not connected';
    if (p.net) p.net.textContent = s.net ? s.net.name : 'Offline';
    const meter = (k: string, v: number | null) => {
      if (!p[`${k}Fill`]) return;
      p[`${k}Fill`].style.transform = `scaleX(${v === null ? 0 : v / 100})`;
      p[`${k}Val`].textContent = v === null ? '' : `${Math.round(v)}%`;
      p[`${k}Fill`].classList.toggle('hot', (v ?? 0) > 85);
    };
    meter('cpu', s.cpu);
    meter('ram', s.ram);
    p.stats?.classList.toggle('has-battery', !!this.battery);
    meter('bat', this.battery ? this.battery.level * 100 : null);
    this.sliders.brightness?.set(s.brightness, s.hardware ? 'Brightness' : 'Brightness (dims the screen)');
    this.sliders.volume?.set(s.volume ?? 0, s.device ? `Volume: ${s.device}` : 'Volume', s.muted ? G.muted : G.speaker, s.volume === null);
  }
}

/** A tall, iPhone-style slider: drag or scroll anywhere on it; the icon at the bottom is a button. */
class VSlider {
  readonly el: HTMLElement;
  private fill: HTMLElement;
  private icon: HTMLElement;
  private value = 0;
  private dragging = false;
  private sendTimer = 0;

  constructor(icon: string, label: string, private min: number, private onChange: (v: number) => void, onIcon: () => void) {
    this.fill = h('div', { class: 'vs-fill' });
    this.icon = h('button', { type: 'button', class: 'vs-icon', html: icon, title: label });
    this.el = h('div', { class: 'vslider', title: label }, this.fill, this.icon);
    this.icon.addEventListener('click', (e) => { e.stopPropagation(); onIcon(); });
    this.icon.addEventListener('pointerdown', (e) => e.stopPropagation());
    const at = (e: PointerEvent) => {
      const r = this.el.getBoundingClientRect();
      this.change(clamp(Math.round((1 - (e.clientY - r.top) / r.height) * 100), this.min, 100));
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.dragging = true;
      this.el.classList.add('active');
      at(e);
      const move = (m: PointerEvent) => at(m);
      const up = () => {
        this.dragging = false;
        this.el.classList.remove('active');
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    this.el.addEventListener('wheel', (e) => { e.preventDefault(); this.change(clamp(this.value + (e.deltaY < 0 ? 4 : -4), this.min, 100)); }, { passive: false });
  }

  private change(v: number) {
    if (v === this.value) return;
    this.value = v;
    this.show();
    // a slider drag produces many values: send at most ~25 a second, always the latest
    if (!this.sendTimer) this.sendTimer = window.setTimeout(() => { this.sendTimer = 0; this.onChange(this.value); }, 40);
  }

  private show() { this.fill.style.transform = `scaleY(${this.value / 100})`; }

  set(v: number, title: string, icon?: string, disabled = false) {
    if (!this.dragging && !this.sendTimer) { this.value = v; this.show(); }
    this.el.title = title;
    if (icon && this.icon.innerHTML !== icon) this.icon.innerHTML = icon;
    this.el.classList.toggle('disabled', disabled);
  }
}
