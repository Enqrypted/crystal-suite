// The details panel: when and with what the photo was taken (EXIF), where (GPS), and the file itself.
import { parse } from 'exifr';
import type { Photo } from './decode';
import { baseName, dirName, native, type PhotoEntry } from './native';
import { h, clear } from './ui/dom';
import { icon } from './icons';

export interface PhotoFacts {
  taken: Date | null;
  camera: string;
  lens: string;
  exposure: string[];
  lat: number | null;
  lon: number | null;
  orientation: number;
}

const factsCache = new Map<string, Promise<PhotoFacts>>();

function fraction(t: number) {
  if (!t) return '';
  if (t >= 1) return `${+t.toFixed(1)} s`;
  return `1/${Math.round(1 / t)} s`;
}

/** EXIF facts for a photo (cached per file version). */
export function factsOf(p: Photo, e: PhotoEntry): Promise<PhotoFacts> {
  const key = `${e.path}|${e.mtime}|${e.size}`;
  let hit = factsCache.get(key);
  if (!hit) {
    hit = (async () => {
      // HEIC: the EXIF block libheif found (exifr's own HEIC reader trips over some files); others: the file
      const opts = { tiff: true, exif: true, gps: true, interop: false, ifd1: false, xmp: false, icc: false, iptc: false, translateValues: true, reviveValues: true } as const;
      const useful = (v: any) => v && Object.keys(v).some((k) => k !== 'errors');
      let x: any = null;
      for (const src of p.exif ? [p.exif, p.bytes] : [p.bytes]) {
        try { x = await parse(src, opts); } catch { x = null; }
        if (useful(x)) break;
      }
      x = useful(x) ? x : {};
      const make = String(x.Make || '').trim(), model = String(x.Model || '').trim();
      const camera = model ? (make && !model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? `${make} ${model}` : model) : make;
      const exposure: string[] = [];
      if (x.ExposureTime) exposure.push(fraction(x.ExposureTime));
      if (x.FNumber) exposure.push(`f/${+Number(x.FNumber).toFixed(1)}`);
      const iso = x.ISO ?? x.ISOSpeedRatings ?? x.PhotographicSensitivity;
      if (iso) exposure.push(`ISO ${Array.isArray(iso) ? iso[0] : iso}`);
      if (x.FocalLength) exposure.push(`${+Number(x.FocalLength).toFixed(1)} mm${x.FocalLengthIn35mmFormat && Math.round(x.FocalLengthIn35mmFormat) !== Math.round(x.FocalLength) ? ` (${x.FocalLengthIn35mmFormat} mm equiv.)` : ''}`);
      const taken = x.DateTimeOriginal || x.CreateDate || x.DateTimeDigitized || null;
      const lat = typeof x.latitude === 'number' && isFinite(x.latitude) ? x.latitude : null;
      const lon = typeof x.longitude === 'number' && isFinite(x.longitude) ? x.longitude : null;
      return {
        taken: taken instanceof Date && !isNaN(+taken) ? taken : null,
        camera, lens: String(x.LensModel || x.LensMake || '').trim(), exposure,
        lat: lat !== null && lon !== null && (lat || lon) ? lat : null, lon: lat !== null && lon !== null && (lat || lon) ? lon : null,
        orientation: typeof x.Orientation === 'number' ? x.Orientation : 1,
      };
    })();
    factsCache.set(key, hit);
  }
  return hit;
}

const sizeText = (b: number) => (b >= 1e6 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const coord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? pos : neg}`;

/** Fills the details panel. */
export async function renderInfo(panel: HTMLElement, p: Photo | null, e: PhotoEntry | null, rotation: number) {
  const token = String(Math.random());
  panel.dataset.token = token;
  clear(panel);
  panel.append(h('div', { class: 'info-head' }, 'Details'));
  if (!p || !e) { panel.append(h('div', { class: 'info-empty' }, 'No photo')); return; }
  const f = await factsOf(p, e);
  if (panel.dataset.token !== token) return; // another photo is showing by now
  const rows = h('div', { class: 'info-rows' });
  const row = (ic: string, title: string, ...lines: (string | Node)[]) => rows.append(h('div', { class: 'info-row' }, icon(ic, 18), h('div', {}, h('div', { class: 'info-title' }, title), ...lines.filter(Boolean).map((l) => h('div', { class: 'info-sub' }, l)))));
  if (f.taken) {
    row('calendar', f.taken.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), f.taken.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  }
  const mp = (p.width * p.height) / 1e6;
  const turned = rotation % 180 !== 0;
  row('image', baseName(e.path),
    `${turned ? p.height : p.width} × ${turned ? p.width : p.height}${mp >= 0.1 ? ` · ${mp >= 10 ? mp.toFixed(0) : mp.toFixed(1)} MP` : ''}`,
    `${sizeText(e.size)} · ${p.format}${p.profile && p.profile !== 'sRGB' ? ` · ${p.profile}` : ''}`);
  if (f.camera || f.exposure.length) row('camera', f.camera || 'Camera', f.lens, f.exposure.join('  ·  '));
  if (f.lat !== null && f.lon !== null) {
    const lat = f.lat, lon = f.lon;
    const link = h('a', { class: 'link', href: '#' }, 'Open in map');
    link.addEventListener('click', (ev) => { ev.preventDefault(); native.openUrl(`https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=15/${lat.toFixed(6)}/${lon.toFixed(6)}`); });
    row('pin', 'Location', `${coord(lat, 'N', 'S')}, ${coord(lon, 'E', 'W')}`, link);
  }
  const folder = h('a', { class: 'link', href: '#', title: e.path }, dirName(e.path));
  folder.addEventListener('click', (ev) => { ev.preventDefault(); native.showInFolder(e.path); });
  row('folder', 'Folder', folder, `Modified ${new Date(e.mtime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`);
  panel.append(rows);
}
