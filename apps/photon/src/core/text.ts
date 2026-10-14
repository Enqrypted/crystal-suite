import { Layer, TextData } from './layer';
import { createCanvas, ctx2d, cssColor } from './util';

export const FONT_FAMILIES = [
  'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia',
  'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Ink Free', 'Lucida Console',
  'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Sitka Text', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
];
export const FONT_STYLES = ['Regular', 'Italic', 'Bold', 'Bold Italic'];

export function defaultText(o: Partial<TextData> = {}): TextData {
  return {
    text: '', font: 'Arial', style: 'Regular', size: 48, color: { r: 0, g: 0, b: 0 },
    align: 'left', leading: 1.2, tracking: 0, antialias: true, ...o,
  };
}

export function cssFont(t: TextData, scale = 1) {
  const bold = /Bold/.test(t.style) || t.fauxBold ? '700' : '400';
  const italic = /Italic/.test(t.style) || t.fauxItalic ? 'italic' : 'normal';
  const fam = /[\s]/.test(t.font) && !/^["']/.test(t.font) ? `"${t.font}"` : t.font;
  return `${italic} ${bold} ${t.size * scale}px ${fam}, sans-serif`;
}

/** Split into lines, wrapping to boxWidth for paragraph text. */
export function layoutLines(ctx: CanvasRenderingContext2D, t: TextData): string[] {
  const raw = (t.allCaps ? t.text.toUpperCase() : t.text).split('\n');
  if (!t.boxWidth) return raw;
  const out: string[] = [];
  for (const para of raw) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && ctx.measureText(test).width > t.boxWidth) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

/** Render the text layer into a fresh canvas, keeping its anchor (top-left of text box) fixed. */
export function renderTextLayer(L: Layer) {
  const t = L.text;
  if (!t) return;
  const measure = ctx2d(createCanvas(1, 1));
  measure.font = cssFont(t);
  (measure as any).letterSpacing = `${(t.tracking / 1000) * t.size}px`;
  const lines = layoutLines(measure, t);
  const lh = t.size * t.leading;
  const widths = lines.map((l) => measure.measureText(l || ' ').width);
  const boxW = t.boxWidth ?? Math.max(1, ...widths);
  const boxH = Math.max(lh, lines.length * lh);
  const pad = Math.ceil(t.size * 0.6) + 4;
  const anchorX = L.x + (t.pad ?? pad), anchorY = L.y + (t.pad ?? pad);
  const c = createCanvas(boxW + pad * 2, boxH + pad * 2);
  const x = ctx2d(c);
  x.font = cssFont(t);
  (x as any).letterSpacing = `${(t.tracking / 1000) * t.size}px`;
  x.fillStyle = cssColor(t.color);
  x.textBaseline = 'alphabetic';
  const m = x.measureText('Hg');
  const fa = m.fontBoundingBoxAscent ?? t.size * 0.8, fd = m.fontBoundingBoxDescent ?? t.size * 0.2;
  lines.forEach((line, i) => {
    const w = widths[i];
    const lx = pad + (t.align === 'center' ? (boxW - w) / 2 : t.align === 'right' ? boxW - w : 0);
    const by = pad + i * lh + (lh - (fa + fd)) / 2 + fa;
    x.fillText(line, lx, by);
    if (t.fauxBold && !/Bold/.test(t.style)) { x.strokeStyle = x.fillStyle as string; x.lineWidth = t.size / 30; x.strokeText(line, lx, by); }
    if (t.underline || t.strike) {
      const th = Math.max(1, t.size / 16);
      const uy = t.underline ? by + th * 1.5 : by - fa * 0.32;
      x.fillRect(lx, uy, w, th);
    }
  });
  L.canvas = c;
  L.x = anchorX - pad;
  L.y = anchorY - pad;
  L.text = { ...t, pad };
  L.touch();
}

export function textLayerName(t: TextData) {
  const s = t.text.replace(/\s+/g, ' ').trim();
  return s ? (s.length > 30 ? s.slice(0, 30) : s) : 'Text';
}
