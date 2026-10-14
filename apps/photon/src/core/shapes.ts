import { Layer, ShapeData } from './layer';
import { createCanvas, ctx2d, cssColor } from './util';

export const CUSTOM_SHAPES: Record<string, { name: string; path: string }> = {
  heart: { name: 'Heart', path: 'M50 88 C20 66 4 48 4 30 A22 22 0 0 1 50 18 A22 22 0 0 1 96 30 C96 48 80 66 50 88 Z' },
  star: { name: 'Star', path: 'M50 4 L61 38 L97 38 L68 59 L79 94 L50 72 L21 94 L32 59 L3 38 L39 38 Z' },
  arrow: { name: 'Arrow', path: 'M4 38 L58 38 L58 14 L96 50 L58 86 L58 62 L4 62 Z' },
  bubble: { name: 'Speech Bubble', path: 'M10 8 H90 A8 8 0 0 1 98 16 V62 A8 8 0 0 1 90 70 H40 L18 92 L22 70 H10 A8 8 0 0 1 2 62 V16 A8 8 0 0 1 10 8 Z' },
  check: { name: 'Checkmark', path: 'M6 52 L20 38 L40 58 L80 14 L94 28 L40 86 Z' },
  bolt: { name: 'Lightning', path: 'M58 2 L14 58 H46 L38 98 L86 38 H54 Z' },
  cross: { name: 'Cross', path: 'M36 4 H64 V36 H96 V64 H64 V96 H36 V64 H4 V36 H36 Z' },
  burst: { name: 'Burst', path: 'M50 2 L58 30 L84 14 L70 42 L98 50 L70 58 L84 86 L58 70 L50 98 L42 70 L16 86 L30 58 L2 50 L30 42 L16 14 L42 30 Z' },
  moon: { name: 'Crescent', path: 'M62 6 A46 46 0 1 0 94 70 A38 38 0 1 1 62 6 Z' },
  drop: { name: 'Drop', path: 'M50 4 C50 4 16 46 16 64 A34 34 0 0 0 84 64 C84 46 50 4 50 4 Z' },
  puzzle: { name: 'Puzzle', path: 'M8 22 H38 A12 12 0 1 1 62 22 H92 V52 A12 12 0 1 0 92 76 V96 H8 Z' },
  cloud: { name: 'Cloud', path: 'M26 80 A20 20 0 0 1 22 40 A26 26 0 0 1 72 30 A22 22 0 0 1 80 80 Z' },
};

/** Trace the shape outline into a path in a w×h box at (0,0). */
export function traceShape(ctx: Path2D, s: ShapeData) {
  const { w, h } = s;
  switch (s.type) {
    case 'rect': {
      const r = Math.min(s.radius ?? 0, w / 2, h / 2);
      if (r > 0) ctx.roundRect(0, 0, w, h, r); else ctx.rect(0, 0, w, h);
      break;
    }
    case 'ellipse': ctx.ellipse(w / 2, h / 2, Math.max(0.1, w / 2), Math.max(0.1, h / 2), 0, 0, Math.PI * 2); break;
    case 'triangle': ctx.moveTo(w / 2, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); break;
    case 'polygon': {
      const n = Math.max(3, s.sides ?? 5), star = s.star ?? 0;
      const pts = star > 0 ? n * 2 : n;
      for (let i = 0; i < pts; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / pts;
        const k = star > 0 && i % 2 ? 1 - star : 1;
        const px = w / 2 + Math.cos(a) * (w / 2) * k, py = h / 2 + Math.sin(a) * (h / 2) * k;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'line': ctx.moveTo(s.x1 ?? 0, s.y1 ?? 0); ctx.lineTo(s.x2 ?? w, s.y2 ?? h); break;
    case 'custom': {
      const p = new Path2D(CUSTOM_SHAPES[s.custom ?? 'heart']?.path ?? CUSTOM_SHAPES.heart.path);
      const m = new DOMMatrix().scale(w / 100, h / 100);
      const p2 = new Path2D();
      p2.addPath(p, m);
      ctx.addPath(p2);
      break;
    }
  }
}

/** Render a shape layer to a fresh canvas, keeping the shape box anchored. */
export function renderShapeLayer(L: Layer) {
  const s = L.shape;
  if (!s) return;
  const sw = s.stroke ? s.strokeWidth : 0;
  const pad = Math.ceil(sw / 2 + 2 + (s.type === 'line' ? sw : 0));
  const anchorX = L.x + (s.pad ?? pad), anchorY = L.y + (s.pad ?? pad);
  const c = createCanvas(Math.max(1, Math.abs(s.w)) + pad * 2, Math.max(1, Math.abs(s.h)) + pad * 2);
  const x = ctx2d(c);
  x.translate(pad, pad);
  const path = new Path2D();
  traceShape(path, s);
  if (s.type === 'line') {
    x.lineCap = 'butt';
    x.strokeStyle = cssColor(s.stroke ?? s.fill ?? { r: 0, g: 0, b: 0 });
    x.lineWidth = Math.max(1, s.strokeWidth || 1);
    x.stroke(path);
  } else {
    if (s.fill) { x.fillStyle = cssColor(s.fill); x.fill(path); }
    if (s.stroke && sw > 0) { x.strokeStyle = cssColor(s.stroke); x.lineWidth = sw; x.lineJoin = 'miter'; x.stroke(path); }
  }
  L.canvas = c;
  L.x = anchorX - pad;
  L.y = anchorY - pad;
  L.shape = { ...s, pad };
  L.touch();
}

export function shapeName(s: ShapeData) {
  return { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon', line: 'Line', custom: CUSTOM_SHAPES[s.custom ?? 'heart']?.name ?? 'Shape' }[s.type];
}
