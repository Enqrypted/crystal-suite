// Media Generators (text, titles, colour) and Transitions.
import { store } from '../core/store';
import * as edit from '../core/edit';
import { clipEnd, clipsOnTrack, defaultText, overlapMap, type TransitionKind } from '../core/model';
import { h } from './dom';
import { toast } from './dialog';

const TRANSITIONS: { kind: TransitionKind; name: string; sub: string; css: string }[] = [
  { kind: 'crossfade', name: 'Crossfade', sub: 'Dissolve from one clip into the next', css: 'linear-gradient(90deg,#3b3f8f,#d4628f)' },
  { kind: 'dip', name: 'Dip to Black', sub: 'Fade out to black, then in', css: 'linear-gradient(90deg,#3b3f8f,#000 50%,#d4628f)' },
  { kind: 'wipe-left', name: 'Wipe Left', sub: 'The next clip wipes in from the right', css: 'linear-gradient(90deg,#3b3f8f 55%,#fff 55%,#fff 58%,#d4628f 58%)' },
  { kind: 'wipe-right', name: 'Wipe Right', sub: 'The next clip wipes in from the left', css: 'linear-gradient(90deg,#d4628f 42%,#fff 42%,#fff 45%,#3b3f8f 45%)' },
  { kind: 'slide-left', name: 'Slide', sub: 'The next clip slides in over this one', css: 'linear-gradient(90deg,#3b3f8f 50%,#d4628f 50%)' },
  { kind: 'push-up', name: 'Push Up', sub: 'The next clip pushes this one up', css: 'linear-gradient(180deg,#3b3f8f 50%,#d4628f 50%)' },
];

export class Generators {
  readonly el: HTMLElement;

  constructor() {
    const gens = h('div', { class: 'gens' });
    const card = (name: string, sub: string, pv: HTMLElement, run: () => void) => {
      const el = h('div', { class: 'gen', title: 'Click to add at the cursor' }, pv, h('div', {}, h('div', { class: 'nm' }, name), h('div', { class: 'sub' }, sub)));
      el.addEventListener('click', run);
      gens.append(el);
    };
    card('Text', 'Plain text in the centre', h('div', { class: 'pv', style: 'background:#1b1b26;color:#fff' }, 'Aa'), () => edit.addGenerator('text'));
    card('Title', 'Large bold title', h('div', { class: 'pv', style: 'background:linear-gradient(135deg,#232046,#3b2a6a);color:#fff;font-size:22px' }, 'TITLE'), () => this.textPreset('title'));
    card('Lower Third', 'Name caption with a box', h('div', { class: 'pv', style: 'background:#14141c;align-items:end;justify-items:start;padding:6px;font-size:11px;color:#fff' }, h('span', { style: 'background:rgba(0,0,0,.6);padding:2px 6px;border-left:3px solid #8d8dff' }, 'Your Name')), () => this.textPreset('lower'));
    card('Solid Color', 'Full-frame colour background', h('div', { class: 'pv', style: 'background:#1e2a78' }), () => edit.addGenerator('solid'));
    card('Gradient', 'Two-colour background', h('div', { class: 'pv', style: 'background:linear-gradient(135deg,#2b1a6e,#d4628f)' }), () => edit.addGenerator('gradient'));
    const trans = h('div', { class: 'gens' });
    for (const t of TRANSITIONS) {
      const el = h('div', { class: 'gen', title: 'Applies to the selected event (where it meets the previous event on its track)' },
        h('div', { class: 'pv', style: `background:${t.css}` }), h('div', {}, h('div', { class: 'nm' }, t.name), h('div', { class: 'sub' }, t.sub)));
      el.addEventListener('click', () => this.applyTransition(t.kind));
      trans.append(el);
    }
    this.el = h('div', {}, h('div', { class: 'gens-title' }, 'Media Generators'), gens, h('div', { class: 'gens-title' }, 'Transitions'), trans);
  }

  private textPreset(kind: 'title' | 'lower') {
    edit.addGenerator('text');
    const id = [...store.selection][0];
    store.commit(kind === 'title' ? 'Title' : 'Lower Third', (p) => {
      const c = p.clips.find((x) => x.id === id);
      if (!c?.text) return;
      if (kind === 'title') Object.assign(c.text, defaultText(), { text: 'Title', size: 0.16, bold: true, shadow: true }), (c.name = 'Title');
      else Object.assign(c.text, defaultText(), { text: 'Your Name\nTitle or role', size: 0.05, align: 'left', x: 0.07, y: 0.82, box: true, shadow: false, bold: false }), (c.name = 'Lower Third');
    });
  }

  /** Sets the transition of the selected events; creates a one-second overlap if they only touch. */
  private applyTransition(kind: TransitionKind) {
    const sel = store.selectedClips();
    if (!sel.length) { toast('Select the event that should transition in (the later one), then pick a transition.'); return; }
    store.commit('Transition', (p) => {
      const overlaps = overlapMap(p);
      for (const s of sel) {
        const c = p.clips.find((x) => x.id === s.id);
        if (!c) continue;
        c.transition = kind;
        if (overlaps.get(c.id)?.before) continue;
        // touching the previous event? pull this one (and what follows) back to overlap
        const list = clipsOnTrack(p, c.trackId);
        const prev = list.filter((x) => x.id !== c.id && clipEnd(x) <= c.start + 1e-3).pop();
        if (!prev || c.start - clipEnd(prev) > 1 / p.fps + 1e-6) continue;
        const ov = Math.min(1, prev.length / 2, c.length / 2);
        const moving = new Set(edit.withGroups(p, [c.id]));
        for (const x of p.clips) if (moving.has(x.id) || (x.trackId === c.trackId && x.start >= c.start && x.id !== c.id)) moving.add(x.id);
        for (const x of p.clips) if (moving.has(x.id)) x.start = Math.max(0, x.start - ov);
      }
    });
  }
}
