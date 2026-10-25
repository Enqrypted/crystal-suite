import { createCanvas, ctx2d, RGB, uid } from './util';
import type { Pattern } from './patterns';

export type LayerKind = 'raster' | 'text' | 'shape' | 'adjustment' | 'fill' | 'group';

export type BlendMode =
  | 'pass-through' | 'normal' | 'dissolve'
  | 'darken' | 'multiply' | 'color-burn' | 'linear-burn' | 'darker-color'
  | 'lighten' | 'screen' | 'color-dodge' | 'linear-dodge' | 'lighter-color'
  | 'overlay' | 'soft-light' | 'hard-light' | 'vivid-light' | 'linear-light' | 'pin-light' | 'hard-mix'
  | 'difference' | 'exclusion' | 'subtract' | 'divide'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

/** Blend modes grouped the way Photoshop lists them ('-' = separator). */
export const BLEND_MODES: (BlendMode | '-')[] = [
  'normal', 'dissolve', '-',
  'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color', '-',
  'lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color', '-',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix', '-',
  'difference', 'exclusion', 'subtract', 'divide', '-',
  'hue', 'saturation', 'color', 'luminosity',
];
export const BLEND_NAMES: Record<BlendMode, string> = {
  'pass-through': 'Pass Through', normal: 'Normal', dissolve: 'Dissolve', darken: 'Darken', multiply: 'Multiply', 'color-burn': 'Color Burn',
  'linear-burn': 'Linear Burn', 'darker-color': 'Darker Color', lighten: 'Lighten', screen: 'Screen',
  'color-dodge': 'Color Dodge', 'linear-dodge': 'Linear Dodge (Add)', 'lighter-color': 'Lighter Color',
  overlay: 'Overlay', 'soft-light': 'Soft Light', 'hard-light': 'Hard Light', 'vivid-light': 'Vivid Light',
  'linear-light': 'Linear Light', 'pin-light': 'Pin Light', 'hard-mix': 'Hard Mix', difference: 'Difference',
  exclusion: 'Exclusion', subtract: 'Subtract', divide: 'Divide', hue: 'Hue', saturation: 'Saturation',
  color: 'Color', luminosity: 'Luminosity',
};

// ----- Layer data payloads. Treated as immutable values: replace, never mutate. -----
export interface TextData {
  text: string;
  font: string;        // family
  style: string;       // 'Regular' | 'Bold' | 'Italic' | 'Bold Italic'
  size: number;        // px
  color: RGB;
  align: 'left' | 'center' | 'right';
  leading: number;     // line height multiplier
  tracking: number;    // letter spacing in 1/1000 em
  underline?: boolean;
  strike?: boolean;
  allCaps?: boolean;
  fauxBold?: boolean;
  fauxItalic?: boolean;
  antialias?: boolean;
  boxWidth?: number;   // paragraph text width (0/undefined = point text)
  boxHeight?: number;  // paragraph text height: lines that don't fit are hidden (undefined = grows with the text)
  /** canvas padding used at last render (layer.x + pad = text box left) */
  pad?: number;
}

export type ShapeType = 'rect' | 'ellipse' | 'triangle' | 'polygon' | 'line' | 'custom';
export interface ShapeData {
  type: ShapeType;
  w: number; h: number;
  fill: RGB | null;
  stroke: RGB | null;
  strokeWidth: number;
  radius?: number;     // rect corner radius
  sides?: number;      // polygon sides
  star?: number;       // star indent 0..1 (0 = no star)
  custom?: string;     // custom shape id
  x1?: number; y1?: number; x2?: number; y2?: number; // line endpoints (relative)
  rotation?: number;
  /** canvas padding used at last render (layer.x + pad = shape box left) */
  pad?: number;
}

export interface GradientStop { pos: number; color: RGB; opacity: number }
export interface Gradient { name?: string; stops: GradientStop[] }
export type GradientStyle = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

export type FillData =
  | { type: 'solid'; color: RGB }
  | { type: 'gradient'; gradient: Gradient; style: GradientStyle; angle: number; scale: number; reverse: boolean }
  /** scale in % (100 = the pattern's own size) */
  | { type: 'pattern'; pattern: Pattern; scale: number };

export type BevelStyle = 'inner' | 'outer' | 'emboss' | 'pillow';

export interface AdjustmentData { kind: string; params: any }

export interface LayerStyle {
  dropShadow?: { enabled: boolean; color: RGB; opacity: number; angle: number; distance: number; spread: number; size: number; blend: BlendMode };
  innerShadow?: { enabled: boolean; color: RGB; opacity: number; angle: number; distance: number; choke: number; size: number; blend: BlendMode };
  outerGlow?: { enabled: boolean; color: RGB; opacity: number; spread: number; size: number; blend: BlendMode };
  innerGlow?: { enabled: boolean; color: RGB; opacity: number; choke: number; size: number; blend: BlendMode };
  stroke?: { enabled: boolean; color: RGB; opacity: number; size: number; position: 'outside' | 'inside' | 'center'; blend: BlendMode };
  colorOverlay?: { enabled: boolean; color: RGB; opacity: number; blend: BlendMode };
  gradientOverlay?: { enabled: boolean; gradient: Gradient; opacity: number; angle: number; style: GradientStyle; scale: number; reverse: boolean; blend: BlendMode };
  /** scale in % */
  patternOverlay?: { enabled: boolean; pattern: Pattern; opacity: number; scale: number; blend: BlendMode };
  satin?: { enabled: boolean; color: RGB; opacity: number; angle: number; distance: number; size: number; invert: boolean; blend: BlendMode };
  /**
   * depth in % (1..1000), size / soften px, angle / altitude in degrees. `opacity` is the highlight's
   * (the effect counts as on when either part shows).
   */
  bevel?: {
    enabled: boolean; style: BevelStyle; technique: 'smooth' | 'chisel'; depth: number; up: boolean; size: number; soften: number;
    angle: number; altitude: number;
    highlightColor: RGB; opacity: number; highlightBlend: BlendMode;
    shadowColor: RGB; shadowOpacity: number; shadowBlend: BlendMode;
  };
}

export interface LayerSnapshot {
  layer: Layer;
  name: string; kind: LayerKind;
  canvas: HTMLCanvasElement; x: number; y: number;
  visible: boolean; opacity: number; fillOpacity: number; blend: BlendMode;
  lockAlpha: boolean; lockPixels: boolean; lockPosition: boolean; lockAll: boolean;
  mask: HTMLCanvasElement | null; maskX: number; maskY: number; maskEnabled: boolean;
  clipped: boolean;
  parentId: number;
  collapsed: boolean;
  style: LayerStyle | null;
  text?: TextData; shape?: ShapeData; fill?: FillData; adjustment?: AdjustmentData;
  color: string;
  isBackground: boolean;
}

/**
 * A layer owns a canvas positioned at (x, y) in document space.
 * Raster layers always cover the whole document rect (invariant maintained by Doc.ensureCoverage).
 * Masks are alpha canvases (alpha = reveal) positioned at (maskX, maskY).
 */
export class Layer {
  id = uid();
  name: string;
  kind: LayerKind = 'raster';
  canvas: HTMLCanvasElement;
  x = 0; y = 0;
  visible = true;
  opacity = 1;
  fillOpacity = 1;
  blend: BlendMode = 'normal';
  lockAlpha = false;
  lockPixels = false;
  lockPosition = false;
  lockAll = false;
  mask: HTMLCanvasElement | null = null;
  maskX = 0; maskY = 0;
  maskEnabled = true;
  clipped = false;
  /** Containing group's id (0 = top level). Group contents sit directly below the group in doc.layers. */
  parentId = 0;
  /** Group is collapsed in the Layers panel. */
  collapsed = false;
  style: LayerStyle | null = null;
  text?: TextData;
  shape?: ShapeData;
  fill?: FillData;
  adjustment?: AdjustmentData;
  /** Layer label color in the Layers panel ('' = none). */
  color = '';
  /** Live preview canvas (filter / adjustment dialogs). Replaces `canvas` when rendering. */
  preview: HTMLCanvasElement | null = null;
  /** Bumped whenever pixels change, for thumbnails and effect caches. */
  version = 0;
  isBackground = false;
  /** Transient: hidden from compositing while edited in place (type tool). */
  editing = false;

  constructor(name: string, w: number, h: number) {
    this.name = name;
    this.canvas = createCanvas(w, h);
  }

  get ctx() { return ctx2d(this.canvas); }
  get editable() { return !this.lockAll && !this.lockPixels; }
  get movable() { return !this.lockAll && !this.lockPosition; }
  get isPixel() { return this.kind === 'raster'; }
  touch() { this.version++; }

  snapshot(): LayerSnapshot {
    return {
      layer: this, name: this.name, kind: this.kind, canvas: this.canvas, x: this.x, y: this.y,
      visible: this.visible, opacity: this.opacity, fillOpacity: this.fillOpacity, blend: this.blend,
      lockAlpha: this.lockAlpha, lockPixels: this.lockPixels, lockPosition: this.lockPosition, lockAll: this.lockAll,
      mask: this.mask, maskX: this.maskX, maskY: this.maskY, maskEnabled: this.maskEnabled, clipped: this.clipped,
      parentId: this.parentId, collapsed: this.collapsed,
      style: this.style, text: this.text, shape: this.shape, fill: this.fill, adjustment: this.adjustment,
      color: this.color, isBackground: this.isBackground,
    };
  }
  restore(s: LayerSnapshot) {
    const pixelsChanged = s.canvas !== this.canvas || s.x !== this.x || s.y !== this.y || s.mask !== this.mask;
    this.name = s.name; this.kind = s.kind; this.canvas = s.canvas; this.x = s.x; this.y = s.y;
    this.visible = s.visible; this.opacity = s.opacity; this.fillOpacity = s.fillOpacity; this.blend = s.blend;
    this.lockAlpha = s.lockAlpha; this.lockPixels = s.lockPixels; this.lockPosition = s.lockPosition; this.lockAll = s.lockAll;
    this.mask = s.mask; this.maskX = s.maskX; this.maskY = s.maskY; this.maskEnabled = s.maskEnabled; this.clipped = s.clipped;
    this.style = s.style; this.text = s.text; this.shape = s.shape; this.fill = s.fill; this.adjustment = s.adjustment;
    this.color = s.color;
    this.isBackground = s.isBackground ?? false;
    this.parentId = s.parentId ?? 0;
    this.collapsed = s.collapsed ?? false;
    this.preview = null;
    if (pixelsChanged) this.touch(); else this.version++;
  }
}
