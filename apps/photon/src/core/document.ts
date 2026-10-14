import { Layer, LayerSnapshot } from './layer';
import { bus } from './bus';
import { createCanvas, ctx2d, Rect, rectUnion, uid, rectIntersect, cloneCanvas } from './util';
import { maskBounds, maskOutline } from './selection';
import { VectorPath, clonePaths } from './paths';
import { normalizeLayers, descendants } from './groups';

export interface AlphaChannel { id: number; name: string; canvas: HTMLCanvasElement }

export interface DocState {
  width: number; height: number; resolution: number;
  layers: LayerSnapshot[];
  activeId: number;
  selection: HTMLCanvasElement | null;
  channels: AlphaChannel[];
  paths: VectorPath[];
}

/** In-place pixel change on a canvas (brush strokes etc.). */
export interface Patch { canvas: HTMLCanvasElement; x: number; y: number; before: ImageData; after: ImageData }

export interface HistoryEntry {
  id: number;
  name: string;
  before: DocState;
  after: DocState;
  patches: Patch[];
}

export interface Snapshot { id: number; name: string; state: DocState; thumb: string }

/** Pixels lifted from a layer (move with selection, free transform, paste). */
export interface Floating {
  layer: Layer;
  canvas: HTMLCanvasElement;
  /** Maps floating-canvas pixel coords to document coords. */
  matrix: DOMMatrix;
}

export const HISTORY_LIMIT = { value: 50 };

export class Doc {
  id = uid();
  name: string;
  width: number;
  height: number;
  resolution = 72;
  layers: Layer[] = [];
  activeId = 0;
  /** Extra layers selected in the Layers panel (Ctrl/Shift click), includes active. */
  selectedIds = new Set<number>();
  selection: HTMLCanvasElement | null = null;
  private selOutline: Path2D | null = null;
  private selBounds: Rect | null | undefined = undefined;
  channels: AlphaChannel[] = [];
  paths: VectorPath[] = [];
  activePathId = 0;
  guides: { dir: 'h' | 'v'; pos: number }[] = [];

  history: HistoryEntry[] = [];
  historyIndex = 0;
  historyBaseName = 'Open';
  snapshots: Snapshot[] = [];
  activeSnapshotId = 0;
  savedStateId = 0;

  zoom = 1;
  panX = 0;
  panY = 0;

  composite: HTMLCanvasElement;
  dirty: Rect | null;

  editMask = false;
  quickMask = false;
  channelView: 'rgb' | 'r' | 'g' | 'b' = 'rgb';
  /** Alt+click mask thumbnail: show the active layer mask in grayscale. */
  viewMask = false;
  /** Backslash: show active layer mask as a red overlay. */
  maskOverlay = false;
  compositeVersion = 0;
  viewInit = false;
  floating: Floating | null = null;
  fileHandle: any = null;
  filePath: string | null = null;
  fileFormat = 'psd';

  constructor(name: string, w: number, h: number) {
    this.name = name;
    this.width = w;
    this.height = h;
    this.composite = createCanvas(w, h);
    this.dirty = { x: 0, y: 0, w, h };
  }

  // ---------- Layers ----------
  get active(): Layer | null { return this.layers.find((l) => l.id === this.activeId) ?? this.layers[this.layers.length - 1] ?? null; }
  byId(id: number) { return this.layers.find((l) => l.id === id) ?? null; }
  indexOf(l: Layer) { return this.layers.indexOf(l); }
  setActive(l: Layer | null, additive = false) {
    if (!l) return;
    this.activeId = l.id;
    if (!additive) this.selectedIds.clear();
    this.selectedIds.add(l.id);
    if (!l.mask) this.editMask = false;
    bus.emit('layers', this);
  }
  get selectedLayers(): Layer[] {
    const s = this.layers.filter((l) => this.selectedIds.has(l.id) || l.id === this.activeId);
    return s.length ? s : this.active ? [this.active] : [];
  }
  nextLayerName(base = 'Layer') {
    let n = 1;
    const names = new Set(this.layers.map((l) => l.name));
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }
  newLayer(name?: string): Layer {
    return new Layer(name ?? this.nextLayerName(), this.width, this.height);
  }
  /**
   * Insert above the active layer (inside it if it's an expanded group), like Photoshop.
   * With an explicit index the caller sets l.parentId.
   */
  insertLayer(l: Layer, index?: number) {
    const a = this.active;
    let i = index;
    if (i === undefined) {
      if (a && a.kind === 'group' && !a.collapsed) { l.parentId = a.id; i = this.indexOf(a); }
      else { l.parentId = a ? a.parentId : 0; i = a ? this.indexOf(a) + 1 : this.layers.length; }
    }
    this.layers.splice(i, 0, l);
    normalizeLayers(this);
    this.setActive(l);
    this.invalidate();
  }
  /** Remove a layer (and a group's contents). */
  removeLayer(l: Layer) {
    const i = this.indexOf(l);
    if (i < 0) return;
    const inner = descendants(this, l);
    for (const d of inner) { this.layers.splice(this.indexOf(d), 1); this.selectedIds.delete(d.id); }
    this.layers.splice(this.indexOf(l), 1);
    this.selectedIds.delete(l.id);
    if (this.activeId === l.id || !this.byId(this.activeId)) {
      const at = Math.max(0, i - inner.length);
      const n = this.layers[Math.min(at, this.layers.length - 1)] ?? this.layers[at - 1];
      if (n) this.setActive(n);
    }
    this.invalidate();
  }

  /** Raster layers (and masks) must cover the document rect so painting anywhere works. */
  ensureCoverage(l: Layer): boolean {
    let changed = false;
    if (l.kind === 'raster') {
      const r = coverRect(l.x, l.y, l.canvas.width, l.canvas.height, this.width, this.height);
      if (r) {
        const c = createCanvas(r.w, r.h);
        ctx2d(c).drawImage(l.canvas, l.x - r.x, l.y - r.y);
        l.canvas = c; l.x = r.x; l.y = r.y;
        changed = true;
      }
    }
    if (l.mask) {
      const r = coverRect(l.maskX, l.maskY, l.mask.width, l.mask.height, this.width, this.height);
      if (r) {
        const c = createCanvas(r.w, r.h);
        const x = ctx2d(c);
        x.fillStyle = '#000';
        x.fillRect(0, 0, r.w, r.h);
        x.clearRect(l.maskX - r.x, l.maskY - r.y, l.mask.width, l.mask.height);
        x.drawImage(l.mask, l.maskX - r.x, l.maskY - r.y);
        l.mask = c; l.maskX = r.x; l.maskY = r.y;
        changed = true;
      }
    }
    if (changed) l.touch();
    return changed;
  }

  // ---------- Selection ----------
  setSelection(mask: HTMLCanvasElement | null) {
    if (mask && !maskBounds(mask)) mask = null;
    this.selection = mask;
    this.selOutline = null;
    this.selBounds = undefined;
    bus.emit('selection', this);
    bus.emit('render', this);
  }
  get hasSelection() { return !!this.selection; }
  selectionBounds(): Rect | null {
    if (!this.selection) return null;
    if (this.selBounds === undefined) this.selBounds = maskBounds(this.selection);
    return this.selBounds;
  }
  selectionOutline(): Path2D | null {
    if (!this.selection) return null;
    if (!this.selOutline) this.selOutline = maskOutline(this.selection);
    return this.selOutline;
  }

  // ---------- State / history ----------
  captureState(): DocState {
    return {
      width: this.width, height: this.height, resolution: this.resolution,
      layers: this.layers.map((l) => l.snapshot()),
      activeId: this.activeId,
      selection: this.selection,
      channels: this.channels.slice(),
      paths: clonePaths(this.paths),
    };
  }
  restoreState(s: DocState) {
    const sizeChanged = s.width !== this.width || s.height !== this.height;
    this.width = s.width; this.height = s.height; this.resolution = s.resolution;
    this.layers = s.layers.map((ls) => { ls.layer.restore(ls); return ls.layer; });
    this.activeId = s.activeId;
    this.selectedIds = new Set([s.activeId]);
    if (!this.active?.mask) this.editMask = false;
    this.channels = s.channels.slice();
    this.paths = clonePaths(s.paths);
    if (sizeChanged) this.composite = createCanvas(this.width, this.height);
    this.floating = null;
    this.setSelection(s.selection);
    this.invalidate();
    bus.emit('layers', this);
    bus.emit('pixels', this);
    bus.emit('paths', this);
    bus.emit('channels', this);
    if (sizeChanged) bus.emit('view', this);
  }

  /** Record an undoable step. `before` must be captured before mutating. */
  commit(name: string, before: DocState, patches: Patch[] = []) {
    this.history.splice(this.historyIndex);
    this.history.push({ id: uid(), name, before, after: this.captureState(), patches });
    if (this.history.length > HISTORY_LIMIT.value) {
      const drop = this.history.length - HISTORY_LIMIT.value;
      this.history.splice(0, drop);
    }
    this.historyIndex = this.history.length;
    this.invalidate();
    bus.emit('history', this);
    bus.emit('layers', this);
    bus.emit('pixels', this);
    bus.emit('docs');
  }
  get canUndo() { return this.historyIndex > 0; }
  get canRedo() { return this.historyIndex < this.history.length; }
  undo() {
    if (!this.canUndo) return;
    const e = this.history[--this.historyIndex];
    for (let i = e.patches.length - 1; i >= 0; i--) { const p = e.patches[i]; ctx2d(p.canvas).putImageData(p.before, p.x, p.y); }
    this.restoreState(e.before);
    bus.emit('history', this);
    bus.emit('docs');
  }
  redo() {
    if (!this.canRedo) return;
    const e = this.history[this.historyIndex++];
    this.restoreState(e.after);
    for (const p of e.patches) ctx2d(p.canvas).putImageData(p.after, p.x, p.y);
    // restoreState ran before the patches; touch layers whose canvas got patched
    for (const p of e.patches) this.layers.forEach((l) => { if (l.canvas === p.canvas || l.mask === p.canvas) l.touch(); });
    this.invalidate();
    bus.emit('pixels', this);
    bus.emit('history', this);
    bus.emit('docs');
  }
  gotoHistory(index: number) {
    while (this.historyIndex > index) this.undo();
    while (this.historyIndex < index) this.redo();
  }
  get stateId() { return this.historyIndex > 0 ? this.history[this.historyIndex - 1].id : 0; }
  get isDirty() { return this.stateId !== this.savedStateId; }
  markSaved() { this.savedStateId = this.stateId; bus.emit('docs'); }

  /** Deep copy of the current state (canvases cloned) for snapshots. */
  cloneState(): DocState {
    const s = this.captureState();
    s.layers = s.layers.map((ls) => ({ ...ls, canvas: cloneCanvas(ls.canvas), mask: ls.mask ? cloneCanvas(ls.mask) : null }));
    return s;
  }
  takeSnapshot(name?: string) {
    const snap: Snapshot = {
      id: uid(),
      name: name ?? `Snapshot ${this.snapshots.length}`,
      state: this.cloneState(),
      thumb: this.thumbnail(48).toDataURL(),
    };
    this.snapshots.push(snap);
    if (!this.activeSnapshotId) this.activeSnapshotId = snap.id;
    bus.emit('history', this);
    return snap;
  }
  restoreSnapshot(snap: Snapshot) {
    const before = this.captureState();
    const s: DocState = { ...snap.state, layers: snap.state.layers.map((ls) => ({ ...ls, canvas: cloneCanvas(ls.canvas), mask: ls.mask ? cloneCanvas(ls.mask) : null })) };
    this.restoreState(s);
    this.commit(snap.name, before);
  }

  // ---------- Rendering ----------
  invalidate(r?: Rect | null) {
    const full = { x: 0, y: 0, w: this.width, h: this.height };
    const rr = r ? rectIntersect(r, full) : full;
    if (rr) this.dirty = rectUnion(this.dirty, rr);
    bus.emit('render', this);
  }
  thumbnail(max: number): HTMLCanvasElement {
    const s = Math.min(max / this.width, max / this.height, 1);
    const c = createCanvas(Math.max(1, Math.round(this.width * s)), Math.max(1, Math.round(this.height * s)));
    const x = ctx2d(c);
    x.imageSmoothingQuality = 'high';
    x.drawImage(this.composite, 0, 0, c.width, c.height);
    return c;
  }
}

function coverRect(x: number, y: number, w: number, h: number, dw: number, dh: number): Rect | null {
  if (x <= 0 && y <= 0 && x + w >= dw && y + h >= dh) return null;
  const nx = Math.min(x, 0), ny = Math.min(y, 0);
  return { x: nx, y: ny, w: Math.max(x + w, dw) - nx, h: Math.max(y + h, dh) - ny };
}
