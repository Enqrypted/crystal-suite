import { Emitter } from './util';

/**
 * Global event bus. Events:
 *  render(doc)      viewport needs repaint
 *  layers(doc)      layer list or layer properties changed
 *  pixels(doc)      layer pixels changed (thumbnails; throttled by listeners)
 *  selection(doc)   selection changed
 *  history(doc)     history list/index changed
 *  docs()           documents opened/closed/activated
 *  view(doc)        zoom / pan changed
 *  tool()           active tool changed
 *  colors()         foreground/background changed
 *  paths(doc)       vector paths changed
 *  channels(doc)    alpha channels / channel view changed
 *  pointer(doc,x,y) cursor moved over canvas (doc coords)
 *  options()        tool options changed elsewhere (e.g. brush size via [ ])
 */
export const bus = new Emitter();
