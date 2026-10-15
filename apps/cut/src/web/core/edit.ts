// Editing operations (each one undoable): adding media, splitting, deleting with ripple, copy/paste,
// tracks, markers, generators, grouping and normalising.
import { store } from './store';
import { media } from './media';
import {
  clipEnd, clipsOnTrack, defaultText, dbToGain, lerpPanCrop, maxLength, newClip, newTrack, snapToFrame, uid,
  type Clip, type GeneratorKind, type MediaItem, type Project, type Track, type TrackKind,
} from './model';

export const STILL_LENGTH = 5;
const EPS = 1e-6;

export const tracksOf = (p: Project, kind: TrackKind) => p.tracks.filter((t) => t.kind === kind);
const q = (t: number) => (store.view.quantize ? snapToFrame(t, store.project.fps) : t);

/** Grouped clips move, trim, split and delete together. */
export function withGroups(p: Project, ids: Iterable<string>) {
  const set = new Set(ids);
  const groups = new Set(p.clips.filter((c) => set.has(c.id) && c.groupId).map((c) => c.groupId));
  for (const c of p.clips) if (c.groupId && groups.has(c.groupId)) set.add(c.id);
  return set;
}

function addTrackTo(p: Project, kind: TrackKind, afterId?: string): Track {
  const n = tracksOf(p, kind).length + 1;
  const t = newTrack(kind, n, p.tracks.length);
  if (kind === 'video') {
    // video tracks stay above audio tracks
    const after = afterId ? p.tracks.findIndex((x) => x.id === afterId && x.kind === 'video') : -1;
    const lastVideo = p.tracks.map((x) => x.kind).lastIndexOf('video');
    p.tracks.splice(after >= 0 ? after + 1 : lastVideo + 1, 0, t);
  } else {
    const after = afterId ? p.tracks.findIndex((x) => x.id === afterId && x.kind === 'audio') : -1;
    p.tracks.splice(after >= 0 ? after + 1 : p.tracks.length, 0, t);
  }
  return t;
}

/** Picks the video and audio tracks for media dropped on `trackId` (creating them if needed). */
function targetTracks(p: Project, trackId: string | null | undefined) {
  const t = p.tracks.find((x) => x.id === trackId);
  const videos = tracksOf(p, 'video');
  const audios = tracksOf(p, 'audio');
  let video: Track | undefined;
  let audioT: Track | undefined;
  if (t?.kind === 'video') {
    video = t;
    audioT = audios[Math.min(videos.indexOf(t), audios.length - 1)] ?? audios[0];
  } else if (t?.kind === 'audio') {
    audioT = t;
    video = videos[Math.min(audios.indexOf(t), videos.length - 1)] ?? videos[0];
  } else {
    video = videos[0];
    audioT = audios[0];
  }
  return {
    video: () => (video ??= addTrackTo(p, 'video')),
    audio: () => (audioT ??= addTrackTo(p, 'audio')),
  };
}

/** Places media on the timeline one after another from `at`. Returns the new clip ids. */
export function addMedia(items: MediaItem[], at: number, trackId?: string | null): string[] {
  const created: string[] = [];
  store.commit(items.length === 1 ? `Add ${items[0].name}` : 'Add Media', (p) => {
    const tracks = targetTracks(p, trackId);
    let cursor = q(at);
    for (const item of items) {
      if (!p.media.some((m) => m.id === item.id)) p.media.push(item);
      const length = item.kind === 'image' ? STILL_LENGTH : item.duration;
      const groupId = item.hasVideo && item.hasAudio ? uid() : undefined;
      if (item.hasVideo) {
        const c = newClip({ trackId: tracks.video().id, mediaId: item.id, name: item.name, start: cursor, length, groupId });
        p.clips.push(c);
        created.push(c.id);
      }
      if (item.hasAudio) {
        const c = newClip({ trackId: tracks.audio().id, mediaId: item.id, name: item.name, start: cursor, length, groupId });
        p.clips.push(c);
        created.push(c.id);
      }
      // next item starts on the first frame after this one ends (never overlapping it)
      cursor = store.view.quantize ? Math.ceil((cursor + length) * p.fps - 1e-6) / p.fps : cursor + length;
    }
  });
  if (created.length) store.select(created);
  return created;
}

/** Adds media to the project bin without placing it. */
export function addToBin(items: MediaItem[]) {
  store.commit('Import Media', (p) => {
    for (const item of items) if (!p.media.some((m) => m.id === item.id)) p.media.push(item);
  });
}

/** A video track with nothing in [start, end), searching from the top (a new top track if all are busy). */
function freeVideoTrack(p: Project, start: number, end: number): Track {
  const busy = (t: Track) => p.clips.some((c) => c.trackId === t.id && c.start < end - EPS && clipEnd(c) > start + EPS);
  const free = tracksOf(p, 'video').find((t) => !busy(t));
  if (free) return free;
  const t = newTrack('video', tracksOf(p, 'video').length + 1, p.tracks.length);
  p.tracks.unshift(t); // above everything, so it shows on top
  return t;
}

/** Adds text or a colour generator at the cursor, on a free video track (titles go over the picture). */
export function addGenerator(kind: GeneratorKind, at = store.time) {
  let id = '';
  store.commit(kind === 'text' ? 'Add Text' : kind === 'solid' ? 'Add Solid Color' : 'Add Gradient', (p) => {
    const start = q(at);
    const track = freeVideoTrack(p, start, start + STILL_LENGTH);
    const c = newClip({
      trackId: track.id, generator: kind, start, length: STILL_LENGTH,
      name: kind === 'text' ? 'Text' : kind === 'solid' ? 'Solid Color' : 'Gradient',
    });
    if (kind === 'text') c.text = defaultText();
    if (kind === 'solid') c.color = '#1e2a78';
    if (kind === 'gradient') { c.color = '#2b1a6e'; c.color2 = '#d4628f'; }
    p.clips.push(c);
    id = c.id;
  });
  if (id) store.select([id]);
}

/** Splits the selected clips (or every clip under the cursor when none is selected) at time t. */
export function split(t = store.time) {
  t = q(t);
  const p = store.project;
  const under = (c: Clip) => t > c.start + EPS && t < clipEnd(c) - EPS;
  let targets = store.selectedClips().filter(under);
  if (!targets.length) targets = p.clips.filter(under);
  if (!targets.length) return;
  const ids = withGroups(p, targets.map((c) => c.id));
  const rightIds: string[] = [];
  store.commit('Split', (pr) => {
    const newGroup = new Map<string, string>();
    for (const c of pr.clips.filter((x) => ids.has(x.id) && under(x))) {
      const right: Clip = structuredClone(c);
      right.id = uid();
      right.start = t;
      right.length = clipEnd(c) - t;
      right.offset = c.offset + (t - c.start) * c.speed;
      right.fadeIn = 0;
      if (c.groupId) {
        if (!newGroup.has(c.groupId)) newGroup.set(c.groupId, uid());
        right.groupId = newGroup.get(c.groupId);
      }
      if (c.panCropEnd) { // keep animated pan/crop continuous across the cut
        const mid = lerpPanCrop(c.panCrop, c.panCropEnd, (t - c.start) / c.length);
        right.panCrop = mid;
        c.panCropEnd = { ...mid };
      }
      c.length = t - c.start;
      c.fadeOut = 0;
      pr.clips.push(right);
      rightIds.push(right.id);
    }
  });
  store.select(rightIds); // like Vegas, the part after the cut stays selected
}

/** Deletes the selected clips; with ripple editing on, later clips on those tracks move left. */
export function deleteSelection(ripple = store.view.ripple) {
  const p = store.project;
  const ids = withGroups(p, store.selection);
  if (!ids.size) return;
  store.commit('Delete', (pr) => {
    const removed = pr.clips.filter((c) => ids.has(c.id));
    pr.clips = pr.clips.filter((c) => !ids.has(c.id));
    if (ripple) rippleClose(pr, removed.map((c) => ({ trackId: c.trackId, start: c.start, end: clipEnd(c) })));
  });
  store.clearSelection();
}

/** Closes the gaps left by removed ranges on each track. */
function rippleClose(p: Project, ranges: { trackId: string; start: number; end: number }[]) {
  const byTrack = new Map<string, { start: number; end: number }[]>();
  for (const r of ranges) (byTrack.get(r.trackId) ?? byTrack.set(r.trackId, []).get(r.trackId)!).push(r);
  for (const [trackId, list] of byTrack) {
    // merge the removed ranges, then shift each later clip by what was removed before it
    list.sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const r of list) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end); else merged.push({ ...r });
    }
    for (const c of p.clips.filter((x) => x.trackId === trackId)) {
      let shift = 0;
      for (const r of merged) if (c.start >= r.end - EPS) shift += r.end - r.start;
      c.start = Math.max(0, c.start - shift);
    }
  }
}

// ---------- clipboard ----------
let clipboard: { clips: Clip[]; trackIndex: Map<string, number>; base: number } | null = null;

export function copySelection() {
  const p = store.project;
  const ids = withGroups(p, store.selection);
  const clips = p.clips.filter((c) => ids.has(c.id));
  if (!clips.length) return false;
  const base = Math.min(...clips.map((c) => c.start));
  const trackIndex = new Map(p.tracks.map((t, i) => [t.id, i]));
  clipboard = { clips: structuredClone(clips), trackIndex, base };
  return true;
}

export function cutSelection() {
  if (copySelection()) deleteSelection();
}

/** Pastes at the cursor; the top-most copied clip lands on the active track (if it is the same kind). */
export function paste() {
  if (!clipboard) return;
  const cb = clipboard;
  const created: string[] = [];
  store.commit('Paste', (p) => {
    const at = q(store.time);
    const firstIdx = Math.min(...cb.clips.map((c) => cb.trackIndex.get(c.trackId) ?? 0));
    const active = p.tracks.findIndex((t) => t.id === store.activeTrack);
    const firstKind = p.tracks[firstIdx]?.kind;
    const shift = active >= 0 && p.tracks[active].kind === firstKind ? active - firstIdx : 0;
    const groups = new Map<string, string>();
    for (const c of cb.clips) {
      const srcIdx = cb.trackIndex.get(c.trackId) ?? 0;
      const kind = p.tracks[srcIdx]?.kind ?? 'video';
      let track = p.tracks[srcIdx + shift];
      if (!track || track.kind !== kind) track = p.tracks.find((t) => t.kind === kind) ?? addTrackTo(p, kind);
      const n: Clip = { ...structuredClone(c), id: uid(), trackId: track.id, start: at + (c.start - cb.base) };
      if (c.groupId) { if (!groups.has(c.groupId)) groups.set(c.groupId, uid()); n.groupId = groups.get(c.groupId); }
      p.clips.push(n);
      created.push(n.id);
    }
  });
  store.select(created);
}

// ---------- tracks ----------
export function insertTrack(kind: TrackKind) {
  let id = '';
  store.commit(kind === 'video' ? 'Insert Video Track' : 'Insert Audio Track', (p) => { id = addTrackTo(p, kind, store.activeTrack ?? undefined).id; });
  store.activeTrack = id;
  store.emit('selection');
}

export function deleteTrack(id: string) {
  const t = store.project.tracks.find((x) => x.id === id);
  if (!t) return;
  store.commit(`Delete Track "${t.name}"`, (p) => {
    p.tracks = p.tracks.filter((x) => x.id !== id);
    p.clips = p.clips.filter((c) => c.trackId !== id);
  });
}

export function moveTrack(id: string, dir: -1 | 1) {
  store.commit('Move Track', (p) => {
    const i = p.tracks.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.tracks.length || p.tracks[j].kind !== p.tracks[i].kind) return;
    [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]];
  });
}

export function updateTrack(id: string, label: string, fn: (t: Track) => void) {
  store.commit(label, (p) => { const t = p.tracks.find((x) => x.id === id); if (t) fn(t); });
}

// ---------- markers & regions ----------
export function addMarker(t = store.time) {
  store.commit('Add Marker', (p) => {
    const time = q(t);
    if (p.markers.some((m) => Math.abs(m.time - time) < 1e-3)) return;
    p.markers.push({ id: uid(), time, name: String(p.markers.length + 1) });
    p.markers.sort((a, b) => a.time - b.time);
  });
}
export function removeMarker(id: string) {
  store.commit('Delete Marker', (p) => { p.markers = p.markers.filter((m) => m.id !== id); });
}
export function setLoop(start: number, end: number) {
  store.commit('Time Selection', (p) => { p.loop = end - start > 1e-3 ? { start: Math.min(start, end), end: Math.max(start, end) } : null; });
}

// ---------- groups, selection helpers ----------
export function groupSelection() {
  const ids = [...store.selection];
  if (ids.length < 2) return;
  store.commit('Group', (p) => { const g = uid(); for (const c of p.clips) if (ids.includes(c.id)) c.groupId = g; });
}
export function ungroupSelection() {
  const ids = withGroups(store.project, store.selection);
  store.commit('Ungroup', (p) => { for (const c of p.clips) if (ids.has(c.id)) delete c.groupId; });
}
export function selectAll() { store.select(store.project.clips.map((c) => c.id)); }

/** Sets selected audio clips so their loudest peak sits at -0.1 dB. */
export function normalizeSelection() {
  const p = store.project;
  const sel = store.selectedClips().filter((c) => c.mediaId && p.tracks.find((t) => t.id === c.trackId)?.kind === 'audio');
  if (!sel.length) return;
  store.commit('Normalize', (pr) => {
    for (const c of pr.clips) {
      if (!sel.some((s) => s.id === c.id)) continue;
      const peak = media.peakLevel(c.mediaId!, c.offset, c.offset + c.length * c.speed);
      if (peak > 0.0001) c.gain = Math.min(dbToGain(24), dbToGain(-0.1) / peak);
    }
  });
}

/** Removes media from the bin (and its clips from the timeline). */
export function removeMedia(id: string) {
  store.commit('Remove Media', (p) => {
    p.media = p.media.filter((m) => m.id !== id);
    p.clips = p.clips.filter((c) => c.mediaId !== id);
  });
}

/** Changes the speed of selected clips, keeping their media range (the length changes). */
export function setSpeed(ids: Iterable<string>, speed: number) {
  const set = new Set(ids);
  store.commit('Playback Rate', (p) => {
    for (const c of p.clips) {
      if (!set.has(c.id) || c.generator) continue;
      const used = c.length * c.speed;
      c.speed = speed;
      c.length = Math.min(used / speed, maxLength(p, c));
    }
  });
}

/** Matches project resolution/frame rate to a video (asked when the first video is added). */
export function matchProject(item: MediaItem) {
  store.commit('Project Properties', (p) => {
    if (item.width && item.height) { p.width = item.width; p.height = item.height; }
    if (item.fps) p.fps = Math.round(item.fps * 1000) / 1000;
  });
}

export { clipsOnTrack };
