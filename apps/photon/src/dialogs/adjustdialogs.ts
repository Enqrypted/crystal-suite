// Image > Adjustments: modal dialogs with live preview, Auto Tone/Contrast/Color,
// Shadows/Highlights and the menu item lists.
import { app } from '../app';
import { getAdjustment } from '../core/adjustments';
import { applyLuts, autoRanges, clipRange, computeHistogram, stretchLUT } from '../core/adjustments-impl';
import { blurCanvas, clamp, createCanvas, ctx2d, getImageData, hslToRgb, rafThrottle, rgbToHsl } from '../core/util';
import { applyFilter, editableTarget, endPreview, FilterFn, pixelFn, previewFilter, targetImageData } from '../ops/target';
import { h } from '../ui/dom';
import { MenuItem, SEP } from '../ui/menutypes';
import { checkbox, section, sliderField } from '../ui/widgets';
import { openDialog } from './dialog';
import { injectStyle } from '../ui/dom';

injectStyle('replacecolor', '.rc-swatch { width: 34px; height: 22px; border: 1px solid var(--input-border); border-radius: 2px; }');

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
    { label: 'Replace Color...', enabled: hasDoc, action: () => { void openReplaceColor(); } },
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

// ---------- Replace Color ----------
/** How much a pixel belongs to the sampled color: the same falloff as Select > Color Range. */
function rangeWeight(r: number, g: number, b: number, c: { r: number; g: number; b: number }, f: number) {
  const d = Math.max(Math.abs(r - c.r), Math.abs(g - c.g), Math.abs(b - c.b));
  return d <= f ? 1 - (d / f) * (d / f) * 0.5 : Math.max(0, 1 - d / (f * 1.5)) * 0.5;
}

interface RC { color: { r: number; g: number; b: number }; fuzz: number; hue: number; sat: number; light: number }

function replaceColorPixels(d: Uint8ClampedArray, p: RC) {
  const f = Math.max(1, p.fuzz);
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const w = rangeWeight(d[i], d[i + 1], d[i + 2], p.color, f);
    if (w <= 0.002) continue;
    const [hh, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    const ns = clamp(s + (p.sat / 100) * (p.sat > 0 ? 1 - s : s), 0, 1);
    const nl = clamp(l + (p.light / 100) * (p.light > 0 ? 1 - l : l), 0, 1);
    const [r, g, b] = hslToRgb((hh + p.hue + 360) % 360, ns, nl);
    d[i] += (r - d[i]) * w; d[i + 1] += (g - d[i + 1]) * w; d[i + 2] += (b - d[i + 2]) * w;
  }
}

/** Image > Adjustments > Replace Color: pick a color in the preview, then shift its hue, saturation and lightness. */
export async function openReplaceColor(): Promise<void> {
  const doc = app.doc;
  if (!doc || !(await editableTarget(doc, 'use the Replace Color command'))) return;
  const src = targetImageData(doc);
  if (!src) return;
  const p: RC = { color: { ...app.fg }, fuzz: 40, hue: 0, sat: 0, light: 0 };
  let preview = true, open = true, showSel = true;
  // small copy of the pixels for the selection preview
  const s = Math.min(1, 220 / Math.max(src.width, src.height));
  const small = createCanvas(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
  const full = createCanvas(src.width, src.height);
  ctx2d(full).putImageData(src, 0, 0);
  ctx2d(small).drawImage(full, 0, 0, small.width, small.height);
  const smallImg = getImageData(small);
  const view = createCanvas(small.width, small.height);
  view.style.cursor = 'crosshair';
  const pickedSw = h('div', { class: 'rc-swatch', title: 'Sampled color' });
  const resultSw = h('div', { class: 'rc-swatch', title: 'Result' });
  const drawView = () => {
    const x = ctx2d(view);
    if (!showSel) { x.drawImage(small, 0, 0); return; }
    const out = x.createImageData(view.width, view.height), od = out.data, sd = smallImg.data, f = Math.max(1, p.fuzz);
    for (let i = 0; i < sd.length; i += 4) {
      const v = Math.round(rangeWeight(sd[i], sd[i + 1], sd[i + 2], p.color, f) * (sd[i + 3] / 255) * 255);
      od[i] = od[i + 1] = od[i + 2] = v; od[i + 3] = 255;
    }
    x.putImageData(out, 0, 0);
  };
  const drawSwatches = () => {
    pickedSw.style.background = `rgb(${p.color.r},${p.color.g},${p.color.b})`;
    const one = new Uint8ClampedArray([p.color.r, p.color.g, p.color.b, 255]);
    replaceColorPixels(one, p);
    resultSw.style.background = `rgb(${one[0]},${one[1]},${one[2]})`;
  };
  const filter = (): FilterFn => { const q = { ...p, color: { ...p.color } }; return pixelFn((img) => replaceColorPixels(img.data, q)); };
  const update = rafThrottle(() => {
    if (!open) return;
    drawView();
    drawSwatches();
    if (preview) previewFilter(filter()); else endPreview();
  });
  view.addEventListener('pointerdown', (e) => {
    const r = view.getBoundingClientRect();
    const px = Math.min(small.width - 1, Math.floor(((e.clientX - r.left) / r.width) * small.width));
    const py = Math.min(small.height - 1, Math.floor(((e.clientY - r.top) / r.height) * small.height));
    const i = (py * small.width + px) * 4;
    p.color = { r: smallImg.data[i], g: smallImg.data[i + 1], b: smallImg.data[i + 2] };
    update();
  });
  const mode = h('div', { class: 'row' });
  for (const [v, label] of [[true, 'Selection'], [false, 'Image']] as const) {
    const id = `rc-${label}`;
    const input = h('input', { type: 'radio', name: 'rc-view', id, class: 'ps-radio' }) as HTMLInputElement;
    input.checked = showSel === v;
    input.addEventListener('change', () => { showSel = v; update(); });
    mode.append(input, h('label', { for: id, class: 'field-label' }, label));
  }
  const ok = await openDialog({
    title: 'Replace Color', layout: 'side', width: 440,
    content: h('div', { class: 'col' },
      section('Selection',
        h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Color:'), pickedSw, h('span', { class: 'field-label', style: { fontSize: '11px' } }, 'Click in the preview to sample')),
        sliderField({ label: 'Fuzziness:', value: p.fuzz, min: 0, max: 200, onInput: (v) => { p.fuzz = v; update(); } }).el,
        h('div', { class: 'preview-box', style: { height: '230px' } }, view),
        mode),
      section('Replacement',
        sliderField({ label: 'Hue:', value: 0, min: -180, max: 180, onInput: (v) => { p.hue = v; update(); } }).el,
        sliderField({ label: 'Saturation:', value: 0, min: -100, max: 100, onInput: (v) => { p.sat = v; update(); } }).el,
        sliderField({ label: 'Lightness:', value: 0, min: -100, max: 100, onInput: (v) => { p.light = v; update(); } }).el,
        h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Result:'), resultSw))),
    preview: { checked: true, onToggle: (on) => { preview = on; update(); } },
    onOpen: () => update(),
  });
  open = false;
  if (ok) await applyFilter('Replace Color', filter());
  else endPreview();
}
