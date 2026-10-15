// Media library: probes files, keeps one streaming Input per file (bytes are read from disk on demand),
// decodes audio once (for playback, rendering and waveforms) and generates timeline thumbnails.
import { Input, ALL_FORMATS, StreamSource, VideoSampleSink, AudioBufferSink, type InputVideoTrack, type InputAudioTrack } from 'mediabunny';
import { native, extOf, fileName } from './native';
import { uid, type MediaItem, type MediaKind } from './model';
import { store } from './store';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'];
/** Waveform resolution: one peak per 5 ms. */
export const PEAKS_PER_SECOND = 200;
const THUMB_HEIGHT = 72;
const MAX_THUMBS = 900;

export interface Peaks { rate: number; data: Float32Array; filled: number }

export interface MediaRuntime {
  item: MediaItem;
  status: 'loading' | 'ready' | 'offline' | 'error';
  error: string;
  input: Input | null;
  video: InputVideoTrack | null;
  audioTrack: InputAudioTrack | null;
  image: ImageBitmap | null;
  /** Decoded audio (null until decoded). */
  audio: AudioBuffer | null;
  audioProgress: number;
  audioPromise: Promise<AudioBuffer | null> | null;
  peaks: Peaks | null;
  poster: ImageBitmap | null;
}

function openInput(path: string, size: number) {
  return new Input({
    formats: ALL_FORMATS,
    source: new StreamSource({
      getSize: () => size,
      read: (start: number, end: number) => native.read(path, start, end),
      prefetchProfile: 'fileSystem',
      maxCacheSize: 32 * 2 ** 20,
    }),
  });
}

class MediaLibrary {
  private rt = new Map<string, MediaRuntime>();
  private thumbs = new Map<string, ImageBitmap>();
  private thumbQueue: { id: string; key: string; t: number }[] = [];
  private thumbBusy = false;
  private thumbSinks = new Map<string, VideoSampleSink>();
  private requested = new Set<string>();

  get(id: string | undefined) { return id ? this.rt.get(id) : undefined; }

  /** Probes files and registers them; audio decoding and posters continue in the background. */
  async import(paths: string[]): Promise<{ items: MediaItem[]; failed: { path: string; error: string }[] }> {
    const items: MediaItem[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const path of paths) {
      const existing = store.project.media.find((m) => m.path.toLowerCase() === path.toLowerCase());
      if (existing) { items.push(existing); continue; }
      try {
        const item = await this.probe(path);
        items.push(item);
      } catch (e) {
        failed.push({ path, error: (e as Error).message || String(e) });
      }
    }
    return { items, failed };
  }

  private async probe(path: string): Promise<MediaItem> {
    const st = await native.stat(path);
    if (!st) throw new Error('File not found');
    const ext = extOf(path);
    const base: MediaItem = {
      id: uid(), path, name: fileName(path), kind: 'video', duration: 0, width: 0, height: 0, fps: 0,
      hasVideo: false, hasAudio: false, sampleRate: 0, channels: 0, size: st.size,
    };
    if (IMAGE_EXT.includes(ext)) {
      const bmp = await this.loadImage(path, st.size);
      const item: MediaItem = { ...base, kind: 'image', width: bmp.width, height: bmp.height, hasVideo: true };
      this.rt.set(item.id, this.blank(item, { status: 'ready', image: bmp, poster: bmp }));
      return item;
    }
    const input = openInput(path, st.size);
    if (!(await input.canRead())) { input.dispose(); throw new Error('This file format is not supported'); }
    const video = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!video && !audioTrack) { input.dispose(); throw new Error('No video or audio found in this file'); }
    if (video && !(await video.canDecode())) { input.dispose(); throw new Error(`Video codec not supported (${(await video.getCodec()) || 'unknown'})`); }
    const duration = await input.computeDuration();
    const item: MediaItem = { ...base, duration, kind: (video ? 'video' : 'audio') as MediaKind };
    if (video) {
      item.hasVideo = true;
      item.width = await video.getDisplayWidth();
      item.height = await video.getDisplayHeight();
      try { item.fps = Math.round((await video.computeFrameRateMetrics()).bestGuessFrameRate * 1000) / 1000; } catch { item.fps = 30; }
    }
    const canAudio = audioTrack ? await audioTrack.canDecode() : false;
    if (audioTrack && canAudio) {
      item.hasAudio = true;
      item.sampleRate = await audioTrack.getSampleRate();
      item.channels = await audioTrack.getNumberOfChannels();
    }
    if (!item.hasVideo && AUDIO_EXT.includes(ext) === false && !item.hasAudio) throw new Error('Nothing playable in this file');
    const r = this.blank(item, { status: 'ready', input, video, audioTrack: canAudio ? audioTrack : null });
    this.rt.set(item.id, r);
    this.background(r);
    return item;
  }

  private blank(item: MediaItem, init: Partial<MediaRuntime>): MediaRuntime {
    return {
      item, status: 'loading', error: '', input: null, video: null, audioTrack: null, image: null, audio: null,
      audioProgress: 0, audioPromise: null, peaks: null, poster: null, ...init,
    };
  }

  private async loadImage(path: string, size: number) {
    const bytes = await native.read(path, 0, size);
    let bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
    const max = 4096;
    if (bmp.width > max || bmp.height > max) {
      const k = max / Math.max(bmp.width, bmp.height);
      const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      bmp.close();
      bmp = small;
    }
    return bmp;
  }

  /** Re-opens media referenced by a loaded project (missing files become "offline"). */
  async attach(items: MediaItem[]) {
    await Promise.all(items.map(async (item) => {
      if (this.rt.has(item.id)) return;
      const r = this.blank(item, {});
      this.rt.set(item.id, r);
      const st = await native.stat(item.path);
      if (!st) { r.status = 'offline'; r.error = 'File not found'; store.emit('media'); return; }
      try {
        if (item.kind === 'image') { r.image = await this.loadImage(item.path, st.size); r.poster = r.image; }
        else {
          r.input = openInput(item.path, st.size);
          r.video = item.hasVideo ? await r.input.getPrimaryVideoTrack() : null;
          r.audioTrack = item.hasAudio ? await r.input.getPrimaryAudioTrack() : null;
          this.background(r);
        }
        r.status = 'ready';
      } catch (e) {
        r.status = 'error';
        r.error = (e as Error).message;
      }
      store.emit('media');
    }));
  }

  /** Points a media item at another file (relink offline media). */
  async relink(id: string, path: string) {
    const old = this.rt.get(id);
    old?.input?.dispose();
    this.rt.delete(id);
    const item = store.project.media.find((m) => m.id === id);
    if (!item) return;
    item.path = path;
    item.name = fileName(path);
    await this.attach([item]);
  }

  private background(r: MediaRuntime) {
    if (r.video && !r.poster) this.poster(r).catch(() => {});
    if (r.audioTrack) this.decodeAudio(r).catch(() => {});
  }

  private async poster(r: MediaRuntime) {
    const sink = new VideoSampleSink(r.video!);
    const t = Math.min(1, r.item.duration / 3);
    const s = await sink.getSample(t);
    if (!s) return;
    r.poster = await this.snapshot(s, 160);
    s.close();
    store.emit('media');
  }

  private async snapshot(s: { displayWidth: number; displayHeight: number; draw(ctx: OffscreenCanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number): void }, height: number) {
    const w = Math.max(1, Math.round((s.displayWidth / s.displayHeight) * height));
    const c = new OffscreenCanvas(w, height);
    const ctx = c.getContext('2d')!;
    s.draw(ctx, 0, 0, w, height);
    return c.transferToImageBitmap();
  }

  /** Decodes the whole audio track once; waveform peaks fill in as it goes. */
  audio(id: string | undefined): Promise<AudioBuffer | null> {
    const r = this.get(id);
    if (!r || !r.audioTrack) return Promise.resolve(null);
    return r.audioPromise ?? this.decodeAudio(r);
  }

  private decodeAudio(r: MediaRuntime): Promise<AudioBuffer | null> {
    if (r.audioPromise) return r.audioPromise;
    r.audioPromise = (async () => {
      const track = r.audioTrack!;
      const sr = r.item.sampleRate || (await track.getSampleRate());
      const chans = Math.max(1, Math.min(2, r.item.channels || (await track.getNumberOfChannels())));
      const total = Math.max(1, Math.ceil(r.item.duration * sr) + sr);
      const data = Array.from({ length: chans }, () => new Float32Array(total));
      const bucket = sr / PEAKS_PER_SECOND;
      const peaks: Peaks = { rate: PEAKS_PER_SECOND, data: new Float32Array(Math.ceil(total / bucket)), filled: 0 };
      r.peaks = peaks;
      const sink = new AudioBufferSink(track);
      let first: number | null = null;
      let written = 0;
      let lastEmit = 0;
      for await (const { buffer, timestamp } of sink.buffers()) {
        if (first === null) first = Math.min(0, timestamp);
        const at = Math.max(0, Math.round((timestamp - first) * sr));
        const n = Math.min(buffer.length, total - at);
        if (n <= 0) continue;
        for (let ch = 0; ch < chans; ch++) {
          const src = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
          data[ch].set(n === src.length ? src : src.subarray(0, n), at);
        }
        // peaks: max |sample| over channels per bucket
        const b0 = Math.floor(at / bucket);
        const b1 = Math.ceil((at + n) / bucket);
        for (let b = b0; b < b1 && b < peaks.data.length; b++) {
          const s0 = Math.max(at, Math.floor(b * bucket));
          const s1 = Math.min(at + n, Math.floor((b + 1) * bucket));
          let m = peaks.data[b];
          for (let ch = 0; ch < chans; ch++) {
            const d = data[ch];
            for (let i = s0; i < s1; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > m) m = v; }
          }
          peaks.data[b] = m;
        }
        written = Math.max(written, at + n);
        peaks.filled = Math.floor(written / bucket);
        r.audioProgress = Math.min(1, written / (r.item.duration * sr || 1));
        const now = performance.now();
        if (now - lastEmit > 250) { lastEmit = now; store.emit('media'); }
      }
      const length = Math.max(1, Math.min(total, written));
      const ab = new AudioBuffer({ length, numberOfChannels: chans, sampleRate: sr });
      for (let ch = 0; ch < chans; ch++) ab.copyToChannel(data[ch].subarray(0, length), ch);
      r.audio = ab;
      r.audioProgress = 1;
      peaks.filled = peaks.data.length;
      store.emit('media');
      return ab;
    })().catch((e) => {
      console.warn('audio decode failed', r.item.name, e);
      r.audioProgress = 1;
      store.emit('media');
      return null;
    });
    return r.audioPromise;
  }

  /** Peak level (0..1) of a media range, for normalising. */
  peakLevel(id: string, from: number, to: number) {
    const p = this.get(id)?.peaks;
    if (!p) return 0;
    let m = 0;
    for (let i = Math.max(0, Math.floor(from * p.rate)); i < Math.min(p.data.length, Math.ceil(to * p.rate)); i++) if (p.data[i] > m) m = p.data[i];
    return m;
  }

  // ---------- thumbnails ----------
  /** A thumbnail near source time t (quantised by `step`), or null while it is generated. */
  thumbnail(id: string, t: number, step: number): ImageBitmap | null {
    const r = this.rt.get(id);
    if (!r) return null;
    if (r.item.kind === 'image') return r.poster;
    if (!r.video || r.status !== 'ready') return null;
    const q = Math.max(step, 1 / (r.item.fps || 30));
    const qt = Math.min(Math.max(0, r.item.duration - 0.05), Math.round(t / q) * q);
    const key = `${id}:${Math.round(qt * 1000)}`;
    const hit = this.thumbs.get(key);
    if (hit) { this.thumbs.delete(key); this.thumbs.set(key, hit); return hit; } // LRU touch
    if (!this.requested.has(key)) {
      this.requested.add(key);
      this.thumbQueue.push({ id, key, t: qt });
      if (this.thumbQueue.length > 80) this.requested.delete(this.thumbQueue.shift()!.key);
      this.pumpThumbs();
    }
    // meanwhile, the nearest cached thumbnail of the same media
    let best: ImageBitmap | null = null;
    let bestD = Infinity;
    for (const [k, bmp] of this.thumbs) {
      if (!k.startsWith(id + ':')) continue;
      const d = Math.abs(Number(k.slice(id.length + 1)) / 1000 - qt);
      if (d < bestD) { bestD = d; best = bmp; }
    }
    return best ?? r.poster;
  }

  private async pumpThumbs() {
    if (this.thumbBusy) return;
    this.thumbBusy = true;
    try {
      while (this.thumbQueue.length) {
        const job = this.thumbQueue.pop()!; // newest first: what is on screen now
        const r = this.rt.get(job.id);
        if (!r?.video) { this.requested.delete(job.key); continue; }
        let sink = this.thumbSinks.get(job.id);
        if (!sink) { sink = new VideoSampleSink(r.video); this.thumbSinks.set(job.id, sink); }
        try {
          const s = await sink.getSample(job.t);
          if (s) {
            this.thumbs.set(job.key, await this.snapshot(s, THUMB_HEIGHT));
            s.close();
            if (this.thumbs.size > MAX_THUMBS) {
              const [k, bmp] = this.thumbs.entries().next().value!;
              bmp.close();
              this.thumbs.delete(k);
              this.requested.delete(k);
            }
            store.emit('media');
          }
        } catch { /* skip this one */ }
      }
    } finally {
      this.thumbBusy = false;
    }
  }

  /** A video decoder for one consumer (playback stream, still frames, render). */
  videoSink(id: string | undefined) {
    const r = this.get(id);
    return r?.video ? new VideoSampleSink(r.video) : null;
  }

  /** Forgets media no longer used by the project (after the user removes it). */
  release(id: string) {
    const r = this.rt.get(id);
    if (!r) return;
    r.input?.dispose();
    this.rt.delete(id);
    this.thumbSinks.delete(id);
    for (const [k, bmp] of [...this.thumbs]) if (k.startsWith(id + ':')) { bmp.close(); this.thumbs.delete(k); }
  }
}

export const media = new MediaLibrary();
