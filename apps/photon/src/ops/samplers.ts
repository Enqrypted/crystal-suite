// Color Sampler readouts: markers on the canvas and the colors under them (Info panel).
import { Doc } from '../core/document';
import { ctx2d } from '../core/util';

export const MAX_SAMPLERS = 10;
/** Sample size of the Color Sampler tool (1 = point, 3 / 5 / 11 = average). */
export const samplerSettings = { size: 1 };

/** Sampler markers, drawn with every tool like Photoshop does. `toScreen` maps doc to canvas CSS pixels. */
export function drawSamplers(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }, d: Doc) {
  if (!d.samplers.length) return;
  ctx.save();
  ctx.font = '600 10px "Segoe UI", sans-serif';
  d.samplers.forEach((s, i) => {
    const q = toScreen(s.x + 0.5, s.y + 0.5);
    for (const [color, w] of [['#000', 3], ['#fff', 1]] as const) {
      ctx.strokeStyle = color; ctx.lineWidth = w;
      ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2);
      ctx.moveTo(q.x - 9, q.y); ctx.lineTo(q.x - 5, q.y); ctx.moveTo(q.x + 5, q.y); ctx.lineTo(q.x + 9, q.y);
      ctx.moveTo(q.x, q.y - 9); ctx.lineTo(q.x, q.y - 5); ctx.moveTo(q.x, q.y + 5); ctx.lineTo(q.x, q.y + 9);
      ctx.stroke();
    }
    ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff';
    ctx.strokeText(String(i + 1), q.x + 7, q.y + 15);
    ctx.fillText(String(i + 1), q.x + 7, q.y + 15);
  });
  ctx.restore();
}

/** Average color of the composite around a sampler. */
export function samplerColor(d: Doc, s: { x: number; y: number }): [number, number, number] | null {
  const r = (samplerSettings.size - 1) / 2;
  const x0 = Math.max(0, s.x - r), y0 = Math.max(0, s.y - r), x1 = Math.min(d.width - 1, s.x + r), y1 = Math.min(d.height - 1, s.y + r);
  if (x1 < x0 || y1 < y0) return null;
  const px = ctx2d(d.composite).getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) { R += px[i]; G += px[i + 1]; B += px[i + 2]; n++; }
  return n ? [Math.round(R / n), Math.round(G / n), Math.round(B / n)] : null;
}
