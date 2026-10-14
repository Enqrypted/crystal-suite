import { Panel } from '../ui/dock';
import { h, clear } from '../ui/dom';
import { icon } from '../ui/icons';
import { app } from '../app';
import { bus } from '../core/bus';
import { Doc } from '../core/document';
import { Layer, ShapeData } from '../core/layer';
import { rafThrottle, getImageData, createCanvas, ctx2d } from '../core/util';
import { numberInput, button, colorSwatch, checkbox, select, iconButton, sliderField, toast, segmented } from '../ui/widgets';
import { ADJUSTMENTS, getAdjustment } from '../core/adjustments';
import { renderLayersInto } from '../core/compositor';
import { setLayerPropLive, flushPendingProp, newAdjustmentLayer, toggleClipping, deleteMask, toggleMask, editFillLayer, addMask } from '../ops/layerops';
import { renderShapeLayer } from '../core/shapes';
import { layerBounds, alignLayers } from '../tools/transform';
import { modifyDialog, selectSubject, selectAndMaskDialog } from '../ops/selectops';
import { imageSizeDialog, canvasSizeDialog } from '../ops/imageops';
import { FONT_FAMILIES, FONT_STYLES } from '../core/text';
import { updateActiveText } from '../tools/type';
import { featherMask, invertMask } from '../core/selection';
import { alphaToGray, grayToAlpha } from '../ops/target';
import { copy } from '../ops/editops';

/** Pixels beneath an adjustment layer (for its histogram / auto buttons). */
function pixelsBelow(doc: Doc, L: Layer): ImageData | null {
  const i = doc.indexOf(L);
  const c = createCanvas(doc.width, doc.height);
  renderLayersInto(doc, ctx2d(c), { x: 0, y: 0, w: doc.width, h: doc.height }, doc.layers.slice(0, i));
  return getImageData(c);
}

const section = (title: string, ...kids: (Node | null)[]) => h('div', { class: 'col' }, h('h4', null, title), ...kids);
const grid2 = (...kids: (Node | string)[]) => h('div', { class: 'grid2' }, ...kids);
const lbl = (t: string) => h('span', { class: 'field-label' }, t);

export const propertiesPanel: Panel = {
  id: 'properties', title: 'Properties', icon: 'p-properties',
  build() {
    const root = h('div');
    let lastKey = '';
    let lastParams: any = null;
    const render = () => {
      const doc = app.doc;
      const L = doc?.active ?? null;
      // don't rebuild while the user is dragging inside adjustment controls of the same layer
      const key = `${doc?.id}|${L?.id}|${L?.kind}|${doc?.editMask}|${L?.adjustment?.kind}|${doc?.width}x${doc?.height}|${L?.mask ? 1 : 0}`;
      if (key === lastKey) {
        // adjustment UIs rebuild only when params changed from outside (undo, reset)
        if (L?.kind === 'adjustment') { if (L.adjustment!.params === lastParams) return; }
        else if (root.contains(document.activeElement) && document.activeElement !== document.body) return;
      }
      lastKey = key;
      lastParams = L?.adjustment?.params ?? null;
      clear(root);
      if (!doc) { root.appendChild(h('div', { class: 'panel-empty' }, 'No properties')); return; }
      if (L && doc.editMask && L.mask) { root.append(header('mask', 'Masks'), maskProps(doc, L)); return; }
      if (!L) { root.append(header('new-doc', 'Document'), docProps(doc)); return; }
      if (L.kind === 'adjustment') { root.append(adjustProps(doc, L)); return; }
      if (L.kind === 'group') {
        const inner = doc.layers.filter((l) => l.parentId === L.id).length;
        root.append(header('folder', 'Group'), h('div', { class: 'props' },
          section('Group', h('div', { class: 'field-label' }, `${inner} layer${inner === 1 ? '' : 's'} · ${L.blend === 'pass-through' ? 'Pass Through' : 'Isolated'} blending`),
            h('div', { class: 'row' },
              button('Ungroup', () => import('../ops/layerops').then((m) => m.ungroupLayers()), { small: true }),
              button('Merge Group', () => import('../ops/layerops').then((m) => m.mergeDown()), { small: true }))),
          alignSection()));
        return;
      }
      const title = L.kind === 'text' ? 'Type Layer' : L.kind === 'shape' ? 'Shape Layer' : L.kind === 'fill' ? 'Fill Layer' : 'Pixel Layer';
      root.append(header(L.kind === 'text' ? 'type' : L.kind === 'shape' ? 'shape-rect' : 'image', title));
      const body = h('div', { class: 'props' });
      body.appendChild(transformSection(doc, L));
      if (L.kind === 'text') body.appendChild(textSection(L));
      if (L.kind === 'shape') body.appendChild(shapeSection(doc, L));
      if (L.kind === 'fill') body.appendChild(section('Fill', button('Edit Fill...', () => editFillLayer(L), { small: true })));
      body.appendChild(alignSection());
      body.appendChild(quickActions(doc, L));
      root.appendChild(body);
    };
    const header = (ic: string, t: string) => h('div', { class: 'props-header' }, icon(ic, 16), h('span', null, t));

    function docProps(doc: Doc) {
      return h('div', { class: 'props' },
        section('Canvas', grid2(lbl('W'), h('span', null, `${doc.width} px`), lbl('H'), h('span', null, `${doc.height} px`)),
          h('div', { class: 'row' }, button('Image Size...', () => imageSizeDialog(), { small: true }), button('Canvas Size...', () => canvasSizeDialog(), { small: true })),
          h('div', { class: 'field-label' }, `Resolution: ${doc.resolution} Pixels/Inch · Mode: RGB Color 8 bit`)),
        section('Rulers & Grids',
          checkbox({ label: 'Rulers', checked: app.prefs.showRulers, onChange: (v) => bus.emit('cmd', 'toggle-rulers', v) }).el,
          checkbox({ label: 'Grid', checked: app.prefs.showGrid, onChange: (v) => { app.prefs.showGrid = v; app.savePrefs(); doc.invalidate(); } }).el,
          checkbox({ label: 'Guides', checked: app.prefs.showGuides, onChange: (v) => { app.prefs.showGuides = v; doc.invalidate(); } }).el));
    }

    function transformSection(doc: Doc, L: Layer) {
      const b = layerBounds(L) ?? { x: L.x, y: L.y, w: 0, h: 0 };
      const mv = (dx: number, dy: number) => {
        if (!L.movable) { toast('Layer position is locked'); return; }
        const before = doc.captureState();
        L.x += dx; L.y += dy; L.maskX += dx; L.maskY += dy;
        doc.ensureCoverage(L); L.touch(); doc.commit('Move', before);
      };
      const x = numberInput({ value: b.x, width: 70, unit: 'px', onChange: (v) => mv(Math.round(v - b.x), 0) });
      const y = numberInput({ value: b.y, width: 70, unit: 'px', onChange: (v) => mv(0, Math.round(v - b.y)) });
      return section('Transform', grid2(lbl('W'), h('span', null, `${b.w} px`), lbl('H'), h('span', null, `${b.h} px`), lbl('X'), x.el, lbl('Y'), y.el));
    }
    function alignSection() {
      const btn = (k: string, t: string, svg: string) => {
        const b = h('button', { class: 'icon-btn', title: t, html: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${svg}</svg>` });
        b.addEventListener('click', () => alignLayers(k));
        return b;
      };
      return section('Align',
        h('div', { class: 'row' },
          btn('left', 'Align left edges', '<path d="M4 3v18"/><rect x="7" y="6" width="10" height="4"/><rect x="7" y="14" width="6" height="4"/>'),
          btn('hcenter', 'Align horizontal centers', '<path d="M12 3v18"/><rect x="6" y="6" width="12" height="4"/><rect x="8" y="14" width="8" height="4"/>'),
          btn('right', 'Align right edges', '<path d="M20 3v18"/><rect x="7" y="6" width="10" height="4"/><rect x="11" y="14" width="6" height="4"/>'),
          btn('top', 'Align top edges', '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="10"/><rect x="14" y="7" width="4" height="6"/>'),
          btn('vcenter', 'Align vertical centers', '<path d="M3 12h18"/><rect x="6" y="6" width="4" height="12"/><rect x="14" y="8" width="4" height="8"/>'),
          btn('bottom', 'Align bottom edges', '<path d="M3 20h18"/><rect x="6" y="7" width="4" height="10"/><rect x="14" y="11" width="4" height="6"/>')));
    }
    function quickActions(doc: Doc, L: Layer) {
      return section('Quick Actions',
        button('Remove Background', async () => {
          if (L.kind !== 'raster') { toast('Works on pixel layers'); return; }
          selectSubject();
          addMask('selection');
        }, { small: true }),
        button('Select Subject', () => selectSubject(), { small: true }),
        button('Copy Layer', () => copy(false), { small: true }));
    }
    function textSection(L: Layer) {
      const t = L.text!;
      const font = select({ options: FONT_FAMILIES, value: t.font, width: 140, onChange: (v) => updateActiveText({ font: v }) });
      const style = select({ options: FONT_STYLES, value: t.style, width: 100, onChange: (v) => updateActiveText({ style: v }) });
      const size = numberInput({ value: t.size, min: 1, max: 2000, unit: 'px', width: 56, onChange: (v) => updateActiveText({ size: v }) });
      const lead = numberInput({ value: Math.round(t.leading * 100), min: 50, max: 400, unit: '%', width: 56, onChange: (v) => updateActiveText({ leading: v / 100 }) });
      const track = numberInput({ value: t.tracking, min: -500, max: 2000, width: 56, onChange: (v) => updateActiveText({ tracking: v }) });
      const color = colorSwatch({ color: t.color, onChange: (c) => updateActiveText({ color: c }) });
      const align = segmented({ value: t.align, options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }], onChange: (v) => updateActiveText({ align: v as any }) });
      return section('Character', h('div', { class: 'row' }, font.el, style.el),
        grid2(lbl('Size'), size.el, lbl('Leading'), lead.el, lbl('Tracking'), track.el, lbl('Color'), color.el),
        h('h4', null, 'Paragraph'), align.el);
    }
    function shapeSection(doc: Doc, L: Layer) {
      const s = L.shape!;
      const upd = (p: Partial<ShapeData>) => {
        const before = doc.captureState();
        L.shape = { ...L.shape!, ...p };
        renderShapeLayer(L);
        doc.invalidate();
        doc.commit('Edit Shape', before);
      };
      const w = numberInput({ value: Math.round(s.w), min: 1, max: 30000, unit: 'px', width: 70, onChange: (v) => upd({ w: v }) });
      const hh = numberInput({ value: Math.round(s.h), min: 1, max: 30000, unit: 'px', width: 70, onChange: (v) => upd({ h: v }) });
      const fillOn = checkbox({ label: 'Fill', checked: !!s.fill, onChange: (v) => upd({ fill: v ? fillSw.get() : null }) });
      const fillSw = colorSwatch({ color: s.fill ?? app.fg, onChange: (c) => upd({ fill: c }) });
      const strokeOn = checkbox({ label: 'Stroke', checked: !!s.stroke, onChange: (v) => upd({ stroke: v ? strokeSw.get() : null, strokeWidth: v ? Math.max(1, s.strokeWidth || 3) : 0 }) });
      const strokeSw = colorSwatch({ color: s.stroke ?? { r: 0, g: 0, b: 0 }, onChange: (c) => upd({ stroke: c }) });
      const sw = numberInput({ value: s.strokeWidth, min: 0, max: 500, unit: 'px', width: 56, onChange: (v) => upd({ strokeWidth: v }) });
      const extra: HTMLElement[] = [];
      if (s.type === 'rect') extra.push(lbl('Radius'), numberInput({ value: s.radius ?? 0, min: 0, max: 5000, unit: 'px', width: 56, onChange: (v) => upd({ radius: v }) }).el);
      if (s.type === 'polygon') extra.push(lbl('Sides'), numberInput({ value: s.sides ?? 5, min: 3, max: 100, width: 56, onChange: (v) => upd({ sides: v }) }).el, lbl('Star %'), numberInput({ value: Math.round((s.star ?? 0) * 100), min: 0, max: 99, width: 56, onChange: (v) => upd({ star: v / 100 }) }).el);
      return section('Appearance', grid2(lbl('W'), w.el, lbl('H'), hh.el),
        h('div', { class: 'row' }, fillOn.el, fillSw.el), h('div', { class: 'row' }, strokeOn.el, strokeSw.el, sw.el),
        extra.length ? grid2(...extra) : null);
    }
    function maskProps(doc: Doc, L: Layer) {
      const before = { v: null as ReturnType<Doc['captureState']> | null };
      const apply = (fn: (m: HTMLCanvasElement) => HTMLCanvasElement, name: string) => {
        const b = doc.captureState();
        L.mask = fn(L.mask!);
        L.touch(); doc.invalidate();
        doc.commit(name, b);
      };
      void before;
      return h('div', { class: 'props' },
        section('Layer Mask',
          h('div', { class: 'row' }, button('Feather...', async () => {
            const n = await import('../dialogs/dialog').then((m) => m.promptDialog('Feather Mask', 'Feather Radius (px):', '5'));
            if (n && Number(n) > 0) apply((m) => featherMask(m, Number(n)), 'Feather Mask');
          }, { small: true }), button('Invert', () => apply((m) => grayToAlpha(invertGray(alphaToGray(m))), 'Invert Mask'), { small: true })),
          h('div', { class: 'row' }, button('Select and Mask...', () => selectAndMaskDialog(), { small: true }), button('Color Range...', () => bus.emit('cmd', 'color-range'), { small: true }))),
        section('Mask Actions',
          h('div', { class: 'row' },
            iconButton('a-selectivecolor', 'Load selection from mask', () => { import('../ops/selectops').then((m) => m.loadFromLayer(doc, L, 'new', true)); }),
            iconButton('check', 'Apply mask', () => deleteMask(true)),
            iconButton('eye', L.maskEnabled ? 'Disable mask' : 'Enable mask', () => toggleMask()),
            iconButton('trash', 'Delete mask', () => deleteMask(false)))),
        h('div', { class: 'field-label', style: { fontSize: '11px' } }, 'Paint with black to hide, white to reveal. Alt+click the mask thumbnail to view it.'));
    }
    function invertGray(c: HTMLCanvasElement) {
      const o = createCanvas(c.width, c.height);
      const x = ctx2d(o);
      x.drawImage(c, 0, 0);
      x.globalCompositeOperation = 'difference';
      x.fillStyle = '#fff';
      x.fillRect(0, 0, o.width, o.height);
      return o;
    }
    function adjustProps(doc: Doc, L: Layer) {
      const def = getAdjustment(L.adjustment!.kind);
      const wrap = h('div');
      if (!def) { wrap.appendChild(h('div', { class: 'panel-empty' }, 'Unknown adjustment')); return wrap; }
      wrap.appendChild(h('div', { class: 'props-header' }, icon(def.icon, 16), h('span', null, def.name)));
      const ui = def.buildUI(L.adjustment!.params, (p) => {
        lastParams = p;
        setLayerPropLive(doc, L, 'adjustment', { kind: def.kind, params: p }, `Modify ${def.name} Layer`);
      }, { source: () => pixelsBelow(doc, L) });
      const body = h('div', { class: 'props' }, ui);
      const foot = h('div', { class: 'panel-footer' },
        iconButton('a-curves', L.clipped ? 'Release clip' : 'Clip to layer below', () => toggleClipping(), { active: L.clipped }),
        iconButton('eye', 'Toggle layer visibility', () => setLayerPropLive(doc, L, 'visible', !L.visible, 'Show/Hide Layer')),
        iconButton('undo', 'Reset to adjustment defaults', () => { setLayerPropLive(doc, L, 'adjustment', { kind: def.kind, params: def.defaults() }, `Reset ${def.name}`); flushPendingProp(); lastKey = ''; render(); }),
        iconButton('trash', 'Delete this adjustment layer', () => import('../ops/layerops').then((m) => m.deleteLayers())));
      wrap.append(body, foot);
      return wrap;
    }

    const r = rafThrottle(render);
    bus.on('layers', r);
    bus.on('docs', r);
    bus.on('history', r);
    render();
    return root;
  },
};

export const adjustmentsPanel: Panel = {
  id: 'adjustments', title: 'Adjustments', icon: 'p-adjustments',
  build() {
    const grid = h('div', { class: 'adj-grid' });
    for (const a of ADJUSTMENTS.filter((x) => !x.noLayer)) {
      grid.appendChild(iconButton(a.icon, a.name, () => newAdjustmentLayer(a.kind)));
    }
    return h('div', null, h('div', { class: 'adj-title' }, 'Add an adjustment'), grid);
  },
};

void sliderField; void modifyDialog; void invertMask;
