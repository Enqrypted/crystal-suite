// Draws one frame of the project at time t. Used by both the preview and the renderer, so what you see
// is what you get. Video tracks composite bottom-up (the top track is in front, like Vegas); clips that
// overlap on a track play their transition; fades and opacity reveal the tracks below (or black).
import {
  audibleTrack, clipEnd, clipsOnTrack, fadeLevel, lerpPanCrop, mediaOf, sourceTime,
  type Clip, type Fx, type Overlaps, type Project, type TextProps,
} from './model';
import type { Drawable } from './frames';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type FrameLookup = (clip: Clip, sourceTime: number) => Drawable | null;

export interface Layer {
  clip: Clip;
  alpha: number;
  /** Transition role when two clips overlap on the track. */
  role: 'single' | 'from' | 'to';
  progress: number; // transition progress 0..1
}

/** The visible clips of each video track at time t, bottom track first. */
export function layersAt(p: Project, t: number, overlaps: Map<string, Overlaps>): Layer[][] {
  const out: Layer[][] = [];
  const tracks = p.tracks.filter((tr) => tr.kind === 'video');
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i];
    if (!audibleTrack(p, tr) || tr.volume <= 0) continue;
    const here = clipsOnTrack(p, tr.id).filter((c) => !c.mute && t >= c.start && t < clipEnd(c));
    if (!here.length) continue;
    const layers: Layer[] = [];
    if (here.length >= 2) {
      // the latest two: a transition from the earlier into the later one
      const a = here[here.length - 2];
      const b = here[here.length - 1];
      const ov = overlaps.get(b.id)?.before || Math.max(1e-6, clipEnd(a) - b.start);
      const progress = Math.max(0, Math.min(1, (t - b.start) / ov));
      layers.push({ clip: a, alpha: own(a, t, overlaps) * tr.volume, role: 'from', progress });
      layers.push({ clip: b, alpha: own(b, t, overlaps) * tr.volume, role: 'to', progress });
    } else {
      layers.push({ clip: here[0], alpha: own(here[0], t, overlaps) * tr.volume, role: 'single', progress: 0 });
    }
    out.push(layers);
  }
  return out;
}

/** A clip's own opacity at t: its level times its fades (overlaps are transitions, not fades). */
function own(c: Clip, t: number, overlaps: Map<string, Overlaps>) {
  const o = overlaps.get(c.id);
  const fadeIn = o?.before ? 0 : c.fadeIn;
  const fadeOut = o?.after ? 0 : c.fadeOut;
  return c.gain * fadeLevel(c, t, fadeIn, fadeOut);
}

export function fxFilter(fx: Fx, scale: number) {
  const f: string[] = [];
  if (fx.brightness !== 1) f.push(`brightness(${fx.brightness})`);
  if (fx.contrast !== 1) f.push(`contrast(${fx.contrast})`);
  if (fx.saturation !== 1) f.push(`saturate(${fx.saturation})`);
  if (fx.hue) f.push(`hue-rotate(${fx.hue}deg)`);
  if (fx.blur > 0) f.push(`blur(${(fx.blur * scale).toFixed(2)}px)`);
  if (fx.grayscale > 0) f.push(`grayscale(${fx.grayscale})`);
  if (fx.sepia > 0) f.push(`sepia(${fx.sepia})`);
  if (fx.invert > 0) f.push(`invert(${fx.invert})`);
  return f.length ? f.join(' ') : 'none';
}

const sizeOf = (d: Drawable) => ('displayWidth' in d ? { w: d.displayWidth, h: d.displayHeight } : { w: d.width, h: d.height });

/** Draws the clip's picture (media or generator) into a W×H frame at time t. */
function drawContent(ctx: Ctx, p: Project, clip: Clip, t: number, W: number, H: number, frame: Drawable | null) {
  const k = clip.length > 0 ? Math.max(0, Math.min(1, (t - clip.start) / clip.length)) : 0;
  const pc = lerpPanCrop(clip.panCrop, clip.panCropEnd, k);
  if (clip.generator === 'solid') { ctx.fillStyle = clip.color || '#000'; ctx.fillRect(0, 0, W, H); return; }
  if (clip.generator === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, clip.color || '#2b1a6e');
    g.addColorStop(1, clip.color2 || '#d4628f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (clip.generator === 'text') { drawText(ctx, clip.text!, W, H, pc); return; }
  if (!frame) return;
  const { w: mw, h: mh } = sizeOf(frame);
  const sx = pc.cropLeft * mw;
  const sy = pc.cropTop * mh;
  const sw = Math.max(1, mw * (1 - pc.cropLeft - pc.cropRight));
  const sh = Math.max(1, mh * (1 - pc.cropTop - pc.cropBottom));
  const fit = Math.min(W / sw, H / sh) * pc.scale; // letterbox: keep the aspect ratio
  const dw = sw * fit;
  const dh = sh * fit;
  ctx.save();
  ctx.translate(W / 2 + pc.x * W, H / 2 + pc.y * H);
  if (pc.rotation) ctx.rotate((pc.rotation * Math.PI) / 180);
  if ('displayWidth' in frame) frame.draw(ctx, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  else ctx.drawImage(frame, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function drawText(ctx: Ctx, tp: TextProps, W: number, H: number, pc: { x: number; y: number; scale: number; rotation: number }) {
  const size = Math.max(4, tp.size * H * pc.scale);
  ctx.save();
  ctx.font = `${tp.italic ? 'italic ' : ''}${tp.bold ? '700 ' : '400 '}${size}px "${tp.font}", "Segoe UI", sans-serif`;
  ctx.textAlign = tp.align;
  ctx.textBaseline = 'middle';
  const lines = tp.text.split('\n');
  const lh = size * 1.2;
  const x = (tp.x + pc.x) * W;
  const y = (tp.y + pc.y) * H;
  ctx.translate(x, y);
  if (pc.rotation) ctx.rotate((pc.rotation * Math.PI) / 180);
  const top = -((lines.length - 1) * lh) / 2;
  if (tp.box) {
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 0.8;
    const h = lines.length * lh + size * 0.4;
    const bx = tp.align === 'left' ? -size * 0.4 : tp.align === 'right' ? -w + size * 0.4 : -w / 2;
    ctx.fillStyle = tp.boxColor;
    ctx.beginPath();
    ctx.roundRect(bx, top - lh / 2 - size * 0.2, w, h, size * 0.15);
    ctx.fill();
  }
  if (tp.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = size * 0.12; ctx.shadowOffsetY = size * 0.04; }
  lines.forEach((line, i) => {
    const ly = top + i * lh;
    if (tp.outline > 0) {
      ctx.lineWidth = tp.outline * size;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = tp.outlineColor;
      ctx.strokeText(line, 0, ly);
    }
    ctx.fillStyle = tp.color;
    ctx.fillText(line, 0, ly);
  });
  ctx.restore();
}

/** Draws a clip with its opacity, effects and (for the incoming clip) its transition. */
function drawLayer(ctx: Ctx, p: Project, l: Layer, t: number, W: number, H: number, frame: Drawable | null) {
  let alpha = l.alpha;
  const pr = l.progress;
  ctx.save();
  if (l.role === 'to') {
    switch (l.clip.transition) {
      case 'dip': alpha *= Math.max(0, pr * 2 - 1); break;
      case 'wipe-left': ctx.beginPath(); ctx.rect(W * (1 - pr), 0, W * pr, H); ctx.clip(); break;
      case 'wipe-right': ctx.beginPath(); ctx.rect(0, 0, W * pr, H); ctx.clip(); break;
      case 'slide-left': ctx.translate(W * (1 - pr), 0); break;
      case 'push-up': ctx.translate(0, H * (1 - pr)); break;
      default: alpha *= pr; // crossfade
    }
  }
  if (alpha > 0.001) {
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.filter = fxFilter(l.clip.fx, H / 1080);
    drawContent(ctx, p, l.clip, t, W, H, frame);
  }
  ctx.restore();
}

/** How the outgoing clip moves or fades for the incoming clip's transition. */
function outgoing(layers: Layer[], H: number): { alphaK: number; shiftY: number } {
  const to = layers.find((l) => l.role === 'to');
  if (!to) return { alphaK: 1, shiftY: 0 };
  if (to.clip.transition === 'dip') return { alphaK: Math.max(0, 1 - to.progress * 2), shiftY: 0 };
  if (to.clip.transition === 'push-up') return { alphaK: 1, shiftY: -H * to.progress };
  return { alphaK: 1, shiftY: 0 };
}

export function drawFrame(ctx: Ctx, p: Project, t: number, W: number, H: number, overlaps: Map<string, Overlaps>, lookup: FrameLookup) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  for (const layers of layersAt(p, t, overlaps)) {
    const out = outgoing(layers, H);
    for (const l of layers) {
      const frame = l.clip.generator ? null : lookup(l.clip, sourceTime(l.clip, t));
      if (l.role === 'from' && (out.alphaK !== 1 || out.shiftY)) {
        ctx.save();
        ctx.translate(0, out.shiftY);
        drawLayer(ctx, p, { ...l, alpha: l.alpha * out.alphaK }, t, W, H, frame);
        ctx.restore();
      } else drawLayer(ctx, p, l, t, W, H, frame);
    }
  }
  ctx.restore();
}

/** Clips whose pictures are needed at t (for fetching frames before drawing). */
export function visualClipsAt(p: Project, t: number, overlaps: Map<string, Overlaps>) {
  return layersAt(p, t, overlaps).flat().map((l) => l.clip).filter((c) => !c.generator && mediaOf(p, c));
}
