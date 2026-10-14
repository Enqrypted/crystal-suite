import fs from 'fs';
import path from 'path';

/** A JSON document on disk with debounced, atomic saves (nothing is written when `persist` is false). */
export class JsonFile<T extends object> {
  data: T;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly file: string, fallback: () => T, readonly persist = true) {
    let data: unknown;
    if (persist) {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run or damaged file */ }
    }
    this.data = data && typeof data === 'object' && !Array.isArray(data) ? { ...fallback(), ...(data as T) } : fallback();
  }

  save(delay = 800) {
    if (!this.persist) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.persist) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch { /* disk full or locked: the data stays in memory */ }
  }
}
