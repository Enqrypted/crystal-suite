// One open document: a PDF.js viewer (continuous pages, text selection, links, form fields, and the
// annotation editor for highlights, drawings, text and images), plus Quartz's own state: where it lives on
// disk, whether it has unsaved changes, and an undo history for page-level edits (organize, insert...).
import { AnnotationEditorParamsType, AnnotationEditorType, AnnotationMode, openDocument, PasswordResponses, viewerLib, type PDFDocumentProxy } from './engine';
import { h } from './ui/dom';
import { baseName } from './native';

export type Tool = 'select' | 'hand' | 'highlight' | 'draw' | 'text' | 'image';
export type ParamKind = 'inkColor' | 'inkThickness' | 'inkOpacity' | 'textColor' | 'textSize' | 'highlightColor' | 'highlightThickness';

export const HIGHLIGHT_COLORS = 'yellow=#FFF16B,green=#7CF2B0,blue=#8FD3FF,pink=#FFB3DA,orange=#FFB061';
const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6.4];
const MODES: Record<Tool, number> = {
  select: AnnotationEditorType.NONE, hand: AnnotationEditorType.NONE, highlight: AnnotationEditorType.HIGHLIGHT,
  draw: AnnotationEditorType.INK, text: AnnotationEditorType.FREETEXT, image: AnnotationEditorType.STAMP,
};

const P = AnnotationEditorParamsType;
const PARAM_KINDS: [ParamKind, number][] = [
  ['inkColor', P.INK_COLOR], ['inkThickness', P.INK_THICKNESS], ['inkOpacity', P.INK_OPACITY],
  ['textColor', P.FREETEXT_COLOR], ['textSize', P.FREETEXT_SIZE],
  ['highlightColor', P.HIGHLIGHT_COLOR], ['highlightThickness', P.HIGHLIGHT_THICKNESS],
];

type ViewerMod = Awaited<typeof viewerLib>;
let seq = 0;

export interface FindResult { current: number; total: number; state: 'found' | 'notfound' | 'wrapped' | 'pending' | '' }

export class DocTab {
  readonly id = ++seq;
  path: string | null;
  name: string;
  /** The document as last loaded or saved (annotation edits live in PDF.js until the next save). */
  bytes: Uint8Array;
  pdf!: PDFDocumentProxy;
  private task: ReturnType<typeof openDocument> | null = null;
  readonly el: HTMLElement;
  private viewerEl: HTMLElement;
  private V!: ViewerMod;
  eventBus!: InstanceType<ViewerMod['EventBus']>;
  linkService!: InstanceType<ViewerMod['PDFLinkService']>;
  findController!: InstanceType<ViewerMod['PDFFindController']>;
  viewer!: InstanceType<ViewerMod['PDFViewer']>;
  uiManager: any = null;
  tool: Tool = 'select';
  /** Page-level changes since the last save (annotation/form edits are tracked by PDF.js). */
  pagesChanged = false;
  editsChanged = false;
  canUndoEdit = false;
  canRedoEdit = false;
  private history: Uint8Array[] = [];
  private future: Uint8Array[] = [];
  password: string | undefined;
  find: FindResult = { current: 0, total: 0, state: '' };
  /** An annotation is selected (colour and size changes then apply to it). */
  hasSelection = false;
  /** What PDF.js reports for the selected annotation, or the current tool's defaults. */
  editorParams: Partial<Record<ParamKind, string | number>> = {};
  /** The colours and sizes new annotations get (the app's saved settings). */
  defaults: () => Partial<Record<ParamKind, string | number>> = () => ({});
  /** PDF.js takes them only once a page's annotation layer exists (again after every reload). */
  private editorReady = false;
  /** Something the toolbar shows changed (page, zoom, tool, modified state, find results). */
  onChange: () => void = () => {};
  askPassword: (wrong: boolean) => Promise<string | null> = async () => null;
  private ready!: Promise<void>;
  private readyResolve!: () => void;

  constructor(bytes: Uint8Array, path: string | null, name?: string) {
    this.bytes = bytes;
    this.path = path;
    this.name = name ?? (path ? baseName(path) : 'Untitled.pdf');
    this.viewerEl = h('div', { class: 'pdfViewer' });
    this.el = h('div', { class: 'doc-view' }, this.viewerEl);
    this.ready = new Promise((r) => { this.readyResolve = r; });
  }

  get modified() { return this.pagesChanged || this.editsChanged; }
  get pageCount() { return this.pdf?.numPages ?? 0; }
  get page() { return this.viewer?.currentPageNumber ?? 1; }
  get scale() { return this.viewer?.currentScale ?? 1; }
  get encrypted() { return !!this.password; }

  /** Builds the viewer and opens the bytes; rejects when the file isn't a usable PDF. */
  async start() {
    this.V = await viewerLib;
    const V = this.V;
    this.eventBus = new V.EventBus();
    this.linkService = new V.PDFLinkService({ eventBus: this.eventBus, externalLinkTarget: V.LinkTarget.BLANK });
    this.findController = new V.PDFFindController({ eventBus: this.eventBus, linkService: this.linkService });
    this.viewer = new V.PDFViewer({
      container: this.el as HTMLDivElement,
      viewer: this.viewerEl as HTMLDivElement,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      annotationMode: AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: AnnotationEditorType.NONE,
      annotationEditorHighlightColors: HIGHLIGHT_COLORS,
      enableHighlightFloatingButton: true,
      textLayerMode: 1,
      removePageBorders: true,
      imageResourcesPath: './pdfjs/images/',
      maxCanvasPixels: 2 ** 25,
    } as never);
    this.linkService.setViewer(this.viewer);
    const bus = this.eventBus;
    bus.on('pagesinit', () => {
      this.viewer.currentScaleValue = String(this.pendingScale ?? 'auto');
      if (this.pendingPage) this.viewer.currentPageNumber = Math.min(this.pendingPage, this.pdf.numPages);
      this.pendingScale = this.pendingPage = undefined;
      this.readyResolve();
      this.onChange();
    });
    bus.on('annotationeditorlayerrendered', () => {
      if (this.editorReady) return;
      this.editorReady = true;
      for (const [kind, value] of Object.entries(this.defaults())) {
        if (value !== undefined && PARAM_KINDS.some(([k]) => k === kind)) this.setParam(kind as ParamKind, value);
      }
    });
    bus.on('pagechanging', () => this.onChange());
    bus.on('scalechanging', () => this.onChange());
    bus.on('annotationeditoruimanager', (e: { uiManager: unknown }) => { this.uiManager = e.uiManager; });
    bus.on('editingstateschanged', (e: { details: { hasSomethingToUndo?: boolean; hasSomethingToRedo?: boolean; hasSelectedEditor?: boolean } }) => {
      if (e.details.hasSomethingToUndo !== undefined) this.canUndoEdit = e.details.hasSomethingToUndo;
      if (e.details.hasSomethingToRedo !== undefined) this.canRedoEdit = e.details.hasSomethingToRedo;
      if (e.details.hasSelectedEditor !== undefined) this.hasSelection = e.details.hasSelectedEditor;
      this.syncTextHandle();
      this.onChange();
    });
    // the colour/size of the selected annotation (or the tool's defaults), for the options bar
    bus.on('annotationeditorparamschanged', (e: { details: [number, unknown][] }) => {
      for (const [type, value] of e.details) {
        const kind = PARAM_KINDS.find(([, t]) => t === type)?.[0];
        if (kind) this.editorParams[kind] = value as string | number;
      }
      this.syncTextHandle();
      this.onChange();
    });
    // PDF.js asks the app to switch tools (adding a picture moves to its image mode) and switches itself;
    // the viewer follows a moment later so its mode (and the toolbar) stay in step
    const follow = (e: { mode: number }) => {
      setTimeout(() => {
        if (this.parked || !this.pdf) return;
        try { this.viewer.annotationEditorMode = { mode: e.mode } as never; } catch { /* closing */ }
      });
    };
    bus.on('switchannotationeditormode', follow);
    // ...and the floating "Highlight" button on a text selection waits for the app to open the highlighter
    bus.on('showannotationeditorui', follow);
    bus.on('annotationeditormodechanged', (e: { mode: number }) => {
      // PDF.js changes mode by itself too (adding a picture or signature switches to its image mode)
      if (!this.parked) {
        const tool = (Object.keys(MODES) as Tool[]).find((k) => k !== 'hand' && MODES[k] === e.mode);
        if (tool && !(tool === 'select' && this.tool === 'hand')) this.tool = tool;
      }
      this.onChange();
    });
    bus.on('updatefindmatchescount', (e: { matchesCount: { current: number; total: number } }) => {
      this.find = { ...this.find, current: e.matchesCount.current, total: e.matchesCount.total };
      this.onChange();
    });
    bus.on('updatefindcontrolstate', (e: { state: number; matchesCount: { current: number; total: number } }) => {
      const states = ['found', 'notfound', 'wrapped', 'pending'] as const;
      this.find = { current: e.matchesCount?.current ?? 0, total: e.matchesCount?.total ?? 0, state: states[e.state] ?? '' };
      this.onChange();
    });
    this.handTool();
    await this.load(this.bytes);
  }

  private pendingScale: string | number | undefined;
  private pendingPage: number | undefined;

  /** Opens bytes in this tab's viewer (PDF.js takes ownership of the buffer it is given, so it gets a copy). */
  private async load(bytes: Uint8Array) {
    this.ready = new Promise((r) => { this.readyResolve = r; });
    this.editorReady = false;
    const task = openDocument(bytes.slice(), this.password);
    task.onPassword = async (update: (pw: string) => void, reason: number) => {
      const pw = await this.askPassword(reason === PasswordResponses.INCORRECT_PASSWORD);
      if (pw === null) { task.destroy(); return; }
      this.password = pw;
      update(pw);
    };
    const oldTask = this.task;
    this.pdf = await task.promise;
    this.task = task;
    const storage = this.pdf.annotationStorage as unknown as { onSetModified: () => void; onResetModified: () => void };
    storage.onSetModified = () => { this.editsChanged = true; this.onChange(); };
    storage.onResetModified = () => { this.editsChanged = false; this.onChange(); };
    this.viewer.setDocument(this.pdf);
    this.linkService.setDocument(this.pdf, null);
    this.canUndoEdit = this.canRedoEdit = false;
    oldTask?.destroy();
    await this.ready;
  }

  /** Finishes what is being edited: the text box being typed in, and a drawing still in progress (PDF.js
   *  keeps a drawing open until the tool changes). */
  commitEditing() {
    const ui = this.uiManager;
    if (ui?.endCurrentEditing) ui.endCurrentEditing();
    else ui?.commitOrRemove?.();
  }

  /** The document as it should be saved: PDF.js writes the annotation and form edits into it. */
  async currentBytes(): Promise<Uint8Array> {
    this.commitEditing();
    if (this.editsChanged && this.pdf.annotationStorage.size > 0) return this.pdf.saveDocument();
    return this.bytes;
  }

  /** After a successful save. */
  saved(bytes: Uint8Array, path: string) {
    this.bytes = bytes;
    this.path = path;
    this.name = baseName(path);
    this.pagesChanged = false;
    this.pdf.annotationStorage.resetModified();
    this.editsChanged = false;
    this.onChange();
  }

  /** Replaces the document with new bytes (a page-level edit), keeping the place; undoable. */
  async replace(next: Uint8Array, opts: { page?: number } = {}) {
    const before = await this.currentBytes();
    this.history.push(before);
    if (this.history.length > 12) this.history.shift();
    this.future = [];
    await this.reload(next, opts.page);
    this.pagesChanged = true;
    this.onChange();
  }

  private async reload(bytes: Uint8Array, page?: number) {
    this.pendingScale = this.viewer.currentScaleValue || 'auto';
    this.pendingPage = page ?? this.viewer.currentPageNumber;
    this.bytes = bytes;
    this.editsChanged = false;
    await this.load(bytes);
  }

  get canUndo() { return this.canUndoEdit || this.history.length > 0; }
  get canRedo() { return this.canRedoEdit || this.future.length > 0; }

  async undo() {
    if (this.canUndoEdit) { this.uiManager?.undo(); return; }
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(await this.currentBytes());
    await this.reload(prev);
    this.pagesChanged = true;
    this.onChange();
  }

  async redo() {
    if (this.canRedoEdit) { this.uiManager?.redo(); return; }
    const next = this.future.pop();
    if (!next) return;
    this.history.push(await this.currentBytes());
    await this.reload(next);
    this.pagesChanged = true;
    this.onChange();
  }

  // ---------- view ----------

  goTo(page: number) { this.viewer.currentPageNumber = Math.max(1, Math.min(this.pageCount, page)); }
  setZoom(v: 'page-width' | 'page-fit' | 'auto' | 'page-actual' | number) { this.viewer.currentScaleValue = typeof v === 'number' ? String(v) : v; }
  zoomStep(dir: 1 | -1) {
    const cur = this.viewer.currentScale;
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.001) ?? cur : [...ZOOMS].reverse().find((z) => z < cur - 0.001) ?? cur;
    this.viewer.currentScale = next;
  }
  rotateView() { this.viewer.pagesRotation = (this.viewer.pagesRotation + 90) % 360; }

  setTool(tool: Tool) {
    this.tool = tool;
    this.parked = false;
    this.el.classList.toggle('hand', tool === 'hand');
    this.setMode(MODES[tool]);
    this.onChange();
  }

  /** While another tab is in front, its editing tools are switched off (PDF.js listens for keys on the
   *  whole window); `unpark` brings the tool back. */
  private parked = false;
  park() { if (this.pdf && MODES[this.tool] !== AnnotationEditorType.NONE) { this.parked = true; this.setMode(AnnotationEditorType.NONE); } }
  unpark() { if (this.parked) this.setTool(this.tool); }
  /** An editing tool (highlight, draw, text, image) is active, so PDF.js handles editing keys. */
  get editing() { return !!this.pdf && !this.parked && MODES[this.tool] !== AnnotationEditorType.NONE; }

  private setMode(mode: number) {
    if (!this.pdf || !this.uiManager) return;
    try { this.viewer.annotationEditorMode = { mode } as never; } catch { /* not ready yet */ }
  }

  /** Sets a colour or size: on the selected annotations if there are any, otherwise for new ones. */
  setParam(kind: ParamKind, value: string | number) {
    const type = PARAM_KINDS.find(([k]) => k === kind)![1];
    this.eventBus.dispatch('switchannotationeditorparams', { source: this, type, value });
    this.editorParams[kind] = value;
  }

  // ---------- resizing text boxes ----------
  // PDF.js sizes a text box by its font size and gives it no handles; a selected text box gets a corner
  // handle here that scales the text as it is dragged (one undo step per drag).
  private textHandle: HTMLElement | null = null;

  private syncTextHandle() {
    if (!this.textHandle) {
      this.textHandle = h('div', { class: 'qz-text-size', title: 'Drag to make the text bigger or smaller' });
      this.textHandle.addEventListener('pointerdown', (e) => this.resizeText(e));
    }
    const selected = [...this.el.querySelectorAll<HTMLElement>('.freeTextEditor.selectedEditor')];
    const box = this.hasSelection && selected.length === 1 ? selected[0] : null;
    if (!box) this.textHandle.remove();
    else if (this.textHandle.parentElement !== box) box.append(this.textHandle);
  }

  private resizeText(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = this.textHandle?.parentElement;
    const editor = box && this.uiManager?.getEditor?.(box.id);
    if (!box || !editor) return;
    const start = Number((editor.propertiesToUpdate as [number, unknown][]).find(([t]) => t === P.FREETEXT_SIZE)?.[1]) || 10;
    const r = box.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    let last = start;
    this.textHandle!.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      // follow whichever way the corner moved more, relative to the box
      const f = Math.max((r.width + m.clientX - sx) / r.width, (r.height + m.clientY - sy) / r.height);
      const size = Math.round(Math.min(200, Math.max(4, start * f)));
      if (size !== last) { last = size; editor.updateParams(P.FREETEXT_SIZE, size); }
    };
    const up = () => {
      this.textHandle?.removeEventListener('pointermove', move);
      this.textHandle?.removeEventListener('pointerup', up);
      this.textHandle?.removeEventListener('pointercancel', up);
      this.editorParams.textSize = last;
      this.syncTextHandle();
      this.onChange();
    };
    this.textHandle!.addEventListener('pointermove', move);
    this.textHandle!.addEventListener('pointerup', up);
    this.textHandle!.addEventListener('pointercancel', up);
  }

  /** Adds an image or signature to the current page (PDF.js's image editor: move and resize it after).
   *  `size` is in PDF points; without it PDF.js treats image pixels as points, capped at 3/4 of the page. */
  addImage(file: File, size?: { w: number; h: number }) {
    const ui = this.uiManager;
    if (!ui) return;
    if (size) {
      // size the new editor as it is added, before its bitmap loads and lays it out
      const restore = () => { if (Object.prototype.hasOwnProperty.call(ui, 'addEditor')) delete ui.addEditor; };
      ui.addEditor = (ed: { width: number; height: number; pageDimensions: [number, number]; editorType: string; div: unknown; isAttachedToDOM: boolean }) => {
        // switching modes re-registers existing editors too: only the brand-new picture is sized
        if (ed.editorType === 'stamp' && !ed.div && !ed.isAttachedToDOM && !ed.width) {
          restore();
          const [pw, ph] = ed.pageDimensions;
          const k = Math.min(1, (pw * 0.8) / size.w, (ph * 0.8) / size.h);
          ed.width = (size.w * k) / pw;
          ed.height = (size.h * k) / ph;
        }
        return Object.getPrototypeOf(ui).addEditor.call(ui, ed);
      };
      setTimeout(restore, 4000);
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    ui.drop({ dataTransfer: dt, preventDefault() {} });
  }

  /** Drag the page around (hand tool). */
  private handTool() {
    this.el.addEventListener('pointerdown', (e) => {
      if (this.tool !== 'hand' || e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = this.el.scrollLeft, oy = this.el.scrollTop;
      this.el.classList.add('grabbing');
      const move = (m: PointerEvent) => { this.el.scrollLeft = ox - (m.clientX - sx); this.el.scrollTop = oy - (m.clientY - sy); };
      const up = () => { this.el.classList.remove('grabbing'); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    // Ctrl + wheel zooms around the pointer
    this.el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const v = this.viewer as unknown as { updateScale?: (o: { scaleFactor: number; origin: [number, number] }) => void };
      const factor = Math.exp(-e.deltaY * 0.0022);
      if (v.updateScale) v.updateScale({ scaleFactor: factor, origin: [e.clientX, e.clientY] });
      else this.viewer.currentScale = Math.min(6.4, Math.max(0.1, this.viewer.currentScale * factor));
    }, { passive: false });
  }

  // ---------- search ----------

  search(query: string, opts: { again?: boolean; previous?: boolean; caseSensitive?: boolean; entireWord?: boolean } = {}) {
    this.eventBus.dispatch('find', {
      source: this, type: opts.again ? 'again' : '', query, caseSensitive: !!opts.caseSensitive, entireWord: !!opts.entireWord,
      highlightAll: true, findPrevious: !!opts.previous, matchDiacritics: false,
    });
  }
  closeSearch() {
    this.eventBus.dispatch('findbarclose', { source: this });
    this.find = { current: 0, total: 0, state: '' };
  }

  destroy() {
    this.viewer?.setDocument(null as never);
    this.task?.destroy();
    this.el.remove();
  }
}
