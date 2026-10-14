// History: visits grouped by day, searchable, removable.
import { prism, icon, esc, shell, favicon, fixIcons, dayLabel, timeOf, debounce, $ } from './common';
import type { Visit } from '../shared';

type Row = Visit & { icon: string };
const PAGE = 200;

const content = shell('history', 'History', `<label class="search">${icon('search', 16)}<input id="q" placeholder="Search history" spellcheck="false" /></label>
  <a class="btn" href="prism://settings/#clear">${icon('trash', 15)}Clear browsing data</a>`);

let rows: Row[] = [];
let done = false;

async function load(reset: boolean) {
  const q = $<HTMLInputElement>('#q').value;
  const before = reset || !rows.length ? Infinity : rows[rows.length - 1].time;
  const more = await prism.call<Row[]>('history', q, PAGE, before === Infinity ? 0 : before);
  rows = reset ? more : rows.concat(more);
  done = more.length < PAGE;
  render();
}

function render() {
  if (!rows.length) {
    const q = $<HTMLInputElement>('#q').value;
    content.innerHTML = `<div class="empty">${icon('clock', 40)}${q ? 'No history matches your search.' : 'Pages you visit will appear here.'}</div>`;
    return;
  }
  let html = '<div class="list">';
  let day = '';
  rows.forEach((r, i) => {
    const d = dayLabel(r.time);
    if (d !== day) { day = d; html += `<div class="day">${esc(d)}</div>`; }
    html += `<div class="item"><span class="time">${esc(timeOf(r.time))}</span>
      <div class="main row">${favicon(r.url, r.icon)}<a class="title ellipsis" href="${esc(r.url)}" title="${esc(r.url)}">${esc(r.title || r.url)}</a>
      <span class="sub ellipsis">${esc(new URL(r.url).hostname.replace(/^www\./, ''))}</span></div>
      <div class="acts"><button class="icon-btn" data-rm="${i}" title="Remove from history">${icon('close', 14)}</button></div></div>`;
  });
  html += '</div>';
  if (!done) html += `<div class="more"><button class="btn" id="more">Show more</button></div>`;
  content.innerHTML = html;
  fixIcons(content);
}

content.addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const rm = t.closest<HTMLElement>('[data-rm]');
  if (rm) {
    const r = rows[Number(rm.dataset.rm)];
    await prism.call('removeHistory', [{ url: r.url, time: r.time }]);
    rows = rows.filter((x) => x !== r);
    render();
    return;
  }
  if (t.closest('#more')) load(false);
  const a = t.closest<HTMLAnchorElement>('a.title');
  if (a && (e.ctrlKey || e.button === 1)) { e.preventDefault(); prism.call('open', a.href, true); }
});
content.addEventListener('auxclick', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.title');
  if (a && e.button === 1) { e.preventDefault(); prism.call('open', a.href, true); }
});
$('#q').addEventListener('input', debounce(() => load(true), 150));
prism.onUpdate((what) => { if (what === 'history') load(true); });
load(true);
