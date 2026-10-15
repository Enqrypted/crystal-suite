// Project files (.cutproj JSON), autosave and recovery.
import { store } from './store';
import { media } from './media';
import { native, dirName, fileName, baseName } from './native';
import { newProject, type Project } from './model';

/** Saves to the current path (or asks for one). Returns false if cancelled. */
export async function save(as = false) {
  let path = store.path;
  if (!path || as) {
    path = await native.saveProject(store.project.name);
    if (!path) return false;
  }
  const p = structuredClone(store.project);
  p.name = baseName(path);
  // remember media paths relative to the project too, so a moved folder still opens
  const data = { ...p, media: p.media.map((m) => ({ ...m, relPath: relative(dirName(path!), m.path) })) };
  const ok = await native.writeText(path, JSON.stringify(data, null, 1));
  if (!ok) throw new Error(`Could not write ${path}`);
  store.project.name = p.name;
  store.path = path;
  store.setDirty(false);
  native.addRecent(path);
  native.autosave(null);
  store.emit('file');
  return true;
}

export async function open(path: string) {
  const text = await native.readText(path);
  if (text === null) throw new Error(`Could not read ${fileName(path)}`);
  const p = parse(text);
  // resolve media that moved together with the project
  for (const m of p.media as (Project['media'][number] & { relPath?: string })[]) {
    if (m.relPath && !(await native.stat(m.path))) {
      const alt = join(dirName(path), m.relPath);
      if (await native.stat(alt)) m.path = alt;
    }
    delete m.relPath;
  }
  p.name = baseName(path);
  store.load(p, path);
  native.addRecent(path);
  await media.attach(p.media);
}

export function parse(text: string): Project {
  const raw = JSON.parse(text);
  if (!raw || raw.version !== 1 || !Array.isArray(raw.tracks) || !Array.isArray(raw.clips)) throw new Error('This is not a Cut project.');
  return { ...newProject(), ...raw };
}

export function newDocument() {
  store.load(newProject(), null);
}

/** Restores an autosave left by a session that did not close normally. */
export async function recover(text: string) {
  const p = parse(text);
  store.load(p, null);
  store.setDirty(true);
  await media.attach(p.media);
}

let autosaveTimer = 0;
/** Writes an autosave a little while after changes (cleared again on save). */
export function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    if (store.dirty && store.project.clips.length) native.autosave(JSON.stringify(store.project));
  }, 4000);
}

function relative(from: string, to: string) {
  const a = from.split(/[\\/]/);
  const b = to.split(/[\\/]/);
  if (a[0].toLowerCase() !== b[0].toLowerCase()) return '';
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('\\');
}
function join(dir: string, rel: string) {
  const parts = dir.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('\\');
}
