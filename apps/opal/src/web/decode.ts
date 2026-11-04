// Loads a photo for the viewer. Chromium decodes JPEG, PNG, GIF, WebP, AVIF, BMP, ICO and SVG itself (colour
// managed, EXIF orientation applied, animations playing); HEIC/HEIF goes to libheif, which first shows the
// small preview inside the file, then the full photo. A few photos around the current one stay decoded so
// stepping through a folder is instant.
import { decodeHeif } from './heif';
import { extOf, isHeif, native, type PhotoEntry } from './native';

export interface Photo {
  path: string;
  /** What the viewer shows: an <img> (Chromium formats) or a <canvas> (HEIC). */
  el: HTMLImageElement | HTMLCanvasElement;
  /** Size as shown (after EXIF orientation / HEIF rotation). */
  width: number;
  height: number;
  format: string;
  /** Colour profile name, when Opal knows it (HEIC). */
  profile: string;
  /** EXIF as TIFF data (HEIC; for other formats it's read from `bytes`). */
  exif: Uint8Array | null;
  bytes: Uint8Array;
  hasAlpha: boolean;
  /** Only the embedded preview is decoded so far (the full photo is on its way). */
  preview: boolean;
  dispose(): void;
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png', apng: 'image/apng',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', dib: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};
const FORMAT: Record<string, string> = {
  jpg: 'JPEG', jpeg: 'JPEG', jfif: 'JPEG', jpe: 'JPEG', png: 'PNG', apng: 'PNG', gif: 'GIF', webp: 'WebP', avif: 'AVIF',
  bmp: 'BMP', dib: 'BMP', ico: 'ICO', svg: 'SVG', heic: 'HEIC', heif: 'HEIF', hif: 'HEIF',
};
export const formatOf = (p: string) => FORMAT[extOf(p)] || extOf(p).toUpperCase();

export class DecodeError extends Error {}

function canvasFrom(r: { width: number; height: number; data: ArrayBuffer; colorSpace: PredefinedColorSpace }) {
  const c = document.createElement('canvas');
  c.width = r.width;
  c.height = r.height;
  const x = c.getContext('2d', { colorSpace: r.colorSpace })!;
  x.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height, { colorSpace: r.colorSpace }), 0, 0);
  return c;
}

async function loadHeif(path: string, bytes: Uint8Array, onPreview?: (p: Photo) => void): Promise<Photo> {
  let previewCanvas: HTMLCanvasElement | null = null;
  const base = { path, format: formatOf(path), bytes };
  if (onPreview) {
    // the preview is ~13 ms where a 12 MP photo takes a few hundred: show it while the photo decodes
    try {
      const p = await decodeHeif(bytes, true);
      previewCanvas = canvasFrom(p);
      onPreview({
        ...base, el: previewCanvas, width: p.fullWidth, height: p.fullHeight, profile: p.profile,
        exif: p.exif ? new Uint8Array(p.exif) : null, hasAlpha: p.hasAlpha, preview: true, dispose: () => { /* replaced by the full photo */ },
      });
    } catch { /* no embedded preview: wait for the photo */ }
  }
  let r;
  try { r = await decodeHeif(bytes); } catch (e) {
    throw new DecodeError(/memory|allocation/i.test((e as Error).message) ? 'This photo is too large to open.' : 'This HEIC photo is damaged or uses a kind of HEIF Opal can’t read.');
  }
  const c = canvasFrom(r);
  if (previewCanvas) previewCanvas.width = previewCanvas.height = 0;
  return {
    ...base, el: c, width: r.width, height: r.height, profile: r.profile, exif: r.exif ? new Uint8Array(r.exif) : null,
    hasAlpha: r.hasAlpha, preview: false, dispose: () => { c.width = c.height = 0; },
  };
}

async function loadNative(path: string, bytes: Uint8Array): Promise<Photo> {
  const ext = extOf(path);
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }));
  const img = new Image();
  img.decoding = 'async';
  img.draggable = false;
  img.src = url;
  try { await img.decode(); } catch {
    URL.revokeObjectURL(url);
    throw new DecodeError(`This ${formatOf(path)} file is damaged or isn’t really a ${formatOf(path)} image.`);
  }
  let w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) { w = 1024; h = 1024; } // an SVG without a size
  return {
    path, el: img, width: w, height: h, format: formatOf(path), profile: '', exif: null, bytes,
    hasAlpha: /^(png|apng|gif|webp|avif|ico|svg)$/.test(ext), preview: false,
    dispose: () => { URL.revokeObjectURL(url); img.removeAttribute('src'); },
  };
}

/** Decodes a file into a Photo. `onPreview` gets a quick low-resolution version first (HEIC). */
export async function loadPhoto(path: string, onPreview?: (p: Photo) => void): Promise<Photo> {
  let bytes: Uint8Array;
  try { bytes = await native.read(path); } catch { throw new DecodeError('The file can’t be read. It may have been moved, or another app is using it.'); }
  if (!bytes.length) throw new DecodeError('The file is empty.');
  // a HEIC renamed to .jpg (or the other way round) still opens: trust the content over the name
  const brand = String.fromCharCode(...bytes.subarray(4, 12));
  const looksHeif = /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(brand);
  if (looksHeif || (isHeif(path) && !/^ftyp(avif|avis)/.test(brand))) return loadHeif(path, bytes, onPreview);
  return loadNative(path, bytes);
}

/** Keeps the current photo and its neighbours decoded. */
export class PhotoCache {
  private map = new Map<string, { key: string; promise: Promise<Photo>; used: number; value?: Photo }>();
  /** The photo being shown: never evicted, and never disposed here (the page does that once it's replaced). */
  current = '';
  shown: Photo | null = null;
  constructor(private max = 5) {}

  private key(e: PhotoEntry) { return `${e.size}|${e.mtime}`; }

  get(e: PhotoEntry, onPreview?: (p: Photo) => void): Promise<Photo> {
    const hit = this.map.get(e.path);
    if (hit && hit.key === this.key(e)) { hit.used = performance.now(); return hit.promise; }
    if (hit) this.drop(e.path);
    const promise = loadPhoto(e.path, onPreview);
    const entry: { key: string; promise: Promise<Photo>; used: number; value?: Photo } = { key: this.key(e), promise, used: performance.now() };
    this.map.set(e.path, entry);
    promise.then((p) => { entry.value = p; }, () => {});
    promise.catch(() => { if (this.map.get(e.path)?.promise === promise) this.map.delete(e.path); });
    this.trim();
    return promise;
  }

  /** Starts decoding without waiting (the photos next to the current one). */
  warm(e: PhotoEntry) { this.get(e).catch(() => {}); }

  has(path: string) { return this.map.has(path); }
  /** Whether this decoded photo is still kept (else whoever shows it disposes it when done). */
  holds(p: Photo) { for (const v of this.map.values()) if (v.value === p) return true; return false; }

  drop(path: string) {
    const hit = this.map.get(path);
    if (!hit) return;
    this.map.delete(path);
    hit.promise.then((p) => { if (p !== this.shown) p.dispose(); }, () => {});
  }

  /** Forgets everything except `keep` (another folder was opened). */
  clear(keep?: string) { for (const k of [...this.map.keys()]) if (k !== keep) this.drop(k); }

  private trim() {
    while (this.map.size > this.max) {
      let oldest = '', t = Infinity;
      for (const [k, v] of this.map) if (k !== this.current && v.used < t) { t = v.used; oldest = k; }
      if (!oldest) return;
      this.drop(oldest);
    }
  }
}
