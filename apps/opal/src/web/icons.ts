// Line icons (24×24 grid, currentColor).
const P: Record<string, string> = {
  open: '<path d="M3.5 7.5v12h15l2-8H7l-2 8"/><path d="M3.5 7.5V5h6l2 2h7v4.5"/>',
  left: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  right: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
  rotLeft: '<path d="M4.5 9.5V4.5M4.5 9.5h5"/><path d="M4.9 9.3A8 8 0 1 1 5 15.5"/>',
  rotRight: '<path d="M19.5 9.5V4.5M19.5 9.5h-5"/><path d="M19.1 9.3A8 8 0 1 0 19 15.5"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13"/><path d="M10 10.5v5.5M14 10.5v5.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.4"/>',
  film: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M3.5 9h17M3.5 15h17M7 5.5v3.5M12 5.5v3.5M17 5.5v3.5M7 15v3.5M12 15v3.5M17 15v3.5"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  full: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
  unfull: '<path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/>',
  more: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5M10.5 8v5"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5"/>',
  fit: '<rect x="4" y="5.5" width="16" height="13" rx="1.5"/><path d="M8 9.5v-1h2M16 9.5v-1h-2M8 14.5v1h2M16 14.5v1h-2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  folder: '<path d="M3.5 7V5.5h6l2 2h9v11h-17z"/>',
  edit: '<path d="M4 20c2.5-.2 4-1.4 4.6-3.4L17 8.2a2.1 2.1 0 0 0-3-3L5.6 13.6C3.6 14.2 3.7 17.5 4 20z"/><path d="M12.6 6.6l4.8 4.8"/>',
  save: '<path d="M12 4.5v10M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 15.5v4h15v-4"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="9.5" r="1.8"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>',
  camera: '<path d="M4 8.5h3.5l1.5-2.5h6l1.5 2.5H20v10H4z"/><circle cx="12" cy="13" r="3.3"/>',
  pin: '<path d="M12 20.5s6-5.6 6-10.5a6 6 0 0 0-12 0c0 4.9 6 10.5 6 10.5z"/><circle cx="12" cy="10" r="2.2"/>',
  photos: '<rect x="6.5" y="3.5" width="14" height="12" rx="2"/><path d="M3.5 7.5v11a2 2 0 0 0 2 2h11"/><path d="M8 13l3.5-3 2.5 2 2-1.5 3 2.5"/>',
  convert: '<path d="M4.5 8.5h12l-3.5-3.5M19.5 15.5h-12l3.5 3.5"/>',
};

export function icon(name: string, size = 20) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('class', 'ic');
  s.setAttribute('fill', name === 'play' || name === 'more' ? 'currentColor' : 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.6');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = P[name] || '';
  return s;
}
