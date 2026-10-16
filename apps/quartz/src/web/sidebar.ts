// The left sidebar for the active document: page thumbnails (drawn as they scroll into view) and the
// outline (bookmarks) when the PDF has one.
import type { DocTab } from './doc';
import { h, clear } from './ui/dom';
import { native } from './native';

const THUMB_W = 150;

/** Renders a page into a canvas `width` CSS px wide. */
export async function renderPage(tab: DocTab, n: number, width: number) {
  const page = await tab.pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: (width / base.width) * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport } as never).promise;
  return canvas;
}

export class Sidebar {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabs: HTMLElement;
  private view: 'pages' | 'outline' = 'pages';
  private tab: DocTab | null = null;
  private observer: IntersectionObserver | null = null;
  private cards: HTMLElement[] = [];
  private builtFor: unknown = null;

  constructor() {
    const pagesBtn = h('button', { class: 'sb-tab on', type: 'button' }, 'Pages');
    const outlineBtn = h('button', { class: 'sb-tab', type: 'button' }, 'Outline');
    pagesBtn.addEventListener('click', () => this.show('pages'));
    outlineBtn.addEventListener('click', () => this.show('outline'));
    this.tabs = h('div', { class: 'sb-tabs' }, pagesBtn, outlineBtn);
    this.body = h('div', { class: 'sb-body' });
    this.el = h('aside', { class: 'sidebar' }, this.tabs, this.body);
  }

  private show(view: 'pages' | 'outline') {
    this.view = view;
    this.tabs.querySelectorAll('.sb-tab').forEach((b, i) => b.classList.toggle('on', (i === 0) === (view === 'pages')));
    this.builtFor = null;
    this.update(this.tab);
  }

  /** Called when the active tab or its document changes. */
  update(tab: DocTab | null) {
    this.tab = tab;
    if (!tab?.pdf) { clear(this.body); this.builtFor = null; return; }
    if (this.builtFor !== tab.pdf) {
      this.builtFor = tab.pdf;
      if (this.view === 'pages') this.buildPages(tab);
      else this.buildOutline(tab);
    }
    this.markCurrent();
  }

  markCurrent() {
    if (!this.tab || this.view !== 'pages') return;
    const cur = this.tab.page;
    this.cards.forEach((c, i) => {
      const on = i + 1 === cur;
      if (c.classList.contains('on') !== on) {
        c.classList.toggle('on', on);
        if (on) c.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  private buildPages(tab: DocTab) {
    this.observer?.disconnect();
    clear(this.body);
    const grid = h('div', { class: 'thumbs' });
    this.body.append(grid);
    this.cards = [];
    const pdf = tab.pdf;
    // placeholders take the first page's shape until each page is drawn
    pdf.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      grid.style.setProperty('--ratio', String(v.height / v.width));
    });
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const card = e.target as HTMLElement;
        this.observer?.unobserve(card);
        const n = Number(card.dataset.page);
        renderPage(tab, n, THUMB_W).then((c) => {
          if (tab.pdf !== pdf) return;
          card.querySelector('.th-img')!.replaceChildren(c);
          card.classList.add('drawn');
        }).catch(() => {});
      }
    }, { root: this.body, rootMargin: '400px 0px' });
    for (let n = 1; n <= pdf.numPages; n++) {
      const card = h('button', { class: 'th', type: 'button', 'data-page': String(n), title: `Page ${n}` }, h('div', { class: 'th-img' }), h('div', { class: 'th-n' }, String(n)));
      card.addEventListener('click', () => tab.goTo(n));
      grid.append(card);
      this.cards.push(card);
      this.observer.observe(card);
    }
  }

  private async buildOutline(tab: DocTab) {
    clear(this.body);
    const outline = await tab.pdf.getOutline().catch(() => null);
    if (this.tab !== tab) return;
    if (!outline?.length) { this.body.append(h('div', { class: 'sb-empty' }, 'This document has no outline.')); return; }
    type Item = { title: string; dest: unknown; url?: string | null; items: Item[]; bold?: boolean; italic?: boolean };
    const list = (items: Item[], depth: number): HTMLElement => {
      const ul = h('div', { class: 'ol' });
      for (const it of items) {
        const kids = it.items?.length ? list(it.items, depth + 1) : null;
        const twisty = h('span', { class: `ol-tw${kids ? '' : ' none'}` }, kids ? '▸' : '');
        const row = h('div', { class: 'ol-row', style: `padding-left:${8 + depth * 14}px`, title: it.title },
          twisty, h('span', { class: `ol-t${it.bold ? ' b' : ''}${it.italic ? ' i' : ''}` }, it.title));
        row.addEventListener('click', (e) => {
          if (kids && e.target === twisty) { kids.classList.toggle('open'); twisty.textContent = kids.classList.contains('open') ? '▾' : '▸'; return; }
          if (it.url) native.openUrl(it.url);
          else if (it.dest) tab.linkService.goToDestination(it.dest as never);
        });
        ul.append(row);
        if (kids) { if (depth === 0 && items.length < 12) { kids.classList.add('open'); twisty.textContent = '▾'; } ul.append(kids); }
      }
      return ul;
    };
    this.body.append(list(outline as Item[], 0));
  }
}
