// Brush engine: tips, stroke spacing/dynamics, and buffered strokes with
// Photoshop semantics (flow accumulates within a stroke, opacity caps it).
import { Doc, Patch } from './document';
import { PixelTarget } from '../ops/target';
import { createCanvas, ctx2d, Rect, rectUnion, rectOut, rectIntersect, RGB, cssColor, tempCanvas, cloneCanvas } from './util';
import { NATIVE_BLEND } from './blend';
import { BlendMode } from './layer';

export type TipShape = 'round' | 'square' | 'chalk' | 'spatter' | 'dry' | 'star' | 'leaf' | 'grass';

export interface BrushOptions {
  size: number;
  hardness: number;      // 0..1
  opacity: number;       // 0..1
  flow: number;          // 0..1
  spacing: number;       // fraction of diameter
  angle: number;         // degrees
  roundness: number;     // 0..1
  tip: TipShape;
  sizePressure: boolean;
  opacityPressure: boolean;
  minSize: number;       // 0..1 with pressure
  sizeJitter: number;    // 0..1
  angleJitter: number;   // 0..1
  scatter: number;       // 0..? multiples of diameter
  count: number;
  opacityJitter: number; // 0..1
  smoothing: number;     // 0..1
  mode: BlendMode | 'behind' | 'clear';
  /** follow stroke direction */
  angleFollow?: boolean;
}

export const defaultBrush = (o: Partial<BrushOptions> = {}): BrushOptions => ({
  size: 30, hardness: 0, opacity: 1, flow: 1, spacing: 0.25, angle: 0, roundness: 1, tip: 'round',
  sizePressure: true, opacityPressure: false, minSize: 0, sizeJitter: 0, angleJitter: 0, scatter: 0, count: 1,
  opacityJitter: 0, smoothing: 0.1, mode: 'normal', ...o,
});

export interface BrushPreset { name: string; opts: Partial<BrushOptions> }
export const BRUSH_PRESETS: BrushPreset[] = [
  { name: 'Soft Round', opts: { tip: 'round', hardness: 0, size: 45, spacing: 0.25 } },
  { name: 'Hard Round', opts: { tip: 'round', hardness: 1, size: 30, spacing: 0.1 } },
  { name: 'Soft Round Pressure Opacity', opts: { tip: 'round', hardness: 0, size: 60, opacityPressure: true, sizePressure: false } },
  { name: 'Hard Round Pressure Size', opts: { tip: 'round', hardness: 0.95, size: 19, sizePressure: true, spacing: 0.08 } },
  { name: 'Airbrush Soft', opts: { tip: 'round', hardness: 0, size: 100, flow: 0.1, spacing: 0.08 } },
  { name: 'Hard Square', opts: { tip: 'square', hardness: 1, size: 24, spacing: 0.1 } },
  { name: 'Chalk', opts: { tip: 'chalk', size: 60, spacing: 0.15, angleJitter: 0.15 } },
  { name: 'Spatter', opts: { tip: 'spatter', size: 70, spacing: 0.4, angleJitter: 1, sizeJitter: 0.4, scatter: 0.3 } },
  { name: 'Dry Brush', opts: { tip: 'dry', size: 50, spacing: 0.05, angleFollow: true } },
  { name: 'Calligraphy', opts: { tip: 'round', hardness: 1, size: 28, roundness: 0.18, angle: 45, spacing: 0.04 } },
  { name: 'Star Scatter', opts: { tip: 'star', size: 40, spacing: 1.2, sizeJitter: 0.6, angleJitter: 1, scatter: 1.5, opacityJitter: 0.4 } },
  { name: 'Leaves', opts: { tip: 'leaf', size: 60, spacing: 0.9, sizeJitter: 0.5, angleJitter: 1, scatter: 1, opacityJitter: 0.3 } },
  { name: 'Grass', opts: { tip: 'grass', size: 80, spacing: 0.3, sizeJitter: 0.4, angleJitter: 0.08, scatter: 0.4 } },
];

// ---------- Tips ----------
const tipCache = new Map<string, HTMLCanvasElement>();
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

/** White alpha tip of the given diameter. Roundness squashes vertically. */
export function getTip(shape: TipShape, size: number, hardness: number, roundness: number, aliased = false): HTMLCanvasElement {
  const d = Math.max(1, Math.round(size));
  const key = `${shape}|${d}|${hardness.toFixed(2)}|${roundness.toFixed(2)}|${aliased}`;
  let c = tipCache.get(key);
  if (c) return c;
  c = createCanvas(d, d);
  const x = ctx2d(c);
  const r = d / 2;
  x.translate(r, r);
  x.scale(1, Math.max(0.01, roundness));
  x.translate(-r, -r);
  if (aliased) {
    x.fillStyle = '#fff';
    if (shape === 'square') x.fillRect(0, 0, d, d);
    else if (d <= 2) x.fillRect(0, 0, d, d);
    else {
      // pixel-exact circle
      x.setTransform(1, 0, 0, 1, 0, 0);
      const ry = r * roundness;
      for (let py = 0; py < d; py++) for (let px = 0; px < d; px++) {
        const dx = (px + 0.5 - r) / r, dy = (py + 0.5 - r) / Math.max(0.5, ry);
        if (dx * dx + dy * dy <= 1) x.fillRect(px, py, 1, 1);
      }
    }
  } else if (shape === 'round') {
    if (hardness >= 0.99 || d <= 2) {
      x.fillStyle = '#fff';
      x.beginPath(); x.arc(r, r, r, 0, Math.PI * 2); x.fill();
    } else {
      const g = x.createRadialGradient(r, r, 0, r, r, r);
      const h = hardness;
      // smooth falloff from the hard core to the edge (gaussian-ish like Photoshop)
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const p = h + (1 - h) * t;
        const a = Math.pow(1 - t, 1.8) * (1 - t * 0.15);
        g.addColorStop(Math.min(1, p), `rgba(255,255,255,${Math.max(0, Math.min(1, a))})`);
      }
      g.addColorStop(0, 'rgba(255,255,255,1)');
      x.fillStyle = g;
      x.fillRect(0, 0, d, d);
    }
  } else if (shape === 'square') {
    x.fillStyle = '#fff';
    x.fillRect(0, 0, d, d);
  } else {
    // sampled-style procedural tips, drawn at 128 and scaled
    const S = 128, src = createCanvas(S, S), sx = ctx2d(src), rnd = seeded(shape.length * 977 + 13);
    sx.fillStyle = '#fff'; sx.strokeStyle = '#fff';
    if (shape === 'chalk') {
      for (let i = 0; i < 900; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 60;
        sx.globalAlpha = 0.25 + rnd() * 0.6;
        sx.fillRect(64 + Math.cos(a) * rr, 64 + Math.sin(a) * rr * 0.8, 1 + rnd() * 3, 1 + rnd() * 3);
      }
    } else if (shape === 'spatter') {
      for (let i = 0; i < 40; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.7) * 56, s = 1 + rnd() * 9 * (1 - rr / 70);
        sx.globalAlpha = 0.6 + rnd() * 0.4;
        sx.beginPath(); sx.arc(64 + Math.cos(a) * rr, 64 + Math.sin(a) * rr, s, 0, Math.PI * 2); sx.fill();
      }
    } else if (shape === 'dry') {
      for (let i = 0; i < 46; i++) {
        const yy = 8 + rnd() * 112;
        sx.globalAlpha = 0.3 + rnd() * 0.7;
        sx.fillRect(40 + rnd() * 20, yy, 30 + rnd() * 28, 1 + rnd() * 2.5);
      }
    } else if (shape === 'star') {
      sx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? 26 : 62;
        sx.lineTo(64 + Math.cos(a) * rr, 64 + Math.sin(a) * rr);
      }
      sx.closePath(); sx.fill();
    } else if (shape === 'leaf') {
      sx.beginPath();
      sx.moveTo(64, 4); sx.quadraticCurveTo(122, 64, 64, 124); sx.quadraticCurveTo(6, 64, 64, 4); sx.fill();
      sx.globalCompositeOperation = 'destination-out'; sx.lineWidth = 3;
      sx.beginPath(); sx.moveTo(64, 14); sx.lineTo(64, 116); sx.stroke();
    } else if (shape === 'grass') {
      for (let i = 0; i < 9; i++) {
        const bx = 30 + rnd() * 68, lean = (rnd() - 0.5) * 50, w = 3 + rnd() * 5;
        sx.beginPath(); sx.moveTo(bx - w, 128); sx.quadraticCurveTo(bx + lean * 0.3, 60, bx + lean, 4 + rnd() * 30); sx.quadraticCurveTo(bx + lean * 0.3 + w * 0.5, 60, bx + w, 128); sx.fill();
      }
    }
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, d, d);
  }
  if (tipCache.size > 96) tipCache.delete(tipCache.keys().next().value!);
  tipCache.set(key, c);
  return c;
}

/** Brush tip preview for UI. */
export function tipPreview(o: Partial<BrushOptions>, w = 40, h = 32, color = '#ddd'): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const x = ctx2d(c);
  const s = Math.min(w, h) - 4;
  const t = getTip(o.tip ?? 'round', s, o.hardness ?? 1, o.roundness ?? 1);
  x.save();
  x.translate(w / 2, h / 2);
  x.rotate(((o.angle ?? 0) * Math.PI) / 180);
  x.drawImage(t, -s / 2, -s / 2);
  x.restore();
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, w, h);
  return c;
}

// ---------- Stroke path (spacing, smoothing, dynamics) ----------
export interface Dab { x: number; y: number; size: number; angle: number; alpha: number; pressure: number; dirX: number; dirY: number }

export class StrokePath {
  private lx = 0; private ly = 0; private lp = 1;
  private sx = 0; private sy = 0;
  private rx = 0; private ry = 0;
  private residual = 0;
  private started = false;
  private rnd = Math.random;
  constructor(private o: BrushOptions, private emit: (d: Dab) => void, private sizeScale = 1) {}

  start(x: number, y: number, p: number) {
    this.lx = this.sx = this.rx = x; this.ly = this.sy = this.ry = y; this.lp = p;
    this.started = true;
    this.residual = 0;
    this.dab(x, y, p, 1, 0);
  }
  move(x: number, y: number, p: number) {
    if (!this.started) return this.start(x, y, p);
    this.rx = x; this.ry = y;
    const s = this.o.smoothing;
    if (s > 0) {
      const k = 1 - Math.min(0.92, s * 0.92);
      this.sx += (x - this.sx) * k; this.sy += (y - this.sy) * k;
      this.segment(this.sx, this.sy, p);
    } else this.segment(x, y, p);
  }
  end() {
    if (!this.started) return;
    if (this.o.smoothing > 0) this.segment(this.rx, this.ry, this.lp);
    this.started = false;
  }
  /** Straight line (Shift+click) */
  lineTo(x: number, y: number, p: number) { this.segment(x, y, p); }
  private sizeAt(p: number) {
    const o = this.o;
    return o.size * this.sizeScale * (o.sizePressure ? o.minSize + (1 - o.minSize) * p : 1);
  }
  private segment(x: number, y: number, p: number) {
    const dx = x - this.lx, dy = y - this.ly;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return;
    let t = 0;
    let travelled = -this.residual;
    while (true) {
      const pp = this.lp + (p - this.lp) * Math.max(0, t);
      const step = Math.max(0.5, this.sizeAt(pp) * Math.max(0.01, this.o.spacing));
      travelled += step;
      if (travelled > dist) { this.residual = dist - (travelled - step); break; }
      t = travelled / dist;
      this.dab(this.lx + dx * t, this.ly + dy * t, this.lp + (p - this.lp) * t, dx / dist, dy / dist);
    }
    this.lx = x; this.ly = y; this.lp = p;
  }
  private dab(x: number, y: number, p: number, dirX: number, dirY: number) {
    const o = this.o;
    for (let n = 0; n < Math.max(1, o.count); n++) {
      let size = this.sizeAt(p);
      if (o.sizeJitter) size *= 1 - this.rnd() * o.sizeJitter;
      let angle = o.angle;
      if (o.angleFollow && (dirX || dirY)) angle += (Math.atan2(dirY, dirX) * 180) / Math.PI;
      if (o.angleJitter) angle += (this.rnd() - 0.5) * 360 * o.angleJitter;
      let px = x, py = y;
      if (o.scatter) {
        const off = (this.rnd() - 0.5) * 2 * o.scatter * size;
        px += -dirY * off + (o.count > 1 ? (this.rnd() - 0.5) * o.scatter * size : 0);
        py += dirX * off;
      }
      let alpha = o.flow * (o.opacityPressure ? p : 1);
      if (o.opacityJitter) alpha *= 1 - this.rnd() * o.opacityJitter;
      if (size < 0.5) continue;
      this.emit({ x: px, y: py, size, angle, alpha, pressure: p, dirX, dirY });
    }
  }
}

// ---------- Buffered paint stroke ----------
export type PaintSource =
  | { kind: 'color'; color: RGB }
  /** source pixel for target-canvas coord c is at (c.x + dx, c.y + dy) in `canvas` */
  | { kind: 'canvas'; canvas: HTMLCanvasElement; dx: number; dy: number };

export interface PaintStrokeOpts {
  mode: 'paint' | 'erase';
  source: PaintSource;
  opacity: number;
  blend?: BrushOptions['mode'];
  aliased?: boolean;
  /** For alpha targets (masks): gray level 0..1 to paint. */
  alphaValue?: number;
  /** Color painted by the eraser where transparency is locked (Background layer). */
  eraseColor?: RGB;
}

/**
 * Accumulates dabs in a coverage buffer and composites original + buffer into the target,
 * so overlapping dabs within one stroke never exceed the stroke opacity.
 */
export class PaintStroke {
  readonly original: HTMLCanvasElement;
  readonly coverage: HTMLCanvasElement;
  private cov: CanvasRenderingContext2D;
  private pending: Rect | null = null;
  total: Rect | null = null;
  readonly before: ReturnType<Doc['captureState']>;

  constructor(public doc: Doc, public t: PixelTarget, public o: PaintStrokeOpts) {
    this.before = doc.captureState();
    this.original = cloneCanvas(t.canvas);
    this.coverage = createCanvas(t.canvas.width, t.canvas.height);
    this.cov = ctx2d(this.coverage);
  }

  /** Dab in document coordinates. */
  dab(d: Dab, tip: HTMLCanvasElement) {
    const x = d.x - this.t.x, y = d.y - this.t.y;
    const s = d.size;
    const c = this.cov;
    c.save();
    c.globalAlpha = Math.max(0, Math.min(1, d.alpha));
    c.translate(x, y);
    if (d.angle) c.rotate((d.angle * Math.PI) / 180);
    if (this.o.aliased) {
      c.imageSmoothingEnabled = false;
      c.drawImage(tip, Math.round(-tip.width / 2), Math.round(-tip.height / 2));
    } else {
      c.drawImage(tip, -s / 2, -s / 2, s, s);
    }
    c.restore();
    const ext = s * 0.75 + 2;
    const r = rectOut({ x: x - ext, y: y - ext, w: ext * 2, h: ext * 2 });
    this.pending = rectUnion(this.pending, r);
  }

  /** Composite pending region into the target canvas. Returns the doc-space dirty rect. */
  flush(): Rect | null {
    if (!this.pending) return null;
    const full = { x: 0, y: 0, w: this.t.canvas.width, h: this.t.canvas.height };
    const r = rectIntersect(this.pending, full);
    this.pending = null;
    if (!r) return null;
    this.total = rectUnion(this.total, r);
    this.composite(r);
    return { x: r.x + this.t.x, y: r.y + this.t.y, w: r.w, h: r.h };
  }

  private composite(r: Rect) {
    const { t, o, doc } = this;
    const tx = ctx2d(t.canvas);
    // Paint = source masked by coverage and selection
    const p = tempCanvas('stroke-src', r.w, r.h);
    const px = ctx2d(p);
    if (o.source.kind === 'color') {
      px.fillStyle = t.alphaOnly ? '#000' : cssColor(o.source.color);
      px.fillRect(0, 0, r.w, r.h);
    } else {
      px.drawImage(o.source.canvas, -(r.x + o.source.dx), -(r.y + o.source.dy));
    }
    px.globalCompositeOperation = 'destination-in';
    px.drawImage(this.coverage, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    if (doc.selection && t.kind !== 'quickmask') px.drawImage(doc.selection, -t.x - r.x, -t.y - r.y);
    px.globalCompositeOperation = 'source-over';

    // restore the original pixels of this rect (not 'copy': that would clear outside the rect)
    tx.save();
    tx.setTransform(1, 0, 0, 1, 0, 0);
    tx.globalAlpha = 1;
    tx.globalCompositeOperation = 'source-over';
    tx.clearRect(r.x, r.y, r.w, r.h);
    tx.drawImage(this.original, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    tx.restore();
    tx.save();
    tx.beginPath(); tx.rect(r.x, r.y, r.w, r.h); tx.clip();
    if (t.alphaOnly) {
      // new = old*(1-a) + v*a
      const v = o.mode === 'erase' ? 0 : o.alphaValue ?? 1;
      tx.globalAlpha = o.opacity;
      tx.globalCompositeOperation = 'destination-out';
      tx.drawImage(p, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
      if (v > 0) {
        tx.globalAlpha = o.opacity * v;
        tx.globalCompositeOperation = 'lighter';
        tx.drawImage(p, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
      }
    } else if (o.mode === 'erase') {
      tx.globalAlpha = o.opacity;
      tx.globalCompositeOperation = t.lockAlpha ? 'source-atop' : 'destination-out';
      if (t.lockAlpha) { // erasing with locked transparency paints background color
        px.globalCompositeOperation = 'source-in'; px.fillStyle = cssColor(o.eraseColor ?? { r: 255, g: 255, b: 255 }); px.fillRect(0, 0, r.w, r.h);
      }
      tx.drawImage(p, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
    } else {
      tx.globalAlpha = o.opacity;
      const m = o.blend ?? 'normal';
      tx.globalCompositeOperation = t.lockAlpha ? 'source-atop'
        : m === 'behind' ? 'destination-over' : m === 'clear' ? 'destination-out' : (NATIVE_BLEND[m as BlendMode] ?? 'source-over');
      tx.drawImage(p, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
    }
    tx.restore();
    t.layer?.touch();
  }

  /** Commit the stroke as one history step. */
  finish(name: string) {
    this.flush();
    if (!this.total) return;
    const r = this.total;
    const patch: Patch = {
      canvas: this.t.canvas, x: r.x, y: r.y,
      before: ctx2d(this.original).getImageData(r.x, r.y, r.w, r.h),
      after: ctx2d(this.t.canvas).getImageData(r.x, r.y, r.w, r.h),
    };
    if (this.t.kind === 'quickmask') {
      // quick mask edits the selection canvas: re-set to refresh outline
      this.doc.setSelection(this.t.canvas);
    }
    this.doc.commit(name, this.before, [patch]);
  }
  cancel() {
    ctx2d(this.t.canvas).globalCompositeOperation = 'copy';
    ctx2d(this.t.canvas).drawImage(this.original, 0, 0);
    ctx2d(this.t.canvas).globalCompositeOperation = 'source-over';
    this.t.layer?.touch();
    this.doc.invalidate();
  }
}

/**
 * Stroke that edits target pixels directly per dab (smudge, blur, dodge...).
 * `modify` receives the region's ImageData and the tip weights (0..1 per pixel) and edits in place.
 */
export class DirectStroke {
  readonly original: HTMLCanvasElement;
  total: Rect | null = null;
  private before: ReturnType<Doc['captureState']>;
  constructor(public doc: Doc, public t: PixelTarget) {
    this.before = doc.captureState();
    this.original = cloneCanvas(t.canvas);
  }
  dab(d: Dab, tip: HTMLCanvasElement, modify: (img: ImageData, w: Float32Array, r: Rect) => void): Rect | null {
    const s = Math.max(1, d.size);
    const x = d.x - this.t.x, y = d.y - this.t.y;
    const full = { x: 0, y: 0, w: this.t.canvas.width, h: this.t.canvas.height };
    const r = rectIntersect(rectOut({ x: x - s / 2 - 1, y: y - s / 2 - 1, w: s + 2, h: s + 2 }), full);
    if (!r) return null;
    // weights = tip * flow * selection
    const wc = tempCanvas('direct-w', r.w, r.h);
    const wx = ctx2d(wc);
    wx.save();
    wx.translate(x - r.x, y - r.y);
    if (d.angle) wx.rotate((d.angle * Math.PI) / 180);
    wx.drawImage(tip, -s / 2, -s / 2, s, s);
    wx.restore();
    if (this.doc.selection && this.t.kind !== 'quickmask') {
      wx.globalCompositeOperation = 'destination-in';
      wx.drawImage(this.doc.selection, -this.t.x - r.x, -this.t.y - r.y);
      wx.globalCompositeOperation = 'source-over';
    }
    const wd = wx.getImageData(0, 0, r.w, r.h).data;
    const w = new Float32Array(r.w * r.h);
    const a = Math.max(0, Math.min(1, d.alpha));
    for (let i = 0; i < w.length; i++) w[i] = (wd[i * 4 + 3] / 255) * a;
    const tx = ctx2d(this.t.canvas);
    const img = tx.getImageData(r.x, r.y, r.w, r.h);
    const lockA = this.t.lockAlpha;
    const alphaBefore = lockA ? new Uint8ClampedArray(img.data) : null;
    modify(img, w, r);
    if (alphaBefore) for (let i = 3; i < img.data.length; i += 4) img.data[i] = alphaBefore[i];
    tx.putImageData(img, r.x, r.y);
    this.total = rectUnion(this.total, r);
    this.t.layer?.touch();
    return { x: r.x + this.t.x, y: r.y + this.t.y, w: r.w, h: r.h };
  }
  finish(name: string) {
    if (!this.total) return;
    const r = this.total;
    const patch: Patch = {
      canvas: this.t.canvas, x: r.x, y: r.y,
      before: ctx2d(this.original).getImageData(r.x, r.y, r.w, r.h),
      after: ctx2d(this.t.canvas).getImageData(r.x, r.y, r.w, r.h),
    };
    if (this.t.kind === 'quickmask') this.doc.setSelection(this.t.canvas);
    this.doc.commit(name, this.before, [patch]);
  }
}
