// Downloads: progress, open / show in folder, pause, cancel, retry.
import { prism, icon, esc, shell, bytes, dayLabel, $ } from './common';
import type { DownloadRecord } from '../shared';

const content = shell('downloads', 'Downloads', `<button class="btn" id="folder">${icon('folder', 15)}Open downloads folder</button>
  <button class="btn" id="clear">${icon('trash', 15)}Clear all</button>`);

let list: DownloadRecord[] = [];

function status(r: DownloadRecord) {
  if (r.state === 'progressing') {
    const pct = r.total ? Math.round((r.received / r.total) * 100) : -1;
    return `<div class="progress"><i style="width:${pct < 0 ? 30 : pct}%"></i></div>
      <span class="sub">${r.paused ? 'Paused · ' : ''}${bytes(r.received)}${r.total ? ` of ${bytes(r.total)}` : ''}${pct >= 0 ? ` · ${pct}%` : ''}</span>`;
  }
  if (r.state === 'completed') return `<span class="sub">${r.exists === false ? 'Deleted' : bytes(r.total || r.received)}</span>`;
  return `<span class="sub" style="color:var(--warn)">${r.state === 'cancelled' ? 'Cancelled' : 'Failed'}</span>`;
}

function actions(r: DownloadRecord) {
  const b = (act: string, ic: string, title: string) => `<button class="icon-btn" data-act="${act}" data-id="${esc(r.id)}" title="${title}">${icon(ic, 16)}</button>`;
  if (r.state === 'progressing') return (r.paused ? b('resume', 'play', 'Resume') : b('pause', 'pause', 'Pause')) + b('cancel', 'close', 'Cancel');
  const out = [];
  if (r.state === 'completed' && r.exists !== false) out.push(b('show', 'folder', 'Show in folder'));
  if (r.state !== 'completed' || r.exists === false) out.push(b('retry', 'reload', 'Retry'));
  out.push(b('remove', 'trash', 'Remove from list'));
  return out.join('');
}

function render() {
  if (!list.length) {
    content.innerHTML = `<div class="empty">${icon('download', 40)}Files you download will appear here.</div>`;
    return;
  }
  let html = '<div class="list">';
  let day = '';
  for (const r of list) {
    const d = dayLabel(r.time);
    if (d !== day) { day = d; html += `<div class="day">${esc(d)}</div>`; }
    const openable = r.state === 'completed' && r.exists !== false;
    html += `<div class="item">${icon('file', 22)}
      <div class="main">
        ${openable ? `<a class="title ellipsis" href="#" data-act="open" data-id="${esc(r.id)}">${esc(r.filename)}</a>` : `<span class="title ellipsis"${r.state === 'completed' ? ' style="text-decoration:line-through"' : ''}>${esc(r.filename)}</span>`}
        <span class="sub ellipsis faint" title="${esc(r.url)}">${esc(r.url.startsWith('data:') ? 'data: URL' : r.url)}</span>
        ${status(r)}
      </div>
      <div class="acts" style="opacity:1">${actions(r)}</div></div>`;
  }
  content.innerHTML = html + '</div>';
}

async function load() {
  list = await prism.call<DownloadRecord[]>('downloads');
  render();
}

content.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el) return;
  e.preventDefault();
  await prism.call('download', el.dataset.act, el.dataset.id);
  load();
});
$('#folder').addEventListener('click', () => prism.call('openDownloadsFolder'));
$('#clear').addEventListener('click', async () => { await prism.call('clearDownloads'); load(); });
let pending = false;
prism.onUpdate((what) => {
  if (what !== 'downloads' || pending) return;
  pending = true;
  setTimeout(() => { pending = false; load(); }, 200);
});
load();
