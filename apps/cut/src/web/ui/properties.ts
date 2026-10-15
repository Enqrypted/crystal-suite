// Properties of the selected events: timing, volume/opacity, fades, transitions, Pan/Crop (with an
// optional animated end state), Video FX, and text/colour settings. Edits apply to every selected event
// of the matching kind (a grouped video+audio pair shows both the Video and Audio sections).
import { store } from '../core/store';
import { media } from '../core/media';
import * as edit from '../core/edit';
import { native } from '../core/native';
import {
  defaultFx, defaultPanCrop, formatDb, maxLength, overlapMap, type Clip, type FadeCurve, type Fx, type PanCrop, type TextProps, type TransitionKind,
} from '../core/model';
import { parseTime, timecode, shortTime } from '../core/timecode';
import { h, clear } from './dom';
import { Slider, dbMap, linMap, panFormat } from './slider';

type Kind = 'video' | 'audio';
const FONTS = ['Segoe UI', 'Arial', 'Bahnschrift', 'Calibri', 'Cambria', 'Consolas', 'Georgia', 'Impact', 'Segoe Script', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
const FX_PRESETS: Record<string, Partial<Fx>> = {
  'None': {},
  'Black & White': { grayscale: 1, contrast: 1.1 },
  'Sepia': { sepia: 0.85, contrast: 1.05 },
  'Vivid': { saturation: 1.45, contrast: 1.12 },
  'Warm': { sepia: 0.2, saturation: 1.15, hue: -8 },
  'Cool': { hue: 12, saturation: 1.05, brightness: 1.02 },
  'Faded': { contrast: 0.82, saturation: 0.75, brightness: 1.08 },
  'High Contrast': { contrast: 1.45, saturation: 1.1 },
  'Dreamy Blur': { blur: 3, brightness: 1.08, saturation: 1.1 },
  'Negative': { invert: 1 },
};

export class Properties {
  readonly el: HTMLElement;
  private sig = '';
  private updaters: (() => void)[] = [];
  private panEnd = false;

  constructor() {
    this.el = h('div', { class: 'props' });
    store.on((t) => { if (t.has('selection') || t.has('project') || t.has('media')) this.refresh(); });
    this.refresh();
  }

  private clipsOf(kind: Kind) {
    const p = store.project;
    return store.selectedClips().filter((c) => p.tracks.find((t) => t.id === c.trackId)?.kind === kind);
  }

  private refresh() {
    const sel = store.selectedClips();
    const p = store.project;
    const ov = overlapMap(p);
    const sig = sel.map((c) => `${c.id}:${c.generator ?? ''}:${!!c.panCropEnd}:${!!ov.get(c.id)?.before}`).join(',') + `|${this.panEnd}`;
    if (sig !== this.sig) { this.sig = sig; this.build(); return; }
    if (store.inGesture || this.el.contains(document.activeElement)) return;
    for (const u of this.updaters) u();
  }

  // ---------- editing helpers ----------
  private apply(label: string, kind: Kind | 'all', fn: (c: Clip) => void) {
    const ids = new Set((kind === 'all' ? store.selectedClips() : this.clipsOf(kind)).map((c) => c.id));
    store.commit(label, (p) => { for (const c of p.clips) if (ids.has(c.id)) fn(c); });
  }
  private liveSlider(label: string, kind: Kind, get: (c: Clip) => number, set: (c: Clip, v: number) => void, map: { toPos: (v: number) => number; fromPos: (p: number) => number }, format: (v: number) => string, reset: number, center = false) {
    const first = this.clipsOf(kind)[0];
    const val = h('span', { class: 'val' });
    let ids = new Set<string>();
    const s = new Slider({
      value: first ? get(first) : reset, ...map, format, reset, center,
      onBegin: () => { ids = new Set(this.clipsOf(kind).map((c) => c.id)); store.begin(); },
      onInput: (v) => { for (const c of store.project.clips) if (ids.has(c.id)) set(c, v); store.live(); },
      onEnd: () => store.end(label),
    }, val);
    this.updaters.push(() => { const c = this.clipsOf(kind)[0]; if (c) s.set(get(c)); });
    return { slider: s.el, val };
  }
  private row(label: string, control: HTMLElement, val?: HTMLElement) {
    return h('div', { class: val ? 'prow' : 'prow wide' }, h('label', { title: label }, label), control, val ?? '');
  }
  private sliderRow(label: string, kind: Kind, get: (c: Clip) => number, set: (c: Clip, v: number) => void, map: { toPos: (v: number) => number; fromPos: (p: number) => number }, format: (v: number) => string, reset: number, center = false) {
    const { slider, val } = this.liveSlider(label, kind, get, set, map, format, reset, center);
    return this.row(label, slider, val);
  }
  private section(title: string, ...kids: (HTMLElement | null)[]) {
    return h('div', { class: 'sect' }, h('h4', {}, title), ...kids.filter(Boolean) as HTMLElement[]);
  }
  private sectionWith(title: string, extra: HTMLElement, ...kids: (HTMLElement | null)[]) {
    return h('div', { class: 'sect' }, h('h4', {}, title, h('span', { class: 'spacer' }), extra), ...kids.filter(Boolean) as HTMLElement[]);
  }
  private numberInput(get: () => number, commit: (v: number) => void, step = 0.1, min = 0) {
    const input = h('input', { type: 'number', step, min }) as HTMLInputElement;
    const fmt = () => { input.value = String(Math.round(get() * 1000) / 1000); };
    fmt();
    input.addEventListener('change', () => { const v = Number(input.value); if (isFinite(v)) commit(Math.max(min, v)); fmt(); });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    this.updaters.push(fmt);
    return input;
  }
  private timeInput(get: () => number, commit: (v: number) => void) {
    const input = h('input', { type: 'text', spellcheck: 'false' }) as HTMLInputElement;
    const fmt = () => { input.value = timecode(get(), store.project.fps); };
    fmt();
    input.addEventListener('change', () => { const v = parseTime(input.value, store.project.fps); if (v !== null) commit(Math.max(0, v)); fmt(); });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
    this.updaters.push(fmt);
    return input;
  }
  private select<T extends string>(options: [T, string][], get: () => T, commit: (v: T) => void) {
    const sel = h('select', {}, ...options.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    sel.value = get();
    sel.addEventListener('change', () => commit(sel.value as T));
    this.updaters.push(() => { sel.value = get(); });
    return sel;
  }
  private check(label: string, get: () => boolean, commit: (v: boolean) => void) {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = get();
    box.addEventListener('change', () => commit(box.checked));
    this.updaters.push(() => { box.checked = get(); });
    return h('label', { class: 'checkline' }, box, label);
  }
  private color(get: () => string, commit: (v: string) => void) {
    const input = h('input', { type: 'color' }) as HTMLInputElement;
    const norm = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#000000');
    input.value = norm(get());
    input.addEventListener('change', () => commit(input.value));
    this.updaters.push(() => { input.value = norm(get()); });
    return input;
  }

  // ---------- building ----------
  private build() {
    clear(this.el);
    this.updaters = [];
    const sel = store.selectedClips();
    if (!sel.length) {
      this.el.append(h('div', { class: 'nothing' }, 'Select an event on the timeline to see and change its properties.'));
      return;
    }
    const p = store.project;
    const video = this.clipsOf('video');
    const audio = this.clipsOf('audio');
    const first = sel[0];
    const m = first.mediaId ? p.media.find((x) => x.id === first.mediaId) : undefined;
    const ov = overlapMap(p);

    // event timing
    const primary = () => store.project.clips.find((c) => c.id === first.id) ?? first;
    this.el.append(this.section(sel.length > 1 ? `${sel.length} events` : 'Event',
      this.row('Name', (() => {
        const i = h('input', { type: 'text', value: first.name }) as HTMLInputElement;
        i.addEventListener('change', () => this.apply('Rename Event', 'all', (c) => { c.name = i.value.slice(0, 120); }));
        i.addEventListener('keydown', (e) => e.stopPropagation());
        this.updaters.push(() => { i.value = primary().name; });
        return i;
      })()),
      this.row('Position', this.timeInput(() => primary().start, (v) => {
        const d = v - primary().start;
        const ids = edit.withGroups(store.project, [first.id]);
        store.commit('Move Event', (pr) => { for (const c of pr.clips) if (ids.has(c.id)) c.start = Math.max(0, c.start + d); });
      })),
      this.row('Length', this.timeInput(() => primary().length, (v) => {
        const ids = edit.withGroups(store.project, [first.id]);
        store.commit('Event Length', (pr) => { for (const c of pr.clips) if (ids.has(c.id)) c.length = Math.max(1 / pr.fps, Math.min(v, maxLength(pr, c))); });
      })),
      first.generator ? null : this.row('Playback rate', (() => {
        const sel2 = this.select([['0.25', '25%'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100% (normal)'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%'], ['3', '300%'], ['4', '400%']] as [string, string][],
          () => String(primary().speed), (v) => edit.setSpeed(edit.withGroups(store.project, store.selection), Number(v)));
        return sel2;
      })()),
      this.check('Mute event', () => primary().mute, (v) => this.apply('Mute Event', 'all', (c) => { c.mute = v; })),
    ));

    if (video.length) {
      const v0 = video[0];
      const hasPrev = !!ov.get(v0.id)?.before;
      this.el.append(this.section('Video',
        this.sliderRow('Opacity', 'video', (c) => c.gain, (c, v) => { c.gain = Math.round(v * 100) / 100; }, linMap(0, 1), (v) => `${Math.round(v * 100)}%`, 1),
        ...this.fadeRows('video'),
        hasPrev
          ? this.row('Transition in', this.select<TransitionKind>([['crossfade', 'Crossfade'], ['dip', 'Dip to black'], ['wipe-left', 'Wipe left'], ['wipe-right', 'Wipe right'], ['slide-left', 'Slide'], ['push-up', 'Push up']],
            () => (store.project.clips.find((c) => c.id === v0.id) ?? v0).transition, (k) => this.apply('Transition', 'video', (c) => { c.transition = k; })))
          : h('div', { class: 'ctx-hint', style: 'margin-top:4px' }, 'Overlap this event with the one before it on the track for a transition.'),
      ));
      if (v0.generator === 'text') this.el.append(this.textSection());
      if (v0.generator === 'solid' || v0.generator === 'gradient') this.el.append(this.colorSection(v0.generator));
      this.el.append(this.panCropSection(), this.fxSection());
    }

    if (audio.length) {
      const a0 = audio[0];
      this.el.append(this.sectionWith('Audio', (() => {
        const b = h('button', { class: 'small-btn', title: 'Set the volume so the loudest peak is at -0.1 dB' }, 'Normalize');
        b.addEventListener('click', () => edit.normalizeSelection());
        return b;
      })(),
      this.sliderRow('Volume', 'audio', (c) => c.gain, (c, v) => { c.gain = v; }, dbMap, formatDb, 1),
      this.sliderRow('Pan', 'audio', (c) => c.pan, (c, v) => { c.pan = Math.abs(v) < 0.02 ? 0 : v; }, linMap(-1, 1), panFormat, 0, true),
      ...this.fadeRows('audio'),
      media.get(a0.mediaId)?.audio ? null : h('div', { class: 'ctx-hint' }, `Decoding audio… ${Math.round((media.get(a0.mediaId)?.audioProgress ?? 0) * 100)}%`),
      ));
    }

    if (m) {
      const info = m.kind === 'audio' ? `${shortTime(m.duration)} · ${(m.sampleRate / 1000).toFixed(1)} kHz · ${m.channels === 1 ? 'mono' : 'stereo'}`
        : m.kind === 'image' ? `${m.width}×${m.height} image` : `${m.width}×${m.height} · ${+m.fps.toFixed(3)} fps · ${shortTime(m.duration)}${m.hasAudio ? ' · with audio' : ''}`;
      const link = h('a', { href: '#', style: 'color:var(--accent-2);word-break:break-all' }, m.path);
      link.addEventListener('click', (e) => { e.preventDefault(); native.showInFolder(m.path); });
      this.el.append(this.section('Media', this.row('File', link), this.row('Format', h('span', { style: 'color:var(--dim)' }, info))));
    }
  }

  private fadeRows(kind: Kind): HTMLElement[] {
    const c0 = () => this.clipsOf(kind)[0];
    const curves: [FadeCurve, string][] = [['smooth', 'Smooth'], ['linear', 'Linear'], ['fast', 'Fast'], ['slow', 'Slow']];
    return [
      this.row('Fade in (s)', this.numberInput(() => c0()?.fadeIn ?? 0, (v) => this.apply('Fade In', kind, (c) => { c.fadeIn = Math.min(v, c.length - c.fadeOut); }))),
      this.row('Fade out (s)', this.numberInput(() => c0()?.fadeOut ?? 0, (v) => this.apply('Fade Out', kind, (c) => { c.fadeOut = Math.min(v, c.length - c.fadeIn); }))),
      this.row('Fade curve', this.select(curves, () => c0()?.fadeInCurve ?? 'smooth', (k) => this.apply('Fade Type', kind, (c) => { c.fadeInCurve = k; c.fadeOutCurve = k; }))),
    ];
  }

  private panCropSection() {
    const v0 = () => this.clipsOf('video')[0];
    const animated = !!v0()?.panCropEnd;
    const which = (c: Clip): PanCrop => (this.panEnd && c.panCropEnd ? c.panCropEnd : c.panCrop);
    const s = (label: string, key: keyof PanCrop, map: ReturnType<typeof linMap>, fmt: (v: number) => string, reset: number, center = false) =>
      this.sliderRow(label, 'video', (c) => which(c)[key], (c, v) => { which(c)[key] = v; }, map, fmt, reset, center);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const reset = h('button', { class: 'small-btn' }, 'Reset');
    reset.addEventListener('click', () => this.apply('Reset Pan/Crop', 'video', (c) => { c.panCrop = defaultPanCrop(); delete c.panCropEnd; }));
    const seg = h('div', { class: 'seg' });
    if (animated) {
      for (const [end, label] of [[false, 'Start'], [true, 'End']] as const) {
        const b = h('button', { class: this.panEnd === end ? 'on' : '' }, label);
        b.addEventListener('click', () => { this.panEnd = end; this.sig = ''; this.refresh(); });
        seg.append(b);
      }
    }
    return this.sectionWith('Pan / Crop', reset,
      this.check('Animate from start to end (Ken Burns)', () => !!v0()?.panCropEnd, (on) => {
        this.apply('Animate Pan/Crop', 'video', (c) => { if (on) c.panCropEnd = { ...c.panCrop, scale: c.panCrop.scale * 1.2 }; else delete c.panCropEnd; });
        this.panEnd = on;
      }),
      animated ? this.row('Editing', seg) : null,
      s('Position X', 'x', linMap(-1, 1), pct, 0, true),
      s('Position Y', 'y', linMap(-1, 1), pct, 0, true),
      s('Zoom', 'scale', { toPos: (v) => Math.log(v / 0.1) / Math.log(40), fromPos: (p) => Math.round(0.1 * Math.pow(40, p) * 100) / 100 }, pct, 1),
      s('Rotation', 'rotation', linMap(-180, 180), (v) => `${Math.round(v)}°`, 0, true),
      s('Crop left', 'cropLeft', linMap(0, 0.45), pct, 0),
      s('Crop right', 'cropRight', linMap(0, 0.45), pct, 0),
      s('Crop top', 'cropTop', linMap(0, 0.45), pct, 0),
      s('Crop bottom', 'cropBottom', linMap(0, 0.45), pct, 0),
    );
  }

  private fxSection() {
    const s = (label: string, key: keyof Fx, map: ReturnType<typeof linMap>, fmt: (v: number) => string, reset: number, center = false) =>
      this.sliderRow(label, 'video', (c) => c.fx[key], (c, v) => { c.fx[key] = Math.round(v * 1000) / 1000; }, map, fmt, reset, center);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const preset = h('select', { style: 'height:22px;background:var(--panel-3);border:1px solid var(--line-2);border-radius:4px' },
      ...Object.keys(FX_PRESETS).map((k) => h('option', { value: k }, k))) as HTMLSelectElement;
    preset.addEventListener('change', () => {
      const fx = { ...defaultFx(), ...FX_PRESETS[preset.value] };
      this.apply(`FX: ${preset.value}`, 'video', (c) => { c.fx = { ...fx }; });
      preset.value = 'None';
    });
    return this.sectionWith('Video FX', preset,
      s('Brightness', 'brightness', linMap(0, 2), pct, 1),
      s('Contrast', 'contrast', linMap(0, 2), pct, 1),
      s('Saturation', 'saturation', linMap(0, 3), pct, 1),
      s('Hue', 'hue', linMap(-180, 180), (v) => `${Math.round(v)}°`, 0, true),
      s('Blur', 'blur', linMap(0, 40), (v) => `${v.toFixed(1)} px`, 0),
      s('Black & white', 'grayscale', linMap(0, 1), pct, 0),
      s('Sepia', 'sepia', linMap(0, 1), pct, 0),
      s('Invert', 'invert', linMap(0, 1), pct, 0),
    );
  }

  private textSection() {
    const t0 = () => this.clipsOf('video').find((c) => c.text)?.text;
    const setText = (label: string, fn: (t: TextProps) => void) => this.apply(label, 'video', (c) => { if (c.text) fn(c.text); });
    const area = h('textarea', { rows: 3 }) as HTMLTextAreaElement;
    area.value = t0()?.text ?? '';
    area.addEventListener('keydown', (e) => e.stopPropagation());
    area.addEventListener('input', () => {
      // live typing: one undo step per editing burst
      store.begin();
      for (const c of store.project.clips) if (store.selection.has(c.id) && c.text) { c.text.text = area.value; c.name = area.value.split('\n')[0].slice(0, 40) || 'Text'; }
      store.live();
    });
    area.addEventListener('change', () => store.end('Edit Text'));
    area.addEventListener('blur', () => store.end('Edit Text'));
    this.updaters.push(() => { area.value = t0()?.text ?? ''; });
    const style = h('div', { class: 'seg' });
    for (const [key, label] of [['bold', 'B'], ['italic', 'I']] as const) {
      const b = h('button', { class: t0()?.[key] ? 'on' : '', style: key === 'bold' ? 'font-weight:700' : 'font-style:italic' }, label);
      b.addEventListener('click', () => setText(key === 'bold' ? 'Bold' : 'Italic', (t) => { t[key] = !t[key]; }));
      this.updaters.push(() => b.classList.toggle('on', !!t0()?.[key]));
      style.append(b);
    }
    const align = h('div', { class: 'seg' });
    for (const a of ['left', 'center', 'right'] as const) {
      const b = h('button', { class: t0()?.align === a ? 'on' : '' }, a[0].toUpperCase() + a.slice(1));
      b.addEventListener('click', () => setText('Text Alignment', (t) => { t.align = a; }));
      this.updaters.push(() => b.classList.toggle('on', t0()?.align === a));
      align.append(b);
    }
    const ts = (label: string, key: 'size' | 'x' | 'y' | 'outline', map: ReturnType<typeof linMap>, fmt: (v: number) => string, reset: number) =>
      this.sliderRow(label, 'video', (c) => c.text?.[key] ?? reset, (c, v) => { if (c.text) c.text[key] = v; }, map, fmt, reset);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    return this.section('Text',
      this.row('Text', area),
      this.row('Font', this.select(FONTS.map((f) => [f, f] as [string, string]), () => t0()?.font ?? 'Segoe UI', (f) => setText('Font', (t) => { t.font = f; }))),
      ts('Size', 'size', linMap(0.02, 0.3), pct, 0.1),
      this.row('Color', h('div', { class: 'checkline' }, this.color(() => t0()?.color ?? '#ffffff', (c) => setText('Text Color', (t) => { t.color = c; })), style)),
      this.row('Align', align),
      ts('Position X', 'x', linMap(0, 1), pct, 0.5),
      ts('Position Y', 'y', linMap(0, 1), pct, 0.5),
      ts('Outline', 'outline', linMap(0, 0.25), (v) => `${Math.round(v * 100)}`, 0),
      this.row('Outline color', this.color(() => t0()?.outlineColor ?? '#000000', (c) => setText('Outline Color', (t) => { t.outlineColor = c; }))),
      this.check('Drop shadow', () => !!t0()?.shadow, (v) => setText('Text Shadow', (t) => { t.shadow = v; })),
      this.check('Background box', () => !!t0()?.box, (v) => setText('Text Box', (t) => { t.box = v; })),
    );
  }

  private colorSection(kind: 'solid' | 'gradient') {
    const c0 = () => this.clipsOf('video')[0];
    return this.section(kind === 'solid' ? 'Color' : 'Gradient',
      this.row(kind === 'solid' ? 'Color' : 'From', this.color(() => c0()?.color ?? '#000000', (v) => this.apply('Color', 'video', (c) => { c.color = v; }))),
      kind === 'gradient' ? this.row('To', this.color(() => c0()?.color2 ?? '#ffffff', (v) => this.apply('Color', 'video', (c) => { c.color2 = v; }))) : null,
    );
  }
}
