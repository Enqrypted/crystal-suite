// The document canvas view: zoom/pan, rulers, guides, overlays, pointer routing to tools.
import { app } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { updateComposite } from '../core/compositor';
import { checkerboard, clamp, createCanvas, ctx2d, Point } from '../core/util';
import { h } from './dom';
import { currentTool, getTool, PointerInfo, Tool } from '../tools/tool';
import { alphaToGray } from '../ops/target';
import { drawSamplers } from '../ops/samplers';

export const ZOOM_STEPS = [0.01, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32];

export class Viewport {
  el: HTMLElement;
  view: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  rulerTop: HTMLCanvasElement;
  rulerLeft: HTMLCanvasElement;
  /** Container for DOM overlays such as the text editor. */
  overlayLayer: HTMLElement;
  w = 0; h = 0; dpr = 1;
  hover: Point | null = null;
  hoverScreen: Point | null = null;
  private renderQueued = false;
  private antsPhase = 0;
  private dragTool: Tool | null = null;
  spaceDown = false;
  /** Tool temporarily overriding the current one (Space=Hand, Ctrl+Space=Zoom...). */
  tempTool: Tool | null = null;
  private colors = { pasteboard: '#282828', border: '#000' };
  onContextMenu: ((p: PointerInfo) => void) | null = null;
  private lastPointer: PointerInfo | null = null;
  private guideDrag: { dir: 'h' | 'v'; pos: number; index: number } | null = null;

  constructor() {
    this.canvas = h('canvas', { class: 'view', tabindex: 0 }) as HTMLCanvasElement;
    this.ctx = ctx2d(this.canvas);
    this.overlayLayer = h('div', { class: 'overlay-layer' });
    this.vbar = h('div', { class: 'vscroll' }, h('div', { class: 'thumb' }));
    this.hbar = h('div', { class: 'hscroll' }, h('div', { class: 'thumb' }));
    this.view = h('div', { class: 'viewport' }, this.canvas, this.overlayLayer, this.vbar, this.hbar);
    this.bindScrollbar(this.vbar, 'y');
    this.bindScrollbar(this.hbar, 'x');
    this.rulerTop = createCanvas(10, 18);
    this.rulerLeft = createCanvas(18, 10);
    const rt = h('div', { class: 'ruler ruler-h' }, this.rulerTop);
    const rl = h('div', { class: 'ruler ruler-v' }, this.rulerLeft);
    this.el = h('div', { class: 'canvas-wrap' }, h('div', { class: 'ruler-corner' }), rt, rl, this.view);
    new ResizeObserver(() => this.resize()).observe(this.view);
    this.bindPointer();
    this.bindRulers(rt, 'h');
    this.bindRulers(rl, 'v');
    bus.on('render', (d: Doc) => { if (!d || d === app.doc) this.requestRender(); });
    bus.on('view', () => this.requestRender());
    bus.on('selection', () => this.requestRender());
    bus.on('docs', () => this.requestRender());
    bus.on('tool', () => this.updateCursor());
    // marching ants
    setInterval(() => {
      const d = app.doc;
      if (d && (d.selection || d.floating) && !document.hidden) { this.antsPhase = (this.antsPhase + 1) % 8; this.requestRender(); }
    }, 110);
    this.updateTheme();
  }

  get doc() { return app.doc; }
  get tool(): Tool { return this.tempTool ?? currentTool(); }

  updateTheme() {
    const cs = getComputedStyle(document.documentElement);
    this.colors.pasteboard = cs.getPropertyValue('--pasteboard').trim() || '#282828';
    this.requestRender();
  }
  setRulers(on: boolean) { this.el.classList.toggle('rulers', on); this.resize(); }

  resize() {
    const r = this.view.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.rulerTop.width = Math.round(r.width * this.dpr); this.rulerTop.height = Math.round(18 * this.dpr);
    this.rulerTop.style.width = `${r.width}px`; this.rulerTop.style.height = '18px';
    this.rulerLeft.width = Math.round(18 * this.dpr); this.rulerLeft.height = Math.round(r.height * this.dpr);
    this.rulerLeft.style.width = '18px'; this.rulerLeft.style.height = `${r.height}px`;
    const d = this.doc;
    if (d && !d.viewInit && this.w > 0) this.fit(d);
    this.render();
  }

  // ---------- coordinates ----------
  toScreen(x: number, y: number, d = this.doc!): Point { return { x: d.panX + x * d.zoom, y: d.panY + y * d.zoom }; }
  toDoc(sx: number, sy: number, d = this.doc!): Point { return { x: (sx - d.panX) / d.zoom, y: (sy - d.panY) / d.zoom }; }

  // ---------- zoom / pan ----------
  setZoom(z: number, sx = this.w / 2, sy = this.h / 2) {
    const d = this.doc;
    if (!d) return;
    this.anim = null;
    z = clamp(z, 0.01, 32);
    const p = this.toDoc(sx, sy);
    d.zoom = z;
    d.panX = sx - p.x * z;
    d.panY = sy - p.y * z;
    this.clampPan();
    bus.emit('view', d);
  }
  zoomStep(dir: 1 | -1, sx?: number, sy?: number) {
    const d = this.doc;
    if (!d) return;
    // step from where an animated zoom is heading, so repeated presses keep stepping
    const z = this.anim && this.anim.doc === d ? this.anim.z : d.zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * 1.001) ?? 32 : [...ZOOM_STEPS].reverse().find((s) => s < z * 0.999) ?? 0.01;
    this.smoothZoomAt(next / z, sx ?? this.w / 2, sy ?? this.h / 2);
  }
  fit(d = this.doc) {
    if (!d || this.w <= 0) return;
    this.anim = null;
    const z = Math.min((this.w - 40) / d.width, (this.h - 40) / d.height, 1e9);
    d.zoom = clamp(z, 0.01, 32);
    d.panX = (this.w - d.width * d.zoom) / 2;
    d.panY = (this.h - d.height * d.zoom) / 2;
    d.viewInit = true;
    bus.emit('view', d);
  }
  fillScreen(d = this.doc) {
    if (!d) return;
    this.anim = null;
    d.zoom = Math.max(this.w / d.width, this.h / d.height);
    d.panX = (this.w - d.width * d.zoom) / 2;
    d.panY = (this.h - d.height * d.zoom) / 2;
    bus.emit('view', d);
  }
  actualPixels() {
    const d = this.doc;
    if (!d) return;
    this.anim = null;
    const c = this.toDoc(this.w / 2, this.h / 2);
    d.zoom = 1;
    d.panX = Math.round(this.w / 2 - c.x);
    d.panY = Math.round(this.h / 2 - c.y);
    this.clampPan();
    bus.emit('view', d);
  }
  panBy(dx: number, dy: number) {
    const d = this.doc;
    if (!d) return;
    this.anim = null;
    d.panX += dx; d.panY += dy;
    this.clampPan();
    bus.emit('view', d);
  }
  /** Allowed pan range at a zoom level (the document can scroll until 60px remain visible). */
  panRange(z = this.doc!.zoom) {
    const d = this.doc!;
    const m = 60;
    const dw = d.width * z, dh = d.height * z;
    return {
      minX: Math.min(m - dw, (this.w - dw) / 2), maxX: Math.max(this.w - m, (this.w - dw) / 2),
      minY: Math.min(m - dh, (this.h - dh) / 2), maxY: Math.max(this.h - m, (this.h - dh) / 2),
    };
  }
  private clampPan() {
    const d = this.doc!;
    const r = this.panRange();
    d.panX = clamp(d.panX, r.minX, r.maxX);
    d.panY = clamp(d.panY, r.minY, r.maxY);
  }

  // ---------- smooth (animated) scrolling & zooming ----------
  private anim: { doc: Doc; x: number; y: number; z: number; ax: number; ay: number } | null = null;
  private animFrame = 0;
  private animTime = 0;
  private animTarget() {
    const d = this.doc!;
    if (!this.anim || this.anim.doc !== d) this.anim = { doc: d, x: d.panX, y: d.panY, z: d.zoom, ax: this.w / 2, ay: this.h / 2 };
    return this.anim;
  }
  private clampTarget(a: NonNullable<Viewport['anim']>) {
    const r = this.panRange(a.z);
    a.x = clamp(a.x, r.minX, r.maxX);
    a.y = clamp(a.y, r.minY, r.maxY);
  }
  smoothPanBy(dx: number, dy: number) {
    if (!this.doc) return;
    const a = this.animTarget();
    a.x += dx; a.y += dy;
    this.clampTarget(a);
    this.kick();
  }
  smoothZoomAt(factor: number, sx: number, sy: number) {
    if (!this.doc) return;
    const a = this.animTarget();
    // keep the document point under the cursor (in the target view) under the cursor
    const px = (sx - a.x) / a.z, py = (sy - a.y) / a.z;
    a.z = clamp(a.z * factor, 0.01, 32);
    a.x = sx - px * a.z; a.y = sy - py * a.z;
    a.ax = sx; a.ay = sy;
    this.clampTarget(a);
    this.kick();
  }
  private kick() {
    if (this.animFrame) return;
    this.animTime = performance.now();
    this.animFrame = requestAnimationFrame(this.step);
  }
  private step = (now: number) => {
    this.animFrame = 0;
    const d = this.doc, a = this.anim;
    if (!d || !a || a.doc !== d) { this.anim = null; return; }
    const dt = Math.min(64, now - this.animTime);
    this.animTime = now;
    const k = 1 - Math.pow(1 - 0.24, dt / 16.7); // ease-out, frame-rate independent
    if (Math.abs(d.zoom - a.z) > a.z * 1e-4) {
      // zoom in log space while holding the anchor point still
      const z = Math.exp(Math.log(d.zoom) + (Math.log(a.z) - Math.log(d.zoom)) * k);
      const px = (a.ax - a.x) / a.z, py = (a.ay - a.y) / a.z;
      d.zoom = z;
      d.panX = a.ax - px * z;
      d.panY = a.ay - py * z;
    } else {
      d.zoom = a.z;
      d.panX += (a.x - d.panX) * k;
      d.panY += (a.y - d.panY) * k;
    }
    const done = Math.abs(d.zoom - a.z) <= a.z * 1e-4 && Math.abs(d.panX - a.x) < 0.25 && Math.abs(d.panY - a.y) < 0.25;
    if (done) { d.zoom = a.z; d.panX = a.x; d.panY = a.y; this.anim = null; }
    bus.emit('view', d);
    if (!done) this.animFrame = requestAnimationFrame(this.step);
  };
  /** Center the view on a doc point. */
  centerOn(x: number, y: number) {
    const d = this.doc;
    if (!d) return;
    this.anim = null;
    d.panX = this.w / 2 - x * d.zoom;
    d.panY = this.h / 2 - y * d.zoom;
    this.clampPan();
    bus.emit('view', d);
  }

  /** Snap a doc point to guides / document edges / center when within 6 screen px. */
  snap(x: number, y: number, enabled = app.prefs.snap): Point {
    const d = this.doc;
    if (!d || !enabled) return { x, y };
    const tol = 6 / d.zoom;
    const xs = [0, d.width, d.width / 2, ...(app.prefs.showGuides ? d.guides.filter((g) => g.dir === 'v').map((g) => g.pos) : [])];
    const ys = [0, d.height, d.height / 2, ...(app.prefs.showGuides ? d.guides.filter((g) => g.dir === 'h').map((g) => g.pos) : [])];
    let bx = x, by = y, dx = tol, dy = tol;
    for (const v of xs) if (Math.abs(v - x) < dx) { dx = Math.abs(v - x); bx = v; }
    for (const v of ys) if (Math.abs(v - y) < dy) { dy = Math.abs(v - y); by = v; }
    return { x: bx, y: by };
  }

  // ---------- pointer ----------
  private info(e: PointerEvent | MouseEvent): PointerInfo {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const d = this.doc;
    const p = d ? this.toDoc(sx, sy) : { x: 0, y: 0 };
    const pe = e as PointerEvent;
    let pressure = pe.pressure ?? 1;
    if (pe.pointerType === 'mouse' || !pe.pointerType) pressure = 1;
    else if (pe.pointerType === 'pen' && pressure === 0 && e.buttons) pressure = 0.5;
    return {
      x: p.x, y: p.y, sx, sy, pressure: pressure || 1, button: e.button,
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, e,
    };
  }

  private bindPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.focus({ preventScroll: true });
      if (!this.doc) return;
      if (e.button === 2) return;
      const p = this.info(e);
      // guides can be dragged with the move tool
      if (e.button === 0 && this.tool.id === 'move' && app.prefs.showGuides) {
        const gi = this.guideAt(p.sx, p.sy);
        if (gi >= 0) { this.startGuideMove(gi, e); return; }
      }
      let tool = this.tool;
      if (e.button === 1) tool = getTool('hand')!;
      this.dragTool = tool;
      c.setPointerCapture(e.pointerId);
      this.lastPointer = p;
      tool.down(p, this);
      this.updateCursor(p);
      this.requestRender();
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.info(e);
      this.lastPointer = p;
      if (this.doc) {
        this.hover = { x: p.x, y: p.y };
        this.hoverScreen = { x: p.sx, y: p.sy };
        bus.emit('pointer', this.doc, p.x, p.y);
      }
      if (this.dragTool) {
        const evs = (e as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
        if (evs && evs.length > 1) for (const ce of evs) this.dragTool.move(this.info(ce), this);
        else this.dragTool.move(p, this);
      } else if (this.doc) {
        this.tool.hover(p, this);
      }
      this.updateCursor(p);
      this.requestRender();
    });
    const end = (e: PointerEvent) => {
      if (!this.dragTool) return;
      const t = this.dragTool;
      this.dragTool = null;
      try { c.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      t.up(this.info(e), this);
      this.updateCursor(this.info(e));
      this.requestRender();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!this.dragTool) { this.hover = null; this.hoverScreen = null; this.requestRender(); } });
    c.addEventListener('dblclick', (e) => { if (this.doc) this.tool.dblclick(this.info(e), this); });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.doc && this.onContextMenu) this.onContextMenu(this.info(e));
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.doc) return;
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      // lines/pages → pixels
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.h : 1;
      let dx = e.deltaX * unit, dy = e.deltaY * unit;
      // trackpads send many small fractional deltas: follow them 1:1; mouse wheels jump in notches: glide
      const precise = e.deltaMode === 0 && Math.abs(dx) < 50 && Math.abs(dy) < 50 && (!Number.isInteger(dy) || !Number.isInteger(dx) || Math.abs(dy) < 20);
      const zoomGesture = e.ctrlKey || e.altKey || (app.prefs.zoomWithWheel && !e.shiftKey);
      if (zoomGesture) {
        const pinch = e.ctrlKey && !e.altKey && precise;
        const factor = Math.exp(-dy * (pinch ? 0.01 : 0.0022));
        if (pinch) this.setZoom(this.doc.zoom * factor, sx, sy);
        else this.smoothZoomAt(factor, sx, sy);
        return;
      }
      if (e.shiftKey && !dx) { dx = dy; dy = 0; } // Shift+wheel scrolls horizontally
      if (precise) this.panBy(-dx, -dy);
      else this.smoothPanBy(-dx * 1.15, -dy * 1.15);
    }, { passive: false });
  }

  updateCursor(p?: PointerInfo | null) {
    const t = this.dragTool ?? this.tool;
    this.canvas.style.cursor = this.doc ? t.cursor(p ?? this.lastPointer) : 'default';
  }

  // ---------- guides ----------
  private guideAt(sx: number, sy: number): number {
    const d = this.doc!;
    for (let i = d.guides.length - 1; i >= 0; i--) {
      const g = d.guides[i];
      const s = this.toScreen(g.pos, g.pos);
      if (g.dir === 'v' && Math.abs(s.x - sx) < 4) return i;
      if (g.dir === 'h' && Math.abs(s.y - sy) < 4) return i;
    }
    return -1;
  }
  private startGuideMove(index: number, e: PointerEvent) {
    const d = this.doc!;
    const g = d.guides[index];
    this.guideDrag = { dir: g.dir, pos: g.pos, index };
    this.canvas.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => {
      const p = this.info(ev);
      const v = g.dir === 'v' ? p.x : p.y;
      g.pos = Math.round(ev.shiftKey ? v : this.snap(v, v).x === v ? v : v);
      this.requestRender();
    };
    const up = (ev: PointerEvent) => {
      this.canvas.removeEventListener('pointermove', mv);
      this.canvas.removeEventListener('pointerup', up);
      const p = this.info(ev);
      // dragged back onto the ruler / out of the document view: delete
      if ((g.dir === 'v' && p.sx < 0) || (g.dir === 'h' && p.sy < 0)) d.guides.splice(d.guides.indexOf(g), 1);
      this.guideDrag = null;
      this.requestRender();
    };
    this.canvas.addEventListener('pointermove', mv);
    this.canvas.addEventListener('pointerup', up);
  }
  private bindRulers(el: HTMLElement, dir: 'h' | 'v') {
    el.addEventListener('pointerdown', (e) => {
      const d = this.doc;
      if (!d) return;
      el.setPointerCapture(e.pointerId);
      // dragging from the top ruler creates a horizontal guide
      const gdir: 'h' | 'v' = dir === 'h' ? (e.altKey ? 'v' : 'h') : (e.altKey ? 'h' : 'v');
      const g = { dir: gdir, pos: -1e6 };
      d.guides.push(g);
      app.prefs.showGuides = true;
      const mv = (ev: PointerEvent) => {
        const r = this.canvas.getBoundingClientRect();
        const p = this.toDoc(ev.clientX - r.left, ev.clientY - r.top);
        let v = gdir === 'h' ? p.y : p.x;
        if (!ev.shiftKey) { const s = this.snap(v, v); v = gdir === 'h' ? s.y : s.x; }
        g.pos = Math.round(v);
        this.requestRender();
      };
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', mv);
        el.removeEventListener('pointerup', up);
        const r = this.canvas.getBoundingClientRect();
        const inside = ev.clientX >= r.left && ev.clientY >= r.top && ev.clientX <= r.right && ev.clientY <= r.bottom;
        if (!inside) d.guides.splice(d.guides.indexOf(g), 1);
        this.requestRender();
      };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
    });
  }

  // ---------- scrollbars ----------
  vbar: HTMLElement;
  hbar: HTMLElement;
  private barGeom(axis: 'x' | 'y') {
    const d = this.doc!;
    const r = this.panRange();
    const span = axis === 'x' ? r.maxX - r.minX : r.maxY - r.minY;
    const view = axis === 'x' ? this.w : this.h;
    const track = Math.max(1, view - 12);
    const thumb = Math.max(28, Math.min(track, (track * view) / (view + span)));
    const pos = span > 0 ? ((axis === 'x' ? r.maxX - d.panX : r.maxY - d.panY) / span) : 0;
    return { span, view, track, thumb, offset: (track - thumb) * clamp(pos, 0, 1) };
  }
  private updateScrollbars() {
    const show = !!this.doc;
    this.vbar.style.display = this.hbar.style.display = show ? '' : 'none';
    if (!show) return;
    for (const axis of ['x', 'y'] as const) {
      const g = this.barGeom(axis);
      const t = (axis === 'x' ? this.hbar : this.vbar).firstElementChild as HTMLElement;
      if (axis === 'x') { t.style.left = g.offset + 'px'; t.style.width = g.thumb + 'px'; }
      else { t.style.top = g.offset + 'px'; t.style.height = g.thumb + 'px'; }
    }
  }
  private bindScrollbar(bar: HTMLElement, axis: 'x' | 'y') {
    const thumb = bar.firstElementChild as HTMLElement;
    thumb.addEventListener('pointerdown', (e) => {
      if (!this.doc) return;
      e.preventDefault(); e.stopPropagation();
      thumb.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      let last = axis === 'x' ? e.clientX : e.clientY;
      const mv = (ev: PointerEvent) => {
        const cur = axis === 'x' ? ev.clientX : ev.clientY;
        const g = this.barGeom(axis);
        const delta = ((cur - last) * g.span) / Math.max(1, g.track - g.thumb);
        last = cur;
        if (axis === 'x') this.panBy(-delta, 0); else this.panBy(0, -delta);
      };
      const up = () => { thumb.removeEventListener('pointermove', mv); thumb.removeEventListener('pointerup', up); bar.classList.remove('dragging'); };
      thumb.addEventListener('pointermove', mv);
      thumb.addEventListener('pointerup', up);
    });
    // clicking the track pages toward the click
    bar.addEventListener('pointerdown', (e) => {
      if (!this.doc || e.target !== bar) return;
      const g = this.barGeom(axis);
      const rr = bar.getBoundingClientRect();
      const at = axis === 'x' ? e.clientX - rr.left : e.clientY - rr.top;
      const dir = at < g.offset ? 1 : -1;
      if (axis === 'x') this.smoothPanBy(dir * g.view * 0.9, 0); else this.smoothPanBy(0, dir * g.view * 0.9);
    });
  }

  // ---------- rendering ----------
  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.render(); });
  }

  private channelCache: { key: string; canvas: HTMLCanvasElement } | null = null;
  private displaySource(d: Doc): HTMLCanvasElement {
    if (d.viewMask && d.active?.mask) {
      const L = d.active;
      const key = `mask|${L.id}|${L.version}|${d.width}`;
      if (this.channelCache?.key !== key) {
        const c = createCanvas(d.width, d.height);
        const x = ctx2d(c);
        x.fillStyle = '#000'; x.fillRect(0, 0, d.width, d.height);
        x.drawImage(alphaToGray(L.mask!), L.maskX, L.maskY);
        this.channelCache = { key, canvas: c };
      }
      return this.channelCache.canvas;
    }
    if (d.channelView === 'rgb') return d.composite;
    const key = `${d.channelView}|${d.compositeVersion}|${d.id}`;
    if (this.channelCache?.key !== key) {
      const src = ctx2d(d.composite).getImageData(0, 0, d.width, d.height);
      const s = src.data;
      const ch = d.channelView === 'r' ? 0 : d.channelView === 'g' ? 1 : 2;
      for (let i = 0; i < s.length; i += 4) {
        const a = s[i + 3] / 255;
        const v = s[i + ch] * a + 255 * (1 - a);
        s[i] = s[i + 1] = s[i + 2] = v; s[i + 3] = 255;
      }
      const c = createCanvas(d.width, d.height);
      ctx2d(c).putImageData(src, 0, 0);
      this.channelCache = { key, canvas: c };
    }
    return this.channelCache.canvas;
  }

  render() {
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.colors.pasteboard;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const d = this.doc;
    this.updateScrollbars();
    if (!d) { this.renderRulers(); return; }
    if (!d.viewInit && this.w > 0) this.fit(d);
    updateComposite(d);
    const z = d.zoom;
    // doc rect in device px
    const x0 = d.panX * dpr, y0 = d.panY * dpr, dw = d.width * z * dpr, dh = d.height * z * dpr;
    // checkerboard (screen-space squares)
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, dw, dh); ctx.clip();
    const pat = ctx.createPattern(checkerboard(8), 'repeat')!;
    pat.setTransform(new DOMMatrix([dpr, 0, 0, dpr, x0, y0]));
    ctx.fillStyle = pat;
    ctx.fillRect(x0, y0, dw, dh);
    ctx.restore();
    // image
    ctx.setTransform(z * dpr, 0, 0, z * dpr, x0, y0);
    ctx.imageSmoothingEnabled = z < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.displaySource(d), 0, 0);
    // quick mask / mask overlay (rubylith)
    if (d.quickMask || (d.maskOverlay && d.active?.mask)) {
      const o = createOverlay(d);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(o, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.imageSmoothingEnabled = true;
    // screen-space overlays from here
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (z >= 8 && app.prefs.showPixelGrid) this.drawPixelGrid(d);
    if (app.prefs.showGrid) this.drawGrid(d);
    // document border
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(d.panX) - 0.5, Math.round(d.panY) - 0.5, Math.round(d.width * z) + 1, Math.round(d.height * z) + 1);
    if (app.prefs.showGuides) this.drawGuides(d);
    if (d.selection && !d.quickMask) this.drawAnts(d);
    if (this.tool.id !== 'color-sampler') drawSamplers(ctx, (x, y) => this.toScreen(x, y), d);
    try { this.tool.overlay(ctx, this); } catch (e) { console.error(e); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.renderRulers();
  }

  /** Draw a doc-space path with marching-ants styling. */
  strokeAnts(path: Path2D, d = this.doc!, closedOnly = false) {
    const ctx = this.ctx, dpr = this.dpr;
    ctx.save();
    ctx.setTransform(d.zoom * dpr, 0, 0, d.zoom * dpr, d.panX * dpr, d.panY * dpr);
    ctx.lineWidth = 1 / d.zoom;
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([]);
    ctx.stroke(path);
    ctx.strokeStyle = '#000';
    ctx.setLineDash([4 / d.zoom, 4 / d.zoom]);
    ctx.lineDashOffset = -this.antsPhase / d.zoom;
    ctx.stroke(path);
    ctx.restore();
    void closedOnly;
  }
  private drawAnts(d: Doc) {
    const p = d.selectionOutline();
    if (p) this.strokeAnts(p, d);
  }
  private drawPixelGrid(d: Doc) {
    const ctx = this.ctx, z = d.zoom;
    const a = this.toDoc(0, 0), b = this.toDoc(this.w, this.h);
    const x0 = Math.max(0, Math.floor(a.x)), x1 = Math.min(d.width, Math.ceil(b.x));
    const y0 = Math.max(0, Math.floor(a.y)), y1 = Math.min(d.height, Math.ceil(b.y));
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { const sx = Math.round(d.panX + x * z) + 0.5; ctx.moveTo(sx, d.panY + y0 * z); ctx.lineTo(sx, d.panY + y1 * z); }
    for (let y = y0; y <= y1; y++) { const sy = Math.round(d.panY + y * z) + 0.5; ctx.moveTo(d.panX + x0 * z, sy); ctx.lineTo(d.panX + x1 * z, sy); }
    ctx.strokeStyle = 'rgba(140,140,140,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  private drawGrid(d: Doc) {
    const ctx = this.ctx, z = d.zoom, gs = app.prefs.gridSize;
    if (gs * z < 4) return;
    ctx.beginPath();
    for (let x = 0; x <= d.width; x += gs) { const sx = Math.round(d.panX + x * z) + 0.5; ctx.moveTo(sx, d.panY); ctx.lineTo(sx, d.panY + d.height * z); }
    for (let y = 0; y <= d.height; y += gs) { const sy = Math.round(d.panY + y * z) + 0.5; ctx.moveTo(d.panX, sy); ctx.lineTo(d.panX + d.width * z, sy); }
    ctx.strokeStyle = 'rgba(128,128,128,0.55)';
    ctx.stroke();
    // subdivisions
    ctx.beginPath();
    const sub = gs / 4;
    if (sub * z >= 8) {
      for (let x = 0; x <= d.width; x += sub) { if (x % gs === 0) continue; const sx = Math.round(d.panX + x * z) + 0.5; ctx.moveTo(sx, d.panY); ctx.lineTo(sx, d.panY + d.height * z); }
      for (let y = 0; y <= d.height; y += sub) { if (y % gs === 0) continue; const sy = Math.round(d.panY + y * z) + 0.5; ctx.moveTo(d.panX, sy); ctx.lineTo(d.panX + d.width * z, sy); }
      ctx.strokeStyle = 'rgba(128,128,128,0.22)';
      ctx.stroke();
    }
  }
  private drawGuides(d: Doc) {
    const ctx = this.ctx;
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const g of d.guides) {
      if (g.dir === 'v') { const sx = Math.round(this.toScreen(g.pos, 0).x) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, this.h); }
      else { const sy = Math.round(this.toScreen(0, g.pos).y) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(this.w, sy); }
    }
    ctx.stroke();
  }

  private renderRulers() {
    if (!this.el.classList.contains('rulers')) return;
    const d = this.doc;
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--panel').trim(), fg = cs.getPropertyValue('--text-2').trim(), line = cs.getPropertyValue('--text-3').trim();
    for (const dir of ['h', 'v'] as const) {
      const c = dir === 'h' ? this.rulerTop : this.rulerLeft;
      const x = ctx2d(c);
      x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const len = dir === 'h' ? this.w : this.h;
      x.fillStyle = bg; x.fillRect(0, 0, dir === 'h' ? len : 18, dir === 'h' ? 18 : len);
      if (!d) continue;
      const z = d.zoom, pan = dir === 'h' ? d.panX : d.panY;
      // choose tick spacing so major labels are >= 50px apart
      const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
      const major = nice.find((n) => n * z >= 55) ?? 10000;
      const minor = major / (major % 4 === 0 || major === 100 || major === 1000 ? 10 : 5);
      x.strokeStyle = line; x.fillStyle = fg; x.lineWidth = 1;
      x.font = '9px Segoe UI, sans-serif';
      x.beginPath();
      const start = Math.floor(-pan / z / minor) * minor, end = (len - pan) / z;
      for (let v = start; v <= end; v += minor) {
        const s = Math.round(pan + v * z) + 0.5;
        const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
        const tl = isMajor ? 18 : (Math.abs((v / (major / 2)) - Math.round(v / (major / 2))) < 1e-6 ? 8 : 4);
        if (dir === 'h') { x.moveTo(s, 18); x.lineTo(s, 18 - tl); } else { x.moveTo(18, s); x.lineTo(18 - tl, s); }
        if (isMajor) {
          const label = String(Math.round(v));
          if (dir === 'h') x.fillText(label, s + 2, 9);
          else { x.save(); x.translate(9, s + 2); x.rotate(-Math.PI / 2); x.textAlign = 'right'; x.fillText(label, 0, 0); x.restore(); }
        }
      }
      x.stroke();
      // cursor marker
      if (this.hoverScreen) {
        x.strokeStyle = fg;
        x.beginPath();
        const s = Math.round(dir === 'h' ? this.hoverScreen.x : this.hoverScreen.y) + 0.5;
        if (dir === 'h') { x.moveTo(s, 0); x.lineTo(s, 18); } else { x.moveTo(0, s); x.lineTo(18, s); }
        x.stroke();
      }
      x.fillStyle = line;
      if (dir === 'h') x.fillRect(0, 17, len, 1); else x.fillRect(17, 0, 1, len);
    }
  }
}

let overlayCanvas: HTMLCanvasElement | null = null;
function createOverlay(d: Doc): HTMLCanvasElement {
  if (!overlayCanvas || overlayCanvas.width !== d.width || overlayCanvas.height !== d.height) overlayCanvas = createCanvas(d.width, d.height);
  const x = ctx2d(overlayCanvas);
  x.globalCompositeOperation = 'copy';
  x.fillStyle = '#ff0000';
  x.fillRect(0, 0, d.width, d.height);
  x.globalCompositeOperation = 'destination-out';
  if (d.quickMask) { if (d.selection) x.drawImage(d.selection, 0, 0); }
  else if (d.active?.mask) x.drawImage(d.active.mask, d.active.maskX, d.active.maskY);
  x.globalCompositeOperation = 'source-over';
  return overlayCanvas;
}
