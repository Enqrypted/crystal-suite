// Client for OnyxHelper.exe (see native/OnyxHelper.cs): one request/reply per line over stdio, plus events.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';

type Reply = { ok: boolean; value: string };

/** How long a command may take: starting a capture sets up the GPU; saving writes up to a few hundred MB. */
const TIMEOUTS: Record<string, number> = { start: 20000, save: 180000 };

export class Helper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private seq = 0;
  private waiting = new Map<string, (r: Reply) => void>();
  private stopped = true;
  private restarts = 0;
  ready = false;
  /** Events from the helper: status, stopped, error, foreground. */
  onEvent: (name: string, data: string) => void = () => {};
  /** Called after (re)starting. */
  onStart: () => void = () => {};
  /** Called when the helper went away (any recording with it). */
  onExit: () => void = () => {};

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
      p = spawn(this.exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch { return; }
    this.proc = p;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => this.read(d));
    p.stderr.on('data', () => {});
    p.stdin.on('error', () => {});
    p.on('error', () => {});
    p.on('exit', () => {
      if (this.proc === p) this.proc = null;
      this.ready = false;
      for (const w of this.waiting.values()) w({ ok: false, value: 'The recorder stopped unexpectedly.' });
      this.waiting.clear();
      this.onExit();
      if (!this.stopped && this.restarts++ < 5) setTimeout(() => this.spawn(), 1000 * this.restarts);
    });
  }

  stop() {
    this.stopped = true;
    const p = this.proc;
    if (p) { try { p.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 3000); }
  }

  private read(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const [id, kind, ...rest] = line.split('\t');
      if (id === '0' && kind === 'event') {
        if (rest[0] === 'ready') { this.ready = true; this.restarts = 0; this.onStart(); }
        else this.onEvent(rest[0], rest.slice(1).join('\t'));
        continue;
      }
      const w = this.waiting.get(id);
      if (w) { this.waiting.delete(id); w({ ok: kind === 'ok', value: rest.join('\t') }); }
    }
  }

  /** Sends a command; resolves with its reply (ok false with the message when it failed). */
  call(cmd: string, ...args: (string | number)[]): Promise<Reply> {
    if (!this.proc || !this.ready) return Promise.resolve({ ok: false, value: 'The recorder isn\'t running.' });
    const id = String(++this.seq);
    const line = [id, cmd, ...args.map((a) => String(a).replace(/[\t\r\n]/g, ' '))].join('\t') + '\n';
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve({ ok: false, value: 'The recorder didn\'t answer.' }); }, TIMEOUTS[cmd] ?? 5000);
      this.waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
      try { this.proc!.stdin.write(line); } catch { clearTimeout(timer); this.waiting.delete(id); resolve({ ok: false, value: 'The recorder isn\'t running.' }); }
    });
  }
}
