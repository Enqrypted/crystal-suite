// Editor state: the project, selection, cursor and view options, with snapshot undo/redo and
// change notifications. Every edit goes through commit() (or a begin/end gesture for drags).
import { newProject, type Project } from './model';

export type Topic = 'project' | 'selection' | 'time' | 'view' | 'media' | 'transport' | 'file';
type Listener = (topics: Set<Topic>) => void;

export interface ViewOptions {
  snapping: boolean;
  quantize: boolean;
  ripple: boolean;
  thumbnails: boolean;
  waveforms: boolean;
  previewQuality: 'auto' | 'full' | 'half' | 'quarter';
  /** Loop playback inside the time selection. */
  loop: boolean;
}

const VIEW_KEY = 'cut.view';
const loadView = (): ViewOptions => {
  const def: ViewOptions = { snapping: true, quantize: true, ripple: false, thumbnails: true, waveforms: true, previewQuality: 'auto', loop: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; } catch { return def; }
};

const MAX_UNDO = 200;

export class Store {
  project: Project = newProject();
  /** Selected clip ids. */
  selection = new Set<string>();
  /** The track used for pasting and inserting. */
  activeTrack: string | null = null;
  /** Cursor / playhead position. */
  time = 0;
  path: string | null = null;
  dirty = false;
  view = loadView();
  private undoStack: { label: string; data: string }[] = [];
  private redoStack: { label: string; data: string }[] = [];
  private gesture: { data: string } | null = null;
  private listeners = new Set<Listener>();
  private pending = new Set<Topic>();
  private scheduled = false;

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Notifies listeners once per frame with everything that changed. */
  emit(...topics: Topic[]) {
    for (const t of topics) this.pending.add(t);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const set = new Set(this.pending);
      this.pending.clear();
      for (const fn of this.listeners) fn(set);
    });
  }

  /** Applies an edit as one undoable step. */
  commit(label: string, fn: (p: Project) => void) {
    const before = JSON.stringify(this.project);
    fn(this.project);
    if (JSON.stringify(this.project) === before) return;
    this.push(label, before);
  }

  /** Starts a drag-style edit: live changes are shown but only one undo step is recorded at the end. */
  begin() { if (!this.gesture) this.gesture = { data: JSON.stringify(this.project) }; }
  /** Live update during a gesture. */
  live() { this.emit('project'); }
  end(label: string) {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (JSON.stringify(this.project) === g.data) { this.emit('project'); return; }
    this.push(label, g.data);
  }
  cancelGesture() {
    if (!this.gesture) return;
    this.project = JSON.parse(this.gesture.data);
    this.gesture = null;
    this.emit('project');
  }
  get inGesture() { return !!this.gesture; }

  private push(label: string, before: string) {
    this.undoStack.push({ label, data: before });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.setDirty(true);
    this.pruneSelection();
    this.emit('project', 'selection');
  }

  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label ?? ''; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label ?? ''; }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ label: e.label, data: JSON.stringify(this.project) });
    this.project = JSON.parse(e.data);
    this.afterRestore();
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push({ label: e.label, data: JSON.stringify(this.project) });
    this.project = JSON.parse(e.data);
    this.afterRestore();
  }
  private afterRestore() {
    this.setDirty(true);
    this.pruneSelection();
    this.emit('project', 'selection', 'media');
  }

  /** Replaces the whole project (new / open). */
  load(p: Project, path: string | null) {
    this.project = p;
    this.path = path;
    this.selection.clear();
    this.activeTrack = p.tracks[0]?.id ?? null;
    this.time = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.setDirty(false);
    this.emit('project', 'selection', 'time', 'media', 'file', 'view');
  }

  setDirty(d: boolean) {
    if (this.dirty === d) return;
    this.dirty = d;
    this.emit('file');
  }

  setTime(t: number) {
    t = Math.max(0, t);
    if (t === this.time) return;
    this.time = t;
    this.emit('time');
  }

  select(ids: Iterable<string>, add = false) {
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.emit('selection');
  }
  toggle(id: string) {
    if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    this.emit('selection');
  }
  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.emit('selection');
  }
  private pruneSelection() {
    const ids = new Set(this.project.clips.map((c) => c.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    if (this.activeTrack && !this.project.tracks.some((t) => t.id === this.activeTrack)) this.activeTrack = this.project.tracks[0]?.id ?? null;
  }
  selectedClips() { return this.project.clips.filter((c) => this.selection.has(c.id)); }

  setView<K extends keyof ViewOptions>(key: K, value: ViewOptions[K]) {
    this.view[key] = value;
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(this.view)); } catch { /* ignore */ }
    this.emit('view');
  }
}

export const store = new Store();
