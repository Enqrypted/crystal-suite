import { Panel } from '../ui/dock';
import { h, clear } from '../ui/dom';
import { icon } from '../ui/icons';
import { app } from '../app';
import { bus } from '../core/bus';
import { rafThrottle } from '../core/util';
import { iconButton, toast } from '../ui/widgets';

/** Icon per history step name (approximate, like Photoshop's state icons). */
function stepIcon(name: string): string {
  const n = name.toLowerCase();
  const map: [string, string][] = [
    ['brush', 'brush'], ['pencil', 'pencil'], ['eraser', 'eraser'], ['clone', 'clone'], ['heal', 'heal'], ['marquee', 'marquee-rect'],
    ['lasso', 'lasso'], ['wand', 'magic-wand'], ['quick sel', 'quick-select'], ['select', 'marquee-rect'], ['move', 'move'],
    ['transform', 'move'], ['crop', 'crop'], ['gradient', 'gradient'], ['bucket', 'bucket'], ['fill', 'bucket'], ['type', 'type'],
    ['text', 'type'], ['layer', 'p-layers'], ['merge', 'p-layers'], ['flatten', 'p-layers'], ['mask', 'mask'], ['style', 'fx'],
    ['blur', 'blur'], ['sharpen', 'sharpen'], ['smudge', 'smudge'], ['dodge', 'dodge'], ['burn', 'burn'], ['sponge', 'sponge'],
    ['path', 'pen'], ['anchor', 'pen'], ['rectangle', 'shape-rect'], ['ellipse', 'shape-ellipse'], ['shape', 'shape-rect'],
    ['size', 'image'], ['canvas', 'image'], ['rotate', 'rotate-view'], ['flip', 'image'],
  ];
  for (const [k, v] of map) if (n.includes(k)) return v;
  return 'p-adjustments';
}

export const historyPanel: Panel = {
  id: 'history', title: 'History', icon: 'p-history',
  build() {
    const list = h('div', { style: { overflowY: 'auto', flex: '1', maxHeight: '60vh' } });
    const render = () => {
      clear(list);
      const d = app.doc;
      if (!d) { list.appendChild(h('div', { class: 'panel-empty' }, 'No document')); return; }
      for (const s of d.snapshots) {
        const brush = h('div', { class: 'vis', title: 'Set the source for the history brush', style: { cursor: 'pointer' } }, s.id === d.activeSnapshotId ? icon('history-brush', 14) : '');
        brush.addEventListener('click', (e) => { e.stopPropagation(); d.activeSnapshotId = s.id; render(); });
        const r = h('div', { class: 'list-row' }, brush, h('div', { class: 'thumb' }, h('img', { src: s.thumb })), h('div', { class: 'grow' }, s.name));
        r.addEventListener('click', () => d.restoreSnapshot(s));
        list.appendChild(r);
      }
      const base = h('div', { class: `list-row${d.historyIndex === 0 ? ' active' : ''}` }, h('div', { class: 'vis' }), icon('image', 16), h('div', { class: 'grow' }, d.historyBaseName));
      base.addEventListener('click', () => d.gotoHistory(0));
      list.appendChild(base);
      d.history.forEach((e, i) => {
        const r = h('div', { class: `list-row${d.historyIndex === i + 1 ? ' active' : ''}${i + 1 > d.historyIndex ? ' future' : ''}` }, h('div', { class: 'vis' }), icon(stepIcon(e.name), 16), h('div', { class: 'grow' }, e.name));
        r.addEventListener('click', () => d.gotoHistory(i + 1));
        list.appendChild(r);
      });
      const act = list.querySelector('.list-row.active') as HTMLElement | null;
      act?.scrollIntoView({ block: 'nearest' });
    };
    const footer = h('div', { class: 'panel-footer' },
      iconButton('camera', 'Create new snapshot', () => { const d = app.doc; if (d) { d.takeSnapshot(); toast('Snapshot created'); } }),
      iconButton('trash', 'Delete current state (and later states)', () => {
        const d = app.doc;
        if (!d || d.historyIndex === 0) return;
        d.undo();
        d.history.splice(d.historyIndex);
        bus.emit('history', d);
      }));
    const r = rafThrottle(render);
    bus.on('history', r);
    bus.on('docs', r);
    render();
    return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, list, footer);
  },
};
