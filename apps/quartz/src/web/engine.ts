// PDF.js setup. Quartz uses PDF.js's "legacy" build: the regular one needs newer JavaScript than Electron
// 33's Chromium has. The worker runs from a blob (module workers can't start from file:// pages), and the
// data PDF.js loads on demand - character maps for CJK text, the 14 standard fonts, image decoders - comes
// through the app's file bridge instead of fetch().
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw';
import type * as Viewer from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import { native } from './native';

(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })), { type: 'module' });

export { pdfjsLib };

/** The viewer components (they read pdfjsLib from globalThis, so they load after it is set). */
export const viewerLib: Promise<typeof Viewer> = import('pdfjs-dist/legacy/web/pdf_viewer.mjs');

/** Reads PDF.js's data files through the app instead of fetch(). */
class AppBinaryDataFactory {
  cMapUrl: string; standardFontDataUrl: string; wasmUrl: string;
  constructor(o: { cMapUrl?: string; standardFontDataUrl?: string; wasmUrl?: string }) {
    this.cMapUrl = o.cMapUrl ?? 'app:';
    this.standardFontDataUrl = o.standardFontDataUrl ?? 'app:';
    this.wasmUrl = o.wasmUrl ?? 'app:';
  }
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    return native.asset(kind, filename);
  }
}

export function openDocument(data: Uint8Array, password?: string) {
  return pdfjsLib.getDocument({
    data,
    password,
    cMapUrl: 'app:cmaps/', cMapPacked: true,
    standardFontDataUrl: 'app:standard_fonts/',
    wasmUrl: 'app:wasm/',
    useWorkerFetch: false,
    BinaryDataFactory: AppBinaryDataFactory as never,
    enableXfa: false,
  });
}

export const { AnnotationEditorType, AnnotationEditorParamsType, AnnotationMode, PasswordResponses } = pdfjsLib;
export type PDFDocumentProxy = pdfjsLib.PDFDocumentProxy;
