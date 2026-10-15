// Render As, render progress, Project Properties, keyboard shortcuts and About.
import { store } from '../core/store';
import { render, encoderSupport, estimateSize, type RenderFormat, type RenderQuality } from '../core/export';
import { native, dirName, fileName, extOf, baseName } from '../core/native';
import { projectEnd } from '../core/model';
import { timecode } from '../core/timecode';
import { transport } from '../core/playback';
import { h } from './dom';
import { modal, alertBox } from './dialog';

const RES: [string, number][] = [['project', 0], ['2160', 2160], ['1440', 1440], ['1080', 1080], ['720', 720], ['480', 480]];
let last = { format: 'mp4' as RenderFormat, res: 'project', fps: 'project', quality: 'high' as RenderQuality, audio: 192000, dir: '' };

const mb = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);
const clock = (s: number) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export async function renderAs() {
  const p = store.project;
  const end = projectEnd(p);
  if (end <= 0) { alertBox('Render As', 'The timeline is empty. Add some media first.'); return; }
  transport.pause();
  const support = await encoderSupport(p.width, p.height);
  if (!support.mp4 && !support.webm) { alertBox('Render As', 'This computer has no supported video encoder.'); return; }
  if (!support[last.format]) last.format = support.mp4 ? 'mp4' : 'webm';
  const name = p.name || 'Untitled';
  const defPath = last.dir ? `${last.dir}\\${name}.${last.format}` : await native.defaultRenderPath(name, last.format);
  const hasLoop = !!p.loop && p.loop.end - p.loop.start > 0.05;

  const path = h('input', { value: defPath, spellcheck: 'false' }) as HTMLInputElement;
  const browse = h('button', { class: 'btn' }, 'Browse…');
  const format = h('select', {},
    h('option', { value: 'mp4', disabled: !support.mp4 }, 'MP4 — H.264 video, AAC audio (plays everywhere)'),
    h('option', { value: 'webm', disabled: !support.webm }, 'WebM — VP9 video, Opus audio')) as HTMLSelectElement;
  format.value = last.format;
  const res = h('select', {}, ...RES.map(([v, hgt]) => {
    const w = hgt ? Math.round((hgt * p.width) / p.height / 2) * 2 : p.width;
    return h('option', { value: v }, v === 'project' ? `Project (${p.width}×${p.height})` : `${w}×${hgt}${hgt === 2160 ? ' (4K)' : ''}`);
  })) as HTMLSelectElement;
  res.value = last.res;
  const fps = h('select', {}, h('option', { value: 'project' }, `Project (${+p.fps.toFixed(3)} fps)`), ...[24, 25, 30, 50, 60].map((f) => h('option', { value: String(f) }, `${f} fps`))) as HTMLSelectElement;
  fps.value = last.fps;
  const quality = h('select', {}, h('option', { value: 'best' }, 'Best (largest file)'), h('option', { value: 'high' }, 'High'), h('option', { value: 'good' }, 'Good'), h('option', { value: 'small' }, 'Small file')) as HTMLSelectElement;
  quality.value = last.quality;
  const abr = h('select', {}, ...[[128000, '128 kbps'], [192000, '192 kbps'], [256000, '256 kbps'], [320000, '320 kbps']].map(([v, l]) => h('option', { value: String(v) }, String(l)))) as HTMLSelectElement;
  abr.value = String(last.audio);
  const range = h('select', {}, h('option', { value: 'all' }, `Entire project (${timecode(end, p.fps)})`),
    h('option', { value: 'loop', disabled: !hasLoop }, hasLoop ? `Time selection only (${timecode(p.loop!.end - p.loop!.start, p.fps)})` : 'Time selection only (none set)')) as HTMLSelectElement;
  range.value = hasLoop && store.view.loop ? 'loop' : 'all';
  const estimate = h('div', { class: 'hint' });

  const opts = () => {
    const hgt = Number(RES.find((r) => r[0] === res.value)![1]) || p.height;
    const w = res.value === 'project' ? p.width : Math.round((hgt * p.width) / p.height / 2) * 2;
    const from = range.value === 'loop' && p.loop ? p.loop.start : 0;
    const to = range.value === 'loop' && p.loop ? p.loop.end : end;
    return { width: w, height: hgt, fps: fps.value === 'project' ? p.fps : Number(fps.value), quality: quality.value as RenderQuality, audioBitrate: Number(abr.value), format: format.value as RenderFormat, from, to };
  };
  const update = () => {
    const o = opts();
    estimate.textContent = `About ${mb(estimateSize(o, o.to - o.from))} · ${o.width}×${o.height} at ${+o.fps.toFixed(3)} fps · ${timecode(o.to - o.from, p.fps)}`;
    // keep the extension in step with the format
    const ext = extOf(path.value);
    if (ext !== o.format && (ext === 'mp4' || ext === 'webm')) path.value = path.value.replace(/\.(mp4|webm)$/i, '.' + o.format);
  };
  for (const el of [format, res, fps, quality, abr, range]) el.addEventListener('change', update);
  browse.addEventListener('click', async () => {
    const chosen = await native.saveRender(path.value, format.value);
    if (chosen) path.value = chosen;
  });
  update();
  const body = h('div', { class: 'form' },
    h('label', {}, 'Save to'), h('div', { class: 'row' }, path, browse),
    h('label', {}, 'Format'), format,
    h('label', {}, 'Resolution'), res,
    h('label', {}, 'Frame rate'), fps,
    h('label', {}, 'Video quality'), quality,
    h('label', {}, 'Audio'), abr,
    h('label', {}, 'Render'), range,
    estimate);
  const choice = await modal('Render As', body, [{ label: 'Cancel', value: '' }, { label: 'Render', value: 'go', primary: true, disabled: () => !path.value.trim() }], { width: 620 });
  if (choice !== 'go') return;
  const o = opts();
  let out = path.value.trim();
  if (!/\.(mp4|webm)$/i.test(out)) out += '.' + o.format;
  last = { format: o.format, res: res.value, fps: fps.value, quality: o.quality, audio: o.audioBitrate, dir: dirName(out) };
  if (await native.stat(out)) {
    const ok = await modal('Render As', h('div', { style: 'color:var(--dim)' }, `${fileName(out)} already exists. Replace it?`), [{ label: 'Cancel', value: '' }, { label: 'Replace', value: 'yes', primary: true }]);
    if (ok !== 'yes') return;
  }
  await runRender({ ...o, path: out });
}

async function runRender(o: Parameters<typeof render>[1]) {
  const p = structuredClone(store.project);
  const abort = new AbortController();
  const pv = h('canvas', { class: 'render-pv', width: 640, height: 360 }) as HTMLCanvasElement;
  const pctx = pv.getContext('2d')!;
  const bar = h('i');
  const stats = { frame: h('b'), elapsed: h('b'), remaining: h('b'), speed: h('b') };
  const body = h('div', {}, pv, h('div', { class: 'progress' }, bar),
    h('div', { class: 'kv' }, h('span', {}, 'Frame ', stats.frame), h('span', {}, 'Speed ', stats.speed), h('span', {}, 'Elapsed ', stats.elapsed), h('span', {}, 'Remaining ', stats.remaining)));
  let closeDlg: (v: string) => void = () => {};
  const dlg = modal(`Rendering ${fileName(o.path)}`, body, [{ label: 'Cancel', value: 'cancel' }], { width: 560, onOpen: (c) => { closeDlg = c; } });
  dlg.then((v) => { if (v === 'cancel' || v === '') abort.abort(); });
  const t0 = performance.now();
  try {
    await render(p, o, (pr, canvas) => {
      const f = pr.frame / pr.frames;
      bar.style.width = `${(f * 100).toFixed(1)}%`;
      stats.frame.textContent = `${pr.frame} / ${pr.frames}`;
      stats.speed.textContent = `${pr.fps.toFixed(1)} fps (${(pr.fps / o.fps).toFixed(2)}×)`;
      stats.elapsed.textContent = clock(pr.elapsed);
      stats.remaining.textContent = clock((pr.frames - pr.frame) / Math.max(0.01, pr.fps));
      pctx.drawImage(canvas, 0, 0, pv.width, pv.height);
    }, abort.signal);
    closeDlg('done');
    const secs = (performance.now() - t0) / 1000;
    const st = await native.stat(o.path);
    const done = h('div', { style: 'color:var(--dim);line-height:1.6' },
      h('div', {}, `${fileName(o.path)} — ${st ? mb(st.size) : ''}, rendered in ${clock(secs)}.`),
      h('div', { style: 'word-break:break-all;color:var(--faint)' }, o.path));
    const v = await modal('Render complete', done, [{ label: 'Open Folder', value: 'folder' }, { label: 'Play', value: 'play' }, { label: 'Close', value: '', primary: true }]);
    if (v === 'folder') native.showInFolder(o.path);
    if (v === 'play') native.openPath(o.path);
  } catch (e) {
    closeDlg('done');
    if ((e as Error).name === 'AbortError') return;
    alertBox('Render failed', `${(e as Error).message || e}`);
  }
}

export async function projectProperties() {
  const p = store.project;
  const presets: [string, number, number][] = [['HD 1080p (1920×1080)', 1920, 1080], ['HD 720p (1280×720)', 1280, 720], ['4K UHD (3840×2160)', 3840, 2160], ['Vertical 1080×1920 (Shorts, Reels, TikTok)', 1080, 1920], ['Square 1080×1080', 1080, 1080], ['Custom', 0, 0]];
  const preset = h('select', {}, ...presets.map(([n], i) => h('option', { value: String(i) }, n))) as HTMLSelectElement;
  const w = h('input', { type: 'number', min: 16, max: 7680, value: p.width }) as HTMLInputElement;
  const hh = h('input', { type: 'number', min: 16, max: 4320, value: p.height }) as HTMLInputElement;
  const current = presets.findIndex(([, a, b]) => a === p.width && b === p.height);
  preset.value = String(current >= 0 ? current : presets.length - 1);
  preset.addEventListener('change', () => { const [, a, b] = presets[Number(preset.value)]; if (a) { w.value = String(a); hh.value = String(b); } });
  const fps = h('select', {}, ...[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((f) => h('option', { value: String(f) }, `${f} fps`))) as HTMLSelectElement;
  fps.value = String([23.976, 24, 25, 29.97, 30, 50, 59.94, 60].reduce((a, b) => (Math.abs(b - p.fps) < Math.abs(a - p.fps) ? b : a)));
  const videos = p.media.filter((m) => m.kind === 'video' && m.width && m.height);
  const match = h('select', {}, h('option', { value: '' }, videos.length ? 'Choose a video…' : 'No video in the project yet'),
    ...videos.map((m) => h('option', { value: m.id }, `${m.name} — ${m.width}×${m.height}, ${+m.fps.toFixed(3)} fps`))) as HTMLSelectElement;
  match.disabled = !videos.length;
  match.addEventListener('change', () => {
    const m = videos.find((v) => v.id === match.value);
    if (!m) return;
    w.value = String(m.width);
    hh.value = String(m.height);
    const rates = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
    fps.value = String(rates.reduce((a, b) => (Math.abs(b - m.fps) < Math.abs(a - m.fps) ? b : a)));
    const i = presets.findIndex(([, a, b]) => a === m.width && b === m.height);
    preset.value = String(i >= 0 ? i : presets.length - 1);
  });
  const body = h('div', { class: 'form' },
    h('label', {}, 'Match media'), match,
    h('label', {}, 'Template'), preset,
    h('label', {}, 'Width'), w,
    h('label', {}, 'Height'), hh,
    h('label', {}, 'Frame rate'), fps,
    h('div', { class: 'hint' }, 'Media keeps its aspect ratio; use Pan/Crop on an event to fill or reframe.'));
  const v = await modal('Project Video Properties', body, [{ label: 'Cancel', value: '' }, { label: 'OK', value: 'ok', primary: true }], { width: 480 });
  if (v !== 'ok') return;
  const W = Math.max(16, Math.min(7680, Math.round(Number(w.value) / 2) * 2));
  const H = Math.max(16, Math.min(4320, Math.round(Number(hh.value) / 2) * 2));
  store.commit('Project Properties', (pr) => { pr.width = W; pr.height = H; pr.fps = Number(fps.value); });
}

export function shortcuts() {
  const keys: [string, string][] = [
    ['Space', 'Play / Stop (returns to start position)'], ['Enter', 'Play / Pause'], ['J / K / L', 'Back 1 s · Pause · Play'],
    ['← / →', 'Previous / next frame'], ['Ctrl+← / Ctrl+→', 'Previous / next edit point'], ['Home / End', 'Start / end of project'],
    ['S', 'Split events at the cursor'], ['Delete', 'Delete selected events'], ['Ctrl+L', 'Auto Ripple on/off'],
    ['Ctrl+X / C / V', 'Cut / Copy / Paste'], ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'], ['Ctrl+A', 'Select all events'],
    ['G / U', 'Group / ungroup'], ['M', 'Insert marker'], ['I / O', 'Time selection start / end at cursor'], ['Q', 'Loop playback'],
    ['↑ / ↓', 'Zoom in / out'], ['Ctrl+wheel', 'Zoom around the mouse'], ['`', 'Zoom to fit the whole project'],
    ['F8', 'Snapping on/off'], ['Ctrl+F8', 'Quantize to frames'], ['Shift (while dragging)', 'Ignore snapping / fine adjust'],
    ['Ctrl+drag event', 'Copy the event'], ['Ctrl+Q / Ctrl+Shift+Q', 'Insert audio / video track'],
    ['Ctrl+I', 'Import media'], ['Ctrl+M', 'Render As'], ['Ctrl+N / O / S', 'New / Open / Save project'],
  ];
  const body = h('div', { class: 'keys' }, ...keys.flatMap(([k, d]) => [h('div', {}, ...k.split(' / ').flatMap((x, i) => (i ? [' / ', h('kbd', {}, x)] : [h('kbd', {}, x)]))), h('span', {}, d)]));
  return modal('Keyboard Shortcuts', body, [{ label: 'Close', value: '', primary: true }], { width: 640 });
}

export async function about() {
  const a = await native.about();
  const body = h('div', { style: 'color:var(--dim);line-height:1.6' },
    h('div', { style: 'display:flex;gap:12px;align-items:center;margin-bottom:10px' },
      h('div', { class: 'brand', style: 'padding:0' }, h('span', { class: 'badge', style: 'width:42px;height:42px;font-size:17px;border-radius:9px' }, 'Ct')),
      h('div', {}, h('div', { style: 'color:var(--text);font-size:16px;font-weight:600' }, `Cut ${a.version}`), h('div', {}, 'Video editor · part of Crystal Suite'))),
    h('div', {}, 'Free and open source (MIT). No account, no watermark, no subscription — everything runs on this computer.'),
    h('div', { style: 'color:var(--faint);margin-top:6px' }, `Chromium ${a.chrome} · Electron ${a.electron} · media engine: Mediabunny (MPL-2.0)`));
  const link = h('a', { href: '#', style: 'color:var(--accent-2)' }, 'Source code on GitHub');
  link.addEventListener('click', (e) => { e.preventDefault(); native.openUrl('https://github.com/Enqrypted/crystal-suite'); });
  body.append(h('div', { style: 'margin-top:8px' }, link));
  return modal('About Cut', body, [{ label: 'Close', value: '', primary: true }], { width: 480 });
}

export { baseName };
