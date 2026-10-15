// A compact horizontal slider (drag, wheel, double-click to reset) used by track headers and Properties.
import { h, clamp } from './dom';
import { dbToGain, gainToDb } from '../core/model';

export interface SliderOptions {
  value: number;
  /** value -> position 0..1 */
  toPos: (v: number) => number;
  /** position 0..1 -> value */
  fromPos: (p: number) => number;
  format: (v: number) => string;
  reset: number;
  onBegin?: () => void;
  onInput: (v: number) => void;
  onEnd?: () => void;
  center?: boolean;
}

export class Slider {
  readonly el: HTMLElement;
  private fill: HTMLElement;
  private handle: HTMLElement;
  private label: HTMLElement | null = null;
  value: number;

  constructor(private o: SliderOptions, label?: HTMLElement) {
    this.value = o.value;
    this.fill = h('div', { class: 'fill' });
    this.handle = h('div', { class: 'handle' });
    this.el = h('div', { class: 'slider' }, this.fill, this.handle);
    this.label = label ?? null;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = this.el.getBoundingClientRect();
      const fine = () => e.shiftKey;
      o.onBegin?.();
      const startPos = o.toPos(this.value);
      const onHandle = Math.abs((e.clientX - rect.left) / rect.width - startPos) < 0.05;
      const setFrom = (clientX: number, startX: number) => {
        const pos = onHandle || fine()
          ? startPos + ((clientX - startX) / rect.width) * (fine() ? 0.2 : 1)
          : (clientX - rect.left) / rect.width;
        this.set(o.fromPos(clamp(pos, 0, 1)), true);
      };
      setFrom(e.clientX, e.clientX);
      this.el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => setFrom(ev.clientX, e.clientX);
      const up = () => { this.el.removeEventListener('pointermove', move); this.el.removeEventListener('pointerup', up); o.onEnd?.(); };
      this.el.addEventListener('pointermove', move);
      this.el.addEventListener('pointerup', up);
    });
    this.el.addEventListener('dblclick', () => { o.onBegin?.(); this.set(o.reset, true); o.onEnd?.(); });
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      o.onBegin?.();
      this.set(o.fromPos(clamp(o.toPos(this.value) + (e.deltaY < 0 ? 0.02 : -0.02), 0, 1)), true);
      o.onEnd?.();
    }, { passive: false });
    this.render();
  }

  set(v: number, notify = false) {
    this.value = v;
    this.render();
    if (notify) this.o.onInput(v);
  }

  private render() {
    const pos = clamp(this.o.toPos(this.value), 0, 1);
    this.handle.style.left = `${pos * 100}%`;
    if (this.o.center) {
      const a = Math.min(pos, 0.5);
      const b = Math.max(pos, 0.5);
      this.fill.style.left = `${a * 100}%`;
      this.fill.style.width = `${(b - a) * 100}%`;
    } else {
      this.fill.style.left = '0';
      this.fill.style.width = `${pos * 100}%`;
    }
    if (this.label) this.label.textContent = this.o.format(this.value);
  }
}

// value mappings
export const dbMap = {
  toPos: (g: number) => { const db = gainToDb(g); return isFinite(db) ? clamp((db + 60) / 72, 0, 1) : 0; },
  fromPos: (p: number) => (p <= 0.001 ? 0 : dbToGain(p * 72 - 60)),
};
export const linMap = (min: number, max: number) => ({
  toPos: (v: number) => (v - min) / (max - min),
  fromPos: (p: number) => min + p * (max - min),
});
export const panFormat = (v: number) => (Math.abs(v) < 0.005 ? 'Center' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'L' : 'R'}`);
