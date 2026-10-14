import { Tool, PointerInfo } from './tool';
import type { Viewport } from '../ui/viewport';
import { h } from '../ui/dom';
import { button } from '../ui/widgets';
import { toolHeader, sep, check } from '../ui/optbits';
import { rectFromPoints } from '../core/util';

function viewButtons(v: () => Viewport) {
  return [
    button('100%', () => v().actualPixels(), { small: true }),
    button('Fit Screen', () => v().fit(), { small: true }),
    button('Fill Screen', () => v().fillScreen(), { small: true }),
  ];
}
let viewportRef: Viewport | null = null;
export const setNavViewport = (v: Viewport) => { viewportRef = v; };

export class HandTool extends Tool {
  id = 'hand'; name = 'Hand Tool'; icon = 'hand'; key = 'H'; group = 'hand';
  private last: { x: number; y: number } | null = null;
  cursor() { return this.last ? 'grabbing' : 'grab'; }
  buildOptions() { return h('div', { class: 'opt-group' }, toolHeader(this.icon), ...viewButtons(() => viewportRef!)); }
  down(p: PointerInfo) { this.last = { x: p.sx, y: p.sy }; }
  move(p: PointerInfo, v: Viewport) {
    if (!this.last) return;
    v.panBy(p.sx - this.last.x, p.sy - this.last.y);
    this.last = { x: p.sx, y: p.sy };
  }
  up() { this.last = null; }
}

export class ZoomTool extends Tool {
  id = 'zoom'; name = 'Zoom Tool'; icon = 'zoom'; key = 'Z'; group = 'zoom';
  zoomOut = false;
  scrubby = true;
  private start: PointerInfo | null = null;
  private cur: PointerInfo | null = null;
  private startZoom = 1;
  cursor(p?: PointerInfo | null) { return (p?.alt ?? false) !== this.zoomOut ? 'zoom-out' : 'zoom-in'; }
  buildOptions() {
    return h('div', { class: 'opt-group' }, toolHeader(this.icon),
      button('Zoom In', () => { this.zoomOut = false; }, { small: true }),
      button('Zoom Out', () => { this.zoomOut = true; }, { small: true }),
      sep(), check('Scrubby Zoom', () => this.scrubby, (v) => { this.scrubby = v; }), sep(),
      ...viewButtons(() => viewportRef!));
  }
  down(p: PointerInfo, v: Viewport) { this.start = p; this.cur = p; this.startZoom = v.doc!.zoom; }
  move(p: PointerInfo, v: Viewport) {
    if (!this.start) return;
    this.cur = p;
    if (this.scrubby && Math.abs(p.sx - this.start.sx) > 3) {
      v.setZoom(this.startZoom * Math.exp((p.sx - this.start.sx) / 150), this.start.sx, this.start.sy);
    }
  }
  up(p: PointerInfo, v: Viewport) {
    const s = this.start;
    this.start = null;
    if (!s) return;
    const dragged = Math.abs(p.sx - s.sx) > 4 || Math.abs(p.sy - s.sy) > 4;
    if (dragged && !this.scrubby) {
      const r = rectFromPoints(s.x, s.y, p.x, p.y);
      const z = Math.min(v.w / r.w, v.h / r.h);
      v.setZoom(z);
      v.centerOn(r.x + r.w / 2, r.y + r.h / 2);
    } else if (!dragged) {
      v.zoomStep((p.alt !== this.zoomOut) ? -1 : 1, p.sx, p.sy);
    }
  }
  overlay(ctx: CanvasRenderingContext2D) {
    if (!this.start || !this.cur || this.scrubby) return;
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.min(this.start.sx, this.cur.sx) + 0.5, Math.min(this.start.sy, this.cur.sy) + 0.5, Math.abs(this.cur.sx - this.start.sx), Math.abs(this.cur.sy - this.start.sy));
    ctx.setLineDash([]);
  }
}
