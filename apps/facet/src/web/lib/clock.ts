// The clock widget: four faces (minimal, card, analog, stacked), all driven by one ClockWidget config.
// Used on the desktop and as the live preview in the Facet window.
import type { ClockWidget } from '../../shared/types';
import { h } from './dom';

export const FONTS: Record<string, { label: string; css: string }> = {
  system: { label: 'System', css: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif' },
  condensed: { label: 'Condensed', css: 'Bahnschrift, "Segoe UI Variable Display", sans-serif' },
  mono: { label: 'Mono', css: '"Cascadia Mono", "Cascadia Code", Consolas, monospace' },
  serif: { label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  elegant: { label: 'Elegant', css: '"Palatino Linotype", "Book Antiqua", Palatino, serif' },
  hand: { label: 'Handwritten', css: '"Ink Free", "Segoe Print", cursive' },
};

export const FACES: { id: ClockWidget['face']; label: string }[] = [
  { id: 'minimal', label: 'Minimal' },
  { id: 'card', label: 'Card' },
  { id: 'analog', label: 'Analog' },
  { id: 'stacked', label: 'Stacked' },
];

const SVG = 'http://www.w3.org/2000/svg';
const pad = (n: number) => String(n).padStart(2, '0');
const setText = (el: Element | undefined | null, s: string) => { if (el && el.textContent !== s) el.textContent = s; };

export class ClockView {
  readonly el: HTMLElement;
  private w!: ClockWidget;
  private timer = 0;
  private parts: Record<string, Element> = {};

  constructor(w: ClockWidget) {
    this.el = h('div', { class: 'clock' });
    this.set(w);
  }

  set(w: ClockWidget) {
    const rebuild = !this.w || ['face', 'seconds', 'date', 'hour24'].some((k) => (this.w as any)[k] !== (w as any)[k]);
    this.w = w;
    const s = w.scale / 100;
    const el = this.el;
    el.className = `clock face-${w.face} align-${w.align} bg-${w.bg}${w.shadow ? ' shadow' : ''}${w.blink ? ' blink' : ''}`;
    el.style.setProperty('--clock-color', w.color);
    el.style.setProperty('--clock-accent', w.accent);
    el.style.setProperty('--clock-font', FONTS[w.font]?.css ?? FONTS.system.css);
    el.style.setProperty('--clock-weight', String(w.weight));
    el.style.setProperty('--s', String(s));
    if (rebuild) this.build();
    this.update(true);
    this.schedule();
  }

  destroy() { clearTimeout(this.timer); }

  private schedule() {
    clearTimeout(this.timer);
    // right after each second boundary (cheap: the DOM only changes when the text does), so the time is
    // right straight after the PC wakes up
    this.timer = window.setTimeout(() => { this.update(false); this.schedule(); }, 1000 - (Date.now() % 1000) + 15);
  }

  private build() {
    const el = this.el;
    el.replaceChildren();
    this.parts = {};
    const w = this.w;
    if (w.face === 'analog') {
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '-100 -100 200 200');
      svg.classList.add('dial');
      const face = document.createElementNS(SVG, 'circle');
      face.setAttribute('r', '98');
      face.classList.add('plate');
      svg.append(face);
      for (let i = 0; i < 60; i++) {
        const major = i % 5 === 0;
        const t = document.createElementNS(SVG, 'line');
        t.setAttribute('x1', '0'); t.setAttribute('x2', '0');
        t.setAttribute('y1', String(major ? -86 : -89)); t.setAttribute('y2', String(-93));
        t.setAttribute('transform', `rotate(${i * 6})`);
        t.classList.add(major ? 'tick-major' : 'tick');
        svg.append(t);
      }
      if (w.date !== 'none') {
        const d = document.createElementNS(SVG, 'text');
        d.setAttribute('x', '0'); d.setAttribute('y', '46');
        d.classList.add('dial-date');
        svg.append(d);
        this.parts.date = d;
      }
      const hand = (cls: string, y1: number, y2: number) => {
        const l = document.createElementNS(SVG, 'line');
        l.setAttribute('x1', '0'); l.setAttribute('x2', '0'); l.setAttribute('y1', String(y1)); l.setAttribute('y2', String(y2));
        l.classList.add(cls);
        svg.append(l);
        return l;
      };
      this.parts.hour = hand('hand-hour', 10, -50);
      this.parts.minute = hand('hand-minute', 12, -76);
      if (w.seconds) this.parts.second = hand('hand-second', 18, -84);
      const cap = document.createElementNS(SVG, 'circle');
      cap.setAttribute('r', w.seconds ? '3.6' : '4.4');
      cap.classList.add(w.seconds ? 'cap-accent' : 'cap');
      svg.append(cap);
      el.append(svg);
      return;
    }
    if (w.face === 'stacked') {
      const date = w.date !== 'none' ? h('div', { class: 'date' }) : null;
      const hours = h('div', { class: 'big hours' });
      const minutes = h('div', { class: 'big minutes' });
      const sec = w.seconds ? h('div', { class: 'sec' }) : null;
      el.append(...[date, hours, minutes, sec].filter(Boolean) as HTMLElement[]);
      Object.assign(this.parts, { date, hours, minutes, sec });
      return;
    }
    // minimal and card
    const weekday = w.face === 'card' ? h('div', { class: 'weekday' }) : null;
    const hm = h('span', { class: 'hm' });
    const sec = w.seconds ? h('span', { class: 'sec' }) : null;
    const ampm = !w.hour24 ? h('span', { class: 'ampm' }) : null;
    const time = h('div', { class: 'time' }, hm, sec, ampm);
    const date = w.date !== 'none' ? h('div', { class: 'date' }) : null;
    el.append(...[weekday, time, date].filter(Boolean) as HTMLElement[]);
    Object.assign(this.parts, { weekday, hm, sec, ampm, date });
  }

  private update(_initial: boolean) {
    const w = this.w;
    const now = new Date();
    const H = now.getHours(), M = now.getMinutes(), S = now.getSeconds();
    const hours = w.hour24 ? pad(H) : String(H % 12 || 12);
    const p = this.parts;
    const dateText = w.date === 'long'
      ? new Intl.DateTimeFormat(undefined, { weekday: w.face === 'card' ? undefined : 'long', month: 'long', day: 'numeric' }).format(now)
      : new Intl.DateTimeFormat(undefined, { weekday: w.face === 'card' ? undefined : 'short', month: 'short', day: 'numeric' }).format(now);
    if (w.face === 'analog') {
      const rot = (el: Element | undefined, deg: number) => { if (el) (el as SVGElement).style.transform = `rotate(${deg}deg)`; };
      rot(p.hour, (H % 12) * 30 + M * 0.5 + S / 120);
      rot(p.minute, M * 6 + S * 0.1);
      if (p.second) {
        rot(p.second, S * 6);
      }
      setText(p.date, new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' }).format(now).toUpperCase());
      return;
    }
    if (w.face === 'stacked') {
      setText(p.hours, hours.padStart(2, '0'));
      setText(p.minutes, pad(M));
      setText(p.sec, pad(S));
      setText(p.date, dateText);
      return;
    }
    // the blink is driven by this once-a-second tick: a CSS animation would keep Chromium drawing frames non-stop
    const hm = `${hours}<span class="colon${w.blink && S % 2 ? ' off' : ''}">:</span>${pad(M)}`;
    if ((p.hm as HTMLElement).innerHTML !== hm) (p.hm as HTMLElement).innerHTML = hm;
    setText(p.sec, `:${pad(S)}`);
    setText(p.ampm, H < 12 ? 'AM' : 'PM');
    setText(p.weekday, new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(now));
    setText(p.date, dateText);
  }
}
