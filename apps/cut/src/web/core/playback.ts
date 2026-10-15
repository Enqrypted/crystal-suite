// Transport: play / pause / stop with the audio clock as the master clock (picture follows sound).
// Like Vegas, Space stops and returns the cursor to where playback started, Enter pauses in place.
import { store } from './store';
import { audio } from './audio';
import { projectEnd } from './model';

class Transport {
  playing = false;
  private from = 0;
  private when = 0;
  private returnTo = 0;
  private raf = 0;
  private restartTimer = 0;
  /** Called on every playback frame with the current time. */
  onFrame: (t: number) => void = () => {};

  /** Current playback position (the cursor when stopped). */
  now() {
    if (!this.playing || !audio.ctx) return store.time;
    const heard = audio.ctx.currentTime - this.when - audio.latency;
    return this.from + Math.max(0, heard);
  }

  private range(from: number) {
    const p = store.project;
    const loop = store.view.loop && p.loop && p.loop.end - p.loop.start > 0.05 ? p.loop : null;
    const end = loop ? loop.end : projectEnd(p);
    if (loop && (from < loop.start || from >= loop.end)) from = loop.start;
    if (!loop && from >= end - 0.02) from = 0; // at the end: play from the start
    return { from, end, loop };
  }

  play(at = store.time) {
    const p = store.project;
    if (!p.clips.length) return;
    const { from, end } = this.range(at);
    if (!this.playing) this.returnTo = store.time;
    this.from = from;
    this.when = audio.start(p, from, end);
    this.playing = true;
    store.setTime(from);
    store.emit('transport');
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = () => {
    if (!this.playing) return;
    const t = this.now();
    const { end, loop } = this.range(this.from);
    if (t >= end) {
      if (loop) { this.play(loop.start); return; }
      this.pause(end);
      return;
    }
    store.setTime(t);
    this.onFrame(t);
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Stops where the playhead is. */
  pause(at?: number) {
    if (!this.playing) return;
    const t = at ?? this.now();
    this.playing = false;
    cancelAnimationFrame(this.raf);
    audio.stop();
    store.setTime(t);
    store.emit('transport');
  }

  /** Stops and returns the cursor to where playback started (Vegas' Space bar). */
  stop() {
    if (!this.playing) return;
    this.pause();
    store.setTime(this.returnTo);
  }

  toggle() { if (this.playing) this.stop(); else this.play(); }
  togglePause() { if (this.playing) this.pause(); else this.play(); }

  /** Moves the playhead; playback continues from there if running. */
  seek(t: number) {
    t = Math.max(0, t);
    if (this.playing) this.play(t); else store.setTime(t);
  }

  /** Re-schedules audio after an edit made during playback. */
  projectChanged() {
    if (!this.playing) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => { if (this.playing) this.play(this.now()); }, 60);
  }
}

export const transport = new Transport();
