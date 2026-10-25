import { Panel } from '../ui/dock';
import { h, clear } from '../ui/dom';
import { icon } from '../ui/icons';
import { app } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { createCanvas, ctx2d, debounce, rafThrottle, rgbToCmyk, rgbToHsv, getImageData, uid } from '../core/util';
import { slider, iconButton, select, numberInput, colorSwatch, checkbox, sliderField, toast, segmented } from '../ui/widgets';
import { copyMask, invertMask } from '../core/selection';
import { applySelectShape, commitSelection, saveSelectionDialog } from '../ops/selectops';
import { maskFromAlpha } from '../core/selection';
import { activePath, pathToSelection, fillPath, strokePath } from '../tools/pen';
import { toPath2D } from '../core/paths';
import { FONT_FAMILIES, FONT_STYLES } from '../core/text';
import { typeOpts, updateActiveText } from '../tools/type';
import { currentTool, TOOLS } from '../tools/tool';
import { BrushBase } from '../tools/paint';
import { BRUSH_PRESETS, tipPreview, BrushOptions, TipShape } from '../core/brush';
import { histogramCanvas } from '../dialogs/adjustdialogs';
import { samplerColor } from '../ops/samplers';

let viewportRef: any = null;
export const setPanelsViewport = (v: any) => { viewportRef = v; };

// ---------- Navigator ----------
export const navigatorPanel: Panel = {
  id: 'navigator', title: 'Navigator', icon: 'p-navigator',
  build() {
    const c = createCanvas(240, 150);
    const rect = h('div', { class: 'nav-rect' });
    const view = h('div', { class: 'nav-view' }, c, rect);
    const zoomIn = numberInput({ value: 100, min: 1, max: 3200, unit: '%', width: 56, onChange: (v) => viewportRef?.setZoom(v / 100) });
    const zs = slider({ value: 0, min: -460, max: 346, onInput: (v) => viewportRef?.setZoom(Math.exp(v / 100)) });
    const draw = () => {
      if (!view.isConnected) return;
      const d = app.doc;
      const x = ctx2d(c);
      x.clearRect(0, 0, c.width, c.height);
      if (!d || !viewportRef) { rect.style.display = 'none'; return; }
      const s = Math.min(240 / d.width, 150 / d.height);
      c.width = Math.max(1, Math.round(d.width * s)); c.height = Math.max(1, Math.round(d.height * s));
      x.drawImage(d.composite, 0, 0, c.width, c.height);
      const a = viewportRef.toDoc(0, 0), b = viewportRef.toDoc(viewportRef.w, viewportRef.h);
      const ox = (view.clientWidth - c.width) / 2, oy = (view.clientHeight - c.height) / 2;
      rect.style.display = '';
      rect.style.left = `${ox + Math.max(0, a.x) * s}px`;
      rect.style.top = `${oy + Math.max(0, a.y) * s}px`;
      rect.style.width = `${(Math.min(d.width, b.x) - Math.max(0, a.x)) * s}px`;
      rect.style.height = `${(Math.min(d.height, b.y) - Math.max(0, a.y)) * s}px`;
      zoomIn.set(Math.round(d.zoom * 1000) / 10);
      zs.set(Math.log(d.zoom) * 100);
    };
    view.addEventListener('pointerdown', (e) => {
      view.setPointerCapture(e.pointerId);
      const go = (ev: PointerEvent) => {
        const d = app.doc; if (!d) return;
        const r = c.getBoundingClientRect();
        const s = c.width / d.width;
        viewportRef?.centerOn((ev.clientX - r.left) / s, (ev.clientY - r.top) / s);
      };
      go(e);
      const up = () => { view.removeEventListener('pointermove', go); view.removeEventListener('pointerup', up); };
      view.addEventListener('pointermove', go);
      view.addEventListener('pointerup', up);
    });
    const r = debounce(draw, 120);
    bus.on('render', r); bus.on('view', r); bus.on('docs', r); bus.on('panel-shown', r);
    return h('div', { class: 'navigator' }, view, h('div', { class: 'row' }, zoomIn.el, iconButton('zoom-out', 'Zoom out', () => viewportRef?.zoomStep(-1)), zs.el, iconButton('zoom-in', 'Zoom in', () => viewportRef?.zoomStep(1))));
  },
};

// ---------- Info ----------
export const infoPanel: Panel = {
  id: 'info', title: 'Info', icon: 'p-info',
  build() {
    const el = h('div', { class: 'info-grid' });
    let last: { d: Doc; x: number; y: number } | null = null;
    const draw = () => {
      if (!el.isConnected) return;
      clear(el);
      const d = app.doc;
      if (!d) return;
      const row = (k: string, v: string) => h('div', null, h('span', null, k), v);
      let rgb = '—', hsb = '—', cmyk = '—';
      if (last && last.d === d && last.x >= 0 && last.y >= 0 && last.x < d.width && last.y < d.height) {
        const px = ctx2d(d.composite).getImageData(Math.floor(last.x), Math.floor(last.y), 1, 1).data;
        rgb = `${px[0]}, ${px[1]}, ${px[2]}`;
        const hs = rgbToHsv({ r: px[0], g: px[1], b: px[2] });
        hsb = `${Math.round(hs.h)}°, ${Math.round(hs.s)}%, ${Math.round(hs.v)}%`;
        const ck = rgbToCmyk({ r: px[0], g: px[1], b: px[2] });
        cmyk = `${Math.round(ck.c)} ${Math.round(ck.m)} ${Math.round(ck.y)} ${Math.round(ck.k)}`;
      }
      const sb = d.selectionBounds();
      el.append(
        row('R:', rgb), row('H:', hsb), row('C:', cmyk), row('A:', last ? `${Math.round(d.composite && last.x >= 0 ? 255 : 0)}` : '—'),
        row('X:', last ? `${Math.floor(last.x)} px` : '—'), row('Y:', last ? `${Math.floor(last.y)} px` : '—'),
        row('W:', sb ? `${sb.w} px` : '—'), row('H:', sb ? `${sb.h} px` : '—'),
        h('div', { style: { gridColumn: '1 / -1', color: 'var(--text-3)', marginTop: '6px' } }, `Doc: ${d.width} × ${d.height} px · ${d.layers.length} layer${d.layers.length === 1 ? '' : 's'}`));
      // Color Sampler readouts
      d.samplers.forEach((s, i) => {
        const c = samplerColor(d, s);
        el.append(row(`#${i + 1} R:`, c ? `${c[0]}, ${c[1]}, ${c[2]}` : '—'), row('X, Y:', `${s.x}, ${s.y}`));
      });
    };
    const r = rafThrottle(draw);
    bus.on('pointer', (d: Doc, x: number, y: number) => { last = { d, x, y }; r(); });
    bus.on('selection', r); bus.on('docs', r); bus.on('samplers', r);
    // readouts follow edits under the samplers
    bus.on('render', () => { if (app.doc?.samplers.length) r(); });
    // it doesn't redraw while hidden (a closed flyout), so catch up when shown
    bus.on('panel-shown', (id: string) => { if (id === 'info') draw(); });
    draw();
    return el;
  },
};

// ---------- Histogram ----------
export const histogramPanel: Panel = {
  id: 'histogram', title: 'Histogram', icon: 'p-histogram',
  build() {
    const wrap = h('div', { class: 'panel-pad col' });
    let ch: 'rgb' | 'lum' | 'r' | 'g' | 'b' = 'rgb';
    const sel = select({ options: [{ value: 'rgb', label: 'Colors' }, { value: 'lum', label: 'Luminosity' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }], value: 'rgb', onChange: (v) => { ch = v as any; draw(); } });
    const holder = h('div');
    const draw = () => {
      if (!wrap.isConnected) return;
      clear(holder);
      const d = app.doc;
      if (!d) return;
      // sample a downscaled composite for speed
      const s = Math.min(1, 512 / Math.max(d.width, d.height));
      const c = createCanvas(Math.max(1, d.width * s), Math.max(1, d.height * s));
      ctx2d(c).drawImage(d.composite, 0, 0, c.width, c.height);
      const hc = histogramCanvas(getImageData(c), ch, 240, 110);
      hc.classList.add('histogram');
      holder.appendChild(hc);
    };
    const r = debounce(draw, 400);
    bus.on('render', r); bus.on('docs', r); bus.on('panel-shown', (id: string) => { if (id === 'histogram') draw(); });
    wrap.append(h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Channel:'), sel.el), holder);
    return wrap;
  },
};

// ---------- Channels ----------
export const channelsPanel: Panel = {
  id: 'channels', title: 'Channels', icon: 'p-channels',
  build() {
    const list = h('div');
    const thumb = (d: Doc, ch: number | null, alpha?: HTMLCanvasElement) => {
      const s = Math.min(36 / d.width, 26 / d.height);
      const c = createCanvas(Math.max(1, d.width * s), Math.max(1, d.height * s));
      const x = ctx2d(c);
      if (alpha) { x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); const t = createCanvas(c.width, c.height); const tx = ctx2d(t); tx.drawImage(alpha, 0, 0, c.width, c.height); tx.globalCompositeOperation = 'source-in'; tx.fillStyle = '#fff'; tx.fillRect(0, 0, c.width, c.height); x.drawImage(t, 0, 0); return c; }
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(d.composite, 0, 0, c.width, c.height);
      if (ch !== null) {
        const id = x.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < id.data.length; i += 4) { const v = id.data[i + ch]; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; }
        x.putImageData(id, 0, 0);
      }
      return c;
    };
    const render = () => {
      clear(list);
      const d = app.doc;
      if (!d) { list.appendChild(h('div', { class: 'panel-empty' }, 'No document')); return; }
      const chans: [string, 'rgb' | 'r' | 'g' | 'b', number | null, string][] = [['RGB', 'rgb', null, 'Ctrl+2'], ['Red', 'r', 0, 'Ctrl+3'], ['Green', 'g', 1, 'Ctrl+4'], ['Blue', 'b', 2, 'Ctrl+5']];
      for (const [name, key, ch, sc] of chans) {
        const active = d.channelView === key || (key !== 'rgb' && false);
        const r = h('div', { class: `list-row${active ? ' active' : ''}` },
          h('div', { class: `vis${d.channelView === 'rgb' || d.channelView === key ? '' : ' off'}` }, icon('eye', 14)),
          h('div', { class: 'thumb' }, thumb(d, ch)), h('div', { class: 'grow' }, name), h('div', { class: 'key' }, sc));
        r.addEventListener('click', (e) => {
          if ((e.ctrlKey || e.metaKey) && ch !== null) {
            // load channel luminosity as selection
            const img = getImageData(d.composite);
            const out = new ImageData(d.width, d.height);
            for (let i = 0; i < img.data.length; i += 4) out.data[i + 3] = img.data[i + ch];
            const m = createCanvas(d.width, d.height); ctx2d(m).putImageData(out, 0, 0);
            commitSelection(d, m, 'Load Selection');
            return;
          }
          d.channelView = key; d.invalidate(); bus.emit('channels', d);
        });
        list.appendChild(r);
      }
      for (const a of d.channels) {
        const r = h('div', { class: 'list-row' }, h('div', { class: 'vis' }), h('div', { class: 'thumb' }, thumb(d, null, a.canvas)), h('div', { class: 'grow' }, a.name));
        r.title = 'Click to load as selection (Shift: add, Alt: subtract)';
        r.addEventListener('click', (e) => applySelectShape(d, copyMask(a.canvas), e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'new', 'Load Selection'));
        r.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const before = d.captureState();
          d.channels = d.channels.filter((c) => c !== a);
          d.commit('Delete Channel', before);
          bus.emit('channels', d);
        });
        list.appendChild(r);
      }
    };
    const footer = h('div', { class: 'panel-footer' },
      iconButton('a-selectivecolor', 'Load channel as selection', () => { const d = app.doc; const a = d?.channels[d.channels.length - 1]; if (d && a) applySelectShape(d, copyMask(a.canvas), 'new', 'Load Selection'); }),
      iconButton('mask', 'Save selection as channel', () => saveSelectionDialog()),
      iconButton('new-layer', 'Create new channel', () => {
        const d = app.doc; if (!d) return;
        const before = d.captureState();
        d.channels = [...d.channels, { id: uid(), name: `Alpha ${d.channels.length + 1}`, canvas: createCanvas(d.width, d.height) }];
        d.commit('New Channel', before); bus.emit('channels', d);
      }),
      iconButton('trash', 'Delete last alpha channel', () => { const d = app.doc; if (!d || !d.channels.length) return; const before = d.captureState(); d.channels = d.channels.slice(0, -1); d.commit('Delete Channel', before); bus.emit('channels', d); }));
    const r = debounce(render, 250);
    bus.on('channels', render); bus.on('docs', render); bus.on('pixels', r); bus.on('history', r);
    render();
    return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, h('div', { style: { flex: '1', overflowY: 'auto' } }, list), footer);
  },
};

// ---------- Paths ----------
export const pathsPanel: Panel = {
  id: 'paths', title: 'Paths', icon: 'p-paths',
  build() {
    const list = h('div');
    const render = () => {
      clear(list);
      const d = app.doc;
      if (!d) { list.appendChild(h('div', { class: 'panel-empty' }, 'No document')); return; }
      if (!d.paths.length) list.appendChild(h('div', { class: 'panel-empty' }, 'Use the Pen tool (P) to draw a path.'));
      for (const p of d.paths) {
        const c = createCanvas(36, 26);
        const x = ctx2d(c);
        const s = Math.min(36 / d.width, 26 / d.height);
        x.fillStyle = '#fff'; x.fillRect(0, 0, 36, 26);
        x.scale(s, s); x.lineWidth = 1 / s; x.strokeStyle = '#000';
        x.stroke(toPath2D(p));
        const r = h('div', { class: `list-row${p.id === d.activePathId ? ' active' : ''}` }, h('div', { class: 'thumb' }, c), h('div', { class: 'grow', style: { fontStyle: p.name === 'Work Path' ? 'italic' : 'normal' } }, p.name));
        r.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey) { pathToSelection(d, p); return; } d.activePathId = p.id; bus.emit('paths', d); d.invalidate(); });
        r.addEventListener('dblclick', async () => {
          const { promptDialog } = await import('../dialogs/dialog');
          const n = await promptDialog('Save Path', 'Name:', p.name === 'Work Path' ? `Path ${d.paths.length}` : p.name);
          if (n) { const before = d.captureState(); d.paths.find((x) => x.id === p.id)!.name = n; d.commit('Rename Path', before); bus.emit('paths', d); }
        });
        list.appendChild(r);
      }
    };
    const footer = h('div', { class: 'panel-footer' },
      iconButton('bucket', 'Fill path with foreground color', () => { const d = app.doc; if (d) fillPath(d); }),
      iconButton('brush', 'Stroke path with brush', () => { const d = app.doc; if (d) strokePath(d); }),
      iconButton('marquee-rect', 'Load path as a selection (Ctrl+Enter)', () => { const d = app.doc; if (d) pathToSelection(d); }),
      iconButton('new-layer', 'Create new path', () => {
        const d = app.doc; if (!d) return;
        const before = d.captureState();
        const p = { id: uid(), name: `Path ${d.paths.length + 1}`, subpaths: [] };
        d.paths.push(p); d.activePathId = p.id;
        d.commit('New Path', before); bus.emit('paths', d);
      }),
      iconButton('trash', 'Delete path', () => {
        const d = app.doc; if (!d) return;
        const p = activePath(d); if (!p) return;
        const before = d.captureState();
        d.paths = d.paths.filter((x) => x.id !== p.id);
        d.commit('Delete Path', before); bus.emit('paths', d); d.invalidate();
      }));
    bus.on('paths', render); bus.on('docs', render); bus.on('history', render);
    render();
    return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, h('div', { style: { flex: '1', overflowY: 'auto' } }, list), footer);
  },
};

// ---------- Character / Paragraph ----------
export const characterPanel: Panel = {
  id: 'character', title: 'Character', icon: 'p-character',
  build() {
    const font = select({ options: FONT_FAMILIES, value: typeOpts.font, width: 150, onChange: (v) => updateActiveText({ font: v }) });
    const style = select({ options: FONT_STYLES, value: typeOpts.style, width: 90, onChange: (v) => updateActiveText({ style: v }) });
    const size = numberInput({ value: typeOpts.size, min: 1, max: 2000, unit: 'px', width: 50, onChange: (v) => updateActiveText({ size: v }) });
    const lead = numberInput({ value: Math.round(typeOpts.leading * 100), min: 50, max: 500, unit: '%', width: 50, onChange: (v) => updateActiveText({ leading: v / 100 }) });
    const track = numberInput({ value: typeOpts.tracking, min: -500, max: 2000, width: 50, onChange: (v) => updateActiveText({ tracking: v }) });
    const color = colorSwatch({ color: typeOpts.color, onChange: (c) => updateActiveText({ color: c }) });
    const toggles: [string, keyof typeof typeOpts][] = [['T', 'fauxBold'], ['𝑇', 'fauxItalic'], ['TT', 'allCaps'], ['T̲', 'underline'], ['T̶', 'strike']];
    const tbtns = toggles.map(([lbl, key]) => {
      const b = h('button', { class: 'icon-btn', title: String(key), style: { fontWeight: key === 'fauxBold' ? '700' : '400' } }, lbl);
      b.addEventListener('click', () => { updateActiveText({ [key]: !typeOpts[key] } as any); sync(); });
      return { b, key };
    });
    const sync = () => {
      const L = app.doc?.active;
      const t = L?.kind === 'text' && L.text ? L.text : typeOpts;
      font.set(t.font); style.set(t.style); size.set(t.size); lead.set(Math.round(t.leading * 100)); track.set(t.tracking); color.set(t.color);
      for (const tb of tbtns) tb.b.classList.toggle('active', !!(t as any)[tb.key]);
    };
    bus.on('layers', sync); bus.on('options', sync);
    sync();
    const lbl = (s: string) => h('span', { class: 'field-label' }, s);
    return h('div', { class: 'props' }, h('div', { class: 'row' }, font.el, style.el),
      h('div', { class: 'grid2' }, lbl('Size'), size.el, lbl('Leading'), lead.el, lbl('Tracking'), track.el, lbl('Color'), color.el),
      h('div', { class: 'row' }, ...tbtns.map((t) => t.b)));
  },
};
export const paragraphPanel: Panel = {
  id: 'paragraph', title: 'Paragraph', icon: 'p-paragraph',
  build() {
    const align = segmented({ value: typeOpts.align, options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }], onChange: (v) => updateActiveText({ align: v as any }) });
    const width = numberInput({ value: 0, min: 0, max: 30000, unit: 'px', width: 70, onChange: (v) => updateActiveText({ boxWidth: v || undefined }) });
    bus.on('layers', () => { const L = app.doc?.active; if (L?.text) { align.set(L.text.align); width.set(L.text.boxWidth ?? 0); } });
    return h('div', { class: 'props' }, h('h4', null, 'Alignment'), align.el, h('h4', null, 'Paragraph width (0 = point text)'), width.el);
  },
};

// ---------- Brushes / Brush Settings ----------
function brushTool(): BrushBase | null {
  const t = currentTool();
  if (t instanceof BrushBase) return t;
  return (TOOLS.find((x) => x.id === 'brush') as BrushBase) ?? null;
}
export const brushesPanel: Panel = {
  id: 'brushes', title: 'Brushes', icon: 'p-brushes',
  build() {
    const list = h('div', { class: 'brush-list' });
    for (const p of BRUSH_PRESETS) {
      const it = h('div', { class: 'brush-item', title: p.name }, tipPreview(p.opts), h('span', null, p.name.split(' ').slice(0, 2).join(' ')));
      it.addEventListener('click', () => {
        const t = brushTool();
        if (!t) return;
        t.setOpts({ hardness: 1, spacing: 0.25, angle: 0, roundness: 1, tip: 'round', sizeJitter: 0, angleJitter: 0, scatter: 0, count: 1, opacityJitter: 0, angleFollow: false, sizePressure: true, opacityPressure: false, flow: 1, ...p.opts });
        list.querySelectorAll('.brush-item').forEach((e) => e.classList.remove('active'));
        it.classList.add('active');
        toast(`${p.name} → ${t.name}`);
      });
      list.appendChild(it);
    }
    return list;
  },
};
export const brushSettingsPanel: Panel = {
  id: 'brush-settings', title: 'Brush Settings', icon: 'p-brush-settings',
  build() {
    const root = h('div', { class: 'props' });
    const render = () => {
      clear(root);
      const t = brushTool();
      if (!t) { root.appendChild(h('div', { class: 'panel-empty' }, 'Select a brush tool')); return; }
      const o = t.opts;
      const set = (p: Partial<BrushOptions>) => { t.setOpts(p); preview(); };
      const prev = createCanvas(240, 60);
      const preview = () => {
        const x = ctx2d(prev);
        x.clearRect(0, 0, 240, 60);
        const tp = tipPreview({ ...o, size: 40 }, 40, 40, '#ccc');
        for (let i = 0; i < 9; i++) x.drawImage(tp, 10 + i * 24, 10 + Math.sin(i / 1.4) * 8, 40, 40);
      };
      preview();
      const sf = (label: string, key: keyof BrushOptions, min: number, max: number, scale = 1, unit = '') =>
        sliderField({ label, value: Math.round((o[key] as number) * scale), min, max, unit, inline: true, onInput: (v) => set({ [key]: v / scale } as any) }).el;
      const tip = select({ options: ['round', 'square', 'chalk', 'spatter', 'dry', 'star', 'leaf', 'grass'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })), value: o.tip, onChange: (v) => set({ tip: v as TipShape }) });
      root.append(
        h('div', { class: 'field-label' }, `Editing: ${t.name}`),
        h('div', { class: 'preview-box', style: { height: '64px' } }, prev),
        h('h4', null, 'Brush Tip Shape'), h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Tip:'), tip.el),
        sf('Size', 'size', 1, 1000, 1, 'px'), sf('Hardness', 'hardness', 0, 100, 100, '%'), sf('Spacing', 'spacing', 1, 300, 100, '%'),
        sf('Angle', 'angle', -180, 180, 1, '°'), sf('Roundness', 'roundness', 1, 100, 100, '%'),
        h('h4', null, 'Shape Dynamics'),
        checkbox({ label: 'Size: Pen Pressure', checked: o.sizePressure, onChange: (v) => set({ sizePressure: v }) }).el,
        sf('Min Diameter', 'minSize', 0, 100, 100, '%'), sf('Size Jitter', 'sizeJitter', 0, 100, 100, '%'), sf('Angle Jitter', 'angleJitter', 0, 100, 100, '%'),
        checkbox({ label: 'Angle follows direction', checked: !!o.angleFollow, onChange: (v) => set({ angleFollow: v }) }).el,
        h('h4', null, 'Scattering'), sf('Scatter', 'scatter', 0, 1000, 100, '%'), sf('Count', 'count', 1, 16),
        h('h4', null, 'Transfer'),
        checkbox({ label: 'Opacity: Pen Pressure', checked: o.opacityPressure, onChange: (v) => set({ opacityPressure: v }) }).el,
        sf('Opacity Jitter', 'opacityJitter', 0, 100, 100, '%'), sf('Flow', 'flow', 1, 100, 100, '%'),
        h('h4', null, 'Smoothing'), sf('Smoothing', 'smoothing', 0, 100, 100, '%'));
    };
    bus.on('tool', render);
    bus.on('panel-shown', (id: string) => { if (id === 'brush-settings') render(); });
    render();
    return root;
  },
};

void invertMask; void maskFromAlpha;
