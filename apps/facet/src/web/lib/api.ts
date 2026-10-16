// Typed access to the preload bridge (window.facet).
import type { DeskCommand, DesktopEntry, DisplayInfo, HitRect, IconInfo, MediaState, OrganizeGroup, RecentFolder, Settings, State, SysState, Wall, Widget, WidgetType, Category } from '../../shared/types';

export interface FacetApi {
  init(): Promise<{ state: State; display: DisplayInfo | null; wall: Wall | null; media: MediaState; sys: SysState | null; recent: RecentFolder[] }>;
  put(w: Widget): Promise<boolean>;
  add(type: WidgetType, opts?: { name?: string; display?: string; x?: number; y?: number; paths?: string[] }): Promise<string | null>;
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
  /** A drag on the empty desktop (only while the Windows desktop icons are hidden). */
  onMarquee(cb: (m: { phase: 'start' | 'move' | 'end'; x: number; y: number }) => void): void;
  onMedia(cb: (m: MediaState) => void): void;
  onSys(cb: (s: SysState) => void): void;
  onRecent(cb: (r: RecentFolder[]) => void): void;
  /** target 'spotify' or 'current'; cmd play-pause, next, prev, seek (ms), shuffle (1/0), repeat (None/Track/List). */
  mediaCmd(target: string, cmd: string, arg?: string): Promise<string | null>;
  sysSet(key: 'volume' | 'mute' | 'nightlight' | 'dark' | 'wifi' | 'bluetooth' | 'brightness', value: number | boolean): Promise<void>;
  launch(what: string): Promise<void>;
  pathForFile(file: File): string;
}

export const api = (window as unknown as { facet: FacetApi }).facet;
