import { Doc } from '../core/document';
import { Layer } from '../core/layer';

/** Turn a type/shape/fill layer into a plain pixel layer (no history; caller commits). */
export function rasterize(doc: Doc, L: Layer) {
  if (L.kind === 'raster' || L.kind === 'adjustment' || L.kind === 'group') return;
  L.kind = 'raster';
  L.text = undefined;
  L.shape = undefined;
  L.fill = undefined;
  doc.ensureCoverage(L);
  L.touch();
}
