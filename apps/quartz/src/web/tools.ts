// Whole-document tools: combine files, split a document, export pages as pictures or the text, document
// properties, and making Quartz the PDF app Windows opens.
import { PDFDocument } from 'pdf-lib';
import type { DocTab } from './doc';
import { loadForEditing } from './organize';
import { canvasBytes, renderOutput, withProgress } from './print';
import { h, clear } from './ui/dom';
import { modal, alertBox, confirm, toast } from './ui/dialog';
import { icon } from './icons';
import { baseName, native } from './native';

const stem = (name: string) => name.replace(/\.pdf$/i, '');
const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** "1-3, 5, 8-" -> [[1,3],[5,5],[8,count]]; throws a readable error for bad input. */
export function parseRanges(text: string, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (const part of text.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d*)\s*(?:(-|–|to)\s*(\d*))?$/i.exec(part);
    if (!m || (!m[1] && !m[3])) throw new Error(`“${part}” isn’t a page or range (try 1-3, 5, 8-).`);
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : count) : a;
    if (a < 1 || b < 1 || a > count || b > count) throw new Error(`Pages go from 1 to ${count}; “${part}” is outside that.`);
    out.push(a <= b ? [a, b] : [b, a]);
  }
  if (!out.length) throw new Error('Enter at least one page or range.');
  return out;
}

const pagesIn = (ranges: [number, number][]) => ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

// ---------- combine ----------

interface Part { name: string; path?: string; bytes: () => Promise<Uint8Array>; pages?: number }

export async function combineDialog(current: DocTab | null, openNew: (bytes: Uint8Array, name: string) => void) {
  const parts: Part[] = current ? [{ name: current.name, path: current.path ?? undefined, bytes: () => current.currentBytes(), pages: current.pageCount }] : [];
  const list = h('div', { class: 'cmb-list' });
  const draw = () => {
    clear(list);
    if (!parts.length) list.append(h('div', { class: 'cmb-empty' }, 'Add the PDFs to combine, in order.'));
    parts.forEach((p, i) => {
      const btn = (name: string, title: string, fn: () => void, disabled = false) => {
        const b = h('button', { type: 'button', class: 'tb', title, html: icon(name, 16), disabled });
        b.addEventListener('click', fn);
        return b;
      };
      list.append(h('div', { class: 'cmb-row' },
        h('span', { class: 'cmb-n' }, String(i + 1)),
        h('span', { class: 'cmb-name', title: p.path ?? p.name }, p.name),
        h('span', { class: 'cmb-pages' }, p.pages ? `${p.pages} page${p.pages === 1 ? '' : 's'}` : ''),
        btn('up', 'Move up', () => { [parts[i - 1], parts[i]] = [parts[i], parts[i - 1]]; draw(); }, i === 0),
        btn('down', 'Move down', () => { [parts[i + 1], parts[i]] = [parts[i], parts[i + 1]]; draw(); }, i === parts.length - 1),
        btn('close', 'Remove', () => { parts.splice(i, 1); draw(); })));
    });
    list.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const add = h('button', { type: 'button', class: 'small-btn' }, 'Add files…');
  add.addEventListener('click', async () => {
    for (const p of await native.openDialog('Add PDFs to combine')) {
      parts.push({ name: baseName(p), path: p, bytes: () => native.read(p) });
    }
    draw();
  });
  draw();
  const v = await modal('Combine files', h('div', {}, list, h('div', { class: 'sig-row' }, add, h('span', { class: 'spacer' }), h('span', { class: 'ctx-hint' }, 'Bookmarks and form fields of the added files aren’t carried over.'))),
    [{ label: 'Cancel', value: '' }, { label: 'Combine', value: 'ok', primary: true, disabled: () => parts.length < 2 }], { width: 580 });
  if (v !== 'ok') return;
  try {
    const bytes = await withProgress('Combining', async (step, cancelled) => {
      const out = await PDFDocument.create();
      for (let i = 0; i < parts.length; i++) {
        if (cancelled()) return null;
        step(i, parts.length, `Adding ${parts[i].name}…`);
        let src: PDFDocument;
        try { src = await PDFDocument.load(await parts[i].bytes(), { updateMetadata: false }); } catch (e) {
          throw new Error(`${parts[i].name}: ${/encrypt/i.test(String(e)) ? 'it’s password-protected.' : (e as Error).message}`);
        }
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      }
      out.setProducer('Quartz');
      return out.save();
    });
    if (bytes) openNew(bytes, 'Combined.pdf');
  } catch (e) { await alertBox('Couldn’t combine', (e as Error).message); }
}

// ---------- split ----------

export async function splitDialog(tab: DocTab) {
  const count = tab.pageCount;
  if (count < 2) { await alertBox('Split', 'This document has only one page.'); return; }
  let how: 'every' | 'ranges' | 'each' = 'every';
  const everyN = h('input', { type: 'number', min: '1', max: String(count - 1), value: String(Math.max(1, Math.min(10, Math.ceil(count / 2)))), style: 'width:70px' }) as HTMLInputElement;
  const ranges = h('input', { type: 'text', placeholder: 'e.g. 1-3, 4-9, 10-', style: 'width:100%' }) as HTMLInputElement;
  const preview = h('div', { class: 'ctx-hint split-pv' });
  const radio = (v: typeof how, label: string, extra?: HTMLElement) => {
    const r = h('input', { type: 'radio', name: 'split', checked: how === v }) as HTMLInputElement;
    r.addEventListener('change', () => { how = v; update(); });
    return h('label', { class: 'split-opt' }, r, h('span', {}, label), extra ?? '');
  };
  const plan = (): [number, number][] => {
    if (how === 'each') return Array.from({ length: count }, (_, i) => [i + 1, i + 1]);
    if (how === 'every') {
      const n = Math.max(1, Math.floor(Number(everyN.value) || 1));
      const out: [number, number][] = [];
      for (let a = 1; a <= count; a += n) out.push([a, Math.min(count, a + n - 1)]);
      return out;
    }
    return parseRanges(ranges.value, count);
  };
  const update = () => {
    try {
      const p = plan();
      preview.textContent = `${p.length} file${p.length === 1 ? '' : 's'}: ${p.slice(0, 6).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(' · ')}${p.length > 6 ? ' …' : ''}`;
      preview.classList.remove('err');
    } catch (e) { preview.textContent = (e as Error).message; preview.classList.add('err'); }
  };
  everyN.addEventListener('input', update);
  ranges.addEventListener('input', update);
  ranges.addEventListener('focus', () => { if (how !== 'ranges') { how = 'ranges'; (ranges.closest('label')!.querySelector('input[type=radio]') as HTMLInputElement).checked = true; update(); } });
  update();
  const body = h('div', { class: 'split' },
    h('div', { class: 'ctx-hint', style: 'margin-bottom:10px' }, `${tab.name} has ${count} pages. Each part is saved as its own PDF in a folder you choose.`),
    radio('every', 'Every', h('span', { class: 'row' }, everyN, h('span', {}, 'pages'))),
    radio('each', 'Each page as its own file'),
    radio('ranges', 'Page ranges', ranges),
    preview);
  const valid = () => { try { plan(); return true; } catch { return false; } };
  const v = await modal('Split document', body, [{ label: 'Cancel', value: '' }, { label: 'Choose folder & split', value: 'ok', primary: true, disabled: () => !valid() }], { width: 520 });
  if (v !== 'ok') return;
  const parts = plan();
  const folder = await native.folderDialog('Save the parts in…');
  if (!folder) return;
  try {
    const src = await loadForEditing(await tab.currentBytes());
    const sep = folder.includes('/') && !folder.includes('\\') ? '/' : '\\';
    const written = await withProgress('Splitting', async (step, cancelled) => {
      const files: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (cancelled()) break;
        const [a, b] = parts[i];
        step(i, parts.length, `Saving pages ${a === b ? a : `${a}-${b}`}…`);
        const out = await PDFDocument.create();
        const pages = await out.copyPages(src, Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k));
        pages.forEach((p) => out.addPage(p));
        const title = src.getTitle();
        if (title) out.setTitle(title);
        out.setProducer('Quartz');
        const file = `${folder}${sep}${stem(tab.name)} (${a === b ? `page ${a}` : `pages ${a}-${b}`}).pdf`;
        const err = await native.write(file, await out.save());
        if (err) throw new Error(err);
        files.push(file);
      }
      return files;
    });
    if (written?.length) {
      toast(`Saved ${written.length} file${written.length === 1 ? '' : 's'}`);
      native.showInFolder(written[0]);
    }
  } catch (e) { await alertBox('Couldn’t split', (e as Error).message); }
}

// ---------- export pages as pictures ----------

export async function exportImagesDialog(tab: DocTab) {
  const count = tab.pageCount;
  let which: 'current' | 'all' | 'range' = count === 1 ? 'all' : 'current';
  const range = h('input', { type: 'text', placeholder: `1-${count}`, style: 'width:140px' }) as HTMLInputElement;
  const format = h('select', {}, h('option', { value: 'png' }, 'PNG (sharp, larger)'), h('option', { value: 'jpeg' }, 'JPEG (photos, smaller)')) as HTMLSelectElement;
  const dpi = h('select', {}, ...[[72, 'Screen (72 dpi)'], [150, 'Standard (150 dpi)'], [300, 'High (300 dpi)'], [600, 'Print (600 dpi)']].map(([v, l]) => h('option', { value: String(v), selected: v === 150 }, String(l)))) as HTMLSelectElement;
  const opt = (v: typeof which, label: string, extra?: HTMLElement) => {
    const r = h('input', { type: 'radio', name: 'which', checked: which === v }) as HTMLInputElement;
    r.addEventListener('change', () => { which = v; });
    return h('label', { class: 'split-opt' }, r, h('span', {}, label), extra ?? '');
  };
  range.addEventListener('focus', () => { which = 'range'; (range.closest('label')!.querySelector('input') as HTMLInputElement).checked = true; });
  const body = h('div', {},
    h('div', { class: 'split' }, opt('current', `Current page (${tab.page})`), opt('all', `All ${count} pages`), opt('range', 'Pages', range)),
    h('div', { class: 'form', style: 'margin-top:12px' }, h('label', {}, 'Format'), format, h('label', {}, 'Resolution'), dpi));
  const v = await modal('Export as images', body, [{ label: 'Cancel', value: '' }, { label: 'Export…', value: 'ok', primary: true }], { width: 480 });
  if (v !== 'ok') return;
  let pages: number[];
  try {
    pages = which === 'current' ? [tab.page] : which === 'all' ? Array.from({ length: count }, (_, i) => i + 1) : pagesIn(parseRanges(range.value, count));
  } catch (e) { await alertBox('Export as images', (e as Error).message); return; }
  const ext = format.value === 'png' ? 'png' : 'jpg';
  const type = format.value === 'png' ? 'image/png' : 'image/jpeg';
  const res = Number(dpi.value);
  let target: string | null;
  let folder = '';
  if (pages.length === 1) {
    target = await native.saveDialog(`${stem(tab.name)} - page ${pages[0]}.${ext}`, 'png');
    if (!target) return;
  } else {
    target = await native.folderDialog('Save the pictures in…');
    if (!target) return;
    folder = target;
  }
  const digits = String(count).length;
  try {
    const files = await withProgress('Exporting', async (step, cancelled) => {
      const out: string[] = [];
      for (let i = 0; i < pages.length; i++) {
        if (cancelled()) break;
        step(i, pages.length, `Page ${pages[i]}…`);
        const c = await renderOutput(tab, pages[i], res);
        const bytes = await canvasBytes(c, type, 0.92);
        c.width = c.height = 0;
        const file = folder ? `${folder}\\${stem(tab.name)} - page ${String(pages[i]).padStart(digits, '0')}.${ext}` : target!;
        const err = await native.write(file, bytes);
        if (err) throw new Error(err);
        out.push(file);
      }
      return out;
    });
    if (files?.length) { toast(`Exported ${files.length} picture${files.length === 1 ? '' : 's'}`); native.showInFolder(files[0]); }
  } catch (e) { await alertBox('Couldn’t export', (e as Error).message); }
}

// ---------- text ----------

export async function exportText(tab: DocTab) {
  const target = await native.saveDialog(`${stem(tab.name)}.txt`, 'txt');
  if (!target) return;
  try {
    const text = await withProgress('Saving text', async (step, cancelled) => {
      const pages: string[] = [];
      for (let n = 1; n <= tab.pageCount; n++) {
        if (cancelled()) return null;
        step(n - 1, tab.pageCount);
        const page = await tab.pdf.getPage(n);
        const tc = await page.getTextContent();
        let s = '';
        for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) {
          if (it.str === undefined) continue;
          s += it.str + (it.hasEOL ? '\r\n' : '');
        }
        pages.push(s.trim());
      }
      return pages.join('\r\n\r\n\f');
    });
    if (text === null) return;
    if (!text.replace(/\s|\f/g, '')) { await alertBox('No text found', 'This document’s pages are pictures (a scan, for example), so there is no text to save.'); return; }
    const err = await native.write(target, new TextEncoder().encode('﻿' + text));
    if (err) throw new Error(err);
    toast('Text saved');
  } catch (e) { await alertBox('Couldn’t save the text', (e as Error).message); }
}

// ---------- properties ----------

export async function propertiesDialog(tab: DocTab) {
  const meta = await tab.pdf.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, string | undefined>;
  const stat = tab.path ? await native.stat(tab.path) : null;
  const page1 = await tab.pdf.getPage(tab.page);
  const v = page1.getViewport({ scale: 1, rotation: 0 });
  const inch = (pt: number) => (pt / 72).toFixed(2);
  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  const date = (s?: string) => {
    const m = s && /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s);
    if (!m) return '—';
    return new Date(Number(m[1]), Number(m[2] ?? 1) - 1, Number(m[3] ?? 1), Number(m[4] ?? 0), Number(m[5] ?? 0)).toLocaleString();
  };
  const field = (value?: string) => h('input', { type: 'text', value: value ?? '' }) as HTMLInputElement;
  const title = field(info.Title), author = field(info.Author), subject = field(info.Subject), keywords = field(info.Keywords);
  const ro = (s: string) => h('div', { class: 'ro' }, s);
  const body = h('div', { class: 'form props-form' },
    h('label', {}, 'Title'), title, h('label', {}, 'Author'), author, h('label', {}, 'Subject'), subject, h('label', {}, 'Keywords'), keywords,
    h('div', { class: 'form-sep' }), h('div', { class: 'form-sep' }),
    h('label', {}, 'File'), ro(tab.path ?? 'Not saved yet'),
    h('label', {}, 'File size'), ro(stat ? formatSize(stat.size) : '—'),
    h('label', {}, 'Pages'), ro(String(tab.pageCount)),
    h('label', {}, `Page ${tab.page} size`), ro(`${inch(v.width)} × ${inch(v.height)} in  (${mm(v.width)} × ${mm(v.height)} mm)`),
    h('label', {}, 'PDF version'), ro(info.PDFFormatVersion ?? '—'),
    h('label', {}, 'Created'), ro(date(info.CreationDate)),
    h('label', {}, 'Modified'), ro(date(info.ModDate)),
    h('label', {}, 'Made with'), ro([info.Creator, info.Producer].filter(Boolean).join(' · ') || '—'),
    h('label', {}, 'Security'), ro(tab.encrypted ? 'Password-protected' : info.IsSignaturesPresent ? 'Digitally signed' : 'None'));
  const editable = !tab.encrypted;
  if (!editable) [title, author, subject, keywords].forEach((i) => { i.disabled = true; });
  const r = await modal('Document properties', body, editable
    ? [{ label: 'Cancel', value: '' }, { label: 'Apply', value: 'ok', primary: true }]
    : [{ label: 'Close', value: '', primary: true }], { width: 600 });
  if (r !== 'ok') return;
  const next = { Title: title.value.trim(), Author: author.value.trim(), Subject: subject.value.trim(), Keywords: keywords.value.trim() };
  if (Object.entries(next).every(([k, val]) => val === (info[k] ?? '').trim())) return;
  if (info.IsSignaturesPresent && !(await confirm('Change a signed document?', 'Changing this document invalidates its digital signatures.', 'Change anyway'))) return;
  try {
    const doc = await loadForEditing(await tab.currentBytes());
    doc.setTitle(next.Title, { showInWindowTitleBar: !!next.Title });
    doc.setAuthor(next.Author);
    doc.setSubject(next.Subject);
    doc.setKeywords(next.Keywords ? next.Keywords.split(/\s*[,;]\s*/) : []);
    doc.setModificationDate(new Date());
    await tab.replace(await doc.save());
    toast('Properties updated');
  } catch (e) { await alertBox('Couldn’t change the properties', (e as Error).message); }
}

// ---------- default app ----------

export async function defaultAppDialog() {
  const s = await native.defaultStatus().catch(() => null);
  if (!s?.supported) { await alertBox('Default PDF app', 'Quartz can be the default PDF app once it’s installed by the Crystal Suite launcher.'); return; }
  if (s.isDefault) { await alertBox('Default PDF app', 'Quartz already opens your PDF files.'); return; }
  const ok = await confirm('Open PDFs with Quartz?',
    'Windows Settings opens on Quartz’s page: set .pdf to Quartz there (Windows has you make that choice yourself).\n\nOr right-click any PDF → Open with → Choose another app → Quartz, and tick “Always”.',
    'Open Settings');
  if (!ok) return;
  const done = await native.makeDefault();
  if (!done) await alertBox('Default PDF app', 'Windows didn’t accept Quartz’s registration. Right-click a PDF file → Open with → Choose another app instead.');
}
