import { bus } from '../core/bus';
import type { Viewport } from '../ui/viewport';

export interface PointerInfo {
  /** document coordinates (float) */
  x: number; y: number;
  /** viewport-relative CSS pixels */
  sx: number; sy: number;
  pressure: number;
  button: number;
  shift: boolean; alt: boolean; ctrl: boolean;
  e: PointerEvent | MouseEvent;
}

export abstract class Tool {
  abstract id: string;
  abstract name: string;
  abstract icon: string;
  /** Single-letter shortcut shared by the group (Shift+key cycles). */
  key = '';
  /** Toolbar slot id; tools sharing a group appear in one flyout. */
  group = '';
  private _bar: HTMLElement | null = null;

  /** CSS cursor for the canvas. */
  cursor(_p?: PointerInfo | null): string { return 'default'; }
  /** Options bar content (built once). */
  buildOptions(): HTMLElement | null { return null; }
  options(): HTMLElement | null {
    if (!this._bar) this._bar = this.buildOptions();
    return this._bar;
  }
  /** Rebuild the options bar (when tool settings change externally). */
  refreshOptions() { this._bar = null; bus.emit('tool'); }

  down(_p: PointerInfo, _v: Viewport): void {}
  move(_p: PointerInfo, _v: Viewport): void {}
  up(_p: PointerInfo, _v: Viewport): void {}
  hover(_p: PointerInfo, _v: Viewport): void {}
  dblclick(_p: PointerInfo, _v: Viewport): void {}
  /** Return true if the key was handled. */
  keydown(_e: KeyboardEvent, _v: Viewport): boolean { return false; }
  keyup(_e: KeyboardEvent, _v: Viewport): boolean { return false; }
  /** Screen-space overlay. ctx is set up for CSS pixels (dpr applied). */
  overlay(_ctx: CanvasRenderingContext2D, _v: Viewport): void {}
  activate(): void {}
  /** Called when switching away: commit pending work. */
  deactivate(): void {}
  /** Tools with modal state (crop, transform, text) report it so Enter/Esc go to them. */
  get busy(): boolean { return false; }
  commit(): void {}
  cancel(): void {}
  /** Brush-like tools expose size for [ and ] */
  get size(): number | null { return null; }
  set size(_v: number | null) {}
  get hardness(): number | null { return null; }
  set hardness(_v: number | null) {}
}

// ---------- registry ----------
export const TOOLS: Tool[] = [];
/** Toolbar layout: groups in order; null = separator. */
export const TOOLBAR: (string | null)[] = [];
const groupActive = new Map<string, string>();
let current: Tool | null = null;

export function registerTools(list: Tool[], layout: (string | null)[]) {
  TOOLS.push(...list);
  TOOLBAR.push(...layout);
  for (const t of list) if (!groupActive.has(t.group)) groupActive.set(t.group, t.id);
}
export const getTool = (id: string) => TOOLS.find((t) => t.id === id) ?? null;
export const currentTool = () => current!;
export const toolsInGroup = (g: string) => TOOLS.filter((t) => t.group === g);
export const groupTool = (g: string) => getTool(groupActive.get(g)!) ?? toolsInGroup(g)[0];

export function setTool(id: string) {
  const t = getTool(id);
  if (!t || t === current) return;
  current?.deactivate();
  current = t;
  groupActive.set(t.group, t.id);
  t.activate();
  bus.emit('tool');
}
/** Pressing a tool letter: select group's tool, Shift cycles within group. */
export function toolByKey(key: string, cycle: boolean) {
  const k = key.toUpperCase();
  const candidates = TOOLS.filter((t) => t.key === k);
  if (!candidates.length) return;
  const g = current && current.key === k ? current.group : candidates[0].group;
  const inGroup = toolsInGroup(g).filter((t) => t.key === k);
  if (cycle && current && current.key === k) {
    const i = inGroup.indexOf(current);
    setTool(inGroup[(i + 1) % inGroup.length].id);
  } else setTool(groupTool(g).key === k ? groupTool(g).id : inGroup[0].id);
}
