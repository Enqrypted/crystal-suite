// Filter > Camera Raw Filter: develop sliders with a live downscaled preview, RGB histogram,
// collapsible panels and a Before/After toggle (\). OK renders the same pipeline at full resolution.
import { app } from '../app';
import { CAMERA_RAW_DEFAULTS, cameraRaw, CameraRawCache, CameraRawParams } from '../core/filters';
import { checkerboard, createCanvas, ctx2d, getImageData, rafThrottle } from '../core/util';
import { alphaToGray, applyFilter, editableTarget } from '../ops/target';
import { h, injectStyle } from '../ui/dom';
import { icon } from '../ui/icons';
import { button, Field, sliderField } from '../ui/widgets';
import { openDialog } from './dialog';

injectStyle('cameraraw', `
.dlg.camera-raw .big-preview { height: min(78vh, 780px); }
.dlg.camera-raw .stage canvas { left: 0; top: 0; }
.dlg.camera-raw .controls { width: 300px; gap: 6px; }
.dlg.camera-raw .cr-label { position: absolute; left: 10px; top: 8px; padding: 2px 8px; border-radius: 3px; background: var(--panel-2); color: var(--text-strong); font-size: 11px; pointer-events: none; }
.dlg.camera-raw .histogram { height: 110px; flex-shrink: 0; }
.dlg.camera-raw .cr-sec { border-top: 1px solid var(--divider); }
.dlg.camera-raw .cr-head { display: flex; align-items: center; gap: 6px; padding: 7px 2px; color: var(--text-strong); font-weight: 600; cursor: default; user-select: none; }
.dlg.camera-raw .cr-head:hover { color: var(--accent-2); }
.dlg.camera-raw .cr-head .ico { transition: transform .12s; }
.dlg.camera-raw .cr-sec.closed .cr-head .ico { transform: rotate(-90deg); }
.dlg.camera-raw .cr-body { display: flex; flex-direction: column; gap: 8px; padding: 2px 4px 12px 4px; }
.dlg.camera-raw .cr-sec.closed .cr-body { display: none; }
.dlg.camera-raw .cr-sub { color: var(--text-2); font-size: 11px; margin-top: 4px; }
.dlg.camera-raw .ps-btn.active { background: var(--accent); color: #fff; }
body.photon-busy, body.photon-busy * { cursor: progress !important; }
`);

type Key = keyof CameraRawParams;
interface SliderDef { key: Key; label: string; min: number; max: number; step?: number; track?: string }

const TEMP_TRACK = 'linear-gradient(90deg, #3b6fd8, #d8d8d8, #e0b030)';
const TINT_TRACK = 'linear-gradient(90deg, #3fae4a, #d8d8d8, #c447c4)';
const SAT_TRACK = 'linear-gradient(90deg, #808080, #ff4040 30%, #ffd040 50%, #40c0ff 75%, #c040ff)';

const PANELS: { title: string; open: boolean; groups: { sub?: string; sliders: SliderDef[] }[] }[] = [
  {
    title: 'Basic', open: true, groups: [
      { sub: 'White Balance', sliders: [
        { key: 'temperature', label: 'Temperature', min: -100, max: 100, track: TEMP_TRACK },
        { key: 'tint', label: 'Tint', min: -100, max: 100, track: TINT_TRACK },
      ] },
      { sub: 'Tone', sliders: [
        { key: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.05 },
        { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
        { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
        { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
        { key: 'whites', label: 'Whites', min: -100, max: 100 },
        { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
      ] },
      { sub: 'Presence', sliders: [
        { key: 'texture', label: 'Texture', min: -100, max: 100 },
        { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
        { key: 'dehaze', label: 'Dehaze', min: -100, max: 100 },
        { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, track: SAT_TRACK },
        { key: 'saturation', label: 'Saturation', min: -100, max: 100, track: SAT_TRACK },
      ] },
    ],
  },
  {
    title: 'Detail', open: false, groups: [{ sliders: [
      { key: 'sharpening', label: 'Sharpening', min: 0, max: 150 },
      { key: 'noiseReduction', label: 'Noise Reduction', min: 0, max: 100 },
    ] }],
  },
  {
    title: 'Effects', open: false, groups: [
      { sub: 'Vignette', sliders: [
        { key: 'vignette', label: 'Amount', min: -100, max: 100 },
        { key: 'vignetteMidpoint', label: 'Midpoint', min: 0, max: 100 },
      ] },
      { sub: 'Grain', sliders: [{ key: 'grain', label: 'Amount', min: 0, max: 100 }] },
    ],
  },
];

const isDefault = (p: CameraRawParams) => (Object.keys(CAMERA_RAW_DEFAULTS) as Key[]).every((k) => p[k] === CAMERA_RAW_DEFAULTS[k]);

function drawHistogram(cv: HTMLCanvasElement, id: ImageData | null) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), hh = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
  const x = ctx2d(cv);
  x.clearRect(0, 0, w, hh);
  if (!id) return;
  const R = new Float64Array(256), G = new Float64Array(256), B = new Float64Array(256), d = id.data;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 8) continue; R[d[i]]++; G[d[i + 1]]++; B[d[i + 2]]++; }
  // scale by a high percentile so spikes don't flatten the graph
  const all = [...R, ...G, ...B].sort((a, b) => a - b);
  const top = Math.max(1, all[Math.floor(all.length * 0.985)] * 1.15);
  x.globalCompositeOperation = 'lighter';
  const plot = (hist: Float64Array, color: string) => {
    x.fillStyle = color;
    x.beginPath();
    x.moveTo(0, hh);
    for (let i = 0; i < 256; i++) x.lineTo((i / 255) * w, hh - Math.min(1, hist[i] / top) * (hh - 2));
    x.lineTo(w, hh);
    x.closePath();
    x.fill();
  };
  plot(R, 'rgba(225,60,60,.75)');
  plot(G, 'rgba(60,200,80,.75)');
  plot(B, 'rgba(60,110,240,.75)');
  x.globalCompositeOperation = 'source-over';
}

export async function openCameraRaw(): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const t = await editableTarget(doc, 'use the Camera Raw Filter');
  if (!t) return;
  const full = t.alphaOnly ? alphaToGray(t.canvas) : t.canvas;
  const W = full.width, H = full.height, fullDim = Math.max(W, H);
  const p: CameraRawParams = { ...CAMERA_RAW_DEFAULTS };

  // ---------- stage ----------
  const view = h('canvas') as HTMLCanvasElement;
  const label = h('div', { class: 'cr-label' }, 'After');
  const stage = h('div', { class: 'stage' }, view, label);
  const hist = h('canvas', { class: 'histogram' }) as HTMLCanvasElement;
  let preview: HTMLCanvasElement | null = null, result: HTMLCanvasElement | null = null, scale = 1;
  let cache: CameraRawCache = { maps: new Map() };
  let before = false;
  let sw = 0, sh = 0, dpr = 1;

  const draw = () => {
    if (!preview || !sw) return;
    const x = ctx2d(view);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, view.width, view.height);
    const img = before || !result ? preview : result;
    const dw = img.width, dh = img.height, ox = Math.round((view.width - dw) / 2), oy = Math.round((view.height - dh) / 2);
    x.fillStyle = x.createPattern(checkerboard(), 'repeat') ?? '#fff';
    x.fillRect(ox, oy, dw, dh);
    x.drawImage(img, ox, oy);
    label.textContent = before ? 'Before' : 'After';
  };
  const render = rafThrottle(() => {
    if (!preview) return;
    try { result = isDefault(p) ? preview : cameraRaw(preview, p, fullDim, scale, cache); } catch (e) { console.error('[Camera Raw]', e); }
    draw();
    drawHistogram(hist, result ? getImageData(result) : null);
  });
  const buildPreview = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.max(1, Math.round(sw * dpr) - 16), ph = Math.max(1, Math.round(sh * dpr) - 16);
    scale = Math.min(1, pw / W, ph / H);
    const c = createCanvas(Math.max(1, Math.round(W * scale)), Math.max(1, Math.round(H * scale)));
    const x = ctx2d(c);
    x.imageSmoothingQuality = 'high';
    x.drawImage(full, 0, 0, c.width, c.height);
    preview = c;
    cache = { maps: new Map() };
  };
  const ro = new ResizeObserver(() => {
    const w = Math.floor(stage.clientWidth), hh = Math.floor(stage.clientHeight);
    if (!w || !hh || (w === sw && hh === sh)) return;
    sw = w; sh = hh;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    view.width = Math.round(sw * dpr); view.height = Math.round(sh * dpr);
    view.style.width = `${sw}px`; view.style.height = `${sh}px`;
    buildPreview();
    render();
  });

  // ---------- controls ----------
  const fields = new Map<Key, Field<number>>();
  const panel = (title: string, open: boolean, body: HTMLElement[]) => {
    const sec = h('div', { class: `cr-sec${open ? '' : ' closed'}` },
      h('div', { class: 'cr-head', onclick: () => sec.classList.toggle('closed') }, icon('chevron-down', 12), h('span', null, title)),
      h('div', { class: 'cr-body' }, body));
    return sec;
  };
  const panels = PANELS.map((pn) => panel(pn.title, pn.open, pn.groups.flatMap((g) => [
    g.sub ? h('div', { class: 'cr-sub' }, g.sub) : null,
    ...g.sliders.map((s) => {
      const f = sliderField({
        label: s.label, value: p[s.key], min: s.min, max: s.max, step: s.step ?? 1, track: s.track, width: 52,
        reset: CAMERA_RAW_DEFAULTS[s.key], onInput: (v) => { p[s.key] = v; render(); },
      });
      fields.set(s.key, f);
      return f.el;
    }),
  ].filter((e): e is HTMLElement => !!e))));
  const controls = h('div', { class: 'controls' }, hist, panels);
  const content = h('div', { class: 'big-preview' }, stage, controls);

  const toggleBefore = () => { before = !before; baBtn.classList.toggle('active', before); draw(); };
  const baBtn = button('Before / After', toggleBefore, { title: 'Toggle Before/After (\\)' });
  const resetBtn = button('Reset', () => {
    Object.assign(p, CAMERA_RAW_DEFAULTS);
    fields.forEach((f, k) => f.set(p[k]));
    render();
  }, { title: 'Reset all settings' });

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    if (e.key === '\\' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); toggleBefore(); }
  };

  const ok = await openDialog({
    title: 'Camera Raw Filter', content, layout: 'bottom', className: 'camera-raw',
    width: Math.round(Math.min(1200, window.innerWidth * 0.95)),
    extraButtons: [baBtn, resetBtn],
    onOpen: () => { window.addEventListener('keydown', onKey, true); ro.observe(stage); },
  });
  ro.disconnect();
  window.removeEventListener('keydown', onKey, true);
  if (!ok || isDefault(p)) return;

  const q = { ...p };
  const fn = (s: HTMLCanvasElement) => cameraRaw(s, q, fullDim, 1);
  document.body.classList.add('photon-busy');
  await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    const done = await applyFilter('Camera Raw Filter', fn, { wholeLayer: true });
    if (done) app.lastFilter = { name: 'Camera Raw Filter', run: () => void applyFilter('Camera Raw Filter', fn, { wholeLayer: true }) };
  } finally {
    document.body.classList.remove('photon-busy');
  }
}
