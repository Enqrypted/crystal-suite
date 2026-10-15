// Frosted glass without a live backdrop blur: the desktop layer redraws the wallpaper the way Windows
// shows it on this display (fill, fit, stretch, center, tile or span), blurs it once at low resolution and
// uses it as the background of every glass surface, lined up with the screen. Cheap and identical to a
// real blur of the wallpaper underneath.
import type { Wall } from '../../shared/types';
import { api } from './api';

const SCALE = 0.25; // the blurred copy is a quarter of the screen resolution
let current = '';
let objectUrl = '';

export async function applyWall(wall: Wall | null) {
  if (!wall) return;
  const key = JSON.stringify([wall.stamp, wall.position, wall.bg, wall.monitor, wall.work, wall.virtual]);
  if (key === current) return;
  current = key;
  let img: ImageBitmap | null = null;
  if (wall.image) {
    try {
      const bytes = await api.readWall();
      if (bytes) img = await createImageBitmap(new Blob([bytes as BlobPart]));
    } catch { img = null; }
  }
  if (key !== current) return; // a newer wallpaper arrived meanwhile
  const blob = await render(wall, img);
  img?.close();
  if (key !== current) return;
  const url = URL.createObjectURL(blob);
  document.documentElement.style.setProperty('--wall', `url("${url}")`);
  if (objectUrl) setTimeout((u: string) => URL.revokeObjectURL(u), 2000, objectUrl);
  objectUrl = url;
}

async function render(wall: Wall, img: ImageBitmap | null): Promise<Blob> {
  const w = Math.max(8, Math.round(wall.work.w * SCALE));
  const h = Math.max(8, Math.round(wall.work.h * SCALE));
  const pad = 24; // drawn past the edges so the blur doesn't darken them
  const src = new OffscreenCanvas(w + pad * 2, h + pad * 2);
  const x = src.getContext('2d')!;
  x.fillStyle = wall.bg || '#000';
  x.fillRect(0, 0, src.width, src.height);
  if (img) {
    x.imageSmoothingQuality = 'high';
    // work in the monitor's physical pixels, with the work area's top-left at (pad, pad)
    x.setTransform(SCALE, 0, 0, SCALE, pad - wall.work.x * SCALE, pad - wall.work.y * SCALE);
    paint(x, img, wall);
    x.setTransform(1, 0, 0, 1, 0, 0);
    // extend the edge pixels into the padding (a cheap clamp for the blur)
    const inner = x.getImageData(pad, pad, w, h);
    const tmp = new OffscreenCanvas(w, h);
    tmp.getContext('2d')!.putImageData(inner, 0, 0);
    x.drawImage(tmp, 0, 0, src.width, src.height);
    x.drawImage(tmp, pad, pad);
  }
  const out = new OffscreenCanvas(w, h);
  const o = out.getContext('2d')!;
  o.filter = 'blur(9px) saturate(1.6)';
  o.drawImage(src, -pad, -pad);
  return out.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

/** Draws the wallpaper in monitor coordinates (physical pixels), like Windows does. */
function paint(x: OffscreenCanvasRenderingContext2D, img: ImageBitmap, wall: Wall) {
  const mw = wall.monitor.w, mh = wall.monitor.h, iw = img.width, ih = img.height;
  switch (wall.position) {
    case 0: // center: actual size
      x.drawImage(img, (mw - iw) / 2, (mh - ih) / 2);
      break;
    case 1: // tile
      for (let ty = 0; ty < mh; ty += ih) for (let tx = 0; tx < mw; tx += iw) x.drawImage(img, tx, ty);
      break;
    case 2: // stretch
      x.drawImage(img, 0, 0, mw, mh);
      break;
    case 3: { // fit
      const k = Math.min(mw / iw, mh / ih);
      x.drawImage(img, (mw - iw * k) / 2, (mh - ih * k) / 2, iw * k, ih * k);
      break;
    }
    case 5: { // span: one picture across all displays
      const v = wall.virtual;
      const k = Math.max(v.w / iw, v.h / ih);
      x.drawImage(img, v.x - wall.monitor.x + (v.w - iw * k) / 2, v.y - wall.monitor.y + (v.h - ih * k) / 2, iw * k, ih * k);
      break;
    }
    default: { // fill
      const k = Math.max(mw / iw, mh / ih);
      x.drawImage(img, (mw - iw * k) / 2, (mh - ih * k) / 2, iw * k, ih * k);
    }
  }
}

/** Lines a glass element's background up with the screen (call after it moves). */
export function alignGlass(el: HTMLElement) {
  let x = 0, y = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) { x += e.offsetLeft; y += e.offsetTop; }
  el.style.setProperty('--gx', `${-x}px`);
  el.style.setProperty('--gy', `${-y}px`);
}
