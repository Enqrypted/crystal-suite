// The photo stage: fit to the window, zoom (wheel, pinch, keys, double-click), pan by dragging, and rotate.
// The photo element is positioned with one CSS transform, so zooming and panning run on the GPU.
import type { Photo } from './decode';

export type WheelMode = 'zoom' | 'navigate';

export class Viewer {
  readonly stage: HTMLElement;
  private photo: Photo | null = null;
  private el: HTMLElement | null = null;
  private rot = 0;
  private s = 1;
  private cx = 0;
  private cy = 0;
  /** The view follows the window size until the user zooms or pans. */
  private fitted = true;
  private dragging: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  wheelMode: WheelMode = 'zoom';
  onChange: () => void = () => {};
  /** Swipe or wheel in "navigate" mode: -1 previous, 1 next. */
  onNavigate: (dir: -1 | 1) => void = () => {};

  constructor(stage: HTMLElement) {
    this.stage = stage;
    new ResizeObserver(() => { if (this.fitted) this.fit(false); else { this.clampCenter(); this.apply(false); } }).observe(stage);
    stage.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    stage.addEventListener('pointerdown', (e) => this.down(e));
    stage.addEventListener('dblclick', (e) => this.dblclick(e));
  }

  get current() { return this.photo; }
  get scale() { return this.s; }
  get rotation() { return this.rot; }
  get isFitted() { return this.fitted; }
  private get box() { return { w: this.stage.clientWidth, h: this.stage.clientHeight }; }
  /** The photo's size on screen at 100%, after rotation. */
  private get dims() {
    const p = this.photo;
    if (!p) return { w: 1, h: 1 };
    return this.rot % 180 ? { w: p.height, h: p.width } : { w: p.width, h: p.height };
  }
  /** The scale that fits the whole photo (never enlarging a small one). */
  get fitScale() {
    const { w, h } = this.box, d = this.dims;
    return Math.min(1, w / d.w, h / d.h);
  }
  /** Zooming out stops at "fit": a smaller photo only wastes the window. */
  get minScale() { return this.fitScale; }
  get maxScale() { return 32; }
  /** The photo is bigger than the window (so dragging pans). */
  get zoomedIn() { const d = this.dims, b = this.box; return d.w * this.s > b.w + 1 || d.h * this.s > b.h + 1; }

  /** Shows a photo. `keepView` keeps the zoom and position (the full photo replacing its preview). */
  show(photo: Photo | null, rotation = 0, keepView = false) {
    const old = this.el;
    this.photo = photo;
    this.rot = rotation;
    if (!photo) {
      old?.remove();
      this.el = null;
      return;
    }
    const el = photo.el as HTMLElement;
    el.classList.add('photo');
    el.style.width = `${photo.width}px`;
    el.style.height = `${photo.height}px`;
    if (old !== el) {
      this.stage.prepend(el);
      // swap in the same frame: the old photo stays until the new one is placed
      if (old && old !== el) requestAnimationFrame(() => { if (this.el !== old) old.remove(); });
    }
    this.el = el;
    if (keepView && !this.fitted) { this.clampCenter(); this.apply(false); this.onChange(); } else this.fit(false);
  }

  setRotation(deg: number, animate = true) {
    this.rot = ((deg % 360) + 360) % 360;
    this.fit(animate);
  }

  fit(animate = true) {
    const { w, h } = this.box;
    this.s = this.fitScale;
    this.cx = w / 2;
    this.cy = h / 2;
    this.fitted = true;
    this.apply(animate);
    this.onChange();
  }

  /** Zooms so that the stage point (px, py) stays put. */
  zoomTo(scale: number, px?: number, py?: number, animate = true) {
    if (!this.photo) return;
    const { w, h } = this.box;
    const s2 = Math.max(this.minScale, Math.min(this.maxScale, scale));
    const x = px ?? w / 2, y = py ?? h / 2;
    this.cx = x - ((x - this.cx) * s2) / this.s;
    this.cy = y - ((y - this.cy) * s2) / this.s;
    this.s = s2;
    this.fitted = Math.abs(s2 - this.fitScale) < 1e-6;
    if (this.fitted) { this.cx = w / 2; this.cy = h / 2; }
    this.clampCenter();
    this.apply(animate);
    this.onChange();
  }
  zoomBy(f: number, px?: number, py?: number, animate = true) { this.zoomTo(this.s * f, px, py, animate); }

  /** Zoom steps for the buttons and keys: the usual percentages, plus "fit" in between. */
  step(dir: 1 | -1) {
    const stops = [0.05, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
    const fit = this.fitScale;
    const all = [...new Set([...stops, fit])].sort((a, b) => a - b);
    const next = dir > 0 ? all.find((v) => v > this.s * 1.001) : [...all].reverse().find((v) => v < this.s * 0.999);
    if (next === undefined) return;
    if (Math.abs(next - fit) < 1e-6) this.fit(true); else this.zoomTo(next);
  }

  pan(dx: number, dy: number) {
    if (!this.zoomedIn) return;
    this.cx += dx;
    this.cy += dy;
    this.fitted = false;
    this.clampCenter();
    this.apply(true);
  }

  private clampCenter() {
    const { w, h } = this.box, d = this.dims;
    const pw = d.w * this.s, ph = d.h * this.s;
    this.cx = pw <= w ? w / 2 : Math.min(pw / 2, Math.max(w - pw / 2, this.cx));
    this.cy = ph <= h ? h / 2 : Math.min(ph / 2, Math.max(h - ph / 2, this.cy));
  }

  private apply(animate: boolean) {
    const el = this.el, p = this.photo;
    if (!el || !p) return;
    el.style.transition = animate ? 'transform .16s ease-out' : 'none';
    el.style.transform = `translate(${this.cx}px, ${this.cy}px) rotate(${this.rot}deg) scale(${this.s}) translate(${-p.width / 2}px, ${-p.height / 2}px)`;
    // pixels stay crisp when zoomed far in, like any photo editor
    el.style.imageRendering = this.s >= 3 ? 'pixelated' : 'auto';
    this.stage.classList.toggle('pannable', this.zoomedIn);
  }

  private wheel(e: WheelEvent) {
    if (!this.photo) return;
    e.preventDefault();
    const r = this.stage.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (e.ctrlKey) {
      // touchpad pinch (Chromium sends it as Ctrl+wheel with small steps) or Ctrl+wheel
      const pinch = e.deltaMode === 0 && Math.abs(e.deltaY) < 40;
      this.zoomBy(Math.exp(-e.deltaY * (pinch ? 0.012 : 0.0022)), px, py, false);
      return;
    }
    if (this.wheelMode === 'navigate' && !this.zoomedIn) {
      if (Math.abs(e.deltaY) >= 4 || Math.abs(e.deltaX) >= 4) this.navThrottled(e.deltaY + e.deltaX > 0 ? 1 : -1);
      return;
    }
    // a touchpad two-finger scroll pans a zoomed photo; a mouse wheel zooms
    const precise = e.deltaMode === 0 && Math.abs(e.deltaY) < 50 && !Number.isInteger(e.deltaY);
    if (precise && this.zoomedIn) { this.pan(-e.deltaX, -e.deltaY); return; }
    this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.07 : 0.0022)), px, py, false);
  }
  private lastNav = 0;
  private navThrottled(dir: 1 | -1) {
    const now = performance.now();
    if (now - this.lastNav < 220) return;
    this.lastNav = now;
    this.onNavigate(dir);
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 || !this.photo || (e.target as HTMLElement).closest('.nav-btn, .msg')) return;
    this.dragging = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false };
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const zoomed = this.zoomedIn;
    if (zoomed) this.stage.classList.add('grabbing');
    const move = (ev: PointerEvent) => {
      const d = this.dragging;
      if (!d) return;
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (!zoomed) return;
      this.cx = d.cx + dx;
      this.cy = d.cy + dy;
      this.fitted = false;
      this.clampCenter();
      this.apply(false);
    };
    const up = (ev: PointerEvent) => {
      this.stage.removeEventListener('pointermove', move);
      this.stage.removeEventListener('pointerup', up);
      this.stage.removeEventListener('pointercancel', up);
      this.stage.classList.remove('grabbing');
      const d = this.dragging;
      this.dragging = null;
      // not zoomed in: a horizontal swipe goes to the next or previous photo
      if (d && !zoomed) {
        const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) this.onNavigate(dx < 0 ? 1 : -1);
      }
    };
    this.stage.addEventListener('pointermove', move);
    this.stage.addEventListener('pointerup', up);
    this.stage.addEventListener('pointercancel', up);
  }

  private dblclick(e: MouseEvent) {
    if (!this.photo || (e.target as HTMLElement).closest('.nav-btn, .msg')) return;
    const r = this.stage.getBoundingClientRect();
    if (!this.fitted && this.s > this.fitScale * 1.01) { this.fit(true); return; }
    // fitted: to 100% (or 200% for a photo that already fits at 100%) around the pointer
    this.zoomTo(this.fitScale < 1 ? 1 : 2, e.clientX - r.left, e.clientY - r.top, true);
  }
}
