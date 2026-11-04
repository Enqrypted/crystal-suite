// Runs libheif in workers: one for the photo on screen (and its neighbours), one for thumbnails, so a folder
// full of thumbnails never holds up the photo you're looking at. libheif's files load on first use.
import HeifWorker from './heif.worker.ts?worker&inline';
import type { HeifImageResult, HeifRequest } from './heif.worker';
import { native } from './native';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
type Req = HeifRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

let assets: Promise<{ glue: string; wasm: Uint8Array }> | null = null;
function loadAssets() {
  assets ??= Promise.all([native.asset('libheif.js'), native.asset('libheif.wasm')]).then(([js, wasm]) => ({
    glue: URL.createObjectURL(new Blob([js], { type: 'text/javascript' })),
    wasm,
  }));
  return assets;
}

class Lane {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private next = 1;

  private start() {
    if (this.ready) return this.ready;
    const w = new HeifWorker();
    this.worker = w;
    w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; error?: string; result?: unknown }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error || 'HEIC decoding failed'));
    };
    w.onerror = (e) => {
      // the worker died (out of memory on a huge photo...): fail what's waiting and start over next time
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'The HEIC decoder stopped'));
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
      this.ready = null;
    };
    this.ready = loadAssets().then(({ glue, wasm }) => this.send({ op: 'init', glue, wasm: wasm.slice().buffer }, []));
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  private send<T>(req: Req, transfer: Transferable[]): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...req, id }, transfer);
    });
  }

  async run<T>(req: Req, transfer: Transferable[] = []): Promise<T> {
    await this.start();
    return this.send<T>(req, transfer);
  }
}

const viewLane = new Lane();
const thumbLane = new Lane();

/** Decodes the photo (or only its embedded preview, which is much faster). `bytes` is copied, not taken. */
export function decodeHeif(bytes: Uint8Array, preview = false): Promise<HeifImageResult> {
  const copy = bytes.slice().buffer;
  return viewLane.run<HeifImageResult>({ op: 'decode', bytes: copy, preview }, [copy]);
}

/** A JPEG thumbnail of a HEIC photo, at most `size` pixels on its long edge. */
export function heifThumb(bytes: Uint8Array, size: number): Promise<{ jpeg: ArrayBuffer; width: number; height: number }> {
  const copy = bytes.slice().buffer;
  return thumbLane.run({ op: 'thumb', bytes: copy, size }, [copy]);
}

export type { HeifImageResult };
