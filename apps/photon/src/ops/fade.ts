// Edit > Fade (Shift+Ctrl+F): right after a filter, adjustment, fill or brush stroke, mix its result back with
// the pixels from before it, by opacity and blend mode. The "before" pixels come from the last history step:
// either the layer canvas it replaced, or the patches a stroke recorded.
import { app } from '../app';
import { Doc } from '../core/document';
import { BLEND_MODES, BLEND_NAMES, BlendMode, Layer } from '../core/layer';
import { NATIVE_BLEND, blendPixels } from '../core/blend';
import { cloneCanvas, createCanvas, ctx2d, rafThrottle } from '../core/util';
import { openDialog } from '../dialogs/dialog';
import { h } from '../ui/dom';
import { select, sliderField } from '../ui/widgets';

interface FadeSource { layer: Layer; before: HTMLCanvasElement; after: HTMLCanvasElement; name: string }

/** The last step, if it changed the active pixel layer's pixels (and nothing has happened since). */
function lastStep(doc: Doc) {
  if (!doc.canUndo || doc.floating) return null;
  const e = doc.history[doc.historyIndex - 1];
  if (e.name.startsWith('Fade ')) return null; // a fade can't be faded again
  const L = doc.active;
  if (!L || L.kind !== 'raster') return null;
  const a = e.after.layers.find((s) => s.layer === L), b = e.before.layers.find((s) => s.layer === L);
  if (!a || !b || a.canvas !== L.canvas || a.x !== b.x || a.y !== b.y || L.x !== a.x || L.y !== a.y) return null;
  if (b.canvas !== a.canvas) {
    return b.canvas.width === a.canvas.width && b.canvas.height === a.canvas.height ? { e, L, b, patches: [] } : null;
  }
  const patches = e.patches.filter((p) => p.canvas === L.canvas);
  return patches.length ? { e, L, b, patches } : null;
}

export const canFade = (doc: Doc | null) => !!doc && !!lastStep(doc);

function fadeSource(doc: Doc): FadeSource | null {
  const s = lastStep(doc);
  if (!s) return null;
  let before = s.b.canvas;
  if (s.patches.length) {
    before = cloneCanvas(s.L.canvas);
    const x = ctx2d(before);
    for (let i = s.patches.length - 1; i >= 0; i--) { const p = s.patches[i]; x.putImageData(p.before, p.x, p.y); }
  }
  return { layer: s.L, before, after: s.L.canvas, name: s.e.name };
}

/** `after` over `before` at `opacity` in `mode`. Normal mode is a straight mix (so fading an eraser works too). */
function faded(before: HTMLCanvasElement, after: HTMLCanvasElement, opacity: number, mode: BlendMode): HTMLCanvasElement {
  const w = before.width, hh = before.height;
  const out = createCanvas(w, hh);
  const ox = ctx2d(out);
  if (mode === 'normal') {
    const bd = ctx2d(before).getImageData(0, 0, w, hh).data, ad = ctx2d(after).getImageData(0, 0, w, hh);
    const d = ad.data, o = opacity;
    for (let i = 0; i < d.length; i += 4) {
      const ab = bd[i + 3] / 255, aa = d[i + 3] / 255;
      const al = ab + (aa - ab) * o;
      if (al <= 0) { d[i + 3] = 0; continue; }
      for (let c = 0; c < 3; c++) d[i + c] = (bd[i + c] * ab + (d[i + c] * aa - bd[i + c] * ab) * o) / al;
      d[i + 3] = al * 255;
    }
    ox.putImageData(ad, 0, 0);
    return out;
  }
  ox.drawImage(before, 0, 0);
  const native = NATIVE_BLEND[mode];
  if (native) {
    ox.globalCompositeOperation = native;
    ox.globalAlpha = opacity;
    ox.drawImage(after, 0, 0);
    return out;
  }
  const dst = ox.getImageData(0, 0, w, hh);
  blendPixels(dst.data, ctx2d(after).getImageData(0, 0, w, hh).data, mode, opacity, w);
  ox.putImageData(dst, 0, 0);
  return out;
}

export async function fadeDialog() {
  const doc = app.doc;
  if (!doc) return;
  const src = fadeSource(doc);
  if (!src) return;
  const L = src.layer;
  let opacity = 1, mode: BlendMode = 'normal', preview = true, open = true;
  const update = rafThrottle(() => {
    if (!open) return;
    L.preview = preview && (opacity < 1 || mode !== 'normal') ? faded(src.before, src.after, opacity, mode) : null;
    L.touch();
    doc.invalidate();
  });
  const op = sliderField({ label: 'Opacity:', value: 100, min: 0, max: 100, unit: '%', onInput: (v) => { opacity = v / 100; update(); } });
  const ms = select({
    options: BLEND_MODES.map((m) => (m === '-' ? '-' : { value: m, label: BLEND_NAMES[m as BlendMode] })) as any,
    value: 'normal', width: 170, onChange: (v) => { mode = v as BlendMode; update(); },
  });
  const ok = await openDialog({
    title: 'Fade', width: 380,
    content: h('div', { class: 'col' }, h('div', { class: 'field-label' }, `Fade ${src.name}`), op.el, h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Mode:'), ms.el)),
    preview: { checked: true, onToggle: (on) => { preview = on; update(); } },
  });
  open = false;
  L.preview = null;
  L.touch();
  if (!ok || (opacity === 1 && mode === 'normal')) { doc.invalidate(); return; }
  const before = doc.captureState();
  L.canvas = faded(src.before, src.after, opacity, mode);
  L.touch();
  doc.commit(`Fade ${src.name}`, before);
}
