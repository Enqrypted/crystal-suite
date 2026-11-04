// HEIC/HEIF decoding off the UI thread with libheif (WebAssembly). The page hands over libheif's glue script
// and .wasm (read through the app: a page can't fetch file://), then photos to decode. Everything goes through
// libheif's plain C API: the primary image (with its rotation and mirroring applied), the small preview
// iPhones embed in every photo, the EXIF block and the colour profile.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare function importScripts(...urls: string[]): void;
declare const libheif: (o: { wasmBinary: ArrayBuffer }) => any;

export type HeifRequest =
  | { id: number; op: 'init'; glue: string; wasm: ArrayBuffer }
  | { id: number; op: 'decode'; bytes: ArrayBuffer; preview?: boolean }
  | { id: number; op: 'thumb'; bytes: ArrayBuffer; size: number };

export interface HeifImageResult {
  width: number; height: number; data: ArrayBuffer;
  /** 'display-p3' for iPhone photos (Display P3 profile), otherwise 'srgb'. */
  colorSpace: PredefinedColorSpace;
  /** The EXIF block (TIFF data, starting at "II*" / "MM*"), if any. */
  exif: ArrayBuffer | null;
  profile: string;
  hasAlpha: boolean;
  /** This is the embedded preview rather than the full photo. */
  preview: boolean;
  fullWidth: number; fullHeight: number;
}

const RGB = 1, RGBA = 11, INTERLEAVED = 10;
let M: any = null;

const heap = () => M.HEAPU8 as Uint8Array;
const view = () => new DataView(M.HEAPU8.buffer as ArrayBuffer);
const u32 = (p: number) => view().getUint32(p, true);
const i32 = (p: number) => view().getInt32(p, true);

/** libheif returns errors as a struct { code, subcode, message* } through a hidden first pointer. */
function call(fn: (sret: number, ...args: number[]) => void, ...args: number[]) {
  const sret = M._malloc(16);
  try {
    fn(sret, ...args);
    const code = u32(sret);
    if (!code) return;
    const msgPtr = u32(sret + 8);
    let msg = '';
    if (msgPtr) { const h = heap(); let e = msgPtr; while (h[e] && e - msgPtr < 400) e++; msg = new TextDecoder().decode(h.slice(msgPtr, e)); }
    throw new Error(msg || `libheif error ${code}`);
  } finally { M._free(sret); }
}

function fourcc(v: number) { return String.fromCharCode((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }

/** Opens a HEIF file; returns the context and its primary image handle. */
function openFile(bytes: ArrayBuffer) {
  const ctx = M._heif_context_alloc();
  const n = bytes.byteLength;
  const data = M._malloc(n);
  heap().set(new Uint8Array(bytes), data);
  const out = M._malloc(4);
  try {
    call(M._heif_context_read_from_memory, ctx, data, n, 0);
    call(M._heif_context_get_primary_image_handle, ctx, out);
    return { ctx, handle: u32(out), data };
  } catch (e) {
    M._free(data);
    M._heif_context_free(ctx);
    throw e;
  } finally { M._free(out); }
}

/** Decodes a handle to straight (non-premultiplied) RGBA bytes. */
function decodeHandle(handle: number, premultiplied: boolean) {
  const out = M._malloc(4);
  let img = 0;
  try {
    call(M._heif_decode_image, handle, out, RGB, RGBA, 0);
    img = u32(out);
  } finally { M._free(out); }
  try {
    const sp = M._malloc(4);
    const plane = M._heif_image_get_plane_readonly(img, INTERLEAVED, sp);
    const stride = i32(sp);
    M._free(sp);
    const w = M._heif_image_get_width(img, INTERLEAVED), h = M._heif_image_get_height(img, INTERLEAVED);
    if (!plane || w <= 0 || h <= 0) throw new Error('The photo has no picture data.');
    const px = new Uint8ClampedArray(w * h * 4);
    const src = heap();
    if (stride === w * 4) px.set(src.subarray(plane, plane + w * h * 4));
    else for (let y = 0; y < h; y++) px.set(src.subarray(plane + y * stride, plane + y * stride + w * 4), y * w * 4);
    if (premultiplied) {
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3];
        if (a && a < 255) { px[i] = (px[i] * 255) / a; px[i + 1] = (px[i + 1] * 255) / a; px[i + 2] = (px[i + 2] * 255) / a; }
      }
    }
    return { w, h, px };
  } finally { if (img) M._heif_image_release(img); }
}

/** Display P3 or sRGB, from an ICC profile's red primary (P3's is much redder than sRGB's) or the nclx primaries. */
function colourOf(handle: number): { space: PredefinedColorSpace; name: string } {
  const type = fourcc(M._heif_image_handle_get_color_profile_type(handle));
  if (type === 'prof' || type === 'rICC') {
    const size = M._heif_image_handle_get_raw_color_profile_size(handle);
    if (size > 132 && size < 10_000_000) {
      const buf = M._malloc(size);
      try {
        call(M._heif_image_handle_get_raw_color_profile, handle, buf);
        const icc = heap().slice(buf, buf + size);
        const dv = new DataView(icc.buffer);
        const count = dv.getUint32(128);
        let redX = 0, name = '';
        for (let i = 0; i < count && 132 + i * 12 + 12 <= size; i++) {
          const o = 132 + i * 12, sig = String.fromCharCode(icc[o], icc[o + 1], icc[o + 2], icc[o + 3]);
          const off = dv.getUint32(o + 4), len = dv.getUint32(o + 8);
          if (off + len > size) continue;
          if (sig === 'rXYZ' && len >= 20) redX = dv.getInt32(off + 8) / 65536;
          if (sig === 'desc') name = profileName(icc, off, len);
        }
        const p3 = /P3/i.test(name) || (redX > 0.49 && redX < 0.56);
        return { space: p3 ? 'display-p3' : 'srgb', name: name || (p3 ? 'Display P3' : 'ICC profile') };
      } catch { /* fall through */ } finally { M._free(buf); }
    }
    return { space: 'srgb', name: 'ICC profile' };
  }
  if (type === 'nclx') {
    const out = M._malloc(4);
    try {
      call(M._heif_image_handle_get_nclx_color_profile, handle, out);
      const p = u32(out);
      const primaries = i32(p + 4);
      M._heif_nclx_color_profile_free(p);
      if (primaries === 11 || primaries === 12) return { space: 'display-p3', name: 'Display P3' };
      if (primaries === 9) return { space: 'srgb', name: 'Rec. 2020' };
    } catch { /* default */ } finally { M._free(out); }
  }
  return { space: 'srgb', name: 'sRGB' };
}

function profileName(icc: Uint8Array, off: number, len: number) {
  const type = String.fromCharCode(icc[off], icc[off + 1], icc[off + 2], icc[off + 3]);
  const dv = new DataView(icc.buffer);
  if (type === 'desc') {
    const n = dv.getUint32(off + 8);
    return new TextDecoder('latin1').decode(icc.slice(off + 12, off + 12 + Math.min(n, len - 12))).replace(/\0.*$/s, '');
  }
  if (type === 'mluc') {
    const recSize = dv.getUint32(off + 12);
    if (recSize < 12) return '';
    const strLen = dv.getUint32(off + 16 + 4), strOff = dv.getUint32(off + 16 + 8);
    const s = icc.slice(off + strOff, off + strOff + strLen);
    let out = '';
    for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s[i] << 8) | s[i + 1]);
    return out.replace(/\0.*$/s, '');
  }
  return '';
}

/** The EXIF block's TIFF data. HEIF stores it after a 4-byte offset to the TIFF header. */
function exifOf(handle: number): ArrayBuffer | null {
  const n = M._heif_image_handle_get_number_of_metadata_blocks(handle, 0);
  if (n <= 0) return null;
  const ids = M._malloc(4 * n), type = M._malloc(8);
  try {
    heap().set([69, 120, 105, 102, 0], type); // "Exif"
    const found = M._heif_image_handle_get_list_of_metadata_block_IDs(handle, type, ids, n);
    if (found <= 0) return null;
    const id = u32(ids);
    const size = M._heif_image_handle_get_metadata_size(handle, id);
    if (size < 12 || size > 4_000_000) return null;
    const buf = M._malloc(size);
    try {
      call(M._heif_image_handle_get_metadata, handle, id, buf);
      const raw = heap().slice(buf, buf + size);
      const skip = new DataView(raw.buffer).getUint32(0);
      let start = 4 + skip;
      // some writers get the offset wrong: look for the TIFF header nearby
      const isTiff = (o: number) => (raw[o] === 0x49 && raw[o + 1] === 0x49 && raw[o + 2] === 42) || (raw[o] === 0x4d && raw[o + 1] === 0x4d && raw[o + 3] === 42);
      if (!isTiff(start)) { start = -1; for (let o = 4; o < Math.min(64, size - 4); o++) if (isTiff(o)) { start = o; break; } }
      return start < 0 ? null : raw.slice(start).buffer;
    } finally { M._free(buf); }
  } catch { return null; } finally { M._free(ids); M._free(type); }
}

/** The smallest embedded preview that is at least `min` pixels on its long edge (or the largest one). */
function thumbnailOf(handle: number, min: number): number {
  const n = M._heif_image_handle_get_number_of_thumbnails(handle);
  if (n <= 0) return 0;
  const ids = M._malloc(4 * n), out = M._malloc(4);
  let best = 0, bestEdge = 0;
  try {
    const count = M._heif_image_handle_get_list_of_thumbnail_IDs(handle, ids, n);
    for (let i = 0; i < count; i++) {
      try { call(M._heif_image_handle_get_thumbnail, handle, u32(ids + i * 4), out); } catch { continue; }
      const th = u32(out);
      const edge = Math.max(M._heif_image_handle_get_width(th), M._heif_image_handle_get_height(th));
      const better = !best || (bestEdge < min ? edge > bestEdge : edge >= min && edge < bestEdge);
      if (better) { if (best) M._heif_image_handle_release(best); best = th; bestEdge = edge; } else M._heif_image_handle_release(th);
    }
  } finally { M._free(ids); M._free(out); }
  return best;
}

function decode(bytes: ArrayBuffer, preview: boolean): { result: HeifImageResult; transfer: ArrayBuffer[] } {
  const f = openFile(bytes);
  try {
    const h = f.handle;
    const fullWidth = M._heif_image_handle_get_width(h), fullHeight = M._heif_image_handle_get_height(h);
    const colour = colourOf(h);
    const exif = exifOf(h);
    const hasAlpha = !!M._heif_image_handle_has_alpha_channel(h);
    let source = h, isPreview = false;
    if (preview) {
      const th = thumbnailOf(h, 256);
      if (!th) throw new Error('no preview');
      source = th; isPreview = true;
    }
    try {
      const { w, h: hh, px } = decodeHandle(source, !!M._heif_image_handle_is_premultiplied_alpha(source));
      const result: HeifImageResult = { width: w, height: hh, data: px.buffer, colorSpace: colour.space, exif, profile: colour.name, hasAlpha, preview: isPreview, fullWidth, fullHeight };
      return { result, transfer: [px.buffer, ...(exif ? [exif] : [])] };
    } finally { if (source !== h) M._heif_image_handle_release(source); }
  } finally {
    M._heif_image_handle_release(f.handle);
    M._heif_context_free(f.ctx);
    M._free(f.data);
  }
}

/** A JPEG thumbnail at most `size` pixels on its long edge, from the embedded preview when it's big enough. */
async function thumb(bytes: ArrayBuffer, size: number) {
  const f = openFile(bytes);
  let rgba: { w: number; h: number; px: Uint8ClampedArray };
  let space: PredefinedColorSpace;
  try {
    space = colourOf(f.handle).space;
    const th = thumbnailOf(f.handle, Math.round(size * 0.9));
    const thEdge = th ? Math.max(M._heif_image_handle_get_width(th), M._heif_image_handle_get_height(th)) : 0;
    const source = th && thEdge >= size * 0.6 ? th : f.handle;
    try { rgba = decodeHandle(source, !!M._heif_image_handle_is_premultiplied_alpha(source)); } finally { if (th) M._heif_image_handle_release(th); }
  } finally {
    M._heif_image_handle_release(f.handle);
    M._heif_context_free(f.ctx);
    M._free(f.data);
  }
  const k = Math.min(1, size / Math.max(rgba.w, rgba.h));
  const w = Math.max(1, Math.round(rgba.w * k)), h = Math.max(1, Math.round(rgba.h * k));
  const bmp = await createImageBitmap(new ImageData(rgba.px, rgba.w, rgba.h, { colorSpace: space }), { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d')!;
  x.fillStyle = '#1b1b1f';
  x.fillRect(0, 0, w, h);
  x.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  return { jpeg: await blob.arrayBuffer(), width: rgba.w, height: rgba.h };
}

self.onmessage = async (e: MessageEvent<HeifRequest>) => {
  const msg = e.data;
  const post = (data: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ id: msg.id, ...(data as object) }, transfer);
  try {
    if (msg.op === 'init') {
      if (!M) {
        importScripts(msg.glue);
        let m = libheif({ wasmBinary: msg.wasm });
        if (m && typeof m.then === 'function') m = await m;
        if (m && m.ready && typeof m.ready.then === 'function') await m.ready;
        M = m;
      }
      post({ ok: true });
    } else if (msg.op === 'decode') {
      const { result, transfer } = decode(msg.bytes, !!msg.preview);
      post({ ok: true, result }, transfer);
    } else if (msg.op === 'thumb') {
      const r = await thumb(msg.bytes, msg.size);
      post({ ok: true, result: r }, [r.jpeg]);
    }
  } catch (err) {
    post({ ok: false, error: (err as Error)?.message || String(err) });
  }
};
