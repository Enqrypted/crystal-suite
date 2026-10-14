import { Panel } from '../ui/dock';
import { h, clear } from '../ui/dom';
import { app } from '../app';
import { bus } from '../core/bus';
import { createCanvas, ctx2d, cssColor, hsvToRgb, rgbToHsv, RGB, rgbToHex, hexToRgb, clamp } from '../core/util';
import { pickColor, slider, segmented, toast } from '../ui/widgets';
import { GRADIENT_PRESETS, gradientSwatch, fgBgGradient, fgTransparentGradient } from '../core/gradient';
import { getTool, setTool } from '../tools/tool';
import { Gradient } from '../core/layer';

/** Color panel: SV square + hue strip (Photoshop's "Hue Cube"), or RGB sliders. */
export const colorPanel: Panel = {
  id: 'color', title: 'Color', icon: 'p-color',
  build() {
    let hue = 0, sat = 0, val = 0;
    let target: 'fg' | 'bg' = 'fg';
    let mode: 'cube' | 'rgb' = 'cube';
    const sv = createCanvas(200, 120), hb = createCanvas(16, 120);
    const svWrap = h('div', { class: 'sv' }, sv, h('div', { class: 'sv-marker' }));
    const hueWrap = h('div', { class: 'hue' }, hb, h('div', { class: 'hue-marker' }));
    const fgChip = h('div', { class: 'color-swatch', title: 'Foreground', style: { width: '30px', height: '24px' } });
    const bgChip = h('div', { class: 'color-swatch', title: 'Background', style: { width: '30px', height: '24px' } });
    const hex = h('input', { class: 'ps-input', style: { width: '70px', fontFamily: 'Consolas, monospace' } }) as HTMLInputElement;
    const rgbSl = (['r', 'g', 'b'] as const).map((k) => slider({ value: 0, min: 0, max: 255, onInput: (v) => { const c = { ...cur(), [k]: v }; set(c, true); } }));
    const rgbBox = h('div', { class: 'col' }, ...rgbSl.map((s, i) => h('div', { class: 'row' }, h('span', { class: 'field-label', style: { width: '14px' } }, 'RGB'[i]), s.el)));
    const picker = h('div', { class: 'picker' }, svWrap, hueWrap);
    const modeSeg = segmented({ value: 'cube', options: [{ value: 'cube', label: 'Hue Cube' }, { value: 'rgb', label: 'RGB Sliders' }], onChange: (v) => { mode = v as any; picker.style.display = mode === 'cube' ? '' : 'none'; rgbBox.style.display = mode === 'rgb' ? '' : 'none'; } });
    rgbBox.style.display = 'none';
    const cur = () => (target === 'fg' ? app.fg : app.bg);
    const set = (c: RGB, fromSliders = false) => {
      if (!fromSliders) { const hsv = rgbToHsv(c); if (hsv.s > 0) hue = hsv.h; sat = hsv.s; val = hsv.v; }
      if (target === 'fg') app.setFg(c); else app.setBg(c);
    };
    const drawSV = () => {
      const x = ctx2d(sv);
      const base = hsvToRgb(hue, 100, 100);
      x.fillStyle = cssColor(base); x.fillRect(0, 0, sv.width, sv.height);
      const gw = x.createLinearGradient(0, 0, sv.width, 0); gw.addColorStop(0, '#fff'); gw.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = gw; x.fillRect(0, 0, sv.width, sv.height);
      const gb = x.createLinearGradient(0, 0, 0, sv.height); gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, '#000');
      x.fillStyle = gb; x.fillRect(0, 0, sv.width, sv.height);
    };
    const drawHue = () => {
      const x = ctx2d(hb);
      const g = x.createLinearGradient(0, 0, 0, hb.height);
      for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, cssColor(hsvToRgb(360 - i * 60, 100, 100)));
      x.fillStyle = g; x.fillRect(0, 0, hb.width, hb.height);
    };
    drawHue();
    const sync = () => {
      const c = cur();
      const hsv = rgbToHsv(c);
      if (hsv.s > 0 && hsv.v > 0) hue = hsv.h;
      sat = hsv.s; val = hsv.v;
      drawSV();
      const m = svWrap.querySelector('.sv-marker') as HTMLElement;
      m.style.left = `${sat}%`; m.style.top = `${100 - val}%`;
      (hueWrap.querySelector('.hue-marker') as HTMLElement).style.top = `${(1 - hue / 360) * 100}%`;
      fgChip.style.background = cssColor(app.fg); bgChip.style.background = cssColor(app.bg);
      fgChip.style.outline = target === 'fg' ? '2px solid var(--accent)' : 'none';
      bgChip.style.outline = target === 'bg' ? '2px solid var(--accent)' : 'none';
      if (document.activeElement !== hex) hex.value = `#${rgbToHex(c)}`;
      rgbSl[0].set(c.r); rgbSl[1].set(c.g); rgbSl[2].set(c.b);
    };
    const dragOn = (el: HTMLElement, fn: (fx: number, fy: number) => void) => {
      el.addEventListener('pointerdown', (e) => {
        el.setPointerCapture(e.pointerId);
        const go = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)); };
        go(e);
        const up = () => { el.removeEventListener('pointermove', go); el.removeEventListener('pointerup', up); };
        el.addEventListener('pointermove', go);
        el.addEventListener('pointerup', up);
      });
    };
    dragOn(svWrap, (fx, fy) => { sat = fx * 100; val = (1 - fy) * 100; set(hsvToRgb(hue, sat, val), true); });
    dragOn(hueWrap, (_fx, fy) => { hue = (1 - fy) * 360; set(hsvToRgb(hue, sat, val), true); });
    fgChip.addEventListener('click', () => { if (target === 'fg') pickColor(app.fg, 'Color Picker (Foreground Color)').then((c) => c && app.setFg(c)); target = 'fg'; sync(); });
    bgChip.addEventListener('click', () => { if (target === 'bg') pickColor(app.bg, 'Color Picker (Background Color)').then((c) => c && app.setBg(c)); target = 'bg'; sync(); });
    hex.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') hex.blur(); });
    hex.addEventListener('change', () => { const c = hexToRgb(hex.value); if (c) set(c); else sync(); });
    bus.on('colors', sync);
    sync();
    return h('div', { class: 'color-panel' }, h('div', { class: 'chips' }, fgChip, bgChip, h('div', { style: { flex: '1' } }), hex), picker, rgbBox, modeSeg.el);
  },
};

// ---------- Swatches ----------
const DEFAULT_SWATCHES = [
  '#000000', '#ffffff', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff',
  '#ed1c24', '#f26522', '#f7941d', '#fff200', '#8dc63f', '#39b54a', '#00a651', '#00a99d', '#00aeef', '#0072bc', '#0054a6', '#2e3192', '#662d91', '#92278f', '#ec008c', '#ed145b',
  '#f69679', '#f9ad81', '#fdc68a', '#fff799', '#c4df9b', '#a3d39c', '#82ca9d', '#7bcdc8', '#6ecff6', '#7da7d9', '#8393ca', '#8781bd', '#a186be', '#bd8cbf', '#f49ac1', '#f5989d',
  '#9e0b0f', '#a0410d', '#a36209', '#aba000', '#598527', '#1a7b30', '#007236', '#00746b', '#0076a3', '#004b80', '#003471', '#1b1464', '#440e62', '#630460', '#9e005d', '#9e0039',
  '#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999', '#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee',
  '#c69c6d', '#a67c52', '#8c6239', '#754c24', '#603913', '#3c2415', '#f2d6c1', '#e0b494', '#c68b67', '#a0674b', '#7b4a32', '#4f2f22',
];
function loadSwatches(): string[] { try { const s = JSON.parse(localStorage.getItem('photon.swatches') || 'null'); return Array.isArray(s) ? s : DEFAULT_SWATCHES; } catch { return DEFAULT_SWATCHES; } }
function saveSwatches(s: string[]) { try { localStorage.setItem('photon.swatches', JSON.stringify(s)); } catch { /* ignore */ } }

export const swatchesPanel: Panel = {
  id: 'swatches', title: 'Swatches', icon: 'p-swatches',
  menu: () => [{ label: 'Reset Swatches', action: () => { saveSwatches(DEFAULT_SWATCHES); bus.emit('swatches'); } }],
  build() {
    const grid = h('div', { class: 'swatch-grid' });
    const render = () => {
      clear(grid);
      const list = loadSwatches();
      list.forEach((hx, i) => {
        const s = h('div', { class: 'sw', title: `${hx} — click: foreground, Alt+click: background, Ctrl+click: delete`, style: { background: hx } });
        s.addEventListener('click', (e) => {
          const c = hexToRgb(hx)!;
          if (e.ctrlKey || e.metaKey) { list.splice(i, 1); saveSwatches(list); render(); return; }
          if (e.altKey) app.setBg(c); else app.setFg(c);
        });
        grid.appendChild(s);
      });
      const add = h('div', { class: 'sw', title: 'Create new swatch from foreground color', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-2)', border: '1px dashed var(--input-border)' } }, '+');
      add.addEventListener('click', () => { const l = loadSwatches(); l.push(`#${rgbToHex(app.fg)}`); saveSwatches(l); render(); toast('Swatch added'); });
      grid.appendChild(add);
    };
    bus.on('swatches', render);
    render();
    return grid;
  },
};

// ---------- Gradients ----------
export const gradientsPanel: Panel = {
  id: 'gradients', title: 'Gradients', icon: 'p-gradients',
  build() {
    const grid = h('div', { class: 'grad-grid' });
    const render = () => {
      clear(grid);
      const list: Gradient[] = [fgBgGradient(app.fg, app.bg), fgTransparentGradient(app.fg), ...GRADIENT_PRESETS];
      for (const g of list) {
        const c = gradientSwatch(g, 96, 30);
        c.title = `${g.name} — click to use with the Gradient tool`;
        c.addEventListener('click', () => {
          const t = getTool('gradient') as any;
          t.gradient = g.name === 'Foreground to Background' ? null : g;
          setTool('gradient');
          t.refreshOptions();
        });
        grid.appendChild(c);
      }
    };
    bus.on('colors', render);
    render();
    return grid;
  },
};
