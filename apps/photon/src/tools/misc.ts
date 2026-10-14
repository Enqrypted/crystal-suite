import { Tool, PointerInfo } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { bus } from '../core/bus';
import { h } from '../ui/dom';
import { toolHeader, sep, num, pct, check, sel, blendSel } from '../ui/optbits';
import { button, segmented, toast } from '../ui/widgets';
import { sampleColor, paintOnto, solidFor } from '../ops/paintops';
import { editableTarget } from '../ops/target';
import { colorRegion } from '../core/selection';
import { renderGradient, fgBgGradient } from '../core/gradient';
import { Gradient, GradientStyle } from '../core/layer';
import { cssColor, createCanvas, ctx2d, getImageData, Point, RGB } from '../core/util';
import { gradientPicker } from '../ui/gradientpicker';
import { rotateLayerOrCanvas } from '../ops/imageops';

// ---------- Eyedropper ----------
export class EyedropperTool extends Tool {
  id = 'eyedropper'; name = 'Eyedropper Tool'; icon = 'eyedropper'; key = 'I'; group = 'eyedropper';
  sampleSize = 1;
  sampleAll = true;
  private ring: { p: Point; color: RGB; prev: RGB } | null = null;
  cursor() { return 'crosshair'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      sel('Sample Size:', [
        { value: '1', label: 'Point Sample' }, { value: '3', label: '3 by 3 Average' }, { value: '5', label: '5 by 5 Average' },
        { value: '11', label: '11 by 11 Average' }, { value: '31', label: '31 by 31 Average' }, { value: '51', label: '51 by 51 Average' }, { value: '101', label: '101 by 101 Average' },
      ], () => String(this.sampleSize), (v) => { this.sampleSize = Number(v); }),
      sel('Sample:', [{ value: 'all', label: 'All Layers' }, { value: 'current', label: 'Current Layer' }], () => (this.sampleAll ? 'all' : 'current'), (v) => { this.sampleAll = v === 'all'; }));
  }
  private pick(p: PointerInfo, v: Viewport) {
    const c = sampleColor(v.doc!, p.x, p.y, this.sampleSize, this.sampleAll);
    if (!c) return;
    const prev = p.alt ? app.bg : app.fg;
    if (p.alt) app.setBg(c); else app.setFg(c);
    this.ring = { p: { x: p.sx, y: p.sy }, color: c, prev: this.ring?.prev ?? prev };
  }
  down(p: PointerInfo, v: Viewport) { this.ring = null; this.pick(p, v); }
  move(p: PointerInfo, v: Viewport) { this.pick(p, v); }
  up() { this.ring = null; }
  overlay(ctx: CanvasRenderingContext2D) {
    const r = this.ring;
    if (!r) return;
    const { x, y } = r.p;
    ctx.save();
    ctx.lineWidth = 16;
    ctx.strokeStyle = cssColor(r.color);
    ctx.beginPath(); ctx.arc(x, y, 40, Math.PI, 0); ctx.stroke();
    ctx.strokeStyle = cssColor(r.prev);
    ctx.beginPath(); ctx.arc(x, y, 40, 0, Math.PI); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = '#888';
    ctx.beginPath(); ctx.arc(x, y, 48, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 32, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

// ---------- Ruler ----------
export class RulerTool extends Tool {
  id = 'ruler'; name = 'Ruler Tool'; icon = 'ruler'; key = 'I'; group = 'eyedropper';
  a: Point | null = null; b: Point | null = null;
  private dragging: 'new' | 'a' | 'b' | null = null;
  private info = h('span', { class: 'opt-label', style: { fontFamily: 'Consolas, monospace' } });
  cursor() { return 'crosshair'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), this.info, sep(),
      button('Straighten Layer', () => this.straighten(), { small: true }),
      button('Clear', () => { this.a = this.b = null; this.sync(); bus.emit('render', app.doc); }, { small: true }));
  }
  private sync() {
    if (!this.a || !this.b) { this.info.textContent = 'X: —  Y: —  W: —  H: —  A: —  L1: —'; return; }
    const dx = this.b.x - this.a.x, dy = this.b.y - this.a.y;
    const ang = (-Math.atan2(dy, dx) * 180) / Math.PI;
    this.info.textContent = `X: ${Math.round(this.a.x)}  Y: ${Math.round(this.a.y)}  W: ${Math.round(dx)}  H: ${Math.round(dy)}  A: ${ang.toFixed(1)}°  L1: ${Math.hypot(dx, dy).toFixed(1)}`;
  }
  down(p: PointerInfo, v: Viewport) {
    const near = (q: Point | null) => q && Math.hypot(v.toScreen(q.x, q.y).x - p.sx, v.toScreen(q.x, q.y).y - p.sy) < 6;
    if (near(this.a)) this.dragging = 'a';
    else if (near(this.b)) this.dragging = 'b';
    else { this.a = { x: p.x, y: p.y }; this.b = { x: p.x, y: p.y }; this.dragging = 'new'; }
  }
  move(p: PointerInfo) {
    if (!this.dragging) return;
    let q = { x: p.x, y: p.y };
    const anchor = this.dragging === 'a' ? this.b! : this.a!;
    if (p.shift) {
      const ang = Math.round(Math.atan2(q.y - anchor.y, q.x - anchor.x) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(q.x - anchor.x, q.y - anchor.y);
      q = { x: anchor.x + Math.cos(ang) * len, y: anchor.y + Math.sin(ang) * len };
    }
    if (this.dragging === 'a') this.a = q; else this.b = q;
    this.sync();
  }
  up() { this.dragging = null; }
  private straighten() {
    if (!this.a || !this.b) { toast('Draw a line along something that should be level'); return; }
    let ang = (Math.atan2(this.b.y - this.a.y, this.b.x - this.a.x) * 180) / Math.PI;
    if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    if (Math.abs(ang) > 45) ang = ang > 0 ? ang - 90 : ang + 90;
    rotateLayerOrCanvas(-ang, 'layer');
    this.a = this.b = null;
    this.sync();
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    if (!this.a || !this.b) return;
    const a = v.toScreen(this.a.x, this.a.y), b = v.toScreen(this.b.x, this.b.y);
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    for (const q of [a, b]) { ctx.beginPath(); ctx.moveTo(q.x - 5, q.y); ctx.lineTo(q.x + 5, q.y); ctx.moveTo(q.x, q.y - 5); ctx.lineTo(q.x, q.y + 5); ctx.stroke(); }
    ctx.restore();
  }
  activate() { this.sync(); }
}

// ---------- Gradient ----------
export class GradientTool extends Tool {
  id = 'gradient'; name = 'Gradient Tool'; icon = 'gradient'; key = 'G'; group = 'gradient';
  gradient: Gradient | null = null;
  style: GradientStyle = 'linear';
  mode = 'normal';
  opacity = 1;
  reverse = false;
  dither = true;
  transparency = true;
  private a: Point | null = null; private b: Point | null = null;
  private picker: ReturnType<typeof gradientPicker> | null = null;
  cursor() { return 'crosshair'; }
  get grad(): Gradient { return this.gradient ?? fgBgGradient(app.fg, app.bg); }
  constructor() {
    super();
    bus.on('colors', () => { if (!this.gradient || this.gradient.name === 'Foreground to Background') { this.gradient = null; this.picker?.set(this.grad); } });
  }
  buildOptions() {
    this.picker = gradientPicker({ value: this.grad, onChange: (g) => { this.gradient = g; }, width: 120 });
    const styles = segmented({
      value: this.style, onChange: (v) => { this.style = v as GradientStyle; },
      options: [
        { value: 'linear', title: 'Linear Gradient', icon: 'gradient' },
        { value: 'radial', title: 'Radial Gradient', icon: 'p-color' },
        { value: 'angle', title: 'Angle Gradient', icon: 'p-navigator' },
        { value: 'reflected', title: 'Reflected Gradient', icon: 'a-gradientmap' },
        { value: 'diamond', title: 'Diamond Gradient', icon: 'shape-polygon' },
      ],
    });
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), this.picker.el, styles.el, sep(),
      blendSel(() => this.mode, (v) => { this.mode = v; }),
      pct('Opacity:', () => this.opacity, (v) => { this.opacity = v; }),
      check('Reverse', () => this.reverse, (v) => { this.reverse = v; }),
      check('Dither', () => this.dither, (v) => { this.dither = v; }),
      check('Transparency', () => this.transparency, (v) => { this.transparency = v; }));
  }
  down(p: PointerInfo) { this.a = { x: p.x, y: p.y }; this.b = { ...this.a }; }
  move(p: PointerInfo) {
    if (!this.a) return;
    let q = { x: p.x, y: p.y };
    if (p.shift) {
      const ang = Math.round(Math.atan2(q.y - this.a.y, q.x - this.a.x) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(q.x - this.a.x, q.y - this.a.y);
      q = { x: this.a.x + Math.cos(ang) * len, y: this.a.y + Math.sin(ang) * len };
    }
    this.b = q;
  }
  async up(_p: PointerInfo, v: Viewport) {
    const a = this.a, b = this.b;
    this.a = this.b = null;
    v.requestRender();
    if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 1) return;
    const doc = v.doc!;
    const t = await editableTarget(doc, 'use the Gradient tool');
    if (!t) return;
    let gr = this.grad;
    if (!this.transparency) gr = { ...gr, stops: gr.stops.map((s) => ({ ...s, opacity: 1 })) };
    const before = doc.captureState();
    const g = renderGradient(gr, this.style, a.x - t.x, a.y - t.y, b.x - t.x, b.y - t.y, t.canvas.width, t.canvas.height, this.reverse, this.dither);
    t.replace(paintOnto(doc, t, g, this.opacity, this.mode as any));
    doc.commit('Gradient', before);
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    if (!this.a || !this.b) return;
    const a = v.toScreen(this.a.x, this.a.y), b = v.toScreen(this.b.x, this.b.y);
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    for (const [q, c] of [[a, this.grad.stops[0]], [b, this.grad.stops[this.grad.stops.length - 1]]] as const) {
      ctx.fillStyle = cssColor((c as any).color); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------- Paint Bucket ----------
export class BucketTool extends Tool {
  id = 'bucket'; name = 'Paint Bucket Tool'; icon = 'bucket'; key = 'G'; group = 'gradient';
  mode = 'normal'; opacity = 1; tolerance = 32; antialias = true; contiguous = true; sampleAll = false;
  cursor() { return 'crosshair'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      sel(null, [{ value: 'fg', label: 'Foreground' }], () => 'fg', () => {}, 100), sep(),
      blendSel(() => this.mode, (v) => { this.mode = v; }),
      pct('Opacity:', () => this.opacity, (v) => { this.opacity = v; }),
      num('Tolerance:', () => this.tolerance, (v) => { this.tolerance = v; }, { min: 0, max: 255, width: 44 }),
      check('Anti-alias', () => this.antialias, (v) => { this.antialias = v; }),
      check('Contiguous', () => this.contiguous, (v) => { this.contiguous = v; }),
      check('All Layers', () => this.sampleAll, (v) => { this.sampleAll = v; }));
  }
  async down(p: PointerInfo, v: Viewport) {
    const doc = v.doc!;
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
    const t = await editableTarget(doc, 'use the Paint Bucket');
    if (!t) return;
    // sample in doc space
    let img: ImageData;
    if (this.sampleAll) img = getImageData(doc.composite);
    else {
      const c = createCanvas(doc.width, doc.height);
      ctx2d(c).drawImage(t.canvas, t.x, t.y);
      img = getImageData(c);
    }
    const region = colorRegion(img, p.x, p.y, this.tolerance, this.contiguous, this.antialias);
    const before = doc.captureState();
    const paint = solidFor(t, app.fg);
    const px = ctx2d(paint);
    px.globalCompositeOperation = 'destination-in';
    px.drawImage(region, -t.x, -t.y);
    t.replace(paintOnto(doc, t, paint, this.opacity, this.mode as any));
    doc.commit('Paint Bucket', before);
  }
}
