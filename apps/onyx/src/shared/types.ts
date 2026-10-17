// What Onyx's main process and its windows share.

/** Which clip lengths the picker offers, in seconds (the replay buffer always holds the longest). */
export const LENGTHS = [15, 30, 60, 120] as const;
export const BUFFER_SECONDS = 120;

/** Max output heights offered; 0 = the game's own size. */
export const RESOLUTIONS = [0, 2160, 1440, 1080, 720, 480] as const;

export type Mode = 'auto' | 'window' | 'screen';

export interface Settings {
  /** Instant replay on (a game is recorded into memory while it runs). */
  enabled: boolean;
  mode: Mode;
  /** The chosen window for mode "window": its program and title when it was picked. */
  window: { exe: string; title: string; name: string; hwnd?: string } | null;
  /** The chosen display for mode "screen" (Electron display id); null = the main display. */
  display: string | null;
  resolution: number;
  fps: 30 | 60;
  /** 0 standard, 1 high, 2 ultra. */
  quality: 0 | 1 | 2;
  systemAudio: boolean;
  mic: boolean;
  hotkey: string;
  /** Where clips go; empty = Videos\Onyx. */
  folder: string;
  sound: boolean;
  startup: boolean;
  /** Length the picker starts on (the last one used). */
  lastLength: number;
  /** Program file names (lower case) that always / never count as games. */
  always: string[];
  never: string[];
}

/** Most games recorded at once (each has its own replay buffer). */
export const MAX_RECORDINGS = 4;

/** One game (or window, or screen) being recorded into its own replay buffer. */
export interface Recording {
  id: string;
  phase: 'starting' | 'recording';
  name: string;
  /** Its window's title (tells two windows of one game apart). */
  title: string;
  exe: string;
  kind: 'window' | 'screen';
  /** The recording whose game was in front most recently. */
  front: boolean;
  width: number;
  height: number;
  fps: number;
  kbps: number;
  encoder: string;
  hardware: boolean;
  gpu: string;
  /** From the helper each second. */
  live: { fps: number; buffered: number; bytes: number; dropped: number };
  /** A warning (sound). */
  message: string;
  saving: boolean;
}

export interface DisplayInfo { id: string; label: string; primary: boolean; width: number; height: number }

export interface State {
  version: string;
  settings: Settings;
  /** off: instant replay switched off; waiting: on, nothing to record; error: the last start failed. */
  status: 'off' | 'waiting' | 'recording' | 'error';
  recordings: Recording[];
  /** Why nothing records (a failed start, the recorder restarting). */
  message: string;
  hotkeyOk: boolean;
  folder: string;
  displays: DisplayInfo[];
  standalone: boolean;
  helper: boolean;
}

export interface Clip {
  path: string;
  name: string;
  game: string;
  size: number;
  mtime: number;
  duration?: number;
  width?: number;
  height?: number;
}

export interface WindowChoice {
  hwnd: string;
  exe: string;
  title: string;
  name: string;
  game: boolean;
  icon: string | null;
}

export type OverlayMessage =
  | { kind: 'picker'; lengths: number[]; index: number; ms: number; hotkey: string; games: { name: string; sub: string; buffered: number }[]; game: number }
  | { kind: 'toast'; tone: 'ok' | 'info' | 'error'; title: string; sub: string; ms: number; chime: boolean; action?: string }
  | { kind: 'hide' };
