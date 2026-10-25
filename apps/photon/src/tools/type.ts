import { Tool, PointerInfo } from './tool';
import type { Viewport } from '../ui/viewport';
import { app } from '../app';
import { bus } from '../core/bus';
import { h } from '../ui/dom';
import { toolHeader, sep } from '../ui/optbits';
import { select, numberInput, colorSwatch, iconButton, segmented } from '../ui/widgets';
import { Layer, TextData } from '../core/layer';
import { Doc, DocState } from '../core/document';
import { clamp, cssColor, Point, Rect } from '../core/util';
import { defaultText, renderTextLayer, cssFont, FONT_FAMILIES, FONT_STYLES, textLayerName } from '../core/text';

/** Settings used for new text and shown in the options bar / Character panel. */
export const typeOpts: TextData = defaultText({ size: 48 });

/** The bounding box's handles while editing: corners and edge midpoints, clockwise from the top left. */
const HANDLES: Point[] = [{ x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }];
const HANDLE_CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];
/** Screen px between the editor and the bounding box (so the handles sit outside the text field), and how far
 *  outside the box a drag moves the text instead of committing it. */
const BOX_GAP = 5, MOVE_ZONE = 18;

type BoxDrag =
  | { kind: 'resize'; h: number; start: Point; t0: TextData; box0: Rect; scale: boolean }
  | { kind: 'move'; start: Point; screen: Point; x0: number; y0: number; commitIfStill: boolean };

export class TypeTool extends Tool {
  id = 'type'; name = 'Horizontal Type Tool'; icon = 'type'; key = 'T'; group = 'type';
  private editing: { L: Layer; isNew: boolean; before: DocState; doc: Doc; original?: TextData } | null = null;
  private ta: HTMLTextAreaElement | null = null;
  private v: Viewport | null = null;
  private dragStart: Point | null = null;
  private dragCur: Point | null = null;
  /** Dragging the bounding box while editing. */
  private boxDrag: BoxDrag | null = null;
  /** The paragraph box is too short for its text (Photoshop marks the corner handle). */
  private overflow = false;
  get busy() { return !!this.editing; }
  cursor(p?: PointerInfo | null) {
    if (this.editing && p) {
      const d = this.boxDrag;
      if (d) return d.kind === 'move' ? 'move' : HANDLE_CURSORS[d.h];
      const hi = this.handleAt(p);
      if (hi !== null) return HANDLE_CURSORS[hi];
      if (p.ctrl || this.nearBox(p)) return 'move';
    }
    return 'text';
  }
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
      // a handle resizes: point text scales, paragraph text reflows in its new box (Ctrl scales it instead)
      const hi = this.handleAt(p);
      if (hi !== null && L.text) {
        this.boxDrag = { kind: 'resize', h: hi, start: { x: p.x, y: p.y }, t0: { ...L.text }, box0: this.textBox()!, scale: p.ctrl || !L.text.boxWidth };
        this.passThrough(true);
        return;
      }
      // just outside the box (or Ctrl anywhere) moves the text; a plain click there still commits it
      if (p.ctrl || this.nearBox(p)) {
        this.boxDrag = { kind: 'move', start: { x: p.x, y: p.y }, screen: { x: p.sx, y: p.sy }, x0: L.x, y0: L.y, commitIfStill: !p.ctrl };
        this.passThrough(true);
        return;
      }
      this.commit();
      return;
    }
    if (hit) { this.beginEdit(doc, hit, false); return; }
    this.dragStart = { x: p.x, y: p.y };
    this.dragCur = this.dragStart;
  }
  move(p: PointerInfo) {
    const d = this.boxDrag, e = this.editing;
    if (d && e) {
      if (d.kind === 'move') {
        e.L.x = Math.round(d.x0 + p.x - d.start.x);
        e.L.y = Math.round(d.y0 + p.y - d.start.y);
        this.positionEditor();
        e.doc.invalidate();
      } else this.resizeTo(p, d);
      return;
    }
    if (this.dragStart) this.dragCur = { x: p.x, y: p.y };
  }
  up(p: PointerInfo, v: Viewport) {
    const d = this.boxDrag;
    if (d) {
      this.boxDrag = null;
      this.passThrough(false);
      if (d.kind === 'move' && d.commitIfStill && Math.hypot(p.sx - d.screen.x, p.sy - d.screen.y) < 3) { this.commit(); return; }
      // the size field follows a scale
      if (d.kind === 'resize' && this.editing?.L.text) { typeOpts.size = this.editing.L.text.size; bus.emit('options'); }
      setTimeout(() => this.ta?.focus()); // pressing on the canvas took the focus from the text
      return;
    }
    if (!this.dragStart) return;
    const doc = v.doc!;
    const s = this.dragStart, c = this.dragCur ?? s;
    this.dragStart = this.dragCur = null;
    const box = Math.abs(c.x - s.x) > 8 ? Math.abs(c.x - s.x) : 0;
    const before = doc.captureState();
    const L = new Layer('Text', 1, 1);
    L.kind = 'text';
    L.text = { ...typeOpts, text: '', boxWidth: box || undefined, boxHeight: undefined, pad: 0 };
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
    // show the text from the top like the layer does, even when the caret is in lines a short paragraph box hides
    ta.addEventListener('scroll', () => { ta.scrollTop = 0; ta.scrollLeft = 0; });
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
    this.overflow = renderTextLayer(e.L); // keeps metrics/anchor current
    const t = e.L.text;
    const z = v.doc!.zoom;
    ta.style.font = cssFont(t, z);
    ta.style.lineHeight = `${t.size * t.leading * z}px`;
    ta.style.letterSpacing = `${(t.tracking / 1000) * t.size * z}px`;
    ta.style.textAlign = t.align;
    ta.style.color = cssColor(t.color);
    ta.style.textTransform = t.allCaps ? 'uppercase' : 'none';
    ta.style.textDecoration = [t.underline ? 'underline' : '', t.strike ? 'line-through' : ''].join(' ').trim() || 'none';
    ta.style.whiteSpace = t.boxWidth ? 'pre-wrap' : 'pre';
    this.positionEditor();
    e.doc.invalidate();
    bus.emit('layers', e.doc);
  }
  private positionEditor() {
    const e = this.editing, ta = this.ta, v = this.v;
    const r = this.editorRect();
    if (!e || !ta || !v || !v.doc || !e.L.text || !r) return;
    ta.style.left = `${r.x}px`;
    ta.style.top = `${r.y}px`;
    ta.style.width = `${r.w}px`;
    ta.style.height = `${r.h}px`;
    ta.style.font = cssFont(e.L.text, v.doc.zoom);
    ta.style.lineHeight = `${e.L.text.size * e.L.text.leading * v.doc.zoom}px`;
  }

  // ---------- bounding box ----------
  /** While the box is dragged the text field lets the pointer through, so the drag keeps reaching the canvas. */
  private passThrough(on: boolean) { if (this.ta) this.ta.style.pointerEvents = on ? 'none' : ''; }
  /** The text box in document coordinates (the layer's canvas minus its padding). */
  private textBox(): Rect | null {
    const t = this.editing?.L.text;
    if (!t) return null;
    const L = this.editing!.L, pad = t.pad ?? 0;
    return { x: L.x + pad, y: L.y + pad, w: L.canvas.width - pad * 2, h: L.canvas.height - pad * 2 };
  }
  /** Where the text field sits on screen. */
  private editorRect(): Rect | null {
    const t = this.editing?.L.text, v = this.v, b = this.textBox();
    if (!t || !v?.doc || !b) return null;
    const z = v.doc.zoom, s = v.toScreen(b.x, b.y);
    const fixedH = !!(t.boxWidth && t.boxHeight);
    return { x: s.x, y: s.y, w: Math.max(t.size * z * 0.6, b.w * z + 4), h: fixedH ? b.h * z : Math.max(t.size * t.leading * z, b.h * z) };
  }
  /** The bounding box on screen (a little outside the text field, so its handles can be grabbed). */
  private handleBox(): Rect | null {
    const r = this.editorRect();
    return r && { x: r.x - BOX_GAP, y: r.y - BOX_GAP, w: r.w + BOX_GAP * 2, h: r.h + BOX_GAP * 2 };
  }
  private handlePoint(r: Rect, i: number): Point {
    const s = HANDLES[i];
    return { x: r.x + ((s.x + 1) / 2) * r.w, y: r.y + ((s.y + 1) / 2) * r.h };
  }
  private handleAt(p: PointerInfo): number | null {
    const r = this.handleBox();
    if (!r) return null;
    for (let i = 0; i < 8; i++) {
      const q = this.handlePoint(r, i);
      if (Math.abs(q.x - p.sx) <= 6 && Math.abs(q.y - p.sy) <= 6) return i;
    }
    return null;
  }
  private nearBox(p: PointerInfo) {
    const r = this.handleBox();
    return !!r && p.sx >= r.x - MOVE_ZONE && p.sy >= r.y - MOVE_ZONE && p.sx <= r.x + r.w + MOVE_ZONE && p.sy <= r.y + r.h + MOVE_ZONE;
  }
  /** Follow a handle drag: scale the type about the opposite handle, or move the paragraph box's edges. */
  private resizeTo(p: PointerInfo, d: Extract<BoxDrag, { kind: 'resize' }>) {
    const e = this.editing!, L = e.L, t0 = d.t0, b0 = d.box0, s = HANDLES[d.h];
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    let bx: number, by: number;
    if (d.scale) {
      const ax = b0.x + ((1 - s.x) / 2) * b0.w, ay = b0.y + ((1 - s.y) / 2) * b0.h; // the opposite handle
      const hx = b0.x + ((1 + s.x) / 2) * b0.w, hy = b0.y + ((1 + s.y) / 2) * b0.h; // the one being dragged
      let k: number;
      if (s.x && s.y) {
        // corners: proportional, along the diagonal
        const vx = hx - ax, vy = hy - ay;
        k = ((hx + dx - ax) * vx + (hy + dy - ay) * vy) / (vx * vx + vy * vy || 1);
      } else if (s.x) k = (hx + dx - ax) / (hx - ax || 1);
      else k = (hy + dy - ay) / (hy - ay || 1);
      const size = clamp(Math.round(t0.size * k * 10) / 10, 1, 2000);
      k = size / t0.size;
      L.text = { ...t0, size, boxWidth: t0.boxWidth ? Math.max(1, t0.boxWidth * k) : undefined, boxHeight: t0.boxHeight ? Math.max(1, t0.boxHeight * k) : undefined };
      renderTextLayer(L);
      const b = this.textBox()!;
      bx = s.x > 0 ? b0.x : s.x < 0 ? b0.x + b0.w - b.w : b0.x + (b0.w - b.w) / 2;
      by = s.y > 0 ? b0.y : s.y < 0 ? b0.y + b0.h - b.h : b0.y + (b0.h - b.h) / 2;
    } else {
      // paragraph text: the dragged edges move, the text rewraps (a height that's set hides lines that don't fit)
      L.text = {
        ...t0,
        boxWidth: s.x ? Math.max(4, b0.w + s.x * dx) : t0.boxWidth,
        boxHeight: s.y ? Math.max(1, b0.h + s.y * dy) : t0.boxHeight,
      };
      renderTextLayer(L);
      const b = this.textBox()!;
      bx = s.x < 0 ? b0.x + b0.w - b.w : b0.x;
      by = s.y < 0 ? b0.y + b0.h - b.h : b0.y;
    }
    const pad = L.text!.pad ?? 0;
    L.x = Math.round(bx) - pad;
    L.y = Math.round(by) - pad;
    this.styleEditor();
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
    const r = this.editing && this.v === v ? this.handleBox() : null;
    if (r) {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#1473e6';
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
      ctx.fillStyle = '#fff';
      for (let i = 0; i < 8; i++) {
        const q = this.handlePoint(r, i);
        ctx.fillRect(Math.round(q.x) - 3.5, Math.round(q.y) - 3.5, 7, 7);
        ctx.strokeRect(Math.round(q.x) - 3.5, Math.round(q.y) - 3.5, 7, 7);
      }
      if (this.overflow) {
        // overflow: a bigger bottom-right handle with a plus
        const q = this.handlePoint(r, 4), x = Math.round(q.x), y = Math.round(q.y);
        ctx.fillRect(x - 5.5, y - 5.5, 11, 11);
        ctx.strokeRect(x - 5.5, y - 5.5, 11, 11);
        ctx.strokeStyle = '#d7373f';
        ctx.beginPath(); ctx.moveTo(x - 3, y + 0.5); ctx.lineTo(x + 4, y + 0.5); ctx.moveTo(x + 0.5, y - 3); ctx.lineTo(x + 0.5, y + 4); ctx.stroke();
      }
      ctx.restore();
    }
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
