// Cut's project model: media, tracks and events (clips), plus time, gain and fade helpers.
// Times are in seconds. Like Vegas, video and audio live on separate tracks; a video file with sound
// becomes a grouped pair of events (one on a video track, one on an audio track).

export type TrackKind = 'video' | 'audio';
export type MediaKind = 'video' | 'audio' | 'image';
export type FadeCurve = 'smooth' | 'linear' | 'fast' | 'slow';
export type TransitionKind = 'crossfade' | 'dip' | 'wipe-left' | 'wipe-right' | 'slide-left' | 'push-up';
export type GeneratorKind = 'text' | 'solid' | 'gradient';

export interface MediaItem {
  id: string;
  path: string;
  name: string;
  kind: MediaKind;
  /** Seconds; 0 for still images (they can be stretched to any length). */
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  sampleRate: number;
  channels: number;
  size: number;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  mute: boolean;
  solo: boolean;
  /** Audio: linear gain (1 = 0 dB). Video: composite level / opacity (0..1). */
  volume: number;
  /** Audio pan, -1 (left) .. 1 (right). */
  pan: number;
  height: number;
  color: number;
}

export interface Fx {
  brightness: number; // 1 = unchanged
  contrast: number;
  saturation: number;
  hue: number; // degrees
  blur: number; // pixels at 1080p
  grayscale: number; // 0..1
  sepia: number;
  invert: number;
}

export interface PanCrop {
  x: number; // offset as a fraction of the frame width (0 = centred)
  y: number;
  scale: number; // 1 = fit to frame
  rotation: number; // degrees
  cropLeft: number; // fractions of the source
  cropTop: number;
  cropRight: number;
  cropBottom: number;
}

export interface TextProps {
  text: string;
  font: string;
  size: number; // fraction of the frame height
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  x: number; // anchor position, 0..1
  y: number;
  outline: number; // fraction of the font size
  outlineColor: string;
  shadow: boolean;
  box: boolean;
  boxColor: string;
}

export interface Clip {
  id: string;
  trackId: string;
  mediaId?: string;
  generator?: GeneratorKind;
  name: string;
  start: number;
  length: number;
  /** In-point in the media ("take offset"). */
  offset: number;
  /** Playback rate (1 = normal). */
  speed: number;
  /** Audio: linear gain (1 = 0 dB). Video: opacity 0..1. */
  gain: number;
  fadeIn: number;
  fadeOut: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
  mute: boolean;
  groupId?: string;
  /** How this clip enters when it overlaps the previous clip on its track. */
  transition: TransitionKind;
  // video
  fx: Fx;
  panCrop: PanCrop;
  /** Optional end state for an animated pan/crop ("Ken Burns"). */
  panCropEnd?: PanCrop;
  // audio
  pan: number;
  // generators
  text?: TextProps;
  color?: string;
  color2?: string;
}

export interface Marker {
  id: string;
  time: number;
  name: string;
}

export interface Project {
  version: 1;
  name: string;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  /** Time selection / loop region. */
  loop: { start: number; end: number } | null;
  masterVolume: number;
}

// ---------- factories ----------
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const TRACK_COLORS = ['#6f7cf0', '#3fb7a6', '#e0954a', '#d4628f', '#8fbf4d', '#b07ff0', '#4aa7e0', '#d9c04a'];

export const defaultFx = (): Fx => ({ brightness: 1, contrast: 1, saturation: 1, hue: 0, blur: 0, grayscale: 0, sepia: 0, invert: 0 });
export const defaultPanCrop = (): PanCrop => ({ x: 0, y: 0, scale: 1, rotation: 0, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 });
export const defaultText = (): TextProps => ({
  text: 'Sample Text', font: 'Segoe UI', size: 0.1, color: '#ffffff', bold: true, italic: false, align: 'center',
  x: 0.5, y: 0.5, outline: 0, outlineColor: '#000000', shadow: true, box: false, boxColor: 'rgba(0,0,0,0.55)',
});

export function newProject(name = 'Untitled'): Project {
  return {
    version: 1, name, width: 1920, height: 1080, fps: 30, sampleRate: 48000,
    media: [], tracks: [newTrack('video', 1, 0), newTrack('audio', 1, 1)], clips: [], markers: [], loop: null, masterVolume: 1,
  };
}

export function newTrack(kind: TrackKind, n: number, color: number): Track {
  return {
    id: uid(), kind, name: kind === 'video' ? `Video ${n}` : `Audio ${n}`, mute: false, solo: false,
    volume: 1, pan: 0, height: kind === 'video' ? 74 : 62, color: color % TRACK_COLORS.length,
  };
}

export function newClip(init: Partial<Clip> & Pick<Clip, 'trackId' | 'start' | 'length'>): Clip {
  return {
    id: uid(), name: '', offset: 0, speed: 1, gain: 1, fadeIn: 0, fadeOut: 0, fadeInCurve: 'smooth', fadeOutCurve: 'smooth',
    mute: false, transition: 'crossfade', fx: defaultFx(), panCrop: defaultPanCrop(), pan: 0, ...init,
  };
}

// ---------- queries ----------
export const clipEnd = (c: Clip) => c.start + c.length;
export const trackOf = (p: Project, c: Clip) => p.tracks.find((t) => t.id === c.trackId);
export const mediaOf = (p: Project, c: Clip) => (c.mediaId ? p.media.find((m) => m.id === c.mediaId) : undefined);
export const projectEnd = (p: Project) => p.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0);
export function clipsOnTrack(p: Project, trackId: string) {
  return p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
/** The longest a clip can be given its media and in-point (Infinity for stills and generators). */
export function maxLength(p: Project, c: Clip) {
  const m = mediaOf(p, c);
  if (!m || m.kind === 'image') return Infinity;
  return Math.max(0, (m.duration - c.offset) / c.speed);
}
export const isVisual = (p: Project, c: Clip) => trackOf(p, c)?.kind === 'video';

/** Tracks that are heard/seen, honouring mute and solo. */
export function audibleTrack(p: Project, t: Track) {
  if (t.mute) return false;
  const anySolo = p.tracks.some((x) => x.kind === t.kind && x.solo);
  return !anySolo || t.solo;
}

/**
 * Overlaps with the neighbouring clips on the same track. An overlap is a crossfade/transition:
 * the earlier clip fades out across it while the later one fades in.
 */
export interface Overlaps { before: number; after: number; prev?: Clip; next?: Clip }
export function overlapMap(p: Project): Map<string, Overlaps> {
  const map = new Map<string, Overlaps>();
  for (const t of p.tracks) {
    const list = clipsOnTrack(p, t.id);
    for (let i = 0; i < list.length; i++) map.set(list[i].id, { before: 0, after: 0 });
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const ov = Math.min(clipEnd(a), clipEnd(b)) - b.start;
      if (ov > 1e-6 && clipEnd(b) > clipEnd(a) - 1e-6) {
        map.get(a.id)!.after = ov;
        map.get(a.id)!.next = b;
        map.get(b.id)!.before = ov;
        map.get(b.id)!.prev = a;
      }
    }
  }
  return map;
}

// ---------- gain and fades ----------
export const dbToGain = (db: number) => (db <= -96 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));
export function formatDb(g: number) {
  const db = gainToDb(g);
  if (!isFinite(db)) return '-inf dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** Fade shape: maps progress 0..1 to a level 0..1. */
export function curve(x: number, kind: FadeCurve) {
  x = Math.max(0, Math.min(1, x));
  switch (kind) {
    case 'linear': return x;
    case 'fast': return 1 - (1 - x) * (1 - x); // rises quickly
    case 'slow': return x * x; // rises slowly
    default: return 0.5 - 0.5 * Math.cos(Math.PI * x); // smooth (S-curve)
  }
}

/**
 * Envelope level of a clip at timeline time `t` from its own fades (crossfades are handled by the
 * caller, which knows the neighbouring clip).
 */
export function fadeLevel(c: Clip, t: number, fadeIn = c.fadeIn, fadeOut = c.fadeOut) {
  let v = 1;
  const local = t - c.start;
  if (fadeIn > 0 && local < fadeIn) v *= curve(local / fadeIn, c.fadeInCurve);
  const toEnd = c.start + c.length - t;
  if (fadeOut > 0 && toEnd < fadeOut) v *= curve(toEnd / fadeOut, c.fadeOutCurve);
  return v;
}

/** Media time shown/heard at timeline time `t`. */
export const sourceTime = (c: Clip, t: number) => c.offset + (t - c.start) * c.speed;

export function lerpPanCrop(a: PanCrop, b: PanCrop | undefined, k: number): PanCrop {
  if (!b) return a;
  const l = (x: number, y: number) => x + (y - x) * k;
  return {
    x: l(a.x, b.x), y: l(a.y, b.y), scale: l(a.scale, b.scale), rotation: l(a.rotation, b.rotation),
    cropLeft: l(a.cropLeft, b.cropLeft), cropTop: l(a.cropTop, b.cropTop), cropRight: l(a.cropRight, b.cropRight), cropBottom: l(a.cropBottom, b.cropBottom),
  };
}

export const snapToFrame = (t: number, fps: number) => Math.round(t * fps) / fps;
