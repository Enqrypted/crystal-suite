import { Tool, PointerInfo } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { bus } from '../core/bus';
import { h } from '../ui/dom';
import { toolHeader, sep, num, sel } from '../ui/optbits';
import { colorSwatch, checkbox, popover } from '../ui/widgets';
import { Layer, ShapeData, ShapeType } from '../core/layer';
import { renderShapeLayer, shapeName, CUSTOM_SHAPES, traceShape } from '../core/shapes';
import { Point, RGB, Rect, rectFromPoints, createCanvas, ctx2d } from '../core/util';
import { editableTarget } from '../ops/target';
import { paintOnto } from '../ops/paintops';
import { pt, VectorPath } from '../core/paths';

export const shapeOpts = {
  mode: 'shape' as 'shape' | 'path' | 'pixels',
  fill: { r: 33, g: 150, b: 243 } as RGB | null,
  stroke: null as RGB | null,
  strokeWidth: 3,
  radius: 0,
  sides: 5,
  star: 0,
  weight: 4,
  custom: 'heart',
};

export class ShapeTool extends Tool {
  key = 'U'; group = 'shape';
  private start: Point | null = null;
  private cur: Point | null = null;
  private mods = { shift: false, alt: false };
  constructor(public id: string, public name: string, public icon: string, private type: ShapeType) { super(); }
  cursor() { return 'crosshair'; }
  buildOptions() {
    const fillSw = colorSwatch({ color: shapeOpts.fill ?? app.fg, title: 'Shape fill color', onChange: (c) => { shapeOpts.fill = c; fillOn.set(true); } });
    const fillOn = checkbox({ label: 'Fill:', checked: !!shapeOpts.fill, onChange: (v) => { shapeOpts.fill = v ? fillSw.get() : null; } });
    const strokeSw = colorSwatch({ color: shapeOpts.stroke ?? { r: 0, g: 0, b: 0 }, title: 'Shape stroke color', onChange: (c) => { shapeOpts.stroke = c; strokeOn.set(true); } });
    const strokeOn = checkbox({ label: 'Stroke:', checked: !!shapeOpts.stroke, onChange: (v) => { shapeOpts.stroke = v ? strokeSw.get() : null; } });
    const extra: (HTMLElement | null)[] = [];
    if (this.type === 'rect') extra.push(num('Radius:', () => shapeOpts.radius, (v) => { shapeOpts.radius = v; }, { min: 0, max: 5000, unit: 'px', width: 44 }));
    if (this.type === 'polygon') {
      extra.push(num('Sides:', () => shapeOpts.sides, (v) => { shapeOpts.sides = v; }, { min: 3, max: 100, width: 40 }));
      extra.push(num('Star:', () => Math.round(shapeOpts.star * 100), (v) => { shapeOpts.star = v / 100; }, { min: 0, max: 99, unit: '%', width: 40 }));
    }
    if (this.type === 'line') extra.push(num('Weight:', () => shapeOpts.weight, (v) => { shapeOpts.weight = v; }, { min: 1, max: 1000, unit: 'px', width: 44 }));
    if (this.type === 'custom') {
      const b = h('button', { class: 'brush-preview-btn', title: 'Custom shape picker' }, shapeIcon(shapeOpts.custom), h('span', { class: 'size' }, '▾'));
      b.addEventListener('click', () => {
        const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 44px)', gap: '4px' } });
        for (const [id, s] of Object.entries(CUSTOM_SHAPES)) {
          const it = h('button', { class: 'icon-btn', title: s.name, style: { width: '44px', height: '40px' } }, shapeIcon(id));
          it.addEventListener('click', () => { shapeOpts.custom = id; b.firstChild?.replaceWith(shapeIcon(id)); pop.close(); });
          grid.appendChild(it);
        }
        const pop = popover(b, grid);
      });
      extra.push(h('div', { class: 'opt-group' }, h('span', { class: 'opt-label' }, 'Shape:'), b));
    }
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      sel(null, [{ value: 'shape', label: 'Shape' }, { value: 'path', label: 'Path' }, { value: 'pixels', label: 'Pixels' }], () => shapeOpts.mode, (v) => { shapeOpts.mode = v as any; }, 80), sep(),
      fillOn.el, fillSw.el, strokeOn.el, strokeSw.el,
      num('', () => shapeOpts.strokeWidth, (v) => { shapeOpts.strokeWidth = v; }, { min: 0, max: 500, unit: 'px', width: 40, title: 'Stroke width' }),
      extra.length ? sep() : null, ...extra);
  }
  down(p: PointerInfo, v: Viewport) {
    const s = v.snap(p.x, p.y);
    this.start = { x: s.x, y: s.y };
    this.cur = this.start;
  }
  move(p: PointerInfo, v: Viewport) {
    if (!this.start) return;
    const s = v.snap(p.x, p.y);
    this.cur = { x: s.x, y: s.y };
    this.mods = { shift: p.shift, alt: p.alt };
  }
  private rect(): Rect {
    const s = this.start!, c = this.cur!;
    let w = c.x - s.x, hh = c.y - s.y;
    if (this.mods.shift && this.type !== 'line') { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
    return this.mods.alt ? rectFromPoints(s.x - w, s.y - hh, s.x + w, s.y + hh) : rectFromPoints(s.x, s.y, s.x + w, s.y + hh);
  }
  private lineEnd(): Point {
    const s = this.start!, c = this.cur!;
    if (!this.mods.shift) return c;
    const ang = Math.round(Math.atan2(c.y - s.y, c.x - s.x) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(c.x - s.x, c.y - s.y);
    return { x: s.x + Math.cos(ang) * len, y: s.y + Math.sin(ang) * len };
  }
  private data(r: Rect): ShapeData {
    const o = shapeOpts;
    const d: ShapeData = { type: this.type, w: Math.max(1, r.w), h: Math.max(1, r.h), fill: o.fill, stroke: o.stroke, strokeWidth: o.stroke ? o.strokeWidth : 0, radius: o.radius, sides: o.sides, star: o.star, custom: o.custom };
    if (this.type === 'line') {
      const s = this.start!, e = this.lineEnd();
      d.x1 = s.x - r.x; d.y1 = s.y - r.y; d.x2 = e.x - r.x; d.y2 = e.y - r.y;
      d.stroke = o.fill ?? o.stroke ?? app.fg; d.fill = null; d.strokeWidth = o.weight;
    }
    return d;
  }
  async up(_p: PointerInfo, v: Viewport) {
    if (!this.start || !this.cur) return;
    const doc = v.doc!;
    const r = this.type === 'line' ? rectFromPoints(this.start.x, this.start.y, this.lineEnd().x, this.lineEnd().y) : this.rect();
    const data = this.data(r);
    this.start = this.cur = null;
    if ((this.type !== 'line' && (r.w < 2 || r.h < 2)) || (this.type === 'line' && Math.hypot(r.w, r.h) < 2)) return;
    if (shapeOpts.mode === 'path') {
      const before = doc.captureState();
      const vp = shapeToPath(data, r.x, r.y);
      let wp = doc.paths.find((p) => p.id === doc.activePathId) ?? doc.paths.find((p) => p.name === 'Work Path');
      if (!wp) { wp = { id: Date.now(), name: 'Work Path', subpaths: [] }; doc.paths.push(wp); }
      wp.subpaths.push(...vp.subpaths);
      doc.activePathId = wp.id;
      doc.commit('Work Path', before);
      bus.emit('paths', doc);
      return;
    }
    if (shapeOpts.mode === 'pixels') {
      const t = await editableTarget(doc, 'draw the shape');
      if (!t) return;
      const before = doc.captureState();
      const c = createCanvas(t.canvas.width, t.canvas.height);
      const x = ctx2d(c);
      x.translate(r.x - t.x, r.y - t.y);
      const path = new Path2D();
      traceShape(path, data);
      x.fillStyle = `rgb(${app.fg.r},${app.fg.g},${app.fg.b})`;
      x.strokeStyle = x.fillStyle;
      if (this.type === 'line') { x.lineWidth = shapeOpts.weight; x.stroke(path); } else x.fill(path);
      t.replace(paintOnto(doc, t, c, 1));
      doc.commit(this.name.replace(' Tool', ''), before);
      return;
    }
    const before = doc.captureState();
    const L = new Layer(doc.nextLayerName(shapeName(data)), 1, 1);
    L.kind = 'shape';
    L.shape = { ...data, pad: 0 };
    L.x = r.x; L.y = r.y;
    renderShapeLayer(L);
    doc.insertLayer(L);
    doc.commit(this.name.replace(' Tool', ''), before);
  }
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    if (!this.start || !this.cur || !v.doc) return;
    const r = this.type === 'line' ? rectFromPoints(this.start.x, this.start.y, this.lineEnd().x, this.lineEnd().y) : this.rect();
    const d = this.data(r);
    const z = v.doc.zoom;
    ctx.save();
    ctx.setTransform(z * v.dpr, 0, 0, z * v.dpr, (v.doc.panX + r.x * z) * v.dpr, (v.doc.panY + r.y * z) * v.dpr);
    const path = new Path2D();
    traceShape(path, d);
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = '#1473e6';
    if (this.type === 'line') { ctx.lineWidth = Math.max(1 / z, shapeOpts.weight); ctx.strokeStyle = 'rgba(20,115,230,.6)'; }
    ctx.stroke(path);
    ctx.restore();
  }
}

function shapeIcon(id: string) {
  const c = createCanvas(28, 28);
  const x = ctx2d(c);
  const p = new Path2D();
  traceShape(p, { type: 'custom', w: 24, h: 24, fill: null, stroke: null, strokeWidth: 0, custom: id });
  x.translate(2, 2);
  x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--icon') || '#ccc';
  x.fill(p);
  return c;
}

/** Convert a shape to an editable vector path (approximating curves). */
export function shapeToPath(s: ShapeData, ox: number, oy: number): VectorPath {
  const pts: { x: number; y: number }[] = [];
  const add = (x: number, y: number) => pts.push({ x: x + ox, y: y + oy });
  const { w, h: hh } = s;
  const K = 0.5522847498;
  if (s.type === 'ellipse') {
    const rx = w / 2, ry = hh / 2, cx = ox + rx, cy = oy + ry;
    const P = (x: number, y: number, ix: number, iy: number, oxx: number, oyy: number) => ({ x, y, ix, iy, ox: oxx, oy: oyy, smooth: true });
    return { id: Date.now(), name: 'Work Path', subpaths: [{ closed: true, points: [
      P(cx, cy - ry, cx - rx * K, cy - ry, cx + rx * K, cy - ry),
      P(cx + rx, cy, cx + rx, cy - ry * K, cx + rx, cy + ry * K),
      P(cx, cy + ry, cx + rx * K, cy + ry, cx - rx * K, cy + ry),
      P(cx - rx, cy, cx - rx, cy + ry * K, cx - rx, cy - ry * K),
    ] }] };
  }
  if (s.type === 'rect') { add(0, 0); add(w, 0); add(w, hh); add(0, hh); }
  else if (s.type === 'triangle') { add(w / 2, 0); add(w, hh); add(0, hh); }
  else if (s.type === 'line') { add(s.x1 ?? 0, s.y1 ?? 0); add(s.x2 ?? w, s.y2 ?? hh); }
  else if (s.type === 'polygon') {
    const n = Math.max(3, s.sides ?? 5), star = s.star ?? 0, total = star > 0 ? n * 2 : n;
    for (let i = 0; i < total; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / total, k = star > 0 && i % 2 ? 1 - star : 1;
      add(w / 2 + Math.cos(a) * (w / 2) * k, hh / 2 + Math.sin(a) * (hh / 2) * k);
    }
  } else {
    // custom: sample the SVG path outline
    add(0, 0); add(w, 0); add(w, hh); add(0, hh);
  }
  return { id: Date.now(), name: 'Work Path', subpaths: [{ closed: s.type !== 'line', points: pts.map((q) => pt(q.x, q.y)) }] };
}
