// Image > Adjustments: modal dialogs with live preview, Auto Tone/Contrast/Color,
// Shadows/Highlights and the menu item lists.
import { app } from '../app';
import { getAdjustment } from '../core/adjustments';
import { applyLuts, autoRanges, clipRange, computeHistogram, stretchLUT } from '../core/adjustments-impl';
import { blurCanvas, clamp, createCanvas, ctx2d, getImageData, rafThrottle } from '../core/util';
import { applyFilter, editableTarget, endPreview, FilterFn, pixelFn, previewFilter, targetImageData } from '../ops/target';
import { h } from '../ui/dom';
import { MenuItem, SEP } from '../ui/menutypes';
import { checkbox, section, sliderField } from '../ui/widgets';
import { openDialog } from './dialog';

export { histogramCanvas } from '../core/adjustments-impl';

const DIALOG_WIDTH: Record<string, number> = { curves: 480, huesat: 480 };

/** Photoshop-style adjustment dialog with live preview on the canvas (Image > Adjustments). */
export async function openAdjustmentDialog(kind: string): Promise<void> {
  const def = getAdjustment(kind);
  const doc = app.doc;
  if (!def || !doc) return;
  if (def.noDialog) {
    const p = def.defaults();
    await applyFilter(def.name, pixelFn((img) => def.apply(img.data, p)));
    return;
  }
  if (!(await editableTarget(doc, `use the ${def.name} command`))) return;
  let params = def.defaults();
  const src = targetImageData(doc);
  let preview = true, open = true;
  const filter = (): FilterFn => { const p = params; return pixelFn((img) => def.apply(img.data, p)); };
  const update = rafThrottle(() => {
    if (!open) return;
    if (preview) previewFilter(filter()); else endPreview();
  });
  const content = def.buildUI(params, (p) => { params = p; update(); }, { source: () => src });
  const ok = await openDialog({
    title: def.name, content, layout: 'side', width: DIALOG_WIDTH[kind] ?? 470,
    preview: { checked: true, onToggle: (on) => { preview = on; update(); } },
    onOpen: () => update(),
  });
  open = false;
  if (ok) await applyFilter(def.name, filter());
  else endPreview();
}

// ---------- Auto Tone / Contrast / Color ----------
async function runAuto(name: string, luts: (d: Uint8ClampedArray) => Uint8Array[] | null): Promise<void> {
  if (!app.doc) return;
  await applyFilter(name, pixelFn((img) => {
    const l = luts(img.data);
    if (l) applyLuts(img.data, l[0], l[1], l[2]);
  }));
}

/** Per-channel levels stretch, clipping 0.1% at each end. */
export function autoTone(): Promise<void> {
  return runAuto('Auto Tone', (d) => {
    const a = autoRanges(d);
    return a.hist.count ? [stretchLUT(...a.r), stretchLUT(...a.g), stretchLUT(...a.b)] : null;
  });
}

/** Same stretch for all channels (preserves color). */
export function autoContrast(): Promise<void> {
  return runAuto('Auto Contrast', (d) => {
    const hs = computeHistogram(d);
    if (!hs.count) return null;
    const all = new Uint32Array(256);
    for (let i = 0; i < 256; i++) all[i] = hs.r[i] + hs.g[i] + hs.b[i];
    const [lo, hi] = clipRange(all, hs.count * 3);
    const l = stretchLUT(lo, hi);
    return [l, l, l];
  });
}

/** Per-channel stretch, then per-channel gamma so near-neutral midtones become gray. */
export function autoColor(): Promise<void> {
  return runAuto('Auto Color', (d) => {
    const a = autoRanges(d);
    if (!a.hist.count) return null;
    const L = [stretchLUT(...a.r), stretchLUT(...a.g), stretchLUT(...a.b)];
    let sr = 0, sg = 0, sb = 0, n = 0, ar = 0, ag = 0, ab = 0, na = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const r = L[0][d[i]], g = L[1][d[i + 1]], b = L[2][d[i + 2]];
      ar += r; ag += g; ab += b; na++;
      const y = (r + g + b) / 3;
      if (Math.max(r, g, b) - Math.min(r, g, b) < 40 && y > 40 && y < 215) { sr += r; sg += g; sb += b; n++; }
    }
    if (n < na * 0.01) { sr = ar; sg = ag; sb = ab; n = na; }
    const means = [sr / n, sg / n, sb / n], t = clamp((means[0] + means[1] + means[2]) / 3, 1, 254) / 255;
    return [a.r, a.g, a.b].map((rg, k) => {
      const exp = clamp(Math.log(t) / Math.log(clamp(means[k], 1, 254) / 255), 0.6, 1.6);
      return stretchLUT(rg[0], rg[1], 1 / exp);
    });
  });
}

// ---------- Shadows/Highlights ----------
interface SH { sAmount: number; sTone: number; sRadius: number; hAmount: number; hTone: number; hRadius: number; color: number; midtone: number }
const SH_DEFAULTS: SH = { sAmount: 35, sTone: 50, sRadius: 30, hAmount: 0, hTone: 50, hRadius: 30, color: 20, midtone: 0 };
let shMore = false;

/** Blurred luminance (0..255 per pixel) used as the local tone mask. */
function lumMask(d: Uint8ClampedArray, w: number, hh: number, radius: number): Uint8Array {
  const lc = createCanvas(w, hh), lx = ctx2d(lc);
  const li = lx.createImageData(w, hh), ld = li.data;
  for (let i = 0; i < d.length; i += 4) {
    ld[i] = ld[i + 1] = ld[i + 2] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    ld[i + 3] = 255;
  }
  lx.putImageData(li, 0, 0);
  const bd = getImageData(radius > 0 ? blurCanvas(lc, radius / 2) : lc).data;
  const m = new Uint8Array(w * hh);
  for (let j = 0, i = 0; j < m.length; j++, i += 4) m[j] = bd[i];
  return m;
}

/** Shadows/Highlights as a FilterFn. `cache` keeps masks across preview updates (pixels don't change while the dialog is open). */
function shFilter(p: SH, cache: Map<string, Uint8Array>): FilterFn {
  return (src) => {
    const w = src.width, hh = src.height;
    const img = getImageData(src), d = img.data;
    const mask = (r: number) => {
      const key = `${w}x${hh}:${r}`;
      let m = cache.get(key);
      if (!m) {
        m = lumMask(d, w, hh, r);
        if (cache.size >= 3) cache.delete(cache.keys().next().value as string);
        cache.set(key, m);
      }
      return m;
    };
    const as = p.sAmount / 100, ah = p.hAmount / 100, mid = p.midtone / 100, cf = 0.5 + p.color / 200;
    const ms = as > 0 ? mask(p.sRadius) : null, mh = ah > 0 ? mask(p.hRadius) : null;
    if (!ms && !mh && !mid) return src;
    const ws = Math.max(0.02, p.sTone / 100), wh = Math.max(0.02, p.hTone / 100);
    for (let j = 0, i = 0; i < d.length; j++, i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const Y = (0.299 * R + 0.587 * G + 0.114 * B) / 255;
      let y = Y;
      if (ms) { // lift where the local average is dark
        let f = 1 - ms[j] / 255 / ws;
        if (f > 0) { f = f * f * (3 - 2 * f); const k = 5 * as * f; y = (y * (1 + k)) / (1 + k * y); }
      }
      if (mh) { // compress where the local average is bright
        let f = 1 - (1 - mh[j] / 255) / wh;
        if (f > 0) { f = f * f * (3 - 2 * f); const k = 5 * ah * f, q = 1 - y; y = 1 - (q * (1 + k)) / (1 + k * q); }
      }
      if (mid) y += mid * (y * y * (3 - 2 * y) - y);
      if (y === Y) continue;
      // keep color: scale chroma partly with the luminance change (Color slider)
      const cs = Math.max(0, 1 + ((Y > 0.002 ? y / Y : 1) - 1) * cf);
      const Y8 = Y * 255, y8 = y * 255;
      d[i] = y8 + (R - Y8) * cs; d[i + 1] = y8 + (G - Y8) * cs; d[i + 2] = y8 + (B - Y8) * cs;
    }
    const out = createCanvas(w, hh);
    ctx2d(out).putImageData(img, 0, 0);
    return out;
  };
}

/** Image > Adjustments > Shadows/Highlights... */
export async function openShadowsHighlights(): Promise<void> {
  const doc = app.doc;
  if (!doc || !(await editableTarget(doc, 'use the Shadows/Highlights command'))) return;
  let p: SH = { ...SH_DEFAULTS };
  const cache = new Map<string, Uint8Array>();
  let preview = true, open = true;
  const update = rafThrottle(() => {
    if (!open) return;
    if (preview) previewFilter(shFilter(p, cache)); else endPreview();
  });
  const more: HTMLElement[] = [];
  const opt = (el: HTMLElement) => { more.push(el); return el; };
  const field = (label: string, k: keyof SH, min: number, max: number, unit?: string) => sliderField({
    label, value: p[k], min, max, unit, reset: SH_DEFAULTS[k], inline: false,
    onInput: (v) => { p = { ...p, [k]: v }; update(); },
  }).el;
  const showMore = () => more.forEach((el) => { el.style.display = shMore ? '' : 'none'; });
  const content = h('div', { class: 'col', style: { gap: '10px' } },
    section('Shadows', field('Amount', 'sAmount', 0, 100, '%'), opt(field('Tone', 'sTone', 0, 100, '%')), opt(field('Radius', 'sRadius', 0, 500, 'px'))),
    section('Highlights', field('Amount', 'hAmount', 0, 100, '%'), opt(field('Tone', 'hTone', 0, 100, '%')), opt(field('Radius', 'hRadius', 0, 500, 'px'))),
    opt(section('Adjustments', field('Color', 'color', -100, 100), field('Midtone', 'midtone', -100, 100))),
    checkbox({ label: 'Show More Options', checked: shMore, onChange: (v) => { shMore = v; showMore(); } }).el,
  );
  showMore();
  const ok = await openDialog({
    title: 'Shadows/Highlights', content, layout: 'side', width: 470,
    preview: { checked: true, onToggle: (on) => { preview = on; update(); } },
    onOpen: () => update(),
  });
  open = false;
  if (ok) await applyFilter('Shadows/Highlights', shFilter(p, cache));
  else endPreview();
}

// ---------- Menus ----------
const hasDoc = () => !!app.doc;

/** Image > Adjustments submenu (Photoshop order). */
export function adjustmentMenuItems(): MenuItem[] {
  const it = (kind: string, label: string, shortcut?: string): MenuItem => ({
    label, shortcut, enabled: hasDoc, action: () => { void openAdjustmentDialog(kind); },
  });
  return [
    it('brightness', 'Brightness/Contrast...'),
    it('levels', 'Levels...', 'Ctrl+L'),
    it('curves', 'Curves...', 'Ctrl+M'),
    it('exposure', 'Exposure...'),
    SEP,
    it('vibrance', 'Vibrance...'),
    it('huesat', 'Hue/Saturation...', 'Ctrl+U'),
    it('colorbalance', 'Color Balance...', 'Ctrl+B'),
    it('bw', 'Black & White...', 'Alt+Shift+Ctrl+B'),
    it('photofilter', 'Photo Filter...'),
    it('channelmixer', 'Channel Mixer...'),
    it('colorlookup', 'Color Lookup...'),
    SEP,
    it('invert', 'Invert', 'Ctrl+I'),
    it('posterize', 'Posterize...'),
    it('threshold', 'Threshold...'),
    it('gradientmap', 'Gradient Map...'),
    it('selectivecolor', 'Selective Color...'),
    SEP,
    { label: 'Shadows/Highlights...', enabled: hasDoc, action: () => { void openShadowsHighlights(); } },
    SEP,
    it('desaturate', 'Desaturate', 'Shift+Ctrl+U'),
    it('equalize', 'Equalize'),
  ];
}

/** Image menu Auto Tone / Auto Contrast / Auto Color. */
export function autoMenuItems(): MenuItem[] {
  return [
    { label: 'Auto Tone', shortcut: 'Shift+Ctrl+L', enabled: hasDoc, action: () => { void autoTone(); } },
    { label: 'Auto Contrast', shortcut: 'Alt+Shift+Ctrl+L', enabled: hasDoc, action: () => { void autoContrast(); } },
    { label: 'Auto Color', shortcut: 'Shift+Ctrl+B', enabled: hasDoc, action: () => { void autoColor(); } },
  ];
}
