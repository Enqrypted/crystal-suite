// Image adjustments registry. Each adjustment is a pure per-pixel function plus a UI builder,
// shared by Image > Adjustments dialogs (destructive) and adjustment layers (non-destructive).

export interface AdjustUIContext {
  /** Pixels the adjustment applies to (for histograms / auto buttons). May be null. */
  source: () => ImageData | null;
}

export interface AdjustmentDef {
  kind: string;
  name: string;
  /** icon id from ui/icons (Adjustments panel) */
  icon: string;
  shortcut?: string;
  defaults(): any;
  /** Apply in place to RGBA data (unpremultiplied). Must leave alpha untouched. */
  apply(data: Uint8ClampedArray, params: any): void;
  /** Controls for Properties panel and dialogs. Call onChange(newParams) with a NEW object on every change. */
  buildUI(params: any, onChange: (p: any) => void, ctx: AdjustUIContext): HTMLElement;
  /** Applies immediately from the Image menu with no dialog (Invert, Desaturate...). */
  noDialog?: boolean;
  /** Not offered as an adjustment layer (e.g. Desaturate, Equalize). */
  noLayer?: boolean;
}

export const ADJUSTMENTS: AdjustmentDef[] = [];

export function registerAdjustment(def: AdjustmentDef) {
  const i = ADJUSTMENTS.findIndex((d) => d.kind === def.kind);
  if (i >= 0) ADJUSTMENTS[i] = def; else ADJUSTMENTS.push(def);
}
export function getAdjustment(kind: string): AdjustmentDef | undefined {
  return ADJUSTMENTS.find((d) => d.kind === kind);
}
