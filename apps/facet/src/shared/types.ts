// Types shared by Facet's main process and its two web UIs (the desktop layer and the Facet window).

export interface Rect { x: number; y: number; w: number; h: number }

export interface FolderItem {
  id: string;
  /** What opens: a file, folder, shortcut (.lnk / .url) or program. */
  path: string;
  name: string;
}

export type FolderStyle = 'tile' | 'panel';
export type WidgetSize = 's' | 'm' | 'l';

export interface FolderWidget {
  id: string;
  type: 'folder';
  /** Display the widget lives on (Electron display id). */
  display: string;
  /** Position inside that display's work area (DIP). */
  x: number;
  y: number;
  name: string;
  items: FolderItem[];
  /** 'tile': an iOS-style folder icon that opens; 'panel': always open on the desktop. */
  style: FolderStyle;
  size: WidgetSize;
  /** Panel layout. */
  cols: number;
  rows: number;
  /** Glass tint ('' = the default glass). */
  tint: string;
}

export type ClockFace = 'minimal' | 'card' | 'analog' | 'stacked';

export interface ClockWidget {
  id: string;
  type: 'clock';
  display: string;
  x: number;
  y: number;
  face: ClockFace;
  font: string;
  weight: number;
  color: string;
  accent: string;
  /** Percent of the face's base size. */
  scale: number;
  hour24: boolean;
  seconds: boolean;
  date: 'none' | 'short' | 'long';
  align: 'left' | 'center' | 'right';
  bg: 'none' | 'glass' | 'dark';
  shadow: boolean;
  blink: boolean;
}

export type Widget = FolderWidget | ClockWidget;

export interface Settings {
  startup: boolean;
  lock: boolean;
  glass: 'light' | 'dark';
  labels: boolean;
  /** Hide the Windows desktop icons while Facet runs. */
  iconsHidden: boolean;
}

export interface DisplayInfo {
  id: string;
  label: string;
  primary: boolean;
  bounds: Rect;
  workArea: Rect;
  scale: number;
}

/** How the wallpaper looks on one display, for the frosted glass. Rects in physical pixels. */
export interface Wall {
  image: string | null;
  /** Changes when the image file does. */
  stamp: string;
  /** 0 center, 1 tile, 2 stretch, 3 fit, 4 fill, 5 span (IDesktopWallpaper positions). */
  position: number;
  bg: string;
  monitor: Rect;
  virtual: Rect;
  /** The work area, relative to the monitor. */
  work: Rect;
}

export interface State {
  version: string;
  widgets: Widget[];
  settings: Settings;
  displays: DisplayInfo[];
  /** The native helper is running (desktop pinning, big icons, desktop icon toggle). */
  helper: boolean;
  /** Whether the Windows desktop icons are showing (null when unknown). */
  iconsVisible: boolean | null;
  standalone: boolean;
  /** The Windows accent colour (selection box). */
  accent: string;
}

export interface IconInfo { url: string; kind: 'icon' | 'thumb' | 'art'; missing?: boolean }

export type Category = 'apps' | 'games' | 'folders' | 'documents' | 'pictures' | 'videos' | 'music' | 'archives' | 'web' | 'other';

export interface DesktopEntry { path: string; name: string; category: Category }

export interface OrganizeGroup { name: string; paths: string[]; style: FolderStyle }

/** Hit areas a desktop layer reports so clicks elsewhere fall through to the real desktop. */
export interface HitRect extends Rect { id: string }

export type DeskCommand =
  | { kind: 'customize'; id: string }
  | { kind: 'open'; id: string }
  | { kind: 'flash'; id: string };
