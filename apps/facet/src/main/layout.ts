// Facet's saved layout (facet.json): the widgets and settings, validated on load and on every change
// that comes from a renderer.
import crypto from 'crypto';
import type { ClockWidget, FolderItem, FolderWidget, Settings, Widget } from '../shared/types';

export interface Layout { version: 1; widgets: Widget[]; settings: Settings }

export const newId = () => crypto.randomBytes(6).toString('hex');

export const DEFAULT_SETTINGS: Settings = { startup: true, lock: false, glass: 'light', labels: true, iconsHidden: false };

export function newFolder(name: string, display: string, x: number, y: number, items: FolderItem[] = []): FolderWidget {
  return { id: newId(), type: 'folder', display, x, y, name, items, style: 'tile', size: 'm', cols: 4, rows: 3, tint: '' };
}

export function newClock(display: string, x: number, y: number): ClockWidget {
  return {
    id: newId(), type: 'clock', display, x, y, face: 'minimal', font: 'system', weight: 200, color: '#ffffff', accent: '#ff9f0a',
    scale: 100, hour24: false, seconds: false, date: 'long', align: 'center', bg: 'none', shadow: true, blink: false,
  };
}

const str = (v: unknown, max = 200, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);
const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const color = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);
const id = (v: unknown) => (typeof v === 'string' && /^[a-z0-9]{4,32}$/i.test(v) ? v : newId());

export function cleanItem(v: any): FolderItem | null {
  if (!v || typeof v.path !== 'string' || !v.path) return null;
  return { id: id(v.id), path: v.path.slice(0, 2000), name: str(v.name, 200) || v.path.split(/[\\/]/).pop() || v.path };
}

export function cleanWidget(v: any): Widget | null {
  if (!v || typeof v !== 'object') return null;
  const base = { id: id(v.id), display: str(v.display, 64), x: Math.round(num(v.x, -20000, 20000, 40)), y: Math.round(num(v.y, -20000, 20000, 40)) };
  if (v.type === 'folder') {
    const items = (Array.isArray(v.items) ? v.items : []).map(cleanItem).filter(Boolean).slice(0, 500) as FolderItem[];
    return {
      ...base, type: 'folder', name: str(v.name, 60, 'Folder'), items,
      style: pick(v.style, ['tile', 'panel'] as const, 'tile'), size: pick(v.size, ['s', 'm', 'l'] as const, 'm'),
      cols: Math.round(num(v.cols, 2, 10, 4)), rows: Math.round(num(v.rows, 1, 10, 3)), tint: v.tint === '' ? '' : color(v.tint, ''),
    };
  }
  if (v.type === 'clock') {
    const d = newClock('', 0, 0);
    return {
      ...base, type: 'clock', face: pick(v.face, ['minimal', 'card', 'analog', 'stacked'] as const, d.face),
      font: pick(v.font, ['system', 'condensed', 'mono', 'serif', 'elegant', 'hand'] as const, 'system'),
      weight: Math.round(num(v.weight, 100, 900, d.weight) / 100) * 100, color: color(v.color, d.color), accent: color(v.accent, d.accent),
      scale: Math.round(num(v.scale, 40, 400, 100)), hour24: bool(v.hour24, d.hour24), seconds: bool(v.seconds, d.seconds),
      date: pick(v.date, ['none', 'short', 'long'] as const, d.date), align: pick(v.align, ['left', 'center', 'right'] as const, d.align),
      bg: pick(v.bg, ['none', 'glass', 'dark'] as const, d.bg), shadow: bool(v.shadow, d.shadow), blink: bool(v.blink, d.blink),
    };
  }
  return null;
}

export function cleanSettings(v: any): Settings {
  const d = DEFAULT_SETTINGS;
  v = v && typeof v === 'object' ? v : {};
  return {
    startup: bool(v.startup, d.startup), lock: bool(v.lock, d.lock), glass: pick(v.glass, ['light', 'dark'] as const, d.glass),
    labels: bool(v.labels, d.labels), iconsHidden: bool(v.iconsHidden, d.iconsHidden),
  };
}

export function cleanLayout(v: any): Layout {
  const widgets = (Array.isArray(v?.widgets) ? v.widgets : []).map(cleanWidget).filter(Boolean) as Widget[];
  // ids must be unique (a hand-edited file could repeat them)
  const seen = new Set<string>();
  for (const w of widgets) { if (seen.has(w.id)) w.id = newId(); seen.add(w.id); }
  return { version: 1, widgets: widgets.slice(0, 200), settings: cleanSettings(v?.settings) };
}
