// Vector paths (Pen tool, Paths panel, shape outlines).

export interface PathPoint {
  x: number; y: number;
  // Absolute handle positions. When equal to the anchor, the segment side is straight.
  ix: number; iy: number;
  ox: number; oy: number;
  smooth: boolean;
}
export interface SubPath { points: PathPoint[]; closed: boolean }
export interface VectorPath { id: number; name: string; subpaths: SubPath[] }

export const pt = (x: number, y: number): PathPoint => ({ x, y, ix: x, iy: y, ox: x, oy: y, smooth: false });

export function clonePaths(p: VectorPath[]): VectorPath[] {
  return p.map((vp) => ({ id: vp.id, name: vp.name, subpaths: vp.subpaths.map((s) => ({ closed: s.closed, points: s.points.map((q) => ({ ...q })) })) }));
}

export function tracePath(ctx: CanvasRenderingContext2D | Path2D, vp: VectorPath | SubPath[]) {
  const subs = Array.isArray(vp) ? vp : vp.subpaths;
  for (const sp of subs) {
    const p = sp.points;
    if (!p.length) continue;
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) segment(ctx, p[i - 1], p[i]);
    if (sp.closed && p.length > 1) { segment(ctx, p[p.length - 1], p[0]); ctx.closePath(); }
  }
}
function segment(ctx: CanvasRenderingContext2D | Path2D, a: PathPoint, b: PathPoint) {
  if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) ctx.lineTo(b.x, b.y);
  else ctx.bezierCurveTo(a.ox, a.oy, b.ix, b.iy, b.x, b.y);
}
export function toPath2D(vp: VectorPath | SubPath[]): Path2D {
  const p = new Path2D();
  tracePath(p, vp);
  return p;
}
export function pathBounds(vp: VectorPath) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of vp.subpaths) for (const p of s.points) {
    for (const [x, y] of [[p.x, p.y], [p.ix, p.iy], [p.ox, p.oy]]) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
