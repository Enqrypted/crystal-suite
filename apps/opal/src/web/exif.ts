// Small, careful EXIF edits on JPEG files and EXIF (TIFF) blocks:
// - rotating a JPEG rewrites only its orientation value (the picture data stays untouched, so it's lossless);
// - a converted copy carries the original's EXIF (date taken, camera, location), with the orientation reset
//   because the copy's pixels are already turned the right way.

/** EXIF orientation values: a rotation (clockwise) and whether the picture is mirrored afterwards. */
const ORIENT: Record<number, { mirror: boolean; rot: number }> = {
  1: { mirror: false, rot: 0 }, 6: { mirror: false, rot: 90 }, 3: { mirror: false, rot: 180 }, 8: { mirror: false, rot: 270 },
  2: { mirror: true, rot: 0 }, 5: { mirror: true, rot: 90 }, 4: { mirror: true, rot: 180 }, 7: { mirror: true, rot: 270 },
};

/** The orientation after turning the shown picture by `deg` clockwise (a multiple of 90). */
export function rotateOrientation(o: number, deg: number) {
  const cur = ORIENT[o] ?? ORIENT[1];
  // a mirrored picture turns the other way under its mirror
  const rot = (((cur.rot + (cur.mirror ? -deg : deg)) % 360) + 360) % 360;
  return Number(Object.keys(ORIENT).find((k) => ORIENT[+k].mirror === cur.mirror && ORIENT[+k].rot === rot) ?? 1);
}

/** Where the EXIF block sits in a JPEG: the APP1 segment and the TIFF data inside it. */
export function jpegExif(b: Uint8Array): { segStart: number; segEnd: number; tiffStart: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; } // fill byte
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no EXIF before the picture
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2 || p + 2 + len > b.length) return null;
    if (marker === 0xe1 && len >= 8 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66 && b[p + 8] === 0 && b[p + 9] === 0) {
      return { segStart: p, segEnd: p + 2 + len, tiffStart: p + 10 };
    }
    p += 2 + len;
  }
  return null;
}

interface Tiff { dv: DataView; little: boolean; base: number; end: number }
function tiffAt(b: Uint8Array, start: number, end = b.length): Tiff | null {
  if (end - start < 8) return null;
  const little = b[start] === 0x49 && b[start + 1] === 0x49;
  const big = b[start] === 0x4d && b[start + 1] === 0x4d;
  if (!little && !big) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint16(start + 2, little) !== 42) return null;
  return { dv, little, base: start, end };
}

/** Finds a tag in IFD0; returns the absolute position of its 12-byte entry. */
function findTag(t: Tiff, tag: number): number {
  const ifd = t.base + t.dv.getUint32(t.base + 4, t.little);
  if (ifd + 2 > t.end) return -1;
  const n = t.dv.getUint16(ifd, t.little);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.end) return -1;
    if (t.dv.getUint16(e, t.little) === tag) return e;
  }
  return -1;
}

/** The orientation stored in a TIFF/EXIF block (1 when there is none). */
export function tiffOrientation(b: Uint8Array, start = 0, end = b.length) {
  const t = tiffAt(b, start, end);
  if (!t) return 1;
  const e = findTag(t, 0x0112);
  if (e < 0) return 1;
  const v = t.dv.getUint16(e + 8, t.little);
  return ORIENT[v] ? v : 1;
}

/** A JPEG's EXIF orientation (1 when there is none). */
export function jpegOrientation(b: Uint8Array) {
  const x = jpegExif(b);
  return x ? tiffOrientation(b, x.tiffStart, x.segEnd) : 1;
}

/**
 * The JPEG with a new EXIF orientation, or null when it can't be done without rewriting the EXIF block
 * (it has one, but without an orientation entry). Picture data is never touched.
 */
export function setJpegOrientation(b: Uint8Array, o: number): Uint8Array | null {
  const x = jpegExif(b);
  if (x) {
    const t = tiffAt(b, x.tiffStart, x.segEnd);
    if (!t) return null;
    const e = findTag(t, 0x0112);
    if (e < 0 || t.dv.getUint16(e + 2, t.little) !== 3) return null;
    const out = b.slice();
    new DataView(out.buffer).setUint16(e + 8, o, t.little);
    return out;
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  // no EXIF yet: add a minimal block with only the orientation, after the JFIF header if there is one
  const app1 = exifSegment(minimalTiff(o));
  let at = 2;
  if (b[2] === 0xff && b[3] === 0xe0) at = 4 + ((b[4] << 8) | b[5]);
  const out = new Uint8Array(b.length + app1.length);
  out.set(b.subarray(0, at), 0);
  out.set(app1, at);
  out.set(b.subarray(at), at + app1.length);
  return out;
}

function minimalTiff(o: number) {
  const t = new Uint8Array(26);
  const dv = new DataView(t.buffer);
  t.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, 1, true);
  dv.setUint16(10, 0x0112, true); dv.setUint16(12, 3, true); dv.setUint32(14, 1, true); dv.setUint16(18, o, true);
  dv.setUint32(22, 0, true);
  return t;
}

function exifSegment(tiff: Uint8Array) {
  const len = 2 + 6 + tiff.length;
  const seg = new Uint8Array(2 + len);
  seg.set([0xff, 0xe1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(tiff, 10);
  return seg;
}

/**
 * A copy of an EXIF block for a converted photo: orientation 1 (the pixels are already turned), and without
 * the location when `keepLocation` is off (the GPS directory is emptied).
 */
export function exifForCopy(tiff: Uint8Array, keepLocation: boolean): Uint8Array | null {
  const out = tiff.slice();
  const t = tiffAt(out, 0);
  if (!t) return null;
  const e = findTag(t, 0x0112);
  if (e >= 0 && t.dv.getUint16(e + 2, t.little) === 3) t.dv.setUint16(e + 8, 1, t.little);
  if (!keepLocation) {
    const g = findTag(t, 0x8825);
    if (g >= 0) {
      const gps = t.dv.getUint32(g + 8, t.little);
      if (gps + 2 <= out.length) t.dv.setUint16(gps, 0, t.little);
    }
  }
  return out;
}

/** Puts an EXIF block into a JPEG made by the canvas (which has none), right after its JFIF header. */
export function jpegWithExif(jpeg: Uint8Array, tiff: Uint8Array): Uint8Array {
  if (tiff.length + 8 > 65533 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const seg = exifSegment(tiff);
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(seg, at);
  out.set(jpeg.subarray(at), at + seg.length);
  return out;
}

/** The EXIF block of a JPEG as standalone TIFF data. */
export function jpegTiff(b: Uint8Array): Uint8Array | null {
  const x = jpegExif(b);
  return x ? b.slice(x.tiffStart, x.segEnd) : null;
}
