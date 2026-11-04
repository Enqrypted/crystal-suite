// Saving copies: the photo as shown (turned the way you turned it) as JPEG, PNG or WebP. A JPEG copy keeps the
// original's details (date taken, camera, and the location unless you leave it out). Also converts every
// HEIC photo in a folder to JPEG in one go.
import { loadPhoto, type Photo } from './decode';
import { exifForCopy, jpegTiff, jpegWithExif } from './exif';
import { baseName, dirName, extOf, isHeif, native, type PhotoEntry } from './native';
import { h } from './ui/dom';
import { modal, toast } from './ui/dialog';

export type OutFormat = 'jpg' | 'png' | 'webp';
const MIME: Record<OutFormat, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** The photo drawn upright (and turned by `rotation`) on an sRGB canvas, at most `maxEdge` on its long side. */
export function renderUpright(p: Photo, rotation: number, maxEdge = Infinity, background?: string) {
  const turned = rotation % 180 !== 0;
  const k = Math.min(1, maxEdge / Math.max(p.width, p.height));
  const w = Math.max(1, Math.round(p.width * k)), hh = Math.max(1, Math.round(p.height * k));
  const c = document.createElement('canvas');
  c.width = turned ? hh : w;
  c.height = turned ? w : hh;
  const x = c.getContext('2d')!;
  if (background) { x.fillStyle = background; x.fillRect(0, 0, c.width, c.height); }
  x.imageSmoothingQuality = 'high';
  x.translate(c.width / 2, c.height / 2);
  x.rotate((rotation * Math.PI) / 180);
  x.drawImage(p.el, -w / 2, -hh / 2, w, hh);
  return c;
}

async function encode(c: HTMLCanvasElement, fmt: OutFormat, quality: number) {
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, MIME[fmt], quality));
  if (!blob) throw new Error('The photo could not be encoded.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** The photo's EXIF as TIFF data (HEIC: from libheif; JPEG: from the file). */
function sourceExif(p: Photo): Uint8Array | null {
  if (p.exif) return p.exif;
  if (/^(jpg|jpeg|jfif|jpe)$/.test(extOf(p.path))) return jpegTiff(p.bytes);
  return null;
}

export interface CopyOptions { fmt: OutFormat; quality: number; keepDetails: boolean; keepLocation: boolean }

export async function encodeCopy(p: Photo, rotation: number, o: CopyOptions) {
  const c = renderUpright(p, rotation, Infinity, o.fmt === 'jpg' ? '#ffffff' : undefined);
  let out = await encode(c, o.fmt, o.quality);
  c.width = c.height = 0;
  if (o.fmt === 'jpg' && o.keepDetails) {
    const tiff = sourceExif(p);
    const copy = tiff && exifForCopy(tiff, o.keepLocation);
    if (copy) out = jpegWithExif(out, copy);
  }
  return out;
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/** A name in `folder` that isn't taken: "IMG_0001.jpg", then "IMG_0001 (2).jpg"... */
async function freeName(folder: string, base: string, ext: string) {
  for (let i = 1; i < 1000; i++) {
    const p = `${folder}\\${base}${i > 1 ? ` (${i})` : ''}.${ext}`;
    if (!(await native.exists(p))) return p;
  }
  return `${folder}\\${base} ${Date.now()}.${ext}`;
}

function formatFields(initial: Partial<CopyOptions>) {
  const o: CopyOptions = { fmt: 'jpg', quality: 0.9, keepDetails: true, keepLocation: true, ...initial };
  const fmt = h('select', { class: 'field' },
    h('option', { value: 'jpg' }, 'JPEG — smaller, opens everywhere'),
    h('option', { value: 'png' }, 'PNG — lossless'),
    h('option', { value: 'webp' }, 'WebP — smaller still'));
  fmt.value = o.fmt;
  const q = h('input', { type: 'range', min: '50', max: '100', value: String(Math.round(o.quality * 100)) }) as HTMLInputElement;
  const qv = h('span', { class: 'qv' }, `${q.value}%`);
  const details = h('input', { type: 'checkbox' }) as HTMLInputElement;
  details.checked = o.keepDetails;
  const loc = h('input', { type: 'checkbox' }) as HTMLInputElement;
  loc.checked = o.keepLocation;
  const qRow = h('label', { class: 'frow' }, h('span', {}, 'Quality'), q, qv);
  const dRow = h('label', { class: 'check' }, details, 'Keep the photo’s details (date taken, camera)');
  const lRow = h('label', { class: 'check sub' }, loc, 'Keep the location');
  const sync = () => {
    o.fmt = fmt.value as OutFormat;
    o.quality = Number(q.value) / 100;
    qv.textContent = `${q.value}%`;
    o.keepDetails = details.checked;
    o.keepLocation = loc.checked;
    qRow.hidden = o.fmt === 'png';
    dRow.hidden = lRow.hidden = o.fmt !== 'jpg';
    loc.disabled = !details.checked;
  };
  fmt.addEventListener('change', sync); q.addEventListener('input', sync); details.addEventListener('change', sync); loc.addEventListener('change', sync);
  sync();
  return { o, el: h('div', { class: 'form' }, h('label', { class: 'frow' }, h('span', {}, 'Format'), fmt), qRow, dRow, lRow) };
}

/** File > Save a copy: asks for the format, then where. */
export async function saveCopy(p: Photo, rotation: number, remembered: Partial<CopyOptions>): Promise<Partial<CopyOptions> | null> {
  const f = formatFields(remembered);
  const go = await modal('Save a copy', f.el, [{ label: 'Cancel', value: '' }, { label: 'Save…', value: 'ok', primary: true }], { width: 440 });
  if (go !== 'ok') return null;
  const target = await native.saveDialog(await freeName(dirName(p.path), stem(baseName(p.path)), f.o.fmt), f.o.fmt);
  if (!target) return null;
  toast('Saving…', 60000);
  try {
    const data = await encodeCopy(p, rotation, f.o);
    const err = await native.write(target, data);
    if (err) throw new Error(err);
    toast(`Saved ${baseName(target)}`);
  } catch (e) {
    toast(`Couldn’t save: ${(e as Error).message}`, 4000);
  }
  return f.o;
}

/** Converts every HEIC photo in the folder (to JPEG by default), next to the originals or into another folder. */
export async function convertFolder(files: PhotoEntry[], folder: string, remembered: Partial<CopyOptions>): Promise<number> {
  const heic = files.filter((f) => isHeif(f.path));
  if (!heic.length) { toast('There are no HEIC photos in this folder.'); return 0; }
  const f = formatFields({ fmt: 'jpg', ...remembered });
  let outDir = folder;
  const where = h('div', { class: 'where' }, h('span', { class: 'path' }, outDir));
  const pick = h('button', { class: 'btn' }, 'Change…');
  pick.addEventListener('click', async () => { const d = await native.folderDialog('Save the converted photos in', outDir); if (d) { outDir = d; where.firstElementChild!.textContent = d; } });
  where.append(pick);
  const body = h('div', {}, h('p', { class: 'lead' }, `Convert ${heic.length} HEIC photo${heic.length === 1 ? '' : 's'}. The originals stay as they are.`), f.el, h('div', { class: 'frow' }, h('span', {}, 'Save in'), where));
  const go = await modal('Convert HEIC photos', body, [{ label: 'Cancel', value: '' }, { label: 'Convert', value: 'ok', primary: true }], { width: 480 });
  if (go !== 'ok') return 0;

  let cancelled = false, done = 0, failed = 0;
  let closeProgress: (v: string) => void = () => {};
  const bar = h('div', { class: 'bar' }, h('i'));
  const label = h('div', { class: 'lead' }, 'Starting…');
  modal('Converting', h('div', {}, label, bar), [{ label: 'Stop', value: 'stop' }], { width: 420, onOpen: (close) => { closeProgress = close; } })
    .then((v) => { if (v !== 'done') cancelled = true; });
  for (const file of heic) {
    if (cancelled) break;
    label.textContent = `${baseName(file.path)} (${done + failed + 1} of ${heic.length})`;
    try {
      const p = await loadPhoto(file.path);
      try {
        const data = await encodeCopy(p, 0, f.o);
        const target = await freeName(outDir, stem(baseName(file.path)), f.o.fmt);
        const err = await native.write(target, data);
        if (err) throw new Error(err);
        done++;
      } finally { p.dispose(); }
    } catch { failed++; }
    (bar.firstElementChild as HTMLElement).style.width = `${((done + failed) / heic.length) * 100}%`;
  }
  const stopped = cancelled;
  if (!stopped) closeProgress('done');
  toast(`${done} photo${done === 1 ? '' : 's'} converted${failed ? `, ${failed} couldn’t be read` : ''}${cancelled ? ' (stopped)' : ''}.`, 4000);
  return done;
}
