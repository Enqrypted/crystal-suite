// Client for FacetHelper.exe (see native/FacetHelper.cs): one request/reply per line over stdio.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';

type Reply = { ok: boolean; value: string };

export class Helper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private seq = 0;
  private waiting = new Map<string, (r: Reply) => void>();
  private stopped = false;
  private restarts = 0;
  ready = false;
  /** Events from the helper: wallpaper, explorer, desktop. */
  onEvent: (name: string, data: string) => void = () => {};
  /** Called after (re)starting, so pinned windows can be pinned again. */
  onStart: () => void = () => {};

  constructor(private exe: string) {}

  get available() { return fs.existsSync(this.exe); }

  start() {
    this.stopped = false;
    this.restarts = 0;
    this.spawn();
  }

  private spawn() {
    if (this.proc || this.stopped || !this.available) return;
    let p: ChildProcessWithoutNullStreams;
    try {
      // detached: outside the job that would end it together with Facet, so after a crash it still sees its
      // input close and shows the desktop icons again before it exits
      p = spawn(this.exe, ['--pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true });
    } catch { return; }
    this.proc = p;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => this.read(d));
    p.stderr.on('data', () => {});
    p.on('error', () => {});
    p.on('exit', () => {
      this.proc = null;
      this.ready = false;
      for (const w of this.waiting.values()) w({ ok: false, value: 'helper exited' });
      this.waiting.clear();
      // a crash should not take the desktop pinning with it: restart a few times
      if (!this.stopped && this.restarts++ < 5) setTimeout(() => this.spawn(), 1000 * this.restarts);
    });
  }

  stop() {
    this.stopped = true;
    const p = this.proc;
    if (p) { try { p.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500); }
  }

  private read(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const [id, kind, ...rest] = line.split('\t');
      if (id === '0' && kind === 'event') {
        if (rest[0] === 'ready') { this.ready = true; this.onStart(); }
        else this.onEvent(rest[0], rest[1] ?? '');
        continue;
      }
      const w = this.waiting.get(id);
      if (w) { this.waiting.delete(id); w({ ok: kind === 'ok', value: rest.join('\t') }); }
    }
  }

  /** Sends a command; resolves with the result text, or null if the helper failed or isn't there. */
  call(cmd: string, ...args: (string | number)[]): Promise<string | null> {
    if (!this.proc || !this.ready) return Promise.resolve(null);
    const id = String(++this.seq);
    const line = [id, cmd, ...args.map((a) => String(a).replace(/[\t\r\n]/g, ' '))].join('\t') + '\n';
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(null); }, cmd === 'icon' ? 20000 : 5000);
      this.waiting.set(id, (r) => { clearTimeout(timer); resolve(r.ok ? r.value : null); });
      try { this.proc!.stdin.write(line); } catch { clearTimeout(timer); this.waiting.delete(id); resolve(null); }
    });
  }
}
