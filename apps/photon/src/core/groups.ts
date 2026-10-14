// Layer groups. doc.layers stays a flat bottom→top list; each layer's parentId names its group,
// and a group's contents always sit directly below the group entry (like PSD section dividers).
import type { Doc } from './document';
import type { Layer } from './layer';

export interface LayerNode { layer: Layer; children: LayerNode[] }

/** Tree of `layers` (any subset); layers whose group isn't in the list become roots. */
export function buildTree(layers: Layer[]): LayerNode[] {
  const nodes = new Map<number, LayerNode>();
  for (const L of layers) nodes.set(L.id, { layer: L, children: [] });
  const roots: LayerNode[] = [];
  for (const L of layers) {
    const n = nodes.get(L.id)!;
    const p = L.parentId ? nodes.get(L.parentId) : undefined;
    if (p && p.layer.kind === 'group' && p !== n) p.children.push(n);
    else roots.push(n);
  }
  return roots;
}

export function flattenTree(nodes: LayerNode[], out: Layer[] = []): Layer[] {
  for (const n of nodes) {
    if (n.layer.kind === 'group') flattenTree(n.children, out);
    out.push(n.layer);
  }
  return out;
}

/** Fix dangling/cyclic parents and reorder so every group's contents sit directly below it. */
export function normalizeLayers(doc: Doc) {
  const byId = new Map(doc.layers.map((l) => [l.id, l]));
  for (const L of doc.layers) {
    const p = L.parentId ? byId.get(L.parentId) : undefined;
    if (L.parentId && (!p || p.kind !== 'group')) L.parentId = 0;
  }
  // break cycles
  for (const L of doc.layers) {
    const seen = new Set<number>([L.id]);
    let cur = L;
    while (cur.parentId) {
      if (seen.has(cur.parentId)) { L.parentId = 0; break; }
      seen.add(cur.parentId);
      cur = byId.get(cur.parentId)!;
    }
  }
  const out = flattenTree(buildTree(doc.layers));
  // a Background layer stays at the very bottom of the stack
  const bg = out.findIndex((l) => l.isBackground);
  if (bg > 0) { const [b] = out.splice(bg, 1); b.parentId = 0; out.unshift(b); }
  doc.layers = out;
}

export const isGroup = (L: Layer | null | undefined): L is Layer => !!L && L.kind === 'group';
export function parentOf(doc: Doc, L: Layer): Layer | null { return L.parentId ? doc.byId(L.parentId) : null; }
export function ancestors(doc: Doc, L: Layer): Layer[] {
  const out: Layer[] = [];
  let p = parentOf(doc, L);
  while (p && out.length < 64) { out.push(p); p = parentOf(doc, p); }
  return out;
}
export const depthOf = (doc: Doc, L: Layer) => ancestors(doc, L).length;
export function isInside(doc: Doc, L: Layer, G: Layer): boolean {
  return ancestors(doc, L).includes(G);
}
/** All layers inside group G (any depth), in document order. */
export function descendants(doc: Doc, G: Layer): Layer[] {
  if (G.kind !== 'group') return [];
  return doc.layers.filter((l) => l !== G && isInside(doc, l, G));
}
/** The group plus its contents, in document order (bottom→top). */
export function block(doc: Doc, L: Layer): Layer[] { return [...descendants(doc, L), L]; }
/** Visible including every enclosing group. */
export function isVisibleDeep(doc: Doc, L: Layer): boolean {
  return L.visible && ancestors(doc, L).every((a) => a.visible);
}
/** Siblings of L (same parent) in document order. */
export function siblings(doc: Doc, L: Layer): Layer[] { return doc.layers.filter((l) => l.parentId === L.parentId); }
/** Selected layers without those already covered by a selected ancestor group. */
export function topLevelSelection(doc: Doc): Layer[] {
  const sel = doc.selectedLayers;
  return sel.filter((l) => !ancestors(doc, l).some((a) => sel.includes(a)));
}
