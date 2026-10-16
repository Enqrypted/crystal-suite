// Signatures: draw one, type one in a handwriting font, or use a picture of one (its paper background can be
// made see-through). Saved signatures are kept for next time. Placing one adds it to the page as an image
// annotation the reader can move and resize before saving.
import type { DocTab } from './doc';
import { h, clear } from './ui/dom';
import { modal, toast } from './ui/dialog';
import { icon } from './icons';
import { native, type Signature } from './native';

const FONTS = ['Segoe Script', 'Ink Free', 'Lucida Handwriting', 'Segoe Print', 'Brush Script MT'];
const INKS = [{ name: 'Black', c: '#111111' }, { name: 'Blue', c: '#1a3fb0' }, { name: 'Red', c: '#b3171d' }];
/** Signatures go on the page this wide (points) unless they are unusually tall. */
const PLACE_W = 170;

export async function signDialog(tab: DocTab) {
  let saved = await native.signatures().catch(() => [] as Signature[]);
  let mode: 'saved' | 'draw' | 'type' | 'image' = saved.length ? 'saved' : 'draw';
  let ink = INKS[0].c;
  let result: Signature | null = null;
  let closeFn: (v: string) => void = () => {};

  const tabs = h('div', { class: 'seg sig-tabs' });
  const pane = h('div', { class: 'sig-pane' });
  const keep = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const keepRow = h('label', { class: 'checkline' }, keep, 'Save this signature for next time');
  const body = h('div', { class: 'sig' }, tabs, pane);

  // ---- draw ----
  const pad = h('canvas', { class: 'sig-pad', width: 1120, height: 360 }) as HTMLCanvasElement;
  const pctx = pad.getContext('2d')!;
  let strokes = 0;
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    const r = pad.getBoundingClientRect();
    const sx = pad.width / r.width;
    const pt = (ev: PointerEvent) => [(ev.clientX - r.left) * sx, (ev.clientY - r.top) * sx] as const;
    let [lx, ly] = pt(e);
    let [mx, my] = [lx, ly];
    pctx.strokeStyle = ink;
    pctx.fillStyle = ink;
    pctx.lineCap = pctx.lineJoin = 'round';
    pctx.beginPath(); pctx.arc(lx, ly, 2.6, 0, Math.PI * 2); pctx.fill();
    let lastT = performance.now();
    let width = 5.5;
    const move = (ev: PointerEvent) => {
      for (const c of ev.getCoalescedEvents?.() ?? [ev]) {
        const [x, y] = pt(c);
        const nx = (x + lx) / 2, ny = (y + ly) / 2;
        // faster strokes draw thinner, like a pen
        const now = performance.now();
        const v = Math.hypot(x - lx, y - ly) / Math.max(1, now - lastT);
        lastT = now;
        width = width * 0.7 + Math.max(2.6, Math.min(7, 7.5 - v * 1.6)) * 0.3;
        pctx.lineWidth = width;
        pctx.beginPath();
        pctx.moveTo(mx, my);
        pctx.quadraticCurveTo(lx, ly, nx, ny);
        pctx.stroke();
        [mx, my, lx, ly] = [nx, ny, x, y];
      }
    };
    const up = () => {
      pad.removeEventListener('pointermove', move);
      pad.removeEventListener('pointerup', up);
      pad.removeEventListener('pointercancel', up);
      strokes++;
      refresh();
    };
    pad.addEventListener('pointermove', move);
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
  });
  const clearPad = () => { pctx.clearRect(0, 0, pad.width, pad.height); strokes = 0; refresh(); };

  // ---- type ----
  const nameInput = h('input', { type: 'text', class: 'sig-name', placeholder: 'Type your name', maxlength: '60', spellcheck: 'false' }) as HTMLInputElement;
  let font = FONTS[0];
  const fontList = h('div', { class: 'sig-fonts' });
  const drawFonts = () => {
    clear(fontList);
    for (const f of FONTS) {
      const b = h('button', { type: 'button', class: `sig-font${f === font ? ' on' : ''}`, style: `font-family:'${f}';color:${ink}` }, nameInput.value.trim() || 'Your Name');
      b.addEventListener('click', () => { font = f; drawFonts(); });
      fontList.append(b);
    }
  };
  nameInput.addEventListener('input', () => { drawFonts(); refresh(); });

  // ---- image ----
  let picture: HTMLImageElement | null = null;
  const knockout = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const picBox = h('div', { class: 'sig-pic' });
  const showPicture = () => {
    clear(picBox);
    if (!picture) { picBox.append(h('div', { class: 'sig-ph' }, 'No picture chosen')); return; }
    const c = imageCanvas();
    if (c) picBox.append(c);
  };
  const choosePicture = async () => {
    const p = await native.imageDialog();
    if (!p) return;
    const bytes = await native.read(p);
    const ext = p.split('.').pop()!.toLowerCase();
    const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    const img = new Image();
    img.src = url;
    try { await img.decode(); picture = img; } catch { toast('That picture couldn’t be read.'); }
    showPicture();
    refresh();
  };
  knockout.addEventListener('change', showPicture);
  const imageCanvas = () => {
    if (!picture) return null;
    const scale = Math.min(1, 1400 / Math.max(picture.naturalWidth, picture.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(picture.naturalWidth * scale));
    c.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    const ctx = c.getContext('2d')!;
    ctx.drawImage(picture, 0, 0, c.width, c.height);
    if (knockout.checked) {
      // paper -> transparent: light pixels fade out, ink stays
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const a = l > 215 ? 0 : l > 150 ? (215 - l) / 65 : 1;
        px[i + 3] = Math.round(px[i + 3] * a);
      }
      ctx.putImageData(d, 0, 0);
    }
    return c;
  };

  const render = () => {
    clear(tabs);
    const modes = [...(saved.length ? [['saved', 'Saved'] as const] : []), ['draw', 'Draw'] as const, ['type', 'Type'] as const, ['image', 'Picture'] as const];
    for (const [m, label] of modes) {
      const b = h('button', { type: 'button', class: mode === m ? 'on' : '' }, label);
      b.addEventListener('click', () => { mode = m; render(); });
      tabs.append(b);
    }
    clear(pane);
    keepRow.hidden = mode === 'saved';
    const inks = h('div', { class: 'sig-inks' }, ...INKS.map((x) => {
      const b = h('button', { type: 'button', class: `sig-ink${x.c === ink ? ' on' : ''}`, title: x.name, style: `background:${x.c}` });
      b.addEventListener('click', () => { ink = x.c; render(); });
      return b;
    }));
    if (mode === 'saved') {
      const grid = h('div', { class: 'sig-saved' });
      for (const s of saved) {
        const del = h('button', { type: 'button', class: 'sig-del', title: 'Delete this signature', html: icon('close', 14) });
        const card = h('div', { class: 'sig-card', title: 'Place this signature' }, h('img', { src: s.png, draggable: 'false' }), del);
        card.addEventListener('click', () => { result = s; closeFn('place'); });
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          saved = saved.filter((x) => x.id !== s.id);
          await native.setSignatures(saved);
          if (!saved.length) mode = 'draw';
          render();
        });
        grid.append(card);
      }
      pane.append(grid, h('div', { class: 'sig-hint' }, 'Click a signature to place it, then drag it where it goes.'));
    } else if (mode === 'draw') {
      const clr = h('button', { type: 'button', class: 'small-btn' }, 'Clear');
      clr.addEventListener('click', clearPad);
      if (strokes) {
        // recolour what is already drawn
        const d = pctx.getImageData(0, 0, pad.width, pad.height);
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(ink.slice(i, i + 2), 16));
        for (let i = 0; i < d.data.length; i += 4) if (d.data[i + 3]) { d.data[i] = r; d.data[i + 1] = g; d.data[i + 2] = b; }
        pctx.putImageData(d, 0, 0);
      }
      pane.append(h('div', { class: 'sig-padwrap' }, pad, h('div', { class: 'sig-line' }), h('span', { class: 'sig-x' }, '×')),
        h('div', { class: 'sig-row' }, inks, h('span', { class: 'spacer' }), clr));
    } else if (mode === 'type') {
      pane.append(nameInput, h('div', { class: 'sig-row' }, inks), fontList);
      drawFonts();
      setTimeout(() => nameInput.focus());
    } else {
      const pick = h('button', { type: 'button', class: 'small-btn' }, picture ? 'Choose another…' : 'Choose a picture…');
      pick.addEventListener('click', choosePicture);
      pane.append(picBox, h('div', { class: 'sig-row' }, pick, h('label', { class: 'checkline' }, knockout, 'Remove the paper background')));
      showPicture();
    }
    refresh();
  };

  /** The signature made in the current mode, trimmed to its ink. */
  const make = (): Signature | null => {
    let src: HTMLCanvasElement | null = null;
    if (mode === 'draw' && strokes) src = pad;
    else if (mode === 'type' && nameInput.value.trim()) {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d')!;
      const px = 150;
      ctx.font = `${px}px '${font}'`;
      const w = Math.ceil(ctx.measureText(nameInput.value.trim()).width + px);
      c.width = Math.min(4000, w);
      c.height = Math.round(px * 1.9);
      ctx.font = `${px}px '${font}'`;
      ctx.fillStyle = ink;
      ctx.textBaseline = 'middle';
      ctx.fillText(nameInput.value.trim(), px / 2, c.height / 2);
      src = c;
    } else if (mode === 'image') src = imageCanvas();
    if (!src) return null;
    const out = trim(src);
    if (!out) return null;
    const label = mode === 'type' ? nameInput.value.trim() : mode === 'draw' ? 'Drawn signature' : 'Picture signature';
    return { id: `s${Date.now().toString(36)}`, name: label, png: out.toDataURL('image/png'), w: out.width, h: out.height };
  };

  const placeBtn = { label: 'Place signature', value: 'place', primary: true, disabled: () => mode === 'saved' || !ready() };
  const ready = () => (mode === 'draw' ? strokes > 0 : mode === 'type' ? !!nameInput.value.trim() : mode === 'image' ? !!picture : false);
  let refresh = () => {};
  render();
  const v = await modal('Sign', body, [{ label: 'Cancel', value: '' }, placeBtn], {
    width: 640,
    footerLeft: keepRow,
    onOpen: (close) => {
      closeFn = close;
      const btn = [...document.querySelectorAll<HTMLButtonElement>('.dialog footer .btn.primary')].pop();
      refresh = () => { if (btn) btn.disabled = !!placeBtn.disabled(); };
      refresh();
    },
  });
  if (v !== 'place') return;
  if (!result) {
    result = make();
    if (!result) return;
    if (keep.checked) {
      saved = [result, ...saved].slice(0, 8);
      await native.setSignatures(saved);
    }
  }
  await placeSignature(tab, result);
}

async function placeSignature(tab: DocTab, s: Signature) {
  const blob = await (await fetch(s.png)).blob();
  const file = new File([blob], 'signature.png', { type: 'image/png' });
  const w = PLACE_W;
  const hgt = (s.h / s.w) * w;
  const k = hgt > 90 ? 90 / hgt : 1;
  tab.addImage(file, { w: w * k, h: hgt * k });
  toast('Drag the signature into place — its corners resize it');
}

/** Crops a canvas to the bounding box of its visible pixels (with a little margin). */
function trim(src: HTMLCanvasElement) {
  const ctx = src.getContext('2d')!;
  const { width: W, height: H } = src;
  const d = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 12) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const m = 6;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
