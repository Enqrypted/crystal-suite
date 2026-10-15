// Reads what is on the Windows desktop (the user's and the shared Public desktop) and sorts it into
// categories for "Organize desktop". Nothing is moved: folders hold shortcuts to the original items.
import fs from 'fs';
import path from 'path';
import { app, shell } from 'electron';
import type { Category, DesktopEntry } from '../shared/types';

const EXT: Record<string, Category> = {};
const add = (cat: Category, list: string) => list.split(' ').forEach((e) => { EXT[e] = cat; });
add('documents', 'pdf doc docx docm dot dotx odt rtf txt md xls xlsx xlsm csv ods ppt pptx odp pages numbers key epub json xml log');
add('pictures', 'png jpg jpeg gif webp bmp tif tiff heic heif avif svg ico psd ai raw cr2 nef arw dng');
add('videos', 'mp4 m4v mov mkv avi webm wmv flv mpg mpeg 3gp cutproj');
add('music', 'mp3 wav flac m4a aac ogg oga opus wma aiff mid midi');
add('archives', 'zip rar 7z tar gz tgz bz2 xz iso cab');
add('apps', 'exe msi appref-ms bat cmd ps1');

const GAME_SCHEMES = /^(steam|com\.epicgames\.launcher|uplay|ubisoft|origin|origin2|eadm|battlenet|heroic|goggalaxy|riotclient|amazon-games|itch):/i;
const GAME_PATHS = /\\(steamapps|epic games|riot games|gog galaxy\\games|ubisoft game launcher|ea games|xboxgames|games)\\/i;

export function desktopDirs(): string[] {
  const dirs = [app.getPath('desktop')];
  const pub = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop');
  if (fs.existsSync(pub) && path.resolve(pub) !== path.resolve(dirs[0])) dirs.push(pub);
  return dirs;
}

/** The name to show: shortcuts and programs without their extension. */
export function displayName(p: string): string {
  const base = path.basename(p);
  return /\.(lnk|url|exe|appref-ms)$/i.test(base) ? base.replace(/\.[^.]+$/, '') : base;
}

function urlOf(file: string): string {
  try {
    const m = /^URL=(.*)$/im.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

export function categorize(p: string): Category {
  let st: fs.Stats | null = null;
  try { st = fs.statSync(p); } catch { /* broken */ }
  if (st?.isDirectory()) return 'folders';
  const ext = path.extname(p).slice(1).toLowerCase();
  if (ext === 'url') {
    const url = urlOf(p);
    if (GAME_SCHEMES.test(url)) return 'games';
    return /^https?:/i.test(url) ? 'web' : 'apps';
  }
  if (ext === 'lnk') {
    let target = '';
    try { target = shell.readShortcutLink(p).target || ''; } catch { /* not a file shortcut (e.g. a Store app) */ }
    if (!target) return 'apps';
    if (GAME_PATHS.test(target)) return 'games';
    try { if (fs.statSync(target).isDirectory()) return 'folders'; } catch { /* missing target */ }
    const t = path.extname(target).slice(1).toLowerCase();
    return EXT[t] ?? (t ? 'other' : 'apps');
  }
  if (ext === 'exe' && GAME_PATHS.test(p)) return 'games';
  return EXT[ext] ?? 'other';
}

/** Everything on the desktop, sorted by name. */
export function scanDesktop(): DesktopEntry[] {
  const out: DesktopEntry[] = [];
  const seen = new Set<string>();
  for (const dir of desktopDirs()) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (/^(desktop\.ini|thumbs\.db)$/i.test(n) || n.startsWith('~$') || n.startsWith('.')) continue;
      const p = path.join(dir, n);
      const key = displayName(p).toLowerCase();
      if (seen.has(key)) continue; // the same shortcut on both desktops
      seen.add(key);
      out.push({ path: p, name: displayName(p), category: categorize(p) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

export const CATEGORY_NAMES: Record<Category, string> = {
  apps: 'Apps', games: 'Games', folders: 'Folders', documents: 'Documents', pictures: 'Pictures',
  videos: 'Videos', music: 'Music', archives: 'Archives', web: 'Web', other: 'Other',
};
