import { Tool, PointerInfo } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { bus } from '../core/bus';
import { h } from '../ui/dom';
import { toolHeader, sep } from '../ui/optbits';
import { select, numberInput, colorSwatch, iconButton, segmented } from '../ui/widgets';
import { Layer, TextData } from '../core/layer';
import { Doc, DocState } from '../core/document';
import { cssColor, Point } from '../core/util';
import { defaultText, renderTextLayer, cssFont, FONT_FAMILIES, FONT_STYLES, textLayerName } from '../core/text';

/** Settings used for new text and shown in the options bar / Character panel. */
export const typeOpts: TextData = defaultText({ size: 48 });

export class TypeTool extends Tool {
  id = 'type'; name = 'Horizontal Type Tool'; icon = 'type'; key = 'T'; group = 'type';
  private editing: { L: Layer; isNew: boolean; before: DocState; doc: Doc; original?: TextData } | null = null;
  private ta: HTMLTextAreaElement | null = null;
  private v: Viewport | null = null;
  private dragStart: Point | null = null;
  private dragCur: Point | null = null;
  get busy() { return !!this.editing; }
  cursor() { return 'text'; }
  constructor() {
    super();
    bus.on('view', () => this.positionEditor());
    bus.on('options', () => { if (this.editing) this.applyOpts(); });
  }
  buildOptions() {
    const font = select({ options: FONT_FAMILIES, value: typeOpts.font, width: 150, onChange: (v) => { typeOpts.font = v; this.optsChanged(); } });
    const style = select({ options: FONT_STYLES, value: typeOpts.style, width: 100, onChange: (v) => { typeOpts.style = v; this.optsChanged(); } });
    const size = numberInput({ value: typeOpts.size, min: 1, max: 2000, unit: 'px', width: 50, onChange: (v) => { typeOpts.size = v; this.optsChanged(); } });
    const align = segmented({
      value: typeOpts.align,
      options: [
        { value: 'left', title: 'Left align text', icon: 'p-paragraph' },
        { value: 'center', title: 'Center text', icon: 'menu' },
        { value: 'right', title: 'Right align text', icon: 'p-properties' },
      ],
      onChange: (v) => { typeOpts.align = v as any; this.optsChanged(); },
    });
    const color = colorSwatch({ color: typeOpts.color, title: 'Set the text color', onChange: (c) => { typeOpts.color = c; this.optsChanged(); } });
    bus.on('options', () => { font.set(typeOpts.font); style.set(typeOpts.style); size.set(typeOpts.size); align.set(typeOpts.align); color.set(typeOpts.color); });
    return h('div', { class: 'opt-group' }, toolHeader(this.icon), font.el, style.el, size.el, sep(), align.el, sep(), color.el, sep(),
      iconButton('close', 'Cancel any current edits (Esc)', () => this.cancel()),
      iconButton('check', 'Commit any current edits (Ctrl+Enter)', () => this.commit()));
  }
  private optsChanged() { bus.emit('options'); }
  /** Push typeOpts into the layer being edited. */
  private applyOpts() {
    const e = this.editing;
    if (!e || !e.L.text) return;
    e.L.text = { ...e.L.text, font: typeOpts.font, style: typeOpts.style, size: typeOpts.size, align: typeOpts.align, color: typeOpts.color, tracking: typeOpts.tracking, leading: typeOpts.leading, underline: typeOpts.underline, strike: typeOpts.strike, allCaps: typeOpts.allCaps, fauxBold: typeOpts.fauxBold, fauxItalic: typeOpts.fauxItalic };
    this.styleEditor();
  }

  down(p: PointerInfo, v: Viewport) {
    this.v = v;
    const doc = v.doc!;
    // clicking another text layer edits it
    const hit = [...doc.layers].reverse().find((l) => l.kind === 'text' && l.visible && p.x >= l.x && p.y >= l.y && p.x <= l.x + l.canvas.width && p.y <= l.y + l.canvas.height);
    if (this.editing) {
      const L = this.editing.L;
      const inside = p.x >= L.x && p.y >= L.y && p.x <= L.x + L.canvas.width + 20 && p.y <= L.y + L.canvas.height + 20;
      if (inside) return;
      this.commit();
      return;
    }
    if (hit) { this.beginEdit(doc, hit, false); return; }
    this.dragStart = { x: p.x, y: p.y };
    this.dragCur = this.dragStart;
  }
  move(p: PointerInfo) { if (this.dragStart) this.dragCur = { x: p.x, y: p.y }; }
  up(_p: PointerInfo, v: Viewport) {
    if (!this.dragStart) return;
    const doc = v.doc!;
    const s = this.dragStart, c = this.dragCur ?? s;
    this.dragStart = this.dragCur = null;
    const box = Math.abs(c.x - s.x) > 8 ? Math.abs(c.x - s.x) : 0;
    const before = doc.captureState();
    const L = new Layer('Text', 1, 1);
    L.kind = 'text';
    L.text = { ...typeOpts, text: '', boxWidth: box || undefined, pad: 0 };
    // point text: click sets the baseline; place box top accordingly
    const top = box ? Math.min(s.y, c.y) : s.y - typeOpts.size * 0.85;
    L.x = Math.min(s.x, c.x); L.y = top;
    renderTextLayer(L);
    doc.insertLayer(L);
    this.beginEdit(doc, L, true, before);
  }
  private beginEdit(doc: Doc, L: Layer, isNew: boolean, before?: DocState) {
    if (!L.text) return;
    doc.setActive(L);
    Object.assign(typeOpts, { ...L.text, text: '' });
    bus.emit('options');
    this.editing = { L, isNew, before: before ?? doc.captureState(), doc, original: L.text };
    L.editing = true;
    L.touch();
    doc.invalidate();
    const ta = h('textarea', { class: 'text-editor', spellcheck: false }) as HTMLTextAreaElement;
    ta.value = L.text.text;
    this.ta = ta;
    ta.addEventListener('input', () => this.onInput());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.commit(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit(); }
    });
    this.v?.overlayLayer.appendChild(ta);
    this.styleEditor();
    setTimeout(() => { ta.focus(); ta.select(); });
  }
  private onInput() {
    const e = this.editing;
    if (!e || !this.ta || !e.L.text) return;
    e.L.text = { ...e.L.text, text: this.ta.value };
    this.styleEditor();
  }
  /** Size/position the textarea to match the layer's text at the current zoom. */
  private styleEditor() {
    const e = this.editing, ta = this.ta, v = this.v;
    if (!e || !ta || !v || !e.L.text) return;
    renderTextLayer(e.L); // keeps metrics/anchor current
    const t = e.L.text;
    const z = v.doc!.zoom;
    const pad = t.pad ?? 0;
    ta.style.font = cssFont(t, z);
    ta.style.lineHeight = `${t.size * t.leading * z}px`;
    ta.style.letterSpacing = `${(t.tracking / 1000) * t.size * z}px`;
    ta.style.textAlign = t.align;
    ta.style.color = cssColor(t.color);
    ta.style.textTransform = t.allCaps ? 'uppercase' : 'none';
    ta.style.textDecoration = [t.underline ? 'underline' : '', t.strike ? 'line-through' : ''].join(' ').trim() || 'none';
    ta.style.whiteSpace = t.boxWidth ? 'pre-wrap' : 'pre';
    const w = (e.L.canvas.width - pad * 2) * z, hh = (e.L.canvas.height - pad * 2) * z;
    ta.style.width = `${Math.max(t.size * z * 0.6, w + 4)}px`;
    ta.style.height = `${Math.max(t.size * t.leading * z, hh)}px`;
    this.positionEditor();
    e.doc.invalidate();
    bus.emit('layers', e.doc);
  }
  private positionEditor() {
    const e = this.editing, ta = this.ta, v = this.v;
    if (!e || !ta || !v || !v.doc || !e.L.text) return;
    const pad = e.L.text.pad ?? 0;
    const s = v.toScreen(e.L.x + pad, e.L.y + pad);
    ta.style.left = `${s.x}px`;
    ta.style.top = `${s.y}px`;
    ta.style.font = cssFont(e.L.text, v.doc.zoom);
    ta.style.lineHeight = `${e.L.text.size * e.L.text.leading * v.doc.zoom}px`;
  }
  commit() {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    this.ta?.remove();
    this.ta = null;
    e.L.editing = false;
    const text = e.L.text?.text ?? '';
    if (!text.trim()) {
      // empty text layer: remove it
      e.doc.removeLayer(e.L);
      if (!e.isNew) e.doc.commit('Delete Layer', e.before);
      else { e.doc.restoreState(e.before); }
      return;
    }
    if (e.isNew || e.L.name === 'Text' || e.L.name === textLayerName(e.original ?? e.L.text!)) e.L.name = textLayerName(e.L.text!);
    renderTextLayer(e.L);
    e.doc.invalidate();
    e.doc.commit(e.isNew ? 'Type Layer' : 'Edit Type Layer', e.before);
  }
  cancel() {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    this.ta?.remove();
    this.ta = null;
    e.L.editing = false;
    e.doc.restoreState(e.before);
  }
  deactivate() { this.commit(); }
  dblclick() {}
  overlay(ctx: CanvasRenderingContext2D, v: Viewport) {
    if (this.dragStart && this.dragCur) {
      const a = v.toScreen(this.dragStart.x, this.dragStart.y), b = v.toScreen(this.dragCur.x, this.dragCur.y);
      ctx.setLineDash([4, 3]); ctx.strokeStyle = '#1473e6';
      ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.setLineDash([]);
    }
  }
}

/** Apply partial text changes to the active text layer (Character / Paragraph panels). */
export function updateActiveText(patch: Partial<TextData>) {
  Object.assign(typeOpts, patch);
  bus.emit('options');
  const doc = app.doc;
  const L = doc?.active;
  if (!doc || !L || L.kind !== 'text' || !L.text || L.editing) return;
  const before = doc.captureState();
  L.text = { ...L.text, ...patch };
  renderTextLayer(L);
  doc.invalidate();
  doc.commit('Edit Type Layer', before);
}
