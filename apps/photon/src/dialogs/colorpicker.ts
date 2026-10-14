// Photoshop-style Color Picker: big field + strip for the selected component, HSB/RGB/Lab/CMYK fields.
import { openDialog } from './dialog';
import { h } from '../ui/dom';
import { numberInput, checkbox, setColorPickerImpl, button } from '../ui/widgets';
import {
  RGB, clamp, createCanvas, ctx2d, cssColor, hsvToRgb, rgbToHsv, rgbToHex, hexToRgb, rgbToLab, labToRgb, rgbToCmyk, cmykToRgb,
} from '../core/util';
import { app } from '../app';

type Comp = 'H' | 'S' | 'B' | 'R' | 'G' | 'Bl';

export function openColorPicker(initial: RGB, title = 'Color Picker'): Promise<RGB | null> {
  let hsv = rgbToHsv(initial);
  let rgb = { ...initial };
  let comp: Comp = 'H';
  let webOnly = false;
  const S = 256;
  const field = createCanvas(S, S), strip = createCanvas(20, S);
  const fieldWrap = h('div', { class: 'field' }, field, h('div', { class: 'sv-marker' }));
  const stripWrap = h('div', { class: 'strip' }, strip, h('div', { class: 'hue-marker' }));
  const newSw = h('div', { class: 'new' }), curSw = h('div', { class: 'cur', style: { background: cssColor(initial) } });
  curSw.title = 'Click to restore the original color';
  curSw.addEventListener('click', () => setRGB(initial));

  const num = (max: number, onChange: (v: number) => void, min = 0) => numberInput({ value: 0, min, max, width: 52, onChange });
  const fH = num(360, (v) => setHSV({ ...hsv, h: v }));
  const fS = num(100, (v) => setHSV({ ...hsv, s: v }));
  const fB = num(100, (v) => setHSV({ ...hsv, v }));
  const fR = num(255, (v) => setRGB({ ...rgb, r: v }));
  const fG = num(255, (v) => setRGB({ ...rgb, g: v }));
  const fBl = num(255, (v) => setRGB({ ...rgb, b: v }));
  const fL = num(100, (v) => { const l = rgbToLab(rgb); setRGB(labToRgb(v, l.a, l.b)); });
  const fa = num(127, (v) => { const l = rgbToLab(rgb); setRGB(labToRgb(l.l, v, l.b)); }, -128);
  const fb = num(127, (v) => { const l = rgbToLab(rgb); setRGB(labToRgb(l.l, l.a, v)); }, -128);
  const fC = num(100, (v) => { const k = rgbToCmyk(rgb); setRGB(cmykToRgb(v, k.m, k.y, k.k)); });
  const fM = num(100, (v) => { const k = rgbToCmyk(rgb); setRGB(cmykToRgb(k.c, v, k.y, k.k)); });
  const fY = num(100, (v) => { const k = rgbToCmyk(rgb); setRGB(cmykToRgb(k.c, k.m, v, k.k)); });
  const fK = num(100, (v) => { const k = rgbToCmyk(rgb); setRGB(cmykToRgb(k.c, k.m, k.y, v)); });
  const hex = h('input', { class: 'ps-input', style: { width: '80px', fontFamily: 'Consolas, monospace' } }) as HTMLInputElement;
  hex.addEventListener('change', () => { const c = hexToRgb(hex.value); if (c) setRGB(c); });
  hex.addEventListener('keydown', (e) => e.stopPropagation());

  const radio = (c: Comp) => {
    const r = h('input', { type: 'radio', name: 'cp-comp', checked: comp === c }) as HTMLInputElement;
    r.addEventListener('change', () => { comp = c; draw(); });
    return r;
  };
  const unit = (s: string) => h('span', { class: 'field-label' }, s);
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'auto 18px 52px 14px', gap: '5px 4px', alignItems: 'center', fontSize: '11px' } },
    radio('H'), h('span', null, 'H:'), fH.el, unit('°'),
    radio('S'), h('span', null, 'S:'), fS.el, unit('%'),
    radio('B'), h('span', null, 'B:'), fB.el, unit('%'),
    h('span'), h('span'), h('span'), h('span'),
    radio('R'), h('span', null, 'R:'), fR.el, h('span'),
    radio('G'), h('span', null, 'G:'), fG.el, h('span'),
    radio('Bl'), h('span', null, 'B:'), fBl.el, h('span'));
  const grid2 = h('div', { style: { display: 'grid', gridTemplateColumns: '18px 52px 14px', gap: '5px 4px', alignItems: 'center', fontSize: '11px' } },
    h('span', null, 'L:'), fL.el, h('span'), h('span', null, 'a:'), fa.el, h('span'), h('span', null, 'b:'), fb.el, h('span'),
    h('span'), h('span'), h('span'),
    h('span', null, 'C:'), fC.el, unit('%'), h('span', null, 'M:'), fM.el, unit('%'), h('span', null, 'Y:'), fY.el, unit('%'), h('span', null, 'K:'), fK.el, unit('%'));
  const web = checkbox({ label: 'Only Web Colors', checked: false, onChange: (v) => { webOnly = v; if (v) setRGB(rgb); } });

  const content = h('div', { class: 'cp' }, fieldWrap, stripWrap,
    h('div', { class: 'col', style: { gap: '10px' } },
      h('div', { class: 'cmp' }, h('span', null, 'new'), newSw, curSw, h('span', null, 'current')),
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '14px' } }, grid, grid2),
      h('div', { class: 'hexrow' }, h('span', null, '#'), hex), web.el,
      button('Add to Swatches', () => {
        try {
          const l = JSON.parse(localStorage.getItem('photon.swatches') || 'null') ?? [];
          l.push(`#${rgbToHex(rgb)}`);
          localStorage.setItem('photon.swatches', JSON.stringify(l));
        } catch { /* ignore */ }
      }, { small: true })));

  function snapWeb(c: RGB): RGB { const s = (v: number) => Math.round(v / 51) * 51; return { r: s(c.r), g: s(c.g), b: s(c.b) }; }
  function setRGB(c: RGB) {
    rgb = webOnly ? snapWeb(c) : { r: Math.round(clamp(c.r, 0, 255)), g: Math.round(clamp(c.g, 0, 255)), b: Math.round(clamp(c.b, 0, 255)) };
    const n = rgbToHsv(rgb);
    hsv = { h: n.s > 0 && n.v > 0 ? n.h : hsv.h, s: n.v > 0 ? n.s : hsv.s, v: n.v };
    draw();
  }
  function setHSV(c: { h: number; s: number; v: number }) {
    hsv = { h: clamp(c.h, 0, 360), s: clamp(c.s, 0, 100), v: clamp(c.v, 0, 100) };
    rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
    if (webOnly) rgb = snapWeb(rgb);
    draw();
  }
  // field: x/y components and strip component per selected radio
  function fieldColor(fx: number, fy: number, z: number): RGB {
    switch (comp) {
      case 'H': return hsvToRgb(z * 360, fx * 100, (1 - fy) * 100);
      case 'S': return hsvToRgb(fx * 360, z * 100, (1 - fy) * 100);
      case 'B': return hsvToRgb(fx * 360, (1 - fy) * 100, z * 100);
      case 'R': return { r: z * 255, g: (1 - fy) * 255, b: fx * 255 };
      case 'G': return { r: (1 - fy) * 255, g: z * 255, b: fx * 255 };
      default: return { r: fx * 255, g: (1 - fy) * 255, b: z * 255 };
    }
  }
  function zOf(): number {
    return comp === 'H' ? hsv.h / 360 : comp === 'S' ? hsv.s / 100 : comp === 'B' ? hsv.v / 100 : comp === 'R' ? rgb.r / 255 : comp === 'G' ? rgb.g / 255 : rgb.b / 255;
  }
  function xyOf(): [number, number] {
    switch (comp) {
      case 'H': return [hsv.s / 100, 1 - hsv.v / 100];
      case 'S': return [hsv.h / 360, 1 - hsv.v / 100];
      case 'B': return [hsv.h / 360, 1 - hsv.s / 100];
      case 'R': return [rgb.b / 255, 1 - rgb.g / 255];
      case 'G': return [rgb.b / 255, 1 - rgb.r / 255];
      default: return [rgb.r / 255, 1 - rgb.g / 255];
    }
  }
  let lastFieldKey = '';
  function draw() {
    const z = zOf();
    const key = `${comp}|${comp === 'H' ? Math.round(hsv.h) : Math.round(z * 255)}`;
    if (key !== lastFieldKey) {
      lastFieldKey = key;
      const fx = ctx2d(field);
      const id = fx.createImageData(S, S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const c = fieldColor(x / (S - 1), y / (S - 1), z);
        const i = (y * S + x) * 4;
        id.data[i] = c.r; id.data[i + 1] = c.g; id.data[i + 2] = c.b; id.data[i + 3] = 255;
      }
      fx.putImageData(id, 0, 0);
    }
    const sx = ctx2d(strip);
    const [px, py] = xyOf();
    for (let y = 0; y < S; y++) {
      const zz = 1 - y / (S - 1);
      const c = comp === 'H' ? hsvToRgb(zz * 360, 100, 100) : fieldColor(px, py, zz);
      sx.fillStyle = cssColor(c);
      sx.fillRect(0, y, 20, 1);
    }
    const m = fieldWrap.querySelector('.sv-marker') as HTMLElement;
    m.style.left = `${px * 100}%`; m.style.top = `${py * 100}%`;
    (stripWrap.querySelector('.hue-marker') as HTMLElement).style.top = `${(1 - z) * 100}%`;
    newSw.style.background = cssColor(rgb);
    fH.set(Math.round(hsv.h)); fS.set(Math.round(hsv.s)); fB.set(Math.round(hsv.v));
    fR.set(rgb.r); fG.set(rgb.g); fBl.set(rgb.b);
    const l = rgbToLab(rgb); fL.set(Math.round(l.l)); fa.set(Math.round(l.a)); fb.set(Math.round(l.b));
    const k = rgbToCmyk(rgb); fC.set(Math.round(k.c)); fM.set(Math.round(k.m)); fY.set(Math.round(k.y)); fK.set(Math.round(k.k));
    if (document.activeElement !== hex) hex.value = rgbToHex(rgb);
  }
  const drag = (el: HTMLElement, fn: (fx: number, fy: number) => void) => {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const go = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)); };
      go(e);
      const up = () => { el.removeEventListener('pointermove', go); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', go);
      el.addEventListener('pointerup', up);
    });
  };
  drag(fieldWrap, (fx, fy) => {
    const c = fieldColor(fx, fy, zOf());
    if (comp === 'H') setHSV({ h: hsv.h, s: fx * 100, v: (1 - fy) * 100 });
    else if (comp === 'S') setHSV({ h: fx * 360, s: hsv.s, v: (1 - fy) * 100 });
    else if (comp === 'B') setHSV({ h: fx * 360, s: (1 - fy) * 100, v: hsv.v });
    else setRGB(c);
  });
  drag(stripWrap, (_fx, fy) => {
    const z = 1 - fy;
    if (comp === 'H') setHSV({ ...hsv, h: z * 360 });
    else if (comp === 'S') setHSV({ ...hsv, s: z * 100 });
    else if (comp === 'B') setHSV({ ...hsv, v: z * 100 });
    else if (comp === 'R') setRGB({ ...rgb, r: z * 255 });
    else if (comp === 'G') setRGB({ ...rgb, g: z * 255 });
    else setRGB({ ...rgb, b: z * 255 });
  });
  draw();
  return openDialog({ title, content, layout: 'side', width: 720 }).then((ok) => (ok ? rgb : null));
}

export function installColorPicker() { setColorPickerImpl(openColorPicker); void app; }
