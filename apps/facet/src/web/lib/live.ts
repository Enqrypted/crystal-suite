// Live data for the Spotify, Control Center and recent-folders widgets, pushed by the main process.
import type { MediaState, RecentFolder, SysState, Track } from '../../shared/types';
import { api } from './api';

export const live = {
  media: { spotify: null, current: null } as MediaState,
  sys: null as SysState | null,
  recent: [] as RecentFolder[],
};

type Kind = keyof typeof live;
const subs: Record<Kind, Set<() => void>> = { media: new Set(), sys: new Set(), recent: new Set() };

export function onLive(kind: Kind, fn: () => void) {
  subs[kind].add(fn);
  return () => { subs[kind].delete(fn); };
}

const emit = (kind: Kind) => subs[kind].forEach((f) => f());

export function initLive(init: { media?: MediaState; sys?: SysState | null; recent?: RecentFolder[] }) {
  if (init.media) live.media = init.media;
  if (init.sys) live.sys = init.sys;
  if (init.recent) live.recent = init.recent;
  api.onMedia((m) => { live.media = m; emit('media'); });
  api.onSys((s) => { live.sys = s; emit('sys'); });
  api.onRecent((r) => { live.recent = r; emit('recent'); });
}

/** The player a widget follows. */
export const trackFor = (source: 'spotify' | 'any'): Track | null => (source === 'spotify' ? live.media.spotify : live.media.current ?? live.media.spotify);

/** Where the track is now (ms), counting time since the player last reported it. */
export function positionOf(t: Track) {
  const p = t.status === 'Playing' ? t.position + (Date.now() - t.updated) : t.position;
  return Math.max(0, t.duration > 0 ? Math.min(t.duration, p) : p);
}

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function ago(ms: number) {
  const d = Date.now() - ms;
  const min = Math.round(d / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const date = new Date(ms);
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return 'Yesterday';
  if (d < 6 * 86400000) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
