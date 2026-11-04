// Typed access to the preload bridge (window.opalNative).
export interface PhotoEntry { path: string; name: string; size: number; mtime: number }
export interface Recent { path: string; at: number }

export interface OpalNative {
  openDialog(): Promise<string | null>;
  folderDialog(title?: string, defaultPath?: string): Promise<string | null>;
  saveDialog(defaultPath: string, ext: string): Promise<string | null>;
  read(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number; mtime: number; ctime: number } | null>;
  list(path: string): Promise<{ folder: string; files: PhotoEntry[] }>;
  write(path: string, data: Uint8Array): Promise<string>;
  exists(path: string): Promise<boolean>;
  trash(path: string): Promise<string>;
  shellThumb(path: string, size: number): Promise<Uint8Array | null>;
  thumbGet(key: string): Promise<Uint8Array | null>;
  thumbPut(key: string, data: Uint8Array): Promise<void>;
  asset(name: string): Promise<Uint8Array>;
  copyImage(png: Uint8Array): Promise<boolean>;
  showInFolder(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  edit(path: string): Promise<boolean>;
  recent(): Promise<Recent[]>;
  addRecent(path: string): Promise<void>;
  clearRecent(): Promise<void>;
  settings(): Promise<Record<string, unknown>>;
  setSettings(s: Record<string, unknown>): Promise<void>;
  setTitle(title: string): Promise<void>;
  setFullscreen(on: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
  defaultStatus(): Promise<{ supported: boolean; registered: boolean; isDefault: boolean }>;
  makeDefault(): Promise<boolean>;
  about(): Promise<{ version: string; electron: string; chrome: string; standalone: boolean }>;
  pathForFile(file: File): string;
  onOpen(cb: (path: string) => void): void;
  onFolderChanged(cb: (folder: string) => void): void;
  onFullscreen(cb: (on: boolean) => void): void;
}

export const native = (window as unknown as { opalNative: OpalNative }).opalNative;

export const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
export const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
export const extOf = (p: string) => (/\.([^.\\/]+)$/.exec(p)?.[1] || '').toLowerCase();
export const isHeif = (p: string) => /^(heic|heif|hif)$/.test(extOf(p));
