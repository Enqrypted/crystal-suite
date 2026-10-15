// Typed access to the main process (see src/preload.ts).
export interface NativeBridge {
  openMedia(): Promise<string[]>;
  openProject(): Promise<string | null>;
  saveProject(name: string): Promise<string | null>;
  saveRender(defaultPath: string, ext: string): Promise<string | null>;
  defaultRenderPath(name: string, ext: string): Promise<string>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  read(path: string, start: number, end: number): Promise<Uint8Array>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<boolean>;
  openWrite(path: string): Promise<number>;
  writeAt(handle: number, data: Uint8Array, position: number): Promise<void>;
  closeWrite(handle: number, removePath?: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  recent(): Promise<string[]>;
  addRecent(path: string): Promise<void>;
  autosave(text: string | null): Promise<void>;
  recovery(): Promise<string | null>;
  setTitle(title: string): Promise<void>;
  about(): Promise<{ version: string; chrome: string; electron: string }>;
  openUrl(url: string): Promise<void>;
  pathForFile(file: File): string;
  onOpen(cb: (req: { project?: string; media?: string[] }) => void): void;
}

export const native = (window as unknown as { cutNative: NativeBridge }).cutNative;

export const fileName = (p: string) => p.split(/[\\/]/).pop() || p;
export const baseName = (p: string) => fileName(p).replace(/\.[^.]+$/, '');
export const extOf = (p: string) => (/\.([^.\\/]+)$/.exec(p)?.[1] || '').toLowerCase();
export const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
