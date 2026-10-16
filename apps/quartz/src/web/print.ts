// Printing: every page is drawn at print resolution with its form values and new annotations, then handed
// to the main process, which opens the system print dialog (printer, page range, copies, layout).
import type { DocTab } from './doc';
import { AnnotationMode } from './engine';
import { h } from './ui/dom';
import { modal, alertBox } from './ui/dialog';
import { native } from './native';

/** Draws page `n` as it should come out on paper (or in an exported image). */
export async function renderOutput(tab: DocTab, n: number, dpi: number, storage?: unknown) {
  const page = await tab.pdf.getPage(n);
  let viewport = page.getViewport({ scale: dpi / 72 });
  // keep huge pages (posters, maps) to a sane bitmap size
  const max = 7000;
  if (Math.max(viewport.width, viewport.height) > max) viewport = page.getViewport({ scale: (dpi / 72) * (max / Math.max(viewport.width, viewport.height)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvas, canvasContext: ctx, viewport, intent: 'print',
    annotationMode: AnnotationMode.ENABLE_STORAGE,
    printAnnotationStorage: storage ?? (tab.pdf.annotationStorage as unknown as { print: unknown }).print,
  } as never).promise;
  page.cleanup();
  return canvas;
}

export const canvasBytes = (c: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality?: number) =>
  new Promise<Uint8Array>((resolve, reject) => c.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('The page couldn’t be drawn.'))), type, quality));

/** Runs `work` with a progress dialog that can cancel it. */
export async function withProgress<T>(title: string, work: (step: (done: number, total: number, label?: string) => void, cancelled: () => boolean) => Promise<T>): Promise<T | null> {
  const bar = h('i');
  const label = h('div', { class: 'prog-label' }, 'Starting…');
  let cancelled = false;
  let close: (v: string) => void = () => {};
  const shown = modal(title, h('div', {}, label, h('div', { class: 'progress' }, bar)), [{ label: 'Cancel', value: 'cancel' }], {
    width: 420, onOpen: (c) => { close = c; },
  }).then((v) => { if (v !== 'done') cancelled = true; });
  try {
    const out = await work((done, total, text) => {
      bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
      label.textContent = text ?? `${done} of ${total}`;
    }, () => cancelled);
    return cancelled ? null : out;
  } finally {
    close('done');
    await shown;
  }
}

export async function printDoc(tab: DocTab) {
  tab.commitEditing();
  const storage = (tab.pdf.annotationStorage as unknown as { print: unknown }).print;
  const total = tab.pageCount;
  // ~150 dpi keeps big documents printable; short ones get sharper output
  const dpi = total > 60 ? 120 : total > 20 ? 150 : 200;
  try {
    const pages = await withProgress('Preparing to print', async (step, cancelled) => {
      const out: Uint8Array[] = [];
      for (let n = 1; n <= total; n++) {
        if (cancelled()) return null;
        step(n - 1, total, `Preparing page ${n} of ${total}…`);
        const c = await renderOutput(tab, n, dpi, storage);
        out.push(await canvasBytes(c, 'image/jpeg', 0.92));
        c.width = c.height = 0;
      }
      step(total, total, 'Opening the print dialog…');
      return out;
    });
    if (!pages) return;
    await native.print(pages, tab.name);
  } catch (e) {
    await alertBox('Couldn’t print', (e as Error).message);
  }
}
