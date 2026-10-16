// Organize pages: a grid of every page to reorder (drag), rotate, delete, duplicate, insert (blank pages or
// pages from another PDF) and extract. Nothing changes until Apply; then pdf-lib rebuilds the document in
// place (same file, so form fields, links and metadata are kept) and the viewer reloads - undoable.
import { degrees, PDFDocument, type PDFPage } from 'pdf-lib';
import type { DocTab } from './doc';
import { openDocument, type PDFDocumentProxy } from './engine';
import { h, clear } from './ui/dom';
import { alertBox, toast } from './ui/dialog';
import { icon } from './icons';
import { baseName, native } from './native';

interface Source { name: string; bytes: Uint8Array | null; pdf: PDFDocumentProxy; task?: ReturnType<typeof openDocument> }
interface Card { key: number; src: number; index: number; rot: number; blank?: { w: number; h: number } }

let keySeq = 0;

export async function loadForEditing(bytes: Uint8Array) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(String((e as Error).message))) throw new Error('This PDF is password-protected, so its pages can’t be rearranged. You can still read, fill and annotate it.');
    throw e;
  }
}

/** Shows the organizer over `host`; resolves when it closes. `openNew` opens extracted pages in a new tab. */
export function organize(tab: DocTab, host: HTMLElement, openNew: (bytes: Uint8Array, name: string) => void): Promise<void> {
  return new Promise((resolve) => {
    const sources: Source[] = [{ name: tab.name, bytes: null, pdf: tab.pdf }];
    let cards: Card[] = Array.from({ length: tab.pageCount }, (_, i) => ({ key: ++keySeq, src: 0, index: i, rot: 0 }));
    const selected = new Set<number>();
    let anchor = -1;
    const grid = h('div', { class: 'org-grid' });
    const count = h('span', { class: 'org-count' });
    const btn = (name: string, label: string, run: () => void, cls = '') => {
      const b = h('button', { class: `tb ${cls}`, type: 'button', title: label, html: `${icon(name)}<span>${label}</span>` });
      b.addEventListener('click', run);
      return b;
    };
    const needSel = [] as HTMLButtonElement[];
    const rotL = btn('rotate-left', 'Rotate left', () => rotate(-90));
    const rotR = btn('rotate-right', 'Rotate right', () => rotate(90));
    const del = btn('trash', 'Delete', () => remove());
    const dup = btn('copy', 'Duplicate', () => duplicate());
    const ext = btn('export', 'Extract', () => extract());
    needSel.push(rotL as HTMLButtonElement, rotR as HTMLButtonElement, del as HTMLButtonElement, dup as HTMLButtonElement, ext as HTMLButtonElement);
    const apply = h('button', { class: 'tb primary', type: 'button' }, 'Apply changes');
    const cancel = h('button', { class: 'tb', type: 'button' }, 'Cancel');
    const bar = h('div', { class: 'org-bar' },
      h('div', { class: 'org-title' }, h('b', {}, 'Organize pages'), count),
      h('div', { class: 'org-actions' }, rotL, rotR, del, dup,
        h('span', { class: 'tsep' }),
        btn('page-plus', 'Blank page', () => insertBlank()),
        btn('file-plus', 'Insert PDF…', () => insertFile()),
        ext),
      h('div', { class: 'org-end' }, cancel, apply));
    const view = h('div', { class: 'organizer' }, bar, h('div', { class: 'org-scroll' }, grid),
      h('div', { class: 'org-hint' }, 'Click to select, Ctrl-click or Shift-click for more · drag to move · Delete removes'));
    host.append(view);

    const thumbCache = new Map<string, Promise<HTMLCanvasElement>>();
    const thumb = (c: Card) => {
      const k = `${c.src}:${c.index}`;
      let p = thumbCache.get(k);
      if (!p) {
        p = (async () => {
          const page = await sources[c.src].pdf.getPage(c.index + 1);
          const v0 = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (180 / Math.max(v0.width, v0.height)) * Math.min(2, devicePixelRatio || 1) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas, canvasContext: ctx, viewport } as never).promise;
          return canvas;
        })();
        thumbCache.set(k, p);
      }
      return p;
    };

    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        const el = e.target as HTMLElement;
        const c = cards.find((x) => x.key === Number(el.dataset.key));
        if (!c || c.blank) continue;
        thumb(c).then((canvas) => {
          const img = h('img', { src: canvas.toDataURL('image/jpeg', 0.85), draggable: 'false' });
          el.querySelector('.org-page')!.replaceChildren(img);
        }).catch(() => {});
      }
    }, { root: view.querySelector('.org-scroll'), rootMargin: '300px 0px' });

    let dragKey = -1;
    const render = () => {
      observer.disconnect();
      clear(grid);
      cards.forEach((c, i) => {
        const page = h('div', { class: `org-page${c.blank ? ' blank' : ''}`, style: `transform: rotate(${c.rot}deg)` });
        const src = c.src > 0 ? h('span', { class: 'org-src', title: sources[c.src].name }, 'inserted') : '';
        const card = h('div', { class: `org-card${selected.has(c.key) ? ' sel' : ''}`, draggable: 'true', 'data-key': String(c.key) },
          h('div', { class: 'org-frame' }, page), h('div', { class: 'org-n' }, String(i + 1), src));
        card.addEventListener('click', (e) => select(c.key, i, e));
        card.addEventListener('dblclick', () => { selected.clear(); selected.add(c.key); rotate(90); });
        card.addEventListener('dragstart', (e) => {
          dragKey = c.key;
          if (!selected.has(c.key)) { selected.clear(); selected.add(c.key); mark(); }
          e.dataTransfer!.effectAllowed = 'move';
          card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => { dragKey = -1; grid.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'dragging')); });
        card.addEventListener('dragover', (e) => {
          if (dragKey < 0) return;
          e.preventDefault();
          const r = card.getBoundingClientRect();
          const after = e.clientX > r.left + r.width / 2;
          grid.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
          card.classList.add(after ? 'drop-after' : 'drop-before');
        });
        card.addEventListener('drop', (e) => {
          e.preventDefault();
          if (dragKey < 0) return;
          const r = card.getBoundingClientRect();
          const after = e.clientX > r.left + r.width / 2;
          const moving = cards.filter((x) => selected.has(x.key));
          const rest = cards.filter((x) => !selected.has(x.key));
          let at = rest.findIndex((x) => x.key === c.key);
          if (at < 0) return; // dropped onto one of the moving pages
          if (after) at++;
          cards = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
          render();
        });
        grid.append(card);
        if (c.blank) page.append(h('span', {}, 'Blank'));
        observer.observe(card);
      });
      mark();
    };
    const mark = () => {
      grid.querySelectorAll<HTMLElement>('.org-card').forEach((el) => el.classList.toggle('sel', selected.has(Number(el.dataset.key))));
      count.textContent = selected.size ? `${selected.size} of ${cards.length} selected` : `${cards.length} page${cards.length === 1 ? '' : 's'}`;
      needSel.forEach((b) => { b.disabled = selected.size === 0; });
    };
    const select = (key: number, i: number, e: MouseEvent) => {
      if (e.shiftKey && anchor >= 0) {
        const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
        if (!e.ctrlKey) selected.clear();
        cards.slice(a, b + 1).forEach((c) => selected.add(c.key));
      } else if (e.ctrlKey || e.metaKey) {
        if (selected.has(key)) selected.delete(key); else selected.add(key);
        anchor = i;
      } else {
        selected.clear();
        selected.add(key);
        anchor = i;
      }
      mark();
    };
    const rotate = (d: number) => {
      cards.forEach((c) => { if (selected.has(c.key)) c.rot = (c.rot + d + 360) % 360; });
      grid.querySelectorAll<HTMLElement>('.org-card').forEach((el) => {
        const c = cards.find((x) => x.key === Number(el.dataset.key));
        if (c) (el.querySelector('.org-page') as HTMLElement).style.transform = `rotate(${c.rot}deg)`;
      });
    };
    const remove = () => {
      if (selected.size >= cards.length) { toast('A PDF needs at least one page.'); return; }
      cards = cards.filter((c) => !selected.has(c.key));
      selected.clear();
      render();
    };
    const duplicate = () => {
      const out: Card[] = [];
      for (const c of cards) {
        out.push(c);
        if (selected.has(c.key)) out.push({ ...c, key: ++keySeq });
      }
      cards = out;
      render();
    };
    const insertAt = () => {
      const last = cards.reduce((m, c, i) => (selected.has(c.key) ? i : m), -1);
      return last >= 0 ? last + 1 : cards.length;
    };
    const insertBlank = async () => {
      const at = insertAt();
      const ref = cards[Math.max(0, at - 1)];
      let w = 612, hgt = 792; // Letter, if nothing else to go by
      if (ref && !ref.blank) {
        const p = await sources[ref.src].pdf.getPage(ref.index + 1);
        const v = p.getViewport({ scale: 1, rotation: 0 });
        w = v.width; hgt = v.height;
      } else if (ref?.blank) { w = ref.blank.w; hgt = ref.blank.h; }
      const c: Card = { key: ++keySeq, src: -1, index: -1, rot: 0, blank: { w, h: hgt } };
      cards.splice(at, 0, c);
      selected.clear();
      selected.add(c.key);
      render();
    };
    const insertFile = async () => {
      const paths = await native.openDialog('Insert pages from…');
      if (!paths.length) return;
      let at = insertAt();
      for (const p of paths) {
        try {
          const bytes = await native.read(p);
          const task = openDocument(bytes.slice());
          const pdf = await task.promise;
          sources.push({ name: baseName(p), bytes, pdf, task });
          const src = sources.length - 1;
          const added = Array.from({ length: pdf.numPages }, (_, i): Card => ({ key: ++keySeq, src, index: i, rot: 0 }));
          cards.splice(at, 0, ...added);
          at += added.length;
          selected.clear();
          added.forEach((c) => selected.add(c.key));
        } catch (e) {
          await alertBox('Couldn’t insert', `${baseName(p)}: ${(e as Error).message}`);
        }
      }
      render();
    };

    /** Builds the result with pdf-lib: the original document edited in place, inserts copied in. */
    const build = async (list: Card[], standalone: boolean) => {
      const base = await loadForEditing(await tab.currentBytes());
      const extra = new Map<number, PDFDocument>();
      for (const c of list) {
        if (c.src > 0 && !extra.has(c.src)) extra.set(c.src, await PDFDocument.load(sources[c.src].bytes!, { updateMetadata: false }));
      }
      const doc = standalone ? await PDFDocument.create() : base;
      const originals = base.getPages();
      const used = new Set<number>();
      const pages: PDFPage[] = [];
      for (const c of list) {
        let p: PDFPage;
        if (c.blank) p = doc.addPage([c.blank.w, c.blank.h]);
        else if (c.src > 0) [p] = await doc.copyPages(extra.get(c.src)!, [c.index]);
        else if (!standalone && !used.has(c.index)) { p = originals[c.index]; used.add(c.index); }
        else [p] = await doc.copyPages(base, [c.index]);
        if (c.rot) p.setRotation(degrees((p.getRotation().angle + c.rot + 360) % 360));
        pages.push(p);
      }
      for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
      pages.forEach((p, i) => doc.insertPage(i, p));
      return doc.save();
    };

    const extract = async () => {
      const list = cards.filter((c) => selected.has(c.key));
      if (!list.length) return;
      try {
        const bytes = await build(list, true);
        const nums = cards.map((c, i) => (selected.has(c.key) ? i + 1 : 0)).filter(Boolean);
        openNew(bytes, `${tab.name.replace(/\.pdf$/i, '')} (pages ${rangeLabel(nums)}).pdf`);
        toast(`Extracted ${list.length} page${list.length === 1 ? '' : 's'} to a new tab`);
      } catch (e) { await alertBox('Couldn’t extract', (e as Error).message); }
    };

    const unchanged = () => cards.length === tab.pageCount && cards.every((c, i) => c.src === 0 && c.index === i && !c.rot && !c.blank);
    const close = () => {
      observer.disconnect();
      removeEventListener('keydown', onKey, true);
      view.remove();
      for (const s of sources.slice(1)) s.task?.destroy();
      resolve();
    };
    cancel.addEventListener('click', close);
    apply.addEventListener('click', async () => {
      if (unchanged()) { close(); return; }
      apply.setAttribute('disabled', '');
      apply.textContent = 'Applying…';
      try {
        const first = cards.findIndex((c) => selected.has(c.key));
        const bytes = await build(cards, false);
        await tab.replace(bytes, { page: first >= 0 ? first + 1 : undefined });
        close();
        toast('Pages updated — Ctrl+Z undoes it');
      } catch (e) {
        apply.removeAttribute('disabled');
        apply.textContent = 'Apply changes';
        await alertBox('Couldn’t change the pages', (e as Error).message);
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('.dialog')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Delete' && selected.size) { e.preventDefault(); remove(); }
      else if (e.key.toLowerCase() === 'a' && e.ctrlKey) { e.preventDefault(); cards.forEach((c) => selected.add(c.key)); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); apply.click(); }
      else return;
      e.stopPropagation();
    };
    addEventListener('keydown', onKey, true);
    render();
  });
}

/** [1,2,3,5,7,8] -> "1-3, 5, 7-8" */
export function rangeLabel(nums: number[]) {
  const out: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : String(nums[i]));
    i = j;
  }
  return out.join(', ');
}
