import { registerTools, setTool } from './tool';
import { HandTool, ZoomTool } from './nav';
import { MarqueeTool, LassoTool, MagicWandTool, QuickSelectTool } from './select';
import { MoveTool, TransformTool, CropTool } from './transform';
import {
  BrushTool, PencilTool, ColorReplaceTool, EraserTool, MagicEraserTool, HistoryBrushTool, CloneStampTool, HealTool,
  SpotHealTool, RedEyeTool, BlurTool, SharpenTool, SmudgeTool, DodgeBurnTool, SpongeTool,
} from './paint';
import { EyedropperTool, RulerTool, GradientTool, BucketTool } from './misc';
import { TypeTool } from './type';
import { ShapeTool } from './shape';
import { PenTool, FreeformPenTool, AnchorTool, DirectSelectTool } from './pen';
import { PatchTool, BackgroundEraserTool, PatternStampTool, ColorSamplerTool } from './extra';
import { WarpTool } from './warp';

export function initTools() {
  registerTools([
    new MoveTool(),
    new MarqueeTool('marquee-rect', 'Rectangular Marquee Tool', 'marquee-rect', 'rect'),
    new MarqueeTool('marquee-ellipse', 'Elliptical Marquee Tool', 'marquee-ellipse', 'ellipse'),
    new MarqueeTool('marquee-row', 'Single Row Marquee Tool', 'marquee-row', 'row'),
    new MarqueeTool('marquee-col', 'Single Column Marquee Tool', 'marquee-col', 'col'),
    new LassoTool('lasso', 'Lasso Tool', 'lasso', 'free'),
    new LassoTool('lasso-poly', 'Polygonal Lasso Tool', 'lasso-poly', 'poly'),
    new LassoTool('lasso-magnetic', 'Magnetic Lasso Tool', 'lasso-magnetic', 'magnetic'),
    new QuickSelectTool(),
    new MagicWandTool(),
    new CropTool(),
    new EyedropperTool(),
    new ColorSamplerTool(),
    new RulerTool(),
    new SpotHealTool(),
    new HealTool(),
    new PatchTool(),
    new RedEyeTool(),
    new BrushTool(),
    new PencilTool(),
    new ColorReplaceTool(),
    new CloneStampTool(),
    new PatternStampTool(),
    new HistoryBrushTool(),
    new EraserTool(),
    new BackgroundEraserTool(),
    new MagicEraserTool(),
    new GradientTool(),
    new BucketTool(),
    new BlurTool(),
    new SharpenTool(),
    new SmudgeTool(),
    new DodgeBurnTool('dodge', 'Dodge Tool', 'dodge', false),
    new DodgeBurnTool('burn', 'Burn Tool', 'burn', true),
    new SpongeTool(),
    new PenTool(),
    new FreeformPenTool(),
    new AnchorTool('add-anchor', 'Add Anchor Point Tool', 'add-anchor', 'add'),
    new AnchorTool('delete-anchor', 'Delete Anchor Point Tool', 'delete-anchor', 'delete'),
    new AnchorTool('convert-point', 'Convert Point Tool', 'convert-point', 'convert'),
    new TypeTool(),
    new DirectSelectTool(true),
    new DirectSelectTool(false),
    new ShapeTool('shape-rect', 'Rectangle Tool', 'shape-rect', 'rect'),
    new ShapeTool('shape-ellipse', 'Ellipse Tool', 'shape-ellipse', 'ellipse'),
    new ShapeTool('shape-triangle', 'Triangle Tool', 'shape-triangle', 'triangle'),
    new ShapeTool('shape-polygon', 'Polygon Tool', 'shape-polygon', 'polygon'),
    new ShapeTool('shape-line', 'Line Tool', 'shape-line', 'line'),
    new ShapeTool('shape-custom', 'Custom Shape Tool', 'shape-custom', 'custom'),
    new HandTool(),
    new ZoomTool(),
    new TransformTool(),
    new WarpTool(),
  ], [
    'move', 'marquee', 'lasso', 'wand', 'crop', null,
    'eyedropper', 'heal', 'brush', 'clone', 'history', 'eraser', 'gradient', 'blur', 'dodge', null,
    'pen', 'type', 'path-select', 'shape', null,
    'hand', 'zoom',
  ]);
  setTool('brush');
}
