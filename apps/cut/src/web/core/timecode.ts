// Time display: SMPTE-style timecode (hh:mm:ss;ff) like Vegas, plus short ruler labels.

export function timecode(t: number, fps: number) {
  const neg = t < 0;
  t = Math.abs(t);
  const f = Math.round(t * fps);
  const rate = Math.round(fps);
  const frames = f % rate;
  const total = Math.floor(f / rate);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${neg ? '-' : ''}${p(h)}:${p(m)}:${p(s)};${p(frames)}`;
}

/** Compact clock form for lengths (e.g. 1:05.4). */
export function shortTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
}

/** Ruler label for a tick at time t, given the tick spacing. */
export function rulerLabel(t: number, step: number, fps: number) {
  const total = Math.round(t * 1000) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = Math.floor(total) % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  const hms = h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  if (step < 1) return `${hms};${p(Math.round((total % 1) * fps))}`;
  return hms;
}

/** Parses "hh:mm:ss;ff", "mm:ss", "ss" or "ss.s" into seconds (null if invalid). */
export function parseTime(text: string, fps: number): number | null {
  const s = text.trim();
  if (!s) return null;
  const m = /^(\d+:)?(\d+:)?(\d+(?:\.\d+)?)(?:[;:.](\d+))?$/.exec(s.replace(/;(\d+)$/, ';$1'));
  if (!m) return null;
  const parts = s.split(/[:;]/).map(Number);
  if (parts.some((n) => !isFinite(n))) return null;
  if (s.includes(';')) {
    const frames = parts.pop()!;
    const [hh, mm, ss] = parts.length === 3 ? parts : parts.length === 2 ? [0, ...parts] : [0, 0, ...parts];
    return hh * 3600 + mm * 60 + ss + frames / fps;
  }
  const [hh, mm, ss] = parts.length === 3 ? parts : parts.length === 2 ? [0, ...parts] : [0, 0, ...parts];
  return hh * 3600 + mm * 60 + ss;
}
