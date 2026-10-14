// Filter > Liquify: brush-driven warping through a reduced-resolution displacement field.
// The stage renders only the visible screen pixels (field + source mip level) so strokes stay
// interactive on large images; OK renders the full-resolution result via applyFilter.
import { app } from '../app';
import { sampleBilinear, warpByField, WarpField } from '../core/filters';
import { checkerboard, clamp, createCanvas, ctx2d, getImageData, rafThrottle } from '../core/util';
import { alphaToGray, applyFilter, editableTarget } from '../ops/target';
import { h, injectStyle } from '../ui/dom';
import { iconButton, button, checkbox, section, sliderField, Field } from '../ui/widgets';
import { openDialog } from './dialog';

injectStyle('liquify', `
.dlg.liquify .big-preview { height: min(76vh, 760px); }
.dlg.liquify .stage { touch-action: none; }
.dlg.liquify .stage canvas { left: 0; top: 0; }
.dlg.liquify .toolcol { padding-top: 2px; }
.dlg.liquify .toolcol .icon-btn { width: 30px; height: 30px; }
.dlg.liquify .controls .ps-section { gap: 10px; }
.dlg.liquify .lq-row { display: flex; gap: 8px; flex-wrap: wrap; }
.dlg.liquify .lq-hint { color: var(--text-3); font-size: 11px; line-height: 1.4; }
body.photon-busy, body.photon-busy * { cursor: progress !important; }
`);

type Tool = 'warp' | 'reconstruct' | 'smooth' | 'twirl' | 'pucker' | 'bloat' | 'push' | 'hand' | 'zoom';
const TOOLS: { id: Tool; icon: string; name: string; key: string }[] = [
  { id: 'warp', icon: 'smudge', name: 'Forward Warp Tool', key: 'W' },
  { id: 'reconstruct', icon: 'history-brush', name: 'Reconstruct Tool', key: 'R' },
  { id: 'smooth', icon: 'blur', name: 'Smooth Tool', key: 'E' },
  { id: 'twirl', icon: 'rotate-view', name: 'Twirl Clockwise Tool (Alt: counter-clockwise)', key: 'C' },
  { id: 'pucker', icon: 'zoom-out', name: 'Pucker Tool', key: 'S' },
  { id: 'bloat', icon: 'zoom-in', name: 'Bloat Tool', key: 'B' },
  { id: 'push', icon: 'move', name: 'Push Left Tool (Alt: push right)', key: 'O' },
  { id: 'hand', icon: 'hand', name: 'Hand Tool', key: 'H' },
  { id: 'zoom', icon: 'zoom', name: 'Zoom Tool (Alt: zoom out)', key: 'Z' },
];
/** Tools that keep working while the mouse is held still. */
const CONTINUOUS = new Set<Tool>(['reconstruct', 'smooth', 'twirl', 'pucker', 'bloat']);

// Brush settings persist for the session, like Photoshop.
const opts = { tool: 'warp' as Tool, size: 100, density: 50, pressure: 100, rate: 80, amount: 100, mesh: false };

export async function openLiquify(): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const t = await editableTarget(doc, 'use the Liquify filter');
  if (!t) return;
  const src = t.alphaOnly ? alphaToGray(t.canvas) : t.canvas;
  const W = src.width, H = src.height;

  // ---------- displacement field (backward map: output p shows source p + D(p)) ----------
  const cs = Math.max(1, Math.ceil(Math.max(W, H) / 512));
  const gw = Math.floor((W - 1) / cs) + 2, gh = Math.floor((H - 1) / cs) + 2;
  const fx = new Float32Array(gw * gh), fy = new Float32Array(gw * gh);
  const undoStack: [Float32Array, Float32Array][] = [], redoStack: [Float32Array, Float32Array][] = [];
  const pushUndo = () => {
    undoStack.push([fx.slice(), fy.slice()]);
    if (undoStack.length > 40) undoStack.shift();
    redoStack.length = 0;
  };
  const swap = (from: [Float32Array, Float32Array][], to: [Float32Array, Float32Array][]) => {
    const s = from.pop();
    if (!s) return;
    to.push([fx.slice(), fy.slice()]);
    fx.set(s[0]); fy.set(s[1]);
    renderAll();
  };
  const fieldAt = (F: Float32Array, x: number, y: number) => {
    const u = clamp(x / cs, 0, gw - 1), v = clamp(y / cs, 0, gh - 1);
    const i0 = Math.min(gw - 2, Math.floor(u)), j0 = Math.min(gh - 2, Math.floor(v)), fu = u - i0, fv = v - j0, n = j0 * gw + i0;
    const a = F[n] + (F[n + 1] - F[n]) * fu, b = F[n + gw] + (F[n + gw + 1] - F[n + gw]) * fu;
    return a + (b - a) * fv;
  };
  const isIdentity = () => { for (let i = 0; i < fx.length; i++) if (fx[i] !== 0 || fy[i] !== 0) return false; return true; };

  /** Brush falloff for t = distance / radius in [0, 1). Higher density = flatter, denser brush. */
  const falloff = (tt: number) => {
    const soft = 0.5 * (1 + Math.cos(Math.PI * tt)), hard = 1 - tt * tt * tt * tt, dn = opts.density / 100;
    return soft + (hard - soft) * dn;
  };
  /** Apply one brush dab at (cx, cy) in image pixels. (ddx, ddy) = stroke movement for warp/push. */
  const stamp = (cx: number, cy: number, tool: Tool, ddx: number, ddy: number, alt: boolean) => {
    const R = opts.size / 2;
    const i0 = Math.max(0, Math.floor((cx - R) / cs)), i1 = Math.min(gw - 1, Math.ceil((cx + R) / cs));
    const j0 = Math.max(0, Math.floor((cy - R) / cs)), j1 = Math.min(gh - 1, Math.ceil((cy + R) / cs));
    if (i1 < i0 || j1 < j0) return;
    const ox = fx.slice(), oy = fy.slice();
    const rate = opts.rate / 100, press = opts.pressure / 100, dir = alt ? -1 : 1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const qx = i * cs, qy = j * cs, dx = qx - cx, dy = qy - cy, d = Math.sqrt(dx * dx + dy * dy);
        if (d >= R) continue;
        const wgt = falloff(d / R), n = j * gw + i;
        let sx = qx, sy = qy;
        switch (tool) {
          case 'warp': sx = qx - ddx * wgt * press; sy = qy - ddy * wgt * press; break;
          case 'push': { const m = wgt * press * 0.6 * dir; sx = qx - ddy * m; sy = qy + ddx * m; break; }
          case 'twirl': {
            const a = dir * 0.05 * rate * wgt, c = Math.cos(a), s = Math.sin(a);
            sx = cx + dx * c + dy * s; sy = cy - dx * s + dy * c; break;
          }
          case 'pucker': { const f = 1 + 0.04 * rate * wgt; sx = cx + dx * f; sy = cy + dy * f; break; }
          case 'bloat': { const f = 1 - 0.04 * rate * wgt; sx = cx + dx * f; sy = cy + dy * f; break; }
          case 'reconstruct': {
            const k = 1 - Math.min(1, 0.1 * rate * wgt);
            fx[n] = ox[n] * k; fy[n] = oy[n] * k;
            continue;
          }
          case 'smooth': {
            let ax = 0, ay = 0, cnt = 0;
            for (let b = Math.max(0, j - 2); b <= Math.min(gh - 1, j + 2); b++) {
              for (let a = Math.max(0, i - 2); a <= Math.min(gw - 1, i + 2); a++) { const m = b * gw + a; ax += ox[m]; ay += oy[m]; cnt++; }
            }
            const k = Math.min(1, 0.3 * rate * wgt);
            fx[n] = ox[n] + (ax / cnt - ox[n]) * k; fy[n] = oy[n] + (ay / cnt - oy[n]) * k;
            continue;
          }
          default: continue;
        }
        fx[n] = sx - qx + fieldAt(ox, sx, sy);
        fy[n] = sy - qy + fieldAt(oy, sx, sy);
      }
    }
  };

  // ---------- source mip levels for the stage ----------
  const levels: { c: HTMLCanvasElement; d: Uint8ClampedArray | null }[] = [{ c: src, d: null }];
  const level = (k: number) => {
    while (levels.length <= k) {
      const prev = levels[levels.length - 1].c;
      const c = createCanvas(Math.max(1, Math.round(prev.width / 2)), Math.max(1, Math.round(prev.height / 2)));
      const x = ctx2d(c);
      x.imageSmoothingQuality = 'high';
      x.drawImage(prev, 0, 0, c.width, c.height);
      levels.push({ c, d: null });
    }
    const L = levels[k];
    if (!L.d) L.d = getImageData(L.c).data;
    return { w: L.c.width, h: L.c.height, d: L.d };
  };
  const maxLevel = Math.max(0, Math.floor(Math.log2(Math.max(W, H) / 64)));

  // ---------- view ----------
  const view = h('canvas') as HTMLCanvasElement;
  const over = h('canvas') as HTMLCanvasElement;
  const stage = h('div', { class: 'stage' }, view, over);
  const buf = createCanvas(1, 1);
  let sw = 0, sh = 0, zoom = 1, panX = 0, panY = 0, fitted = false;
  let frame: ImageData | null = null;
  const fit = () => {
    zoom = Math.min((sw - 24) / W, (sh - 24) / H, 1);
    if (!(zoom > 0)) zoom = 0.01;
    panX = (sw - W * zoom) / 2; panY = (sh - H * zoom) / 2;
  };
  const zoomAt = (z: number, sx: number, sy: number) => {
    z = clamp(z, 0.02, 32);
    const ix = (sx - panX) / zoom, iy = (sy - panY) / zoom;
    zoom = z; panX = sx - ix * zoom; panY = sy - iy * zoom;
    renderAll();
  };
  const toImage = (e: PointerEvent | WheelEvent) => {
    const r = over.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, x: (sx - panX) / zoom, y: (sy - panY) / zoom };
  };

  const renderImage = () => {
    if (!sw || !sh) return;
    if (!frame || frame.width !== sw || frame.height !== sh) frame = new ImageData(sw, sh);
    const od = frame.data;
    od.fill(0);
    const k = clamp(Math.floor(Math.log2(1 / zoom)), 0, maxLevel);
    const L = level(k), lsx = L.w / W, lsy = L.h / H, iz = 1 / zoom;
    const x0 = Math.max(0, Math.floor(panX)), y0 = Math.max(0, Math.floor(panY));
    const x1 = Math.min(sw, Math.ceil(panX + W * zoom)), y1 = Math.min(sh, Math.ceil(panY + H * zoom));
    for (let sy = y0; sy < y1; sy++) {
      const iy = (sy + 0.5 - panY) * iz - 0.5;
      if (iy < -0.5 || iy > H - 0.5) continue;
      const v = clamp(iy, 0, H - 1) / cs, j0 = Math.min(gh - 2, Math.floor(v)), fv = v - j0;
      for (let sx = x0; sx < x1; sx++) {
        const ix = (sx + 0.5 - panX) * iz - 0.5;
        if (ix < -0.5 || ix > W - 0.5) continue;
        const u = clamp(ix, 0, W - 1) / cs, i0 = Math.min(gw - 2, Math.floor(u)), fu = u - i0, n = j0 * gw + i0;
        const a = fx[n] + (fx[n + 1] - fx[n]) * fu, b = fx[n + gw] + (fx[n + gw + 1] - fx[n + gw]) * fu;
        const c = fy[n] + (fy[n + 1] - fy[n]) * fu, d = fy[n + gw] + (fy[n + gw + 1] - fy[n + gw]) * fu;
        const dx = a + (b - a) * fv, dy = c + (d - c) * fv;
        sampleBilinear(L.d, L.w, L.h, (ix + dx + 0.5) * lsx - 0.5, (iy + dy + 0.5) * lsy - 0.5, 'clamp', od, (sy * sw + sx) * 4);
      }
    }
    if (buf.width !== sw || buf.height !== sh) { buf.width = sw; buf.height = sh; }
    ctx2d(buf).putImageData(frame, 0, 0);
    const x = ctx2d(view);
    x.clearRect(0, 0, sw, sh);
    x.fillStyle = x.createPattern(checkerboard(), 'repeat') ?? '#fff';
    x.fillRect(Math.max(0, panX), Math.max(0, panY), Math.min(sw, panX + W * zoom) - Math.max(0, panX), Math.min(sh, panY + H * zoom) - Math.max(0, panY));
    x.drawImage(buf, 0, 0);
  };

  let mouse: { sx: number; sy: number } | null = null;
  const themeColor = (v: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fb;
  const drawOverlay = () => {
    const x = ctx2d(over);
    x.clearRect(0, 0, sw, sh);
    if (opts.mesh) {
      // approximate forward mesh: node q drawn at q - D(q)
      const M = Math.max(1, Math.ceil(Math.max(32, 14 / zoom) / cs));
      x.strokeStyle = themeColor('--text-3', '#888');
      x.globalAlpha = 0.7;
      x.lineWidth = 1;
      x.beginPath();
      const P = (i: number, j: number) => {
        const n = j * gw + i;
        return [panX + (i * cs - fx[n]) * zoom, panY + (j * cs - fy[n]) * zoom];
      };
      for (let j = 0; j < gh; j += M) for (let i = 0; i < gw; i++) { const [a, b] = P(i, j); if (i === 0) x.moveTo(a, b); else x.lineTo(a, b); }
      for (let i = 0; i < gw; i += M) for (let j = 0; j < gh; j++) { const [a, b] = P(i, j); if (j === 0) x.moveTo(a, b); else x.lineTo(a, b); }
      x.stroke();
      x.globalAlpha = 1;
    }
    const tool = activeTool();
    if (mouse && tool !== 'hand' && tool !== 'zoom') {
      const r = Math.max(1, (opts.size / 2) * zoom);
      for (const [col, wd] of [['rgba(0,0,0,.7)', 3], ['rgba(255,255,255,.95)', 1]] as [string, number][]) {
        x.strokeStyle = col; x.lineWidth = wd;
        x.beginPath(); x.arc(mouse.sx, mouse.sy, r, 0, Math.PI * 2); x.stroke();
        x.beginPath(); x.moveTo(mouse.sx - 3, mouse.sy); x.lineTo(mouse.sx + 3, mouse.sy); x.moveTo(mouse.sx, mouse.sy - 3); x.lineTo(mouse.sx, mouse.sy + 3); x.stroke();
      }
    }
  };
  const renderAll = rafThrottle(() => { renderImage(); drawOverlay(); });
  const renderOverlay = rafThrottle(drawOverlay);

  // ---------- tools & input ----------
  let spaceDown = false, altDown = false;
  const activeTool = (): Tool => (spaceDown ? 'hand' : opts.tool);
  const updateCursor = () => {
    const tool = activeTool();
    over.style.cursor = tool === 'hand' ? 'grab' : tool === 'zoom' ? (altDown ? 'zoom-out' : 'zoom-in') : 'none';
  };
  const toolBtns = new Map<Tool, HTMLButtonElement>();
  const setTool = (tool: Tool) => {
    opts.tool = tool;
    toolBtns.forEach((b, id) => b.classList.toggle('active', id === tool));
    updateCursor();
    renderOverlay();
  };
  const toolcol = h('div', { class: 'toolcol' }, TOOLS.map((tl) => {
    const b = iconButton(tl.icon, `${tl.name} (${tl.key})`, () => setTool(tl.id), { size: 18, active: tl.id === opts.tool });
    toolBtns.set(tl.id, b);
    return b;
  }));

  let stroke: { last: { x: number; y: number }; timer: number; alt: boolean; tool: Tool } | null = null;
  let panDrag: { sx: number; sy: number; px: number; py: number } | null = null;
  over.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    over.setPointerCapture(e.pointerId);
    const p = toImage(e), tool = e.button === 1 ? 'hand' : activeTool();
    if (tool === 'hand') { panDrag = { sx: e.clientX, sy: e.clientY, px: panX, py: panY }; over.style.cursor = 'grabbing'; return; }
    if (tool === 'zoom') { zoomAt(zoom * (e.altKey ? 1 / 1.5 : 1.5), p.sx, p.sy); return; }
    pushUndo();
    const alt = e.altKey;
    stroke = { last: { x: p.x, y: p.y }, alt, tool, timer: 0 };
    if (CONTINUOUS.has(tool)) {
      stamp(p.x, p.y, tool, 0, 0, alt);
      stroke.timer = window.setInterval(() => {
        if (!stroke) return;
        stamp(stroke.last.x, stroke.last.y, stroke.tool, 0, 0, stroke.alt);
        renderAll();
      }, 40);
      renderAll();
    }
  });
  over.addEventListener('pointermove', (e) => {
    const p = toImage(e);
    mouse = { sx: p.sx, sy: p.sy };
    if (panDrag) {
      panX = panDrag.px + e.clientX - panDrag.sx; panY = panDrag.py + e.clientY - panDrag.sy;
      renderAll();
      return;
    }
    if (stroke) {
      const ddx = p.x - stroke.last.x, ddy = p.y - stroke.last.y, len = Math.hypot(ddx, ddy);
      if (len > 0) {
        if (stroke.tool === 'warp' || stroke.tool === 'push') {
          const steps = Math.max(1, Math.ceil(len / Math.max(1, opts.size * 0.1)));
          for (let k = 1; k <= steps; k++) {
            const cx = stroke.last.x + (ddx * k) / steps, cy = stroke.last.y + (ddy * k) / steps;
            stamp(cx, cy, stroke.tool, ddx / steps, ddy / steps, stroke.alt);
          }
        } else stamp(p.x, p.y, stroke.tool, 0, 0, stroke.alt);
        stroke.last = { x: p.x, y: p.y };
        renderAll();
        return;
      }
    }
    renderOverlay();
  });
  const endStroke = () => {
    if (stroke) { clearInterval(stroke.timer); stroke = null; }
    if (panDrag) { panDrag = null; updateCursor(); }
  };
  over.addEventListener('pointerup', endStroke);
  over.addEventListener('pointercancel', endStroke);
  over.addEventListener('pointerleave', () => { if (!stroke) { mouse = null; renderOverlay(); } });
  over.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toImage(e);
    zoomAt(zoom * Math.pow(1.0015, -e.deltaY), p.sx, p.sy);
  }, { passive: false });

  // ---------- controls ----------
  const sizeF: Field<number> = sliderField({ label: 'Size:', value: opts.size, min: 1, max: 1500, reset: 100, onInput: (v) => { opts.size = v; renderOverlay(); } });
  const controls = h('div', { class: 'controls' },
    section('Brush Tool Options',
      sizeF.el,
      sliderField({ label: 'Density:', value: opts.density, min: 0, max: 100, reset: 50, onInput: (v) => { opts.density = v; } }).el,
      sliderField({ label: 'Pressure:', value: opts.pressure, min: 1, max: 100, reset: 100, onInput: (v) => { opts.pressure = v; } }).el,
      sliderField({ label: 'Rate:', value: opts.rate, min: 0, max: 100, reset: 80, onInput: (v) => { opts.rate = v; } }).el,
    ),
    section('Reconstruct Options',
      sliderField({ label: 'Amount:', value: opts.amount, min: 0, max: 100, reset: 100, onInput: (v) => { opts.amount = v; } }).el,
      h('div', { class: 'lq-row' },
        button('Reconstruct', () => {
          pushUndo();
          const k = 1 - opts.amount / 100;
          for (let i = 0; i < fx.length; i++) { fx[i] *= k; fy[i] *= k; }
          renderAll();
        }, { small: true, title: 'Revert distortions by the Amount' }),
        button('Restore All', () => { pushUndo(); fx.fill(0); fy.fill(0); renderAll(); }, { small: true })),
    ),
    section('View Options',
      checkbox({ label: 'Show Mesh', checked: opts.mesh, onChange: (v) => { opts.mesh = v; renderOverlay(); } }).el),
    h('div', { class: 'lq-hint' }, '[ / ] brush size · Space: pan · Wheel: zoom · Ctrl+0: fit · Ctrl+Z / Ctrl+Shift+Z: undo / redo'),
  );
  const content = h('div', { class: 'big-preview' }, toolcol, stage, controls);

  // ---------- keyboard (window capture: the dialog swallows propagation) ----------
  const isField = (el: EventTarget | null) => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Alt') { altDown = true; updateCursor(); e.preventDefault(); return; }
    if (isField(e.target)) return;
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === ' ') { e.preventDefault(); if (!spaceDown) { spaceDown = true; updateCursor(); renderOverlay(); } return; }
    if (ctrl && k === 'z') { e.preventDefault(); if (e.shiftKey) swap(redoStack, undoStack); else swap(undoStack, redoStack); return; }
    if (ctrl && k === 'y') { e.preventDefault(); swap(redoStack, undoStack); return; }
    if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); zoomAt(zoom * 1.5, sw / 2, sh / 2); return; }
    if (ctrl && k === '-') { e.preventDefault(); zoomAt(zoom / 1.5, sw / 2, sh / 2); return; }
    if (ctrl && k === '0') { e.preventDefault(); fit(); renderAll(); return; }
    if (ctrl || e.altKey) return;
    if (k === '[' || k === ']') {
      e.preventDefault();
      const step = opts.size < 20 ? 2 : opts.size < 100 ? 10 : opts.size < 400 ? 25 : 50;
      opts.size = clamp(opts.size + (k === ']' ? step : -step), 1, 1500);
      sizeF.set(opts.size);
      renderOverlay();
      return;
    }
    const tl = TOOLS.find((x) => x.key.toLowerCase() === k);
    if (tl) { e.preventDefault(); setTool(tl.id); }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') { e.preventDefault(); spaceDown = false; updateCursor(); renderOverlay(); }
    if (e.key === 'Alt') { altDown = false; updateCursor(); }
  };

  const ro = new ResizeObserver(() => {
    const w = Math.max(1, Math.floor(stage.clientWidth)), hh = Math.max(1, Math.floor(stage.clientHeight));
    if (w === sw && hh === sh) return;
    sw = w; sh = hh;
    view.width = over.width = sw; view.height = over.height = sh;
    if (!fitted) { fit(); fitted = true; }
    renderAll();
  });

  const ok = await openDialog({
    title: 'Liquify', content, layout: 'side', className: 'liquify',
    width: Math.round(Math.min(1200, window.innerWidth * 0.95)),
    onOpen: () => {
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);
      ro.observe(stage);
      setTool(opts.tool);
    },
  });
  endStroke();
  ro.disconnect();
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  if (!ok || isIdentity()) return;

  const field: WarpField = { fx, fy, gw, gh, cs, W, H };
  const fn = (s: HTMLCanvasElement) => warpByField(s, field);
  document.body.classList.add('photon-busy');
  await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    const done = await applyFilter('Liquify', fn, { wholeLayer: true });
    if (done) app.lastFilter = { name: 'Liquify', run: () => void applyFilter('Liquify', fn, { wholeLayer: true }) };
  } finally {
    document.body.classList.remove('photon-busy');
  }
}
