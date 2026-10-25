// Global application state.
import { Doc } from './core/document';
import { bus } from './core/bus';
import { RGB } from './core/util';

export const APP_NAME = 'Photon';
export const SUITE_NAME = 'Crystal Suite';
export const APP_VERSION = '0.2.1';

export interface Prefs {
  theme: 'darkest' | 'dark' | 'medium' | 'light';
  historyStates: number;
  showRulers: boolean;
  showGrid: boolean;
  showGuides: boolean;
  showPixelGrid: boolean;
  snap: boolean;
  gridSize: number;
  brushCursor: 'normal' | 'full' | 'precise';
  zoomWithWheel: boolean;
  units: 'px' | 'in' | 'cm' | 'mm';
}

const PREFS_KEY = 'photon.prefs.v1';
function loadPrefs(): Prefs {
  const d: Prefs = {
    theme: 'dark', historyStates: 50, showRulers: true, showGrid: false, showGuides: true, showPixelGrid: true,
    snap: true, gridSize: 50, brushCursor: 'normal', zoomWithWheel: false, units: 'px',
  };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return d; }
}

class App {
  docs: Doc[] = [];
  doc: Doc | null = null;
  fg: RGB = { r: 0, g: 0, b: 0 };
  bg: RGB = { r: 255, g: 255, b: 255 };
  prefs: Prefs = loadPrefs();
  /** Name of the last filter run + its re-run function (Ctrl+Alt+F / Filter > Last Filter). */
  lastFilter: { name: string; run: () => void } | null = null;
  clipboard: { canvas: HTMLCanvasElement; x: number; y: number } | null = null;
  untitledCounter = 1;
  /** Magic Wand tolerance, shared with Select > Grow / Similar. */
  wandTolerance = 32;

  savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* storage unavailable */ }
  }
  setFg(c: RGB) { this.fg = { ...c }; bus.emit('colors'); }
  setBg(c: RGB) { this.bg = { ...c }; bus.emit('colors'); }
  swapColors() { [this.fg, this.bg] = [this.bg, this.fg]; bus.emit('colors'); }
  resetColors() { this.fg = { r: 0, g: 0, b: 0 }; this.bg = { r: 255, g: 255, b: 255 }; bus.emit('colors'); }

  addDoc(doc: Doc) {
    this.docs.push(doc);
    this.setActiveDoc(doc);
  }
  setActiveDoc(doc: Doc | null) {
    this.doc = doc;
    bus.emit('docs');
    bus.emit('layers', doc);
    bus.emit('history', doc);
    bus.emit('selection', doc);
    bus.emit('paths', doc);
    bus.emit('channels', doc);
    bus.emit('view', doc);
    bus.emit('render', doc);
  }
  removeDoc(doc: Doc) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    this.docs.splice(i, 1);
    if (this.doc === doc) this.setActiveDoc(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    else bus.emit('docs');
  }
}

export const app = new App();
