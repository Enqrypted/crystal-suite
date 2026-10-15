// Line icons (24×24 grid, currentColor).
const P: Record<string, string> = {
  new: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M12 11v6M9 14h6"/>',
  open: '<path d="M3.5 7.5v12h15l2-8H7l-2 8"/><path d="M3.5 7.5V5h6l2 2h7v4.5"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  render: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>',
  undo: '<path d="M9 7L4.5 11.5 9 16"/><path d="M4.5 11.5H14a5.5 5.5 0 0 1 0 11h-2"/>',
  redo: '<path d="M15 7l4.5 4.5L15 16"/><path d="M19.5 11.5H10a5.5 5.5 0 0 0 0 11h2"/>',
  cut: '<circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/><path d="M8.3 15.7L18 4M15.7 15.7L6 4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="1.5"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>',
  paste: '<rect x="5" y="4.5" width="14" height="16" rx="1.5"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h6"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5l1 13.5h9l1-13.5"/>',
  split: '<path d="M12 3v18"/><path d="M7 7l-3.5 5L7 17M17 7l3.5 5L17 17"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
  ripple: '<path d="M3.5 8h7M3.5 16h17"/><path d="M14 5l3 3-3 3M17 8h3.5"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
  loop: '<path d="M4 12a6 6 0 0 1 6-6h8M15 3l3 3-3 3"/><path d="M20 12a6 6 0 0 1-6 6H6M9 21l-3-3 3-3"/>',
  start: '<path d="M5 5v14"/><path d="M19 5v14L8 12z" fill="currentColor"/>',
  end: '<path d="M19 5v14"/><path d="M5 5v14l11-7z" fill="currentColor"/>',
  prev: '<path d="M7 5v14"/><path d="M17 7v10l-7-5z" fill="currentColor"/>',
  next: '<path d="M17 5v14"/><path d="M7 7v10l7-5z" fill="currentColor"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5M10.5 8v5"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  import: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 15v4.5h15V15"/>',
  text: '<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>',
  solid: '<rect x="4.5" y="4.5" width="15" height="15" rx="2" fill="currentColor" opacity=".6"/><rect x="4.5" y="4.5" width="15" height="15" rx="2"/>',
  gradient: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/><path d="M4.5 15l11-10.5M4.5 19.5L19.5 5M9 19.5l10.5-10"/>',
  marker: '<path d="M6 21V4h11l-2.5 4L17 12H6"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M7 5v14M17 5v14M3.5 9H7M3.5 15H7M17 9h3.5M17 15h3.5"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4.5 4.5"/>',
  folder: '<path d="M3.5 6.5h6l2 2h9v11h-17z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  fx: '<path d="M5 19l3-14h6M6 11h6"/><path d="M14 11l5 8M19 11l-5 8"/>',
  crop: '<path d="M7 3v14h14M3 7h14v14"/>',
  speaker: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  video: '<rect x="3.5" y="6.5" width="12" height="11" rx="1.5"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
  audio: '<path d="M4 12h2M8 8v8M12 5v14M16 9v6M20 11v2"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.5a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .9-1 1.6v.6M12 16.8v.2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  transition: '<rect x="3.5" y="6" width="10" height="12" rx="1"/><rect x="10.5" y="6" width="10" height="12" rx="1"/>',
};

export function icon(name: string, size = 16) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? ''}</svg>`;
}

export function iconEl(name: string, size = 16) {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = icon(name, size);
  return span.firstElementChild as SVGElement;
}
