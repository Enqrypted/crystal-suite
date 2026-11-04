// Thumbnails for the filmstrip and the grid. JPEG, PNG, GIF and BMP come from Windows (its thumbnail cache
// makes them instant); HEIC uses the preview inside the file, and the rest are decoded here. Those Opal makes
// itself are kept on disk, so a folder opens with its thumbnails the second time. Only thumbnails that are
// on screen are made, the ones you can see first.
import { heifThumb } from './heif';
import { extOf, isHeif, native, type PhotoEntry } from './native';

const MIME: Record<string, string> = { webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml', png: 'image/png', apng: 'image/apng', gif: 'image/gif', bmp: 'image/bmp' };

const urls = new Map<string, Promise<string | null>>();
const keyOf = (e: PhotoEntry, size: number) => `${e.path}|${e.size}|${e.mtime}|${size}`;

async function decodeHere(bytes: Uint8Array, ext: string, size: number): Promise<Uint8Array> {
  const blob = new Blob([bytes], { type: MIME[ext] || 'image/jpeg' });
  const probe = await createImageBitmap(blob);
  const k = Math.min(1, size / Math.max(probe.width, probe.height));
  const w = Math.max(1, Math.round(probe.width * k)), h = Math.max(1, Math.round(probe.height * k));
  probe.close();
  const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d')!;
  x.fillStyle = '#1b1b1f';
  x.fillRect(0, 0, w, h);
  x.drawImage(bmp, 0, 0);
  bmp.close();
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 })).arrayBuffer());
}

async function make(e: PhotoEntry, size: number): Promise<string | null> {
  const ext = extOf(e.path);
  const key = keyOf(e, size);
  let jpeg: Uint8Array | null = null;
  if (!isHeif(e.path)) jpeg = await native.shellThumb(e.path, size);
  if (!jpeg) jpeg = await native.thumbGet(key);
  if (!jpeg) {
    const bytes = await native.read(e.path);
    const brand = String.fromCharCode(...bytes.subarray(4, 12));
    jpeg = isHeif(e.path) || /^ftyp(heic|heix|mif1|msf1)/.test(brand) ? new Uint8Array((await heifThumb(bytes, size)).jpeg) : await decodeHere(bytes, ext, size);
    native.thumbPut(key, jpeg);
  }
  return URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
}

// ---------- a small queue: the most recently requested (= just scrolled into view) go first ----------
interface Job { e: PhotoEntry; size: number; resolve: (u: string | null) => void; cancelled: boolean }
const queue: Job[] = [];
let running = 0;
const MAX = 3;

function pump() {
  while (running < MAX && queue.length) {
    const job = queue.pop()!;
    if (job.cancelled) { job.resolve(null); continue; }
    running++;
    make(job.e, job.size).catch(() => null).then((u) => { running--; job.resolve(u); pump(); });
  }
}

/** A thumbnail's object URL (cached). The returned cancel() drops it from the queue if it hasn't started. */
export function thumbUrl(e: PhotoEntry, size: number): { promise: Promise<string | null>; cancel: () => void } {
  const key = keyOf(e, size);
  const hit = urls.get(key);
  if (hit) return { promise: hit, cancel: () => {} };
  let job: Job | null = null;
  const promise = new Promise<string | null>((resolve) => {
    job = { e, size, resolve, cancelled: false };
    queue.push(job);
    pump();
  });
  urls.set(key, promise);
  promise.then((u) => { if (!u) urls.delete(key); });
  return { promise, cancel: () => { if (job && !job.cancelled && queue.includes(job)) { job.cancelled = true; urls.delete(key); } } };
}

/** Forgets thumbnails of files that changed or went away. */
export function forgetThumbs(path: string) {
  for (const [k, p] of urls) if (k.startsWith(path + '|')) { urls.delete(k); p.then((u) => u && URL.revokeObjectURL(u)); }
}

const observed = new WeakMap<Element, { e: PhotoEntry; size: number; cancel?: () => void; done?: boolean }>();
const io = new IntersectionObserver((entries) => {
  for (const it of entries) {
    const st = observed.get(it.target);
    if (!st || st.done) continue;
    if (it.isIntersecting) {
      const t = thumbUrl(st.e, st.size);
      st.cancel = t.cancel;
      t.promise.then((u) => {
        if (!u || observed.get(it.target) !== st) return;
        st.done = true;
        const img = it.target.querySelector('img');
        if (img) { img.src = u; img.onload = () => img.classList.add('loaded'); }
      });
    } else st.cancel?.();
  }
}, { rootMargin: '200px' });

/** Loads `cell`'s <img> with the photo's thumbnail when the cell comes on screen. */
export function observeThumb(cell: HTMLElement, e: PhotoEntry, size: number) {
  const prev = observed.get(cell);
  if (prev && prev.e.path === e.path && prev.e.mtime === e.mtime) return;
  prev?.cancel?.();
  observed.set(cell, { e, size });
  io.unobserve(cell);
  io.observe(cell);
}
