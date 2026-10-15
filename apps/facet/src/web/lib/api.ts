// Typed access to the preload bridge (window.facet).
import type { DeskCommand, DesktopEntry, DisplayInfo, HitRect, IconInfo, OrganizeGroup, Settings, State, Wall, Widget, Category } from '../../shared/types';

export interface FacetApi {
  init(): Promise<{ state: State; display: DisplayInfo | null; wall: Wall | null }>;
  put(w: Widget): Promise<boolean>;
  add(type: 'folder' | 'clock', opts?: { name?: string; display?: string; x?: number; y?: number; paths?: string[] }): Promise<string | null>;
  remove(id: string): Promise<void>;
  addItems(id: string, paths: string[], index?: number): Promise<number>;
  settings(patch: Partial<Settings>): Promise<void>;
  icon(path: string): Promise<IconInfo>;
  exists(paths: string[]): Promise<boolean[]>;
  open(path: string): Promise<string>;
  reveal(path: string): Promise<void>;
  pick(kind: 'files' | 'folder'): Promise<string[]>;
  desktop(): Promise<DesktopEntry[]>;
  categorize(paths: string[]): Promise<Category[]>;
  organize(groups: OrganizeGroup[], hideIcons: boolean): Promise<number>;
  desktopIcons(show: boolean): Promise<void>;
  home(): Promise<void>;
  quit(): Promise<void>;
  command(cmd: DeskCommand): Promise<void>;
  rects(rects: HitRect[], capture: boolean): Promise<void>;
  keyboard(on: boolean): Promise<void>;
  readWall(): Promise<Uint8Array | null>;
  onState(cb: (s: State) => void): void;
  onWall(cb: (w: Wall) => void): void;
  onInteractive(cb: (on: boolean) => void): void;
  onCommand(cb: (c: DeskCommand | { kind: 'organize' }) => void): void;
  pathForFile(file: File): string;
}

export const api = (window as unknown as { facet: FacetApi }).facet;
