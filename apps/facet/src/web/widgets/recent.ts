// Recently used folders, newest first (from Windows' Recent items), as a list or a grid of folder icons.
import type { RecentWidget } from '../../shared/types';
import { api } from '../lib/api';
import { h } from '../lib/dom';
import { G } from '../lib/glyphs';
import { glass } from '../lib/liquid';
import { ago, live, onLive } from '../lib/live';
import { itemImage, menu } from '../lib/ui';

export class RecentList {
  readonly el: HTMLElement;
  private w!: RecentWidget;
  private off: () => void;
  private timer = 0;
  private sig = '';

  constructor(w: RecentWidget, private dark = () => false) {
    this.el = h('div', { class: 'recent' });
    this.off = onLive('recent', () => this.render());
    this.set(w);
    // "5 min ago" moves on
    this.timer = window.setInterval(() => this.el.querySelectorAll<HTMLElement>('[data-time]').forEach((e) => { e.textContent = ago(Number(e.dataset.time)); }), 30000);
  }

  set(w: RecentWidget) { this.w = w; this.sig = ''; this.render(); }

  destroy() { this.off(); clearInterval(this.timer); }

  private render() {
    const w = this.w;
    const list = live.recent.slice(0, w.count);
    const sig = JSON.stringify([w, list, this.dark()]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.el.className = `recent ${w.layout} size-${w.size}`;
    const rows = h('div', { class: 'rc-items' });
    for (const f of list) {
      const row = h('button', { type: 'button', class: 'rc-item', title: f.path },
        itemImage(f.path, 'rc-icon'),
        h('div', { class: 'rc-text' }, h('div', { class: 'rc-name', text: f.name }),
          w.layout === 'list' ? h('div', { class: 'rc-sub' }, h('span', { class: 'rc-parent', text: f.parent ? short(f.parent) : 'Drive' }), h('span', { class: 'rc-dot', text: '·' }), h('span', { text: ago(f.time), 'data-time': String(f.time) })) : ''));
      row.addEventListener('click', () => api.open(f.path));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        menu([
          { label: 'Open', icon: 'open', run: () => api.open(f.path) },
          { label: 'Show in Folder', icon: 'reveal', run: () => api.reveal(f.path) },
        ], e.clientX, e.clientY);
      });
      rows.append(row);
    }
    if (!list.length) rows.append(h('div', { class: 'empty-note', text: 'Folders you open in File Explorer show up here.' }));
    this.el.replaceChildren(h('div', { class: 'rc-head' }, h('span', { class: 'rc-head-ic', html: G.recent }), h('span', { text: 'Recent folders' })), rows);
    glass(this.el, { dark: this.dark() || undefined });
  }
}

/** C:\Users\gabee\Documents\Work -> ~\Documents\Work; long paths keep their ends. */
function short(p: string) {
  const home = /^[A-Z]:\\Users\\[^\\]+/i.exec(p);
  let s = home ? '~' + p.slice(home[0].length) : p;
  if (s.length > 38) s = s.slice(0, 14) + '…' + s.slice(-22);
  return s || '~';
}
