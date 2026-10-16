// Typed access to the preload bridge (window.quartzNative).
export interface Recent { path: string; name: string; at: number; pages?: number }
export interface Signature { id: string; name: string; png: string; w: number; h: number }

export interface QuartzNative {
  openDialog(title?: string): Promise<string[]>;
  imageDialog(): Promise<string | null>;
  saveDialog(defaultName: string, kind?: 'pdf' | 'png' | 'txt'): Promise<string | null>;
  folderDialog(title?: string): Promise<string | null>;
  read(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  write(path: string, data: Uint8Array): Promise<string>;
  recent(): Promise<Recent[]>;
  addRecent(r: { path: string; name?: string; pages?: number }): Promise<void>;
  removeRecent(path: string): Promise<void>;
  signatures(): Promise<Signature[]>;
  setSignatures(list: Signature[]): Promise<void>;
  asset(kind: string, filename: string): Promise<Uint8Array>;
  showInFolder(path: string): Promise<void>;
  openPath(path: string): Promise<string>;
  openUrl(url: string): Promise<void>;
  setTitle(title: string): Promise<void>;
  print(pages: Uint8Array[], name: string): Promise<boolean>;
  defaultStatus(): Promise<{ supported: boolean; registered: boolean; isDefault: boolean }>;
  makeDefault(): Promise<boolean>;
  about(): Promise<{ version: string; electron: string; chrome: string }>;
  pathForFile(file: File): string;
  onOpen(cb: (paths: string[]) => void): void;
}

export const native = (window as unknown as { quartzNative: QuartzNative }).quartzNative;

export const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
