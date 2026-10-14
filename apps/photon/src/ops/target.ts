// Where pixel edits go (layer, layer mask or quick mask), plus the generic
// "apply a filter to the target, respecting the selection" pipeline with live preview.
import { app } from '../app';
import { Doc } from '../core/document';
import { Layer } from '../core/layer';
import { createCanvas, ctx2d, getImageData, Rect, rectIntersect, rectOut } from '../core/util';
import { alertDialog, confirmDialog } from '../dialogs/dialog';
import { toast } from '../ui/widgets';
import { rasterize } from './rasterize';

export interface PixelTarget {
  kind: 'layer' | 'mask' | 'quickmask';
  layer: Layer | null;
  canvas: HTMLCanvasElement;
  /** Document position of canvas (0,0). */
  x: number; y: number;
  /** Mask / quick mask: only alpha matters (alpha = white). */
  alphaOnly: boolean;
  lockAlpha: boolean;
  replace(c: HTMLCanvasElement): void;
  setPreview(c: HTMLCanvasElement | null): void;
}

export function activeDoc(): Doc | null {
  if (!app.doc) toast('No document open');
  return app.doc;
}

/** Resolve the current pixel target without prompting. */
export function currentTarget(doc: Doc): PixelTarget | null {
  if (doc.quickMask) {
    let original: HTMLCanvasElement | null = null;
    const sel = doc.selection ?? createCanvas(doc.width, doc.height);
    return {
      kind: 'quickmask', layer: null, canvas: sel, x: 0, y: 0, alphaOnly: true, lockAlpha: false,
      replace: (c) => { doc.setSelection(c); },
      setPreview: (c) => {
        if (c) { if (!original) original = doc.selection; doc.selection = c; }
        else if (original !== null) { doc.selection = original; original = null; }
        doc.setSelection(doc.selection);
      },
    };
  }
  const L = doc.active;
  if (!L) return null;
  if (doc.editMask && L.mask) {
    let original: HTMLCanvasElement | null = null;
    return {
      kind: 'mask', layer: L, canvas: L.mask, x: L.maskX, y: L.maskY, alphaOnly: true, lockAlpha: false,
      replace: (c) => { L.mask = c; L.touch(); doc.invalidate(); },
      setPreview: (c) => {
        if (c) { if (!original) original = L.mask; L.mask = c; }
        else if (original) { L.mask = original; original = null; }
        L.touch(); doc.invalidate();
      },
    };
  }
  if (L.kind !== 'raster') return null;
  return {
    kind: 'layer', layer: L, canvas: L.canvas, x: L.x, y: L.y, alphaOnly: false, lockAlpha: L.lockAlpha,
    replace: (c) => { L.canvas = c; L.preview = null; L.touch(); doc.invalidate(); },
    setPreview: (c) => { L.preview = c; L.touch(); doc.invalidate(); },
  };
}

/**
 * Get an editable pixel target, prompting to rasterize type/shape layers like Photoshop.
 * Returns null (after telling the user why) if editing is impossible.
 */
export async function editableTarget(doc: Doc, what = 'complete your request'): Promise<PixelTarget | null> {
  const L = doc.active;
  if (!doc.quickMask && !(doc.editMask && L?.mask)) {
    if (!L) { toast('No layer selected'); return null; }
    if (!L.visible) { await alertDialog('Photon', `Could not ${what} because the target layer is hidden.`); return null; }
    if (L.lockAll || L.lockPixels) { await alertDialog('Photon', `Could not ${what} because the layer is locked.`); return null; }
    if (L.kind === 'adjustment') { await alertDialog('Photon', `Could not ${what} because the selected layer is an adjustment layer. Select a pixel layer.`); return null; }
    if (L.kind === 'group') { await alertDialog('Photon', `Could not ${what} because the selected layer is a group. Select a layer inside the group.`); return null; }
    if (L.kind !== 'raster') {
      const kind = L.kind === 'text' ? 'type layer' : L.kind === 'shape' ? 'shape layer' : 'fill layer';
      const r = await confirmDialog('Photon', `This ${kind} must be rasterized before proceeding.${L.kind === 'text' ? ' Its text will no longer be editable.' : ''} Rasterize the layer?`, 'OK', 'Cancel');
      if (r !== 'ok') return null;
      const before = doc.captureState();
      rasterize(doc, L);
      doc.commit(L.kind === 'text' ? 'Rasterize Type' : 'Rasterize Layer', before);
    }
  }
  return currentTarget(doc);
}

// ---------- alpha <-> gray conversion for mask targets ----------
export function alphaToGray(c: HTMLCanvasElement): HTMLCanvasElement {
  const o = createCanvas(c.width, c.height);
  const x = ctx2d(o);
  x.fillStyle = '#fff';
  x.fillRect(0, 0, o.width, o.height);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(c, 0, 0);
  x.globalCompositeOperation = 'destination-over';
  x.fillStyle = '#000';
  x.fillRect(0, 0, o.width, o.height);
  return o;
}
export function grayToAlpha(c: HTMLCanvasElement): HTMLCanvasElement {
  const id = getImageData(c);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * (d[i + 3] / 255);
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = v;
  }
  const o = createCanvas(c.width, c.height);
  ctx2d(o).putImageData(id, 0, 0);
  return o;
}

export type FilterFn = (src: HTMLCanvasElement) => HTMLCanvasElement;
export interface FilterOpts {
  /** Extra source pixels around the selection the filter needs (blur radius etc.). */
  pad?: number;
  /** Filter needs the whole layer even with a selection (e.g. distortions centered on layer). */
  wholeLayer?: boolean;
}

/** Run fn on the target (only the selected area changes). Returns the full new canvas. */
export function computeFiltered(doc: Doc, t: PixelTarget, fn: FilterFn, o: FilterOpts = {}): HTMLCanvasElement {
  const full: Rect = { x: 0, y: 0, w: t.canvas.width, h: t.canvas.height };
  const sb = doc.selectionBounds();
  let region: Rect = full;
  if (sb && !o.wholeLayer && t.kind !== 'quickmask') {
    const r = rectIntersect(rectOut({ x: sb.x - t.x, y: sb.y - t.y, w: sb.w, h: sb.h }, o.pad ?? 0), full);
    if (!r) return t.canvas;
    region = r;
  }
  let src = createCanvas(region.w, region.h);
  ctx2d(src).drawImage(t.canvas, -region.x, -region.y);
  if (t.alphaOnly) src = alphaToGray(src);
  let out = fn(src);
  if (t.alphaOnly) out = grayToAlpha(out);

  // Lerp original -> filtered by selection amount (premultiplied add via 'lighter')
  const result = createCanvas(t.canvas.width, t.canvas.height);
  const rx = ctx2d(result);
  rx.drawImage(t.canvas, 0, 0);
  const patch = createCanvas(region.w, region.h);
  const px = ctx2d(patch);
  px.drawImage(out, 0, 0);
  if (doc.selection && t.kind !== 'quickmask') {
    px.globalCompositeOperation = 'destination-in';
    px.drawImage(doc.selection, -t.x - region.x, -t.y - region.y);
    rx.save();
    rx.globalCompositeOperation = 'destination-out';
    rx.drawImage(doc.selection, -t.x, -t.y);
    rx.restore();
    rx.globalCompositeOperation = 'lighter';
    rx.drawImage(patch, region.x, region.y);
  } else {
    rx.clearRect(region.x, region.y, region.w, region.h);
    rx.drawImage(patch, region.x, region.y);
  }
  rx.globalCompositeOperation = 'source-over';
  if (t.lockAlpha) {
    // keep original transparency
    const keep = createCanvas(result.width, result.height);
    const kx = ctx2d(keep);
    kx.drawImage(t.canvas, 0, 0);
    kx.globalCompositeOperation = 'source-atop';
    kx.drawImage(result, 0, 0);
    return keep;
  }
  return result;
}

let previewTarget: PixelTarget | null = null;

/** Live preview of fn on the current target (call again to update, endPreview to stop). */
export function previewFilter(fn: FilterFn, o: FilterOpts = {}) {
  const doc = app.doc;
  if (!doc) return;
  const t = previewTarget ?? currentTarget(doc);
  if (!t) return;
  if (!previewTarget) previewTarget = t;
  // compute from the real pixels (t.canvas is the original even while previewing)
  t.setPreview(computeFiltered(doc, t, fn, o));
}
export function endPreview() {
  if (previewTarget) { previewTarget.setPreview(null); previewTarget = null; }
}

/** Apply fn to the editable target with an undo step named `name`. */
export async function applyFilter(name: string, fn: FilterFn, o: FilterOpts = {}): Promise<boolean> {
  endPreview();
  const doc = activeDoc();
  if (!doc) return false;
  const t = await editableTarget(doc, `use the ${name.replace(/\.\.\.$/, '')} command`);
  if (!t) return false;
  const before = doc.captureState();
  const out = computeFiltered(doc, t, fn, o);
  t.replace(out);
  doc.commit(name, before);
  return true;
}

/** Wrap an in-place ImageData function as a FilterFn. */
export function pixelFn(fn: (img: ImageData) => void): FilterFn {
  return (src) => {
    const id = getImageData(src);
    fn(id);
    const o = createCanvas(src.width, src.height);
    ctx2d(o).putImageData(id, 0, 0);
    return o;
  };
}

/** Pixels of the current target (selection area if any) for histograms. */
export function targetImageData(doc: Doc): ImageData | null {
  const t = currentTarget(doc);
  if (!t) return null;
  const sb = doc.selectionBounds();
  const full = { x: 0, y: 0, w: t.canvas.width, h: t.canvas.height };
  const r = sb ? rectIntersect({ x: sb.x - t.x, y: sb.y - t.y, w: sb.w, h: sb.h }, full) : full;
  if (!r) return null;
  const src = t.alphaOnly ? alphaToGray(t.canvas) : t.canvas;
  return ctx2d(src).getImageData(r.x, r.y, r.w, r.h);
}
