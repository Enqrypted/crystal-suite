// Builds the Crystal Suite website into site/: the home page, landing pages for the searches people make
// ("free Photoshop alternative", "Adobe Creative Cloud alternative"), the download page, a page per app,
// a 404 page, sitemap.xml and robots.txt. Versions and sizes come from catalog.json; screenshots live in
// site/img and the social cards in site/img/og (made by scripts/build-site-images.cjs).
//
//   node scripts/build-site.cjs              -> site/*.html, sitemap.xml, robots.txt
//   SITE_URL=https://example.com/ node scripts/build-site.cjs   (another address for canonical links)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const REPO = 'https://github.com/Enqrypted/crystal-suite';
/** Where the site is published (GitHub Pages); canonical links, the sitemap and social cards use it. */
const SITE_URL = (process.env.SITE_URL || 'https://enqrypted.github.io/crystal-suite/').replace(/\/?$/, '/');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const LAUNCHER = catalog.launcher.version;
const LAUNCHER_SIZE = '71 MB'; // CrystalSuite-Setup-<v>.exe on the release
const SETUP = `${REPO}/releases/download/v${LAUNCHER}/CrystalSuite-Setup-${LAUNCHER}.exe`;
const PORTABLE = `${REPO}/releases/download/v${LAUNCHER}/CrystalSuite-Portable-${LAUNCHER}.exe`;
const TODAY = new Date().toISOString().slice(0, 10);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mb = (bytes) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);
const shotDims = { w: 2880, h: 1800 };
const dims = { 'facet-desktop.webp': [2200, 1376], 'facet-window.webp': [2360, 1520], 'launcher.webp': [2360, 1800] };
const img = (src, alt, cls = '', eager = false) => {
  const [w, h] = dims[src] ?? [shotDims.w, shotDims.h];
  return `<img src="img/${src}" width="${w}" height="${h}" alt="${esc(alt)}"${cls ? ` class="${cls}"` : ''}${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
};

const APPS = [
  {
    id: 'photon', name: 'Photon', tag: 'Photo editing, retouching & compositing', alt: 'Alternative to Photoshop',
    blurb: 'A layered image editor laid out like Photoshop, with its tools, panels and shortcuts. Retouch photos, build composites, and open or save PSD files.',
    ticks: ['Layers, groups, masks and all 27 blend modes', 'Curves, Levels, Camera Raw, Liquify and dozens of filters', 'Opens and saves PSD, PNG, JPEG, WebP and more'],
    shots: [['photon-layers.webp', 'Photon editing a layered landscape, with a Curves adjustment layer selected and the Layers panel open', 'A Curves adjustment layer over a grouped landscape, with Photoshop-style panels.']],
    features: [
      ['Layers that behave', 'Pixel, type, shape, fill and adjustment layers, groups, masks, clipping masks, and layer styles from Drop Shadow to Bevel & Emboss.'],
      ['Real selections', 'Magic Wand, Quick Selection, lassos, Color Range, Select Subject, Select and Mask, and Quick Mask.'],
      ['Adjustments and filters', 'Curves, Levels, Hue/Saturation and more as adjustment layers. Camera Raw, Liquify, blurs and distortions with a live preview.'],
      ['A proper brush engine', 'Size, hardness, flow, pen pressure, jitter and smoothing, plus healing, patch, clone, pattern stamp and history brushes.'],
      ['PSD in and out', 'Open PSDs with their layers and masks, save back to PSD, or keep everything editable in a Photon project.'],
      ['Export Layer As', 'Export each layer trimmed to its content as PNG, JPEG or WebP, with a live preview of the result.'],
    ],
  },
  {
    id: 'prism', name: 'Prism', tag: 'Clean, private web browser', alt: 'Alternative to Chrome',
    blurb: 'A Chromium browser with ad and tracker blocking built in, and nothing you didn’t ask for: no account, no sync, no news feed, no telemetry.',
    ticks: ['Blocks ads and trackers with uBlock Origin and EasyList filters', 'HTTPS everywhere, third-party cookies blocked, private windows', 'The same engine as Chrome and Edge, so sites just work'],
    shots: [
      ['prism-browsing.webp', 'Prism showing a Wikipedia article in one of three tabs, with the tracker shield in the toolbar', 'The shield in the toolbar counts what was blocked on each page.'],
      ['prism-newtab.webp', 'Prism’s new tab page with a search box and recent sites', 'A quiet new tab: search, your sites, nothing sponsored.'],
    ],
    features: [
      ['Ads and trackers blocked', 'EasyList, EasyPrivacy and uBlock Origin filters, on by default. The shield shows what each page tried to load.'],
      ['Private by default', 'Third-party cookies blocked, every site upgraded to HTTPS, Global Privacy Control sent, and no WebRTC address leaks.'],
      ['Private windows', 'Nothing is written to disk, and everything is dropped when the last private window closes.'],
      ['Feels familiar', 'Tabs, address bar suggestions, bookmarks, history, downloads, find in page, zoom per site and developer tools.'],
      ['Your search engine', 'DuckDuckGo by default, or Brave Search, Startpage, Ecosia, Google or Bing.'],
      ['Also on its own', 'Install Prism from the launcher, or download the standalone Prism installer.'],
    ],
  },
  {
    id: 'cut', name: 'Cut', tag: 'Video editing', alt: 'Alternative to Vegas Pro',
    blurb: 'A video editor laid out like Sony Vegas Pro: media, preview and properties on top, the timeline below. Cut, layer, mix and render to MP4 or WebM.',
    ticks: ['Multitrack timeline with ripple editing, snapping and markers', 'Fades, crossfades, transitions, Pan/Crop and video effects', 'Renders MP4 or WebM up to 4K, using your graphics card'],
    shots: [
      ['cut-timeline.webp', 'Cut with three pictures, two titles and a music track on the timeline, and the title showing in the preview', 'Titles over pictures with crossfades and a music bed, Vegas-style.'],
      ['cut-render.webp', 'Cut’s Render As dialog with MP4 format, resolution, frame rate and quality options', 'Render As: MP4 or WebM, up to 4K, with a size estimate.'],
    ],
    features: [
      ['A real timeline', 'Video and audio tracks, split with S, trim, ripple editing, snapping to edges and markers, loop a time selection.'],
      ['Vegas-style handles', 'Drag an event’s top corners for fades and its top edge for volume or opacity. Overlap two events for a crossfade.'],
      ['Mix the audio', 'Event and track volume and pan, mute and solo, normalize, and a master bus with peak meters.'],
      ['Picture tools', 'Transitions, Pan/Crop with Ken Burns moves, brightness, contrast, color, blur and more.'],
      ['Titles and generators', 'Text, titles, lower thirds, solid colors and gradients.'],
      ['Render As', 'MP4 (H.264 + AAC) or WebM (VP9 + Opus), up to 4K, with hardware encoding when your PC has it.'],
    ],
  },
  {
    id: 'facet', name: 'Facet', tag: 'Desktop folders & widgets', alt: 'iPhone-style widgets',
    blurb: 'Folders and widgets that live on the Windows desktop itself: iPhone-style folders for your shortcuts, a clock, Spotify and a Control Center, in liquid glass.',
    ticks: ['Folders you name and fill with apps, files and shortcuts', 'Clock, Spotify, Control Center and Recent folders widgets', 'Tidies your desktop in one click, without moving a file'],
    shots: [
      ['facet-desktop.webp', 'A Windows desktop with a glass clock, a Photos panel and two folders called Crystal Suite and Tools', 'Glass folders, a panel and a clock over the wallpaper.'],
      ['facet-window.webp', 'The Facet window listing the widgets on the desktop and its settings', 'Everything on your desktop, in one window.'],
    ],
    features: [
      ['Folders like on an iPhone', 'A tile that opens in place. Drag apps, files and folders in, rename it, or show it as an always-open panel.'],
      ['Liquid glass', 'Clear glass over your actual wallpaper, with a bright edge and a highlight that follows the pointer.'],
      ['A clock you design', 'Four faces, six fonts, weight, size and colour, 12 or 24-hour, seconds and the date.'],
      ['Spotify and Control Center', 'Now playing with its controls, plus Wi-Fi, Bluetooth, night light, brightness and volume.'],
      ['Organize desktop', 'Sorts your desktop into Apps, Games, Documents, Pictures and more. Nothing is moved: folders hold shortcuts.'],
      ['Light on your PC', 'Starts when you sign in and idles at well under 1% CPU.'],
    ],
  },
  {
    id: 'quartz', name: 'Quartz', tag: 'PDF reader & editor', alt: 'Alternative to Acrobat',
    blurb: 'Read, fill, sign and edit PDFs. Quartz opens documents in tabs, adds highlights, notes and signatures, and rearranges pages.',
    ticks: ['Highlight, draw, and add text, pictures and signatures', 'Fill in forms, and sign by drawing, typing or with a photo', 'Reorder, rotate, insert, extract, combine and split pages'],
    shots: [
      ['quartz-annotate.webp', 'Quartz showing a project brief with a highlighted sentence, a circled number and a red note', 'Highlights, pen marks and notes, saved as standard PDF annotations.'],
      ['quartz-sign.webp', 'Quartz’s Sign dialog with a typed name shown in five handwriting styles', 'Sign by drawing, typing your name, or from a photo of your signature.'],
      ['quartz-organize.webp', 'Quartz’s page organizer with nine pages, two of them selected', 'Organize pages: drag to reorder, rotate, insert, extract.'],
    ],
    features: [
      ['Read comfortably', 'Tabs, page thumbnails, the outline, search, zoom, two-page layouts and a night mode.'],
      ['Annotate', 'Highlights, drawings, text boxes and pictures, saved as standard annotations that other PDF readers show.'],
      ['Fill and sign', 'Fill in PDF forms. Sign by drawing, typing in a handwriting font, or from a photo of your signature.'],
      ['Organize pages', 'Drag pages to reorder, rotate, delete, duplicate, or insert blank pages and pages from other PDFs.'],
      ['Combine and split', 'Merge several PDFs into one, or split a document by page ranges, every few pages, or page by page.'],
      ['Export and print', 'Save pages as PNG or JPEG, save the text, and print through the Windows print dialog.'],
    ],
  },
  {
    id: 'onyx', name: 'Onyx', tag: 'Instant replay for games', alt: 'Like ShadowPlay’s instant replay',
    blurb: 'Onyx keeps the last two minutes of your games ready to save. When something great happens, press Ctrl+Shift+G and keep it as a clip.',
    ticks: ['Records every game you open by itself, Roblox included', 'Ctrl+Shift+G saves the last 15 or 30 seconds, 1 or 2 minutes', 'Runs on your graphics card’s encoder, so games keep their frame rate'],
    shots: [
      ['onyx-picker.webp', 'A neon racing game with Onyx’s clip picker at the top of the screen, offering 15 seconds, 30 seconds, 1 minute or 2 minutes', 'Press Ctrl+Shift+G in game, pick a length, done.'],
      ['onyx-window.webp', 'The Onyx window with two games recording, their save buttons, the clips below and the settings', 'Every open game records on its own; your clips are right below.'],
      ['onyx-games.webp', 'Onyx’s What to record section, with two games recognised and other apps left alone', 'Onyx tells games from other apps, and you can correct it.'],
    ],
    features: [
      ['Save it after it happens', 'The last two minutes are always kept. Pick 15 or 30 seconds, 1 or 2 minutes, and it’s an MP4 in Videos\\Onyx.'],
      ['Finds your games', 'Games Windows knows, games from Steam, Epic, Riot and other launchers, Roblox, Minecraft and anything fullscreen.'],
      ['Several games at once', 'Each open game has its own replay buffer. In the picker, Tab chooses which one to save.'],
      ['Easy on your frame rate', 'Captured and encoded on the graphics card (NVIDIA, AMD or Intel), with only compressed video kept in memory.'],
      ['Your size, your sound', 'The game’s own size or 2160p down to 480p, at 30 or 60 fps, with game sound and your microphone if you like.'],
      ['Always ready', 'Starts with Windows in the tray. Your clips are in the Onyx window, with previews and a player.'],
    ],
  },
  {
    id: 'opal', name: 'Opal', tag: 'Photo viewer', alt: 'Like the Windows Photos viewer',
    blurb: 'A fast photo viewer that opens iPhone HEIC photos with no extra codecs, steps through your folders and turns HEIC into JPEG when you need to share.',
    ticks: ['Opens HEIC, AVIF, JPEG, PNG, GIF, WebP and more', 'Filmstrip, grid, zoom, slideshow and the photo’s details', 'Converts HEIC to JPEG and keeps the date taken'],
    shots: [
      ['opal-viewer.webp', 'An iPhone HEIC photo of a lake at sunset in Opal, with the details panel showing the date, camera, exposure and location, and a filmstrip of the folder below', 'Every photo in the folder, one key press apart.'],
      ['opal-grid.webp', 'Opal’s grid of a folder of iPhone photos', 'The whole folder at a glance.'],
      ['opal-convert.webp', 'Opal’s Convert HEIC photos dialog: JPEG, quality, keep the photo’s details and location', 'HEIC to JPEG for a whole folder, details included.'],
    ],
    features: [
      ['iPhone photos, no codecs', 'HEIC and HEIF open as they are, in their full Display P3 colour. No Microsoft extensions to buy or install.'],
      ['Instant', 'The preview inside a HEIC shows at once, the full photo a moment later, and the next photos are already decoded.'],
      ['Your whole folder', 'Arrow keys, swipes or the wheel, a filmstrip and a grid, sorted by name, date or size. New photos appear by themselves.'],
      ['Look closer', 'Zoom with the wheel, a pinch or a double-click, drag around, fit to the window. Full screen and slideshows.'],
      ['The details', 'When and where it was taken, the camera and lens, shutter speed, aperture and ISO, with a link to the map.'],
      ['Convert and tidy up', 'Save copies as JPEG, PNG or WebP, convert a folder at once, rotate JPEGs losslessly, delete to the Recycle Bin.'],
    ],
  },
];

/** What each app replaces and how people search for it: page title, description, headline and FAQ. */
const SEO = {
  photon: {
    replaces: 'Photoshop', color: '#31a8ff', category: 'MultimediaApplication', sub: 'Photo editor',
    title: 'Photon – Free Photoshop-Style Photo Editor for Windows',
    description: 'Photon is a free photo editor for Windows laid out like Photoshop: layers, masks, blend modes, filters, layer styles and PSD files. No subscription.',
    h1: 'A free photo editor that works like Photoshop',
    faq: [
      ['Is Photon a free Photoshop alternative?', 'Yes. Photon is free and open source, and it is laid out like Photoshop: the same kind of tools, panels, menus and keyboard shortcuts, with layers, masks, adjustment layers, blend modes, filters and layer styles. There is no subscription and no account.'],
      ['Can Photon open and save PSD files?', 'Yes. Photon opens PSD files with their layers, groups, masks, blend modes, opacity and clipping masks, and saves layered PSD files that open in Photoshop, GIMP and Photopea. Its own .phtn project format keeps type, shape, fill and adjustment layers editable.'],
      ['Does Photon work offline?', 'Yes. Photon runs entirely on your PC. The internet is only used by the Crystal Suite launcher to check for updates.'],
      ['Does Photon run on Mac or Linux?', 'Not yet. Crystal Suite is made for Windows 10 and Windows 11 (64-bit).'],
    ],
  },
  prism: {
    replaces: 'Chrome', color: '#b794ff', category: 'BrowserApplication', sub: 'Web browser',
    title: 'Prism – Free Private Browser with Built-in Ad Blocker for Windows',
    description: 'Prism is a free Chromium browser for Windows with ad and tracker blocking built in, HTTPS everywhere and private windows. No account, no sync, no telemetry.',
    h1: 'A private browser with the ad blocker built in',
    faq: [
      ['Does Prism block ads?', 'Yes. Prism blocks ads and trackers by default with the EasyList, EasyPrivacy and uBlock Origin filter lists, and hides leftover ad slots. A shield in the toolbar shows what was blocked and turns protection off for a site.'],
      ['Is Prism based on Chromium?', 'Yes. Prism uses the same engine as Chrome and Edge, so websites work as you expect.'],
      ['Does Prism collect data?', 'No. Prism has no account, no sync and no telemetry, blocks third-party cookies and upgrades sites to HTTPS.'],
    ],
  },
  cut: {
    replaces: 'Premiere Pro & Vegas', color: '#9999ff', category: 'MultimediaApplication', sub: 'Video editor',
    title: 'Cut – Free Video Editor for Windows (Vegas Pro Alternative)',
    description: 'Cut is a free video editor for Windows laid out like Vegas Pro: multitrack timeline, transitions, titles and MP4 export up to 4K. No watermark.',
    h1: 'A free video editor laid out like Vegas Pro',
    faq: [
      ['Does Cut add a watermark?', 'No. Cut is completely free and never adds a watermark to your videos.'],
      ['What can Cut export?', 'MP4 (H.264 with AAC audio) or WebM (VP9 with Opus), at your project size or a preset up to 4K, using your graphics card’s encoder when your PC has one.'],
      ['Is Cut like Vegas Pro?', 'Cut follows the Vegas Pro layout: media, preview and properties on top, the timeline below, with Vegas-style fade and volume handles on each event and automatic crossfades.'],
    ],
  },
  facet: {
    replaces: 'Messy desktops', color: '#5ce1c6', category: 'DesktopEnhancementApplication', sub: 'Desktop widgets',
    title: 'Facet – Free Desktop Widgets & iPhone-Style Folders for Windows',
    description: 'Facet adds iPhone-style folders and widgets to the Windows desktop: a clock, Spotify and a Control Center, in liquid glass. Free and light on your PC.',
    h1: 'iPhone-style folders and widgets for your desktop',
    faq: [
      ['Does Facet move my desktop files?', 'No. Facet’s folders hold shortcuts, so nothing on your desktop is moved or deleted.'],
      ['Does Facet slow down my PC?', 'No. Facet starts when you sign in and idles at well under 1% CPU.'],
      ['Does the Spotify widget need my account?', 'No. It reads Windows’ own media controls, so it works with the Spotify app without signing in.'],
    ],
  },
  quartz: {
    replaces: 'Acrobat', color: '#ff7a6b', category: 'BusinessApplication', sub: 'PDF editor',
    title: 'Quartz – Free PDF Editor for Windows (Adobe Acrobat Alternative)',
    description: 'Quartz is a free PDF editor for Windows: annotate, fill forms, sign, merge and split PDFs. An Adobe Acrobat alternative with no subscription.',
    h1: 'A free PDF editor, without the Acrobat subscription',
    faq: [
      ['Can I sign PDFs for free with Quartz?', 'Yes. Sign by drawing, by typing your name in a handwriting font, or from a photo of your signature. Signatures are kept for next time.'],
      ['Can Quartz merge and split PDFs?', 'Yes. Combine several PDFs into one, split a document by page ranges or page by page, and reorder, rotate, insert or delete pages.'],
      ['Will other PDF readers show my annotations?', 'Yes. Quartz saves highlights, drawings and notes as standard PDF annotations.'],
    ],
  },
  onyx: {
    replaces: 'ShadowPlay', color: '#b6ff5c', category: 'GameApplication', sub: 'Game recorder',
    title: 'Onyx – Free Instant Replay Game Recorder for Windows',
    description: 'Onyx keeps the last two minutes of your games ready to save: press Ctrl+Shift+G for a clip. Finds games by itself, Roblox included. Free for Windows.',
    h1: 'Instant replay for every game you play',
    faq: [
      ['Does Onyx work with Roblox?', 'Yes. Onyx recognises Roblox and Roblox Studio, Minecraft and games from Steam, Epic, Riot and other launchers, and records anything running fullscreen.'],
      ['Will Onyx lower my frame rate?', 'Onyx captures and encodes on your graphics card (NVIDIA NVENC, AMD or Intel Quick Sync) and only keeps compressed video in memory, so games keep their frame rate.'],
      ['Where are the clips saved?', 'As MP4 files in your Videos\\Onyx folder, ready to share.'],
    ],
  },
  opal: {
    replaces: 'Windows Photos', color: '#ffc65c', category: 'MultimediaApplication', sub: 'Photo viewer',
    title: 'Opal – Free HEIC Photo Viewer for Windows (Convert HEIC to JPG)',
    description: 'Opal is a free photo viewer for Windows that opens iPhone HEIC photos without extra codecs and converts HEIC to JPG, keeping the date taken.',
    h1: 'Open iPhone HEIC photos on Windows, free',
    faq: [
      ['Can Opal open HEIC files without the HEIF extensions?', 'Yes. Opal brings its own HEIC decoder (libheif), so iPhone photos open without Microsoft’s HEIF or HEVC extensions.'],
      ['Can Opal convert HEIC to JPG?', 'Yes. Save a copy of one photo, or convert every HEIC photo in a folder to JPEG at once. The copies keep the date taken and camera details, and the location if you choose.'],
      ['Which formats does Opal open?', 'HEIC and HEIF, AVIF, JPEG, PNG, GIF and WebP (animations play), BMP and ICO.'],
    ],
  },
};
for (const a of APPS) Object.assign(a, SEO[a.id]);
for (const a of APPS) {
  const c = catalog.apps.find((x) => x.id === a.id);
  a.version = c?.version ?? '';
  a.size = c ? mb(c.size) : '';
}

/** Adobe apps and what Crystal Suite has in their place. */
const ADOBE = [
  ['Photoshop', 'photon', 'Photon', 'Layers, masks, blend modes, adjustment layers, filters, layer styles, PSD open and save.'],
  ['Acrobat', 'quartz', 'Quartz', 'Read, annotate, fill, sign, merge and split PDFs.'],
  ['Premiere Pro', 'cut', 'Cut', 'Multitrack video editing with transitions, titles and 4K MP4 export.'],
  ['Bridge & photo viewing', 'opal', 'Opal', 'Browse folders of photos, iPhone HEIC included, and convert them to JPEG.'],
  ['Lightroom', null, 'Darkroom', 'Photo library and RAW development. Planned.'],
  ['Illustrator', null, 'Vector', 'Vector illustration and logos. Planned.'],
  ['After Effects', null, 'Motion', 'Motion graphics and effects. Planned.'],
  ['InDesign', null, 'Layout', 'Page layout and publishing. Planned.'],
];

const ICON = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  cross: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  windows: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5.5l7.5-1v7H3zm8.5-1.2L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zm8.5 0H21V21l-9.5-1.3z"/></svg>',
};

const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';

// ---------- structured data ----------
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...obj }).replace(/</g, '\\u003c')}</script>`;
const softwareLd = (name, description, url, image, extra = {}) => ({
  '@type': 'SoftwareApplication', name, description, url, image,
  operatingSystem: 'Windows 10, Windows 11', applicationCategory: 'MultimediaApplication',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  isAccessibleForFree: true, license: `${REPO}/blob/main/LICENSE`, downloadUrl: SETUP,
  publisher: { '@type': 'Organization', name: 'Crystal Suite', url: SITE_URL },
  ...extra,
});
const faqLd = (faq) => ({ '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
const crumbsLd = (items) => ({ '@type': 'BreadcrumbList', itemListElement: items.map(([name, file], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE_URL + (file === 'index.html' ? '' : file) })) });

// ---------- shell ----------
function header(current) {
  const menu = APPS.map((a) => `<a href="${a.id}.html"${current === a.id ? ' aria-current="page"' : ''}><img src="img/icons/${a.id}.png" alt="" width="36" height="36"><b>${a.name}</b><span>${esc(a.sub)} &middot; replaces ${esc(a.replaces)}</span></a>`).join('');
  return `<header class="site-header"><div class="wrap">
  <a class="brand" href="index.html"><img src="img/icons/suite.png" alt="" width="30" height="30"><span>Crystal Suite</span></a>
  <nav class="nav" aria-label="Main">
    <details class="apps-menu"><summary>Apps</summary><div class="menu">${menu}</div></details>
    <a class="hide-sm" href="free-photoshop-alternative.html"${current === 'photoshop' ? ' aria-current="page"' : ''}>Photoshop alternative</a>
    <a class="hide-md" href="adobe-alternative.html"${current === 'adobe' ? ' aria-current="page"' : ''}>vs Adobe</a>
    <a class="hide-md" href="${REPO}">GitHub</a>
    <a class="btn small header-dl" href="download.html">${ICON.download}Download</a>
  </nav>
</div></header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="wrap">
  <div class="foot-grid">
    <div class="foot-brand">
      <a class="brand" href="index.html"><img src="img/icons/suite.png" alt="" width="30" height="30"><span>Crystal Suite</span></a>
      <p>Free, open-source creative apps for Windows. No account, no subscription, no telemetry.</p>
      <a class="btn small ghost" href="download.html">${ICON.download}Download free</a>
    </div>
    <nav aria-label="Apps"><h2>Apps</h2>${APPS.map((a) => `<a href="${a.id}.html">${a.name} <span>${esc(a.sub)}</span></a>`).join('')}</nav>
    <nav aria-label="Alternatives"><h2>Free alternatives</h2>
      <a href="free-photoshop-alternative.html">Photoshop alternative</a>
      <a href="adobe-alternative.html">Creative Cloud alternative</a>
      <a href="quartz.html">Acrobat alternative</a>
      <a href="cut.html">Vegas Pro alternative</a>
      <a href="opal.html">HEIC viewer for Windows</a>
      <a href="onyx.html">ShadowPlay alternative</a>
    </nav>
    <nav aria-label="Project"><h2>Project</h2>
      <a href="download.html">Download</a>
      <a href="${REPO}">Source code</a>
      <a href="${REPO}/releases">Releases</a>
      <a href="${REPO}/issues">Report a problem</a>
      <a href="${REPO}/blob/main/LICENSE">MIT license</a>
    </nav>
  </div>
  <p class="fine">Crystal Suite is free and open-source software under the MIT license, made by independent contributors. Adobe, Photoshop, Acrobat, Premiere Pro, Lightroom, Illustrator, After Effects, InDesign, Bridge and Creative Cloud are trademarks of Adobe; Chrome of Google; Vegas Pro of MAGIX; iPhone of Apple; ShadowPlay of NVIDIA; Roblox of Roblox Corporation. Crystal Suite is not affiliated with or endorsed by any of them; their names are used only to describe what the apps are alike.</p>
</div></footer>`;
}

function page({ file, title, description, body, current, bodyClass = '', image = 'img/og/home.jpg', ldItems = [], preload = '', noindex = false, absolute = false }) {
  const url = SITE_URL + (file === 'index.html' ? '' : file);
  const abs = (s) => (absolute ? s.replace(/(href|src)="(?!https?:|#|mailto:|data:)([^"]*)"/g, (_m, a, p) => `${a}="${SITE_URL}${p}"`) : s);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${url}">`}
<meta name="theme-color" content="#08080f">
<meta name="color-scheme" content="dark">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Crystal Suite">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE_URL}${image}">
<link rel="icon" type="image/png" sizes="64x64" href="img/icons/favicon-64.png">
<link rel="icon" type="image/png" sizes="192x192" href="img/icons/suite.png">
<link rel="apple-touch-icon" href="img/icons/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="style.css">
${preload ? `<link rel="preload" as="image" href="img/${preload}" fetchpriority="high">` : ''}
<script>document.documentElement.classList.add('js')</script>
${ldItems.map(ld).join('\n')}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
<div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<a class="skip" href="#main">Skip to content</a>
${header(current)}
<main id="main">
${body}
</main>
${footer()}
<script src="site.js" defer></script>
</body>
</html>
`;
  return abs(html);
}

// ---------- shared blocks ----------
const trust = `<ul class="trust">
  <li>${ICON.check}Free forever</li><li>${ICON.check}No account</li><li>${ICON.check}Open source (MIT)</li><li>${ICON.windows}Windows 10 &amp; 11</li>
</ul>`;

const cta = (title = 'Get Crystal Suite free', text = 'One small launcher for Windows 10 and 11. Install the apps you want with one click; they keep themselves up to date.') => `<section class="cta reveal"><div class="wrap">
  <div class="cta-card">
    <div class="cta-glow" aria-hidden="true"></div>
    <div class="cta-icons" aria-hidden="true">${APPS.map((a) => `<img src="img/icons/${a.id}.png" alt="" width="56" height="56" loading="lazy">`).join('')}</div>
    <h2>${title}</h2>
    <p class="lede">${text}</p>
    <div class="cta-row center"><a class="btn big" href="download.html">${ICON.download}Download for Windows</a><a class="btn big ghost" href="${REPO}">${ICON.github}Source on GitHub</a></div>
    <p class="meta">Version ${LAUNCHER} &middot; ${LAUNCHER_SIZE} &middot; no account needed</p>
  </div>
</div></section>`;

const faqBlock = (faq, title = 'Questions, answered') => `<section class="faq-sec"><div class="wrap narrow">
  <div class="section-head center reveal"><span class="eyebrow">FAQ</span><h2>${title}</h2></div>
  <div class="faq">${faq.map(([q, a], i) => `<details class="reveal"${i === 0 ? ' open' : ''}><summary><h3>${esc(q)}</h3></summary><p>${esc(a)}</p></details>`).join('')}</div>
</div></section>`;

const marquee = () => {
  const items = [...APPS.map((a) => [a.replaces, a.name, a.id]), ['Lightroom', 'Darkroom (soon)', null], ['Illustrator', 'Vector (soon)', null]];
  const row = items.map(([r, n, id]) => `<span class="swap">${esc(r)} ${ICON.arrow} ${id ? `<img src="img/icons/${id}.png" alt="" width="22" height="22">` : ''}<b>${esc(n)}</b></span>`).join('');
  return `<div class="marquee" aria-label="What Crystal Suite replaces"><div class="track">${row}${row.replace(/<span class="swap">/g, '<span class="swap" aria-hidden="true">')}</div></div>`;
};

const bento = () => `<div class="bento">${APPS.map((a, i) => `<a class="tile reveal t-${a.id}${i === 0 ? ' big' : ''}" href="${a.id}.html" style="--c:${a.color}">
  <div class="tile-head"><img src="img/icons/${a.id}.png" alt="" width="52" height="52" loading="lazy"><div><h3>${a.name}</h3><span>${esc(a.sub)}</span></div><em>replaces ${esc(a.replaces)}</em></div>
  <p>${esc(a.blurb)}</p>
  ${i === 0 ? `<ul class="ticks">${a.ticks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
  <div class="tile-shot">${img(a.shots[0][0], a.shots[0][1])}</div>
  <span class="tile-more">Explore ${a.name} ${ICON.arrow}</span>
</a>`).join('')}</div>`;

const compareTable = (rows, cols) => `<div class="table-wrap reveal"><table class="compare">
  <thead><tr><th scope="col"><span class="sr">Feature</span></th>${cols.map((c, i) => `<th scope="col"${i === 0 ? ' class="us"' : ''}>${c}</th>`).join('')}</tr></thead>
  <tbody>${rows.map(([f, ...v]) => `<tr><th scope="row">${f}</th>${v.map((x, i) => `<td${i === 0 ? ' class="us"' : ''}>${x === true ? `<span class="yes">${ICON.check}</span>` : x === false ? `<span class="no">${ICON.cross}</span>` : x}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`;

const HOME_FAQ = [
  ['Is Crystal Suite really free?', 'Yes. Every app is free and open source under the MIT license. There is no paid tier, no trial, no ads and nothing to unlock.'],
  ['Is it a free alternative to Adobe Creative Cloud?', 'Crystal Suite covers the everyday Creative Cloud jobs with free apps: Photon for photo editing (like Photoshop), Quartz for PDFs (like Acrobat), Cut for video (like Premiere Pro or Vegas Pro) and Opal for viewing photos. Vector, Darkroom, Motion and Layout are planned.'],
  ['Do I need an account?', 'No. There is nothing to sign up for. Your files stay on your PC, and the apps work offline.'],
  ['Can it open Photoshop (PSD) files?', 'Yes. Photon opens PSD files with their layers, masks, blend modes and opacity, and saves layered PSD files that Photoshop opens.'],
  ['Is it safe to install?', 'The source code is public on GitHub. The installer isn’t code-signed yet, so Windows SmartScreen may warn the first time: click More info, then Run anyway. Every app download is checked against its published SHA-256 checksum.'],
  ['Does it work on Mac or Linux?', 'Not yet. Crystal Suite is made for Windows 10 and Windows 11 (64-bit).'],
];

// ---------- pages ----------
const home = {
  file: 'index.html', current: 'home', preload: 'photon-layers.webp',
  title: 'Crystal Suite – Free Adobe Creative Cloud Alternative for Windows',
  description: 'Free, open-source alternatives to Photoshop, Acrobat and Premiere Pro for Windows: a photo editor that opens PSD files, a PDF editor, a video editor and more.',
  ldItems: [
    { '@type': 'WebSite', name: 'Crystal Suite', url: SITE_URL },
    softwareLd('Crystal Suite', 'Free, open-source creative suite for Windows: photo editor (Photoshop alternative), PDF editor (Acrobat alternative), video editor, browser, photo viewer and more.', SITE_URL, `${SITE_URL}img/og/home.jpg`, { softwareVersion: LAUNCHER, fileSize: LAUNCHER_SIZE }),
    faqLd(HOME_FAQ),
  ],
  body: `<section class="hero"><div class="wrap hero-grid">
  <div class="hero-copy">
    <span class="pill"><i></i>Free &amp; open source &middot; ${APPS.length} apps</span>
    <h1>The <span class="grad">free alternative</span> to Adobe Creative Cloud.</h1>
    <p class="lede">A Photoshop-style photo editor that opens PSD files, a PDF editor, a video editor and more, in one small launcher for Windows. No subscription, no account, no telemetry.</p>
    <div class="cta-row"><a class="btn big" href="download.html">${ICON.download}Download free</a><a class="btn big ghost" href="free-photoshop-alternative.html">See the Photoshop alternative ${ICON.arrow}</a></div>
    ${trust}
  </div>
  <div class="hero-visual">
    <div class="stage"><figure class="shot tilt">${img('photon-layers.webp', 'Photon, a free Photoshop alternative, editing a layered landscape with Curves and the Layers panel', '', true)}</figure></div>
    <div class="orbit" aria-hidden="true">${APPS.map((a, i) => `<img class="o o${i}" src="img/icons/${a.id}.png" alt="" width="60" height="60">`).join('')}</div>
  </div>
</div></section>

${marquee()}

<section id="apps"><div class="wrap">
  <div class="section-head reveal"><span class="eyebrow">${APPS.length} apps, one launcher</span><h2>Everything you pay Adobe for. <span class="dim">Free.</span></h2><p class="lede">Install only the apps you want. Each one gets its own shortcut, opens on its own and keeps itself up to date.</p></div>
  ${bento()}
</div></section>

<section class="spot"><div class="wrap spot-grid">
  <div class="spot-copy reveal">
    <span class="eyebrow">Photon &middot; photo editor</span>
    <h2>Feels like Photoshop. Costs nothing.</h2>
    <p class="lede">Photon has Photoshop’s layout, tools and shortcuts, so you already know how to use it.</p>
    <ul class="ticks big">
      <li>Layers, groups, masks, clipping masks and all 27 blend modes</li>
      <li>Adjustment layers, Camera Raw, Liquify, Warp and dozens of filters</li>
      <li>Healing, Patch, Clone Stamp and Content-Aware Fill</li>
      <li>Layer styles: Drop Shadow, Bevel &amp; Emboss, Glow, Stroke and more</li>
      <li>Opens and saves layered PSD files</li>
    </ul>
    <a class="btn ghost" href="free-photoshop-alternative.html">Photon vs Photoshop ${ICON.arrow}</a>
  </div>
  <figure class="shot reveal glow-blue">${img('photon-layers.webp', 'Photon’s layers, adjustment layers and Photoshop-style panels')}</figure>
</div></section>

<section><div class="wrap">
  <div class="section-head center reveal"><span class="eyebrow">Free means free</span><h2>No account. No subscription. No catch.</h2></div>
  <div class="stats">
    <div class="stat reveal"><b>$0</b><span>forever, for every app</span></div>
    <div class="stat reveal"><b>0</b><span>accounts to create</span></div>
    <div class="stat reveal"><b>${APPS[0].size}</b><span>Photon download, thanks to the shared runtime</span></div>
    <div class="stat reveal"><b>100%</b><span>open source, MIT license</span></div>
  </div>
</div></section>

<section><div class="wrap">
  <div class="section-head reveal"><span class="eyebrow">Crystal Suite vs Creative Cloud</span><h2>How it compares</h2><p class="lede">Adobe’s apps do more. Crystal Suite does the everyday jobs, for free, on your own terms.</p></div>
  ${compareTable([
    ['Price', '<b>Free</b>', 'Monthly or yearly subscription'],
    ['Account needed', '<b>No</b>', 'Yes, an Adobe account'],
    ['Works offline', true, 'Needs periodic sign-in'],
    ['Open source', true, false],
    ['Photo editing with layers &amp; PSD', true, true],
    ['PDF editing &amp; signing', true, true],
    ['Video editing', true, true],
    ['Windows 10 &amp; 11', true, true],
    ['macOS', false, true],
  ], ['Crystal Suite', 'Adobe Creative Cloud'])}
  <p class="center more-link reveal"><a href="adobe-alternative.html">Every Adobe app and its free replacement ${ICON.arrow}</a></p>
</div></section>

${faqBlock(HOME_FAQ)}
${cta()}`,
};

const PS_FAQ = [
  ['What is the best free Photoshop alternative for Windows?', 'It depends on how you work. If you already know Photoshop, Photon is the closest match: it copies Photoshop’s layout, tools and shortcuts, opens and saves PSD files, and runs offline on Windows. It is free and open source, with no account.'],
  ['Is Photon really free, or is it a trial?', 'Really free. Photon is open source under the MIT license: no trial, no watermark, no subscription and no paid version.'],
  ['Can Photon open my PSD files?', 'Yes, with their layers, groups, masks, blend modes, opacity and clipping masks. Photon also saves layered PSD files that open in Photoshop.'],
  ['Does Photon have Photoshop’s keyboard shortcuts?', 'Yes. V for Move, B for Brush, Ctrl+T for Free Transform, Ctrl+J for Layer via Copy and the rest of the usual shortcuts work as you expect.'],
  ['What can Photoshop do that Photon can’t?', 'Photoshop has generative AI features, 3D, CMYK printing workflows, smart objects, actions and plug-ins, and runs on macOS. Photon focuses on the everyday photo editing, retouching and compositing most people use Photoshop for.'],
  ['Does Photon work without the internet?', 'Yes. Everything runs on your PC; nothing is uploaded.'],
];
const photoshopPage = {
  file: 'free-photoshop-alternative.html', current: 'photoshop', bodyClass: 'app-photon', preload: 'photon-layers.webp', image: 'img/og/photon.jpg',
  title: 'Free Photoshop Alternative for Windows – No Subscription | Photon',
  description: 'Looking for a free Photoshop alternative? Photon has Photoshop’s layout, tools and shortcuts, opens PSD files and runs offline on Windows. Free.',
  ldItems: [
    softwareLd('Photon', SEO.photon.description, `${SITE_URL}photon.html`, `${SITE_URL}img/og/photon.jpg`, { softwareVersion: APPS[0].version, applicationSubCategory: 'Photo editor', screenshot: `${SITE_URL}img/photon-layers.webp` }),
    crumbsLd([['Crystal Suite', 'index.html'], ['Free Photoshop alternative', 'free-photoshop-alternative.html']]),
    faqLd(PS_FAQ),
  ],
  body: `<section class="hero app-hero"><div class="wrap center-col">
  <img class="icon" src="img/icons/photon.png" alt="" width="88" height="88">
  <span class="eyebrow">Free Photoshop alternative &middot; Windows</span>
  <h1>The free <span class="grad">Photoshop alternative</span> that feels like Photoshop.</h1>
  <p class="lede">Photon gives you Photoshop’s layout, tools and shortcuts, opens and saves PSD files, and runs offline on your PC. No subscription. No account. No watermark.</p>
  <div class="cta-row center"><a class="btn big" href="download.html">${ICON.download}Download Photon free</a><a class="btn big ghost" href="photon.html">All of Photon’s features ${ICON.arrow}</a></div>
  ${trust}
</div>
<div class="wrap big-shot"><figure class="shot tilt-up">${img('photon-layers.webp', 'Photon, a free Photoshop alternative for Windows, with layers, a Curves adjustment layer and Photoshop-style panels', '', true)}</figure></div>
</section>

<section><div class="wrap narrow prose reveal">
  <h2>Why people look for a Photoshop alternative</h2>
  <p>Photoshop is the standard photo editor, but it is only sold as a subscription, needs an Adobe account and is a download of several gigabytes. If you edit photos now and then, retouch, make thumbnails or build composites, you pay every month for tools you use a few times.</p>
  <p>A good free alternative should do the same everyday jobs, open the PSD files you already have, and not make you learn everything again. That is what Photon is built for: it copies Photoshop’s interface, so the Layers panel, the toolbar, the options bar and the shortcuts are where your hands expect them.</p>
</div></section>

<section><div class="wrap">
  <div class="section-head reveal"><span class="eyebrow">Everything you use in Photoshop</span><h2>The tools you know, in the places you expect</h2></div>
  <div class="features">
    ${[
      ['Layers, masks &amp; blend modes', 'Pixel, type, shape, fill and adjustment layers, groups, layer masks, clipping masks, all 27 Photoshop blend modes, opacity and fill.'],
      ['Selections', 'Marquees, lassos, Magic Wand, Quick Selection, Color Range, Select Subject, Select and Mask, Quick Mask and alpha channels.'],
      ['Retouching', 'Spot Healing, Healing Brush, Patch, Clone Stamp, Content-Aware Fill, Red Eye, Dodge, Burn and Sponge.'],
      ['Adjustments', 'Levels, Curves, Hue/Saturation, Color Balance, Black &amp; White, Selective Color, Replace Color and more, as adjustment layers.'],
      ['Filters', 'Camera Raw Filter, Liquify, Gaussian and lens blurs, Unsharp Mask, noise, distort, stylize and Lens Correction, with live previews.'],
      ['Transform &amp; Warp', 'Free Transform, perspective and distort, and Warp with a Bézier grid or presets like Arc, Flag and Bulge.'],
      ['Layer styles', 'Drop Shadow, Inner Shadow, Outer and Inner Glow, Bevel &amp; Emboss, Satin, Stroke, and Color, Gradient and Pattern Overlay.'],
      ['Type &amp; shapes', 'Point and paragraph text you edit on the canvas, and rectangle, ellipse, polygon, star, line and custom shapes.'],
      ['PSD files', 'Open PSDs with their layers and masks and save layered PSDs back. Export PNG, JPEG and WebP, or each layer on its own.'],
    ].map(([t, d]) => `<div class="feature reveal"><h3>${t}</h3><p>${d}</p></div>`).join('')}
  </div>
</div></section>

<section><div class="wrap">
  <div class="section-head reveal"><span class="eyebrow">Side by side</span><h2>Photon vs Photoshop</h2><p class="lede">An honest comparison. Photoshop does more; Photon does the everyday work for free.</p></div>
  ${compareTable([
    ['Price', '<b>Free</b>', 'Subscription'],
    ['Account', '<b>None</b>', 'Adobe account required'],
    ['Download size', `<b>${APPS[0].size}</b> + the launcher`, 'Several gigabytes'],
    ['Open source', true, false],
    ['Works offline', true, 'Needs periodic sign-in'],
    ['Photoshop-style interface &amp; shortcuts', true, true],
    ['Layers, masks, 27 blend modes', true, true],
    ['Adjustment layers &amp; layer styles', true, true],
    ['Opens and saves layered PSD', true, true],
    ['Healing, Patch, Content-Aware Fill', true, true],
    ['Camera Raw, Liquify, Warp', true, true],
    ['Generative AI, 3D, actions, plug-ins', false, true],
    ['macOS', false, true],
  ], ['Photon', 'Adobe Photoshop'])}
</div></section>

<section><div class="wrap two">
  <div class="reveal">
    <span class="eyebrow">Get started in a minute</span>
    <h2>Three steps to Photon</h2>
    <ol class="steps">
      <li><div><b>Download Crystal Suite</b><p>The free launcher for Windows 10 and 11 (${LAUNCHER_SIZE}).</p></div></li>
      <li><div><b>Click Install next to Photon</b><p>A ${APPS[0].size} download that checks itself and gets its own shortcut.</p></div></li>
      <li><div><b>Open your photos and PSDs</b><p>Drag files onto Photon, or set it as the app for PSD files.</p></div></li>
    </ol>
    <a class="btn" href="download.html">${ICON.download}Download free</a>
  </div>
  <figure class="captioned reveal"><div class="shot">${img('launcher.webp', 'The Crystal Suite launcher with Photon and the other apps ready to install')}</div><figcaption>The Crystal Suite launcher: one click installs Photon.</figcaption></figure>
</div></section>

${faqBlock(PS_FAQ, 'Free Photoshop alternative: FAQ')}
${cta('Try the free Photoshop alternative', 'Photon is part of Crystal Suite: free, open source and made for Windows 10 and 11.')}`,
};

const ADOBE_FAQ = [
  ['Is there a free alternative to Adobe Creative Cloud?', 'Yes. Crystal Suite is a free, open-source set of Windows apps for the everyday Creative Cloud jobs: Photon (like Photoshop), Quartz (like Acrobat), Cut (like Premiere Pro) and Opal (photo viewing), with more apps planned.'],
  ['Can I open my Adobe files?', 'Photon opens and saves layered Photoshop PSD files, and Quartz opens, edits and saves PDFs. Other Adobe formats (AI, INDD, PRPROJ) aren’t supported.'],
  ['Why is it free?', 'Crystal Suite is an independent open-source project under the MIT license. It has no ads, no telemetry and no paid version.'],
  ['Is Crystal Suite as powerful as Adobe’s apps?', 'No. Adobe’s apps have many more features. Crystal Suite covers the everyday work—photo editing, PDFs, video—without a subscription.'],
];
const adobePage = {
  file: 'adobe-alternative.html', current: 'adobe', preload: 'photon-layers.webp',
  title: 'Free Adobe Creative Cloud Alternative for Windows | Crystal Suite',
  description: 'Free alternatives to Adobe Creative Cloud for Windows: Photon for Photoshop, Quartz for Acrobat, Cut for Premiere Pro. No subscription, open source.',
  ldItems: [
    crumbsLd([['Crystal Suite', 'index.html'], ['Adobe Creative Cloud alternative', 'adobe-alternative.html']]),
    { '@type': 'ItemList', name: 'Free alternatives to Adobe apps', itemListElement: ADOBE.filter((r) => r[1]).map(([adobe, id, name], i) => ({ '@type': 'ListItem', position: i + 1, name: `${name} (free ${adobe} alternative)`, url: `${SITE_URL}${id}.html` })) },
    faqLd(ADOBE_FAQ),
  ],
  body: `<section class="hero app-hero"><div class="wrap center-col">
  <span class="pill"><i></i>Cancel the subscription</span>
  <h1>A free alternative to <span class="grad">Adobe Creative Cloud</span>.</h1>
  <p class="lede">Crystal Suite replaces the Adobe apps most people use with free, open-source apps for Windows. No subscription, no Adobe account, no telemetry.</p>
  <div class="cta-row center"><a class="btn big" href="download.html">${ICON.download}Download free</a><a class="btn big ghost" href="#map">See the replacements</a></div>
  ${trust}
</div></section>

<section id="map" style="padding-top:0"><div class="wrap">
  <div class="swaps">
    ${ADOBE.map(([adobe, id, name, what]) => {
      const a = APPS.find((x) => x.id === id);
      return `<${id ? `a href="${id}.html"` : 'div'} class="swap-card reveal${id ? '' : ' soon'}"${a ? ` style="--c:${a.color}"` : ''}>
      <span class="from">${esc(adobe)}</span><span class="arrow">${ICON.arrow}</span>
      <span class="to">${id ? `<img src="img/icons/${id}.png" alt="" width="40" height="40" loading="lazy">` : '<i class="ph"></i>'}<b>${esc(name)}</b>${id ? '<em>Free</em>' : '<em class="later">Planned</em>'}</span>
      <p>${esc(what)}</p>
    </${id ? 'a' : 'div'}>`;
    }).join('')}
  </div>
</div></section>

<section><div class="wrap">
  <div class="section-head center reveal"><span class="eyebrow">Why switch</span><h2>Keep the work. Drop the bill.</h2></div>
  <div class="features">
    ${[
      ['No subscription', 'Every app is free for good. Nothing to renew, nothing to cancel, no price rises.'],
      ['No account', 'Nothing to sign in to. Your files never leave your PC, and the apps work offline.'],
      ['Small and fast', `Apps share one runtime: Photon is ${APPS[0].size}, the whole launcher ${LAUNCHER_SIZE}.`],
      ['Familiar', 'Photon follows Photoshop’s layout and shortcuts; Cut follows Vegas Pro’s.'],
      ['Your files', 'Open and save layered PSDs in Photon, and edit and sign PDFs in Quartz.'],
      ['Open source', 'MIT licensed. Read the code, change it, share it.'],
    ].map(([t, d]) => `<div class="feature reveal"><h3>${t}</h3><p>${d}</p></div>`).join('')}
  </div>
</div></section>

${faqBlock(ADOBE_FAQ, 'Adobe alternative: FAQ')}
${cta()}`,
};

const download = {
  file: 'download.html', current: 'download', preload: 'launcher.webp',
  title: 'Download Crystal Suite – Free for Windows 10 & 11',
  description: `Download Crystal Suite ${LAUNCHER} free for Windows 10 and 11: Photon (Photoshop alternative), Quartz (PDF editor), Cut (video editor), Opal and more.`,
  ldItems: [
    softwareLd('Crystal Suite', 'Free launcher for the Crystal Suite apps on Windows.', `${SITE_URL}download.html`, `${SITE_URL}img/og/home.jpg`, { softwareVersion: LAUNCHER, fileSize: LAUNCHER_SIZE }),
    crumbsLd([['Crystal Suite', 'index.html'], ['Download', 'download.html']]),
  ],
  body: `<section class="hero app-hero"><div class="wrap center-col">
  <span class="pill"><i></i>Version ${LAUNCHER} &middot; free</span>
  <h1>Download <span class="grad">Crystal Suite</span></h1>
  <p class="lede">For Windows 10 and 11 (64-bit). Install the launcher, then pick the apps you want. Each is a small download.</p>
</div></section>

<section style="padding-top:0"><div class="wrap">
  <div class="dl-grid">
    <div class="dl reveal"><span class="tag">Recommended</span><h2>Installer</h2><p>Installs Crystal Suite for your account, with Start menu and desktop shortcuts. No admin rights needed.</p><a class="btn big" href="${SETUP}">${ICON.download}Download installer</a><span class="file">CrystalSuite-Setup-${LAUNCHER}.exe &middot; ${LAUNCHER_SIZE}</span></div>
    <div class="dl reveal"><span class="tag">No install</span><h2>Portable</h2><p>One file you can run from anywhere, such as a USB stick. Apps still install to your user folder.</p><a class="btn big ghost" href="${PORTABLE}">${ICON.download}Download portable</a><span class="file">CrystalSuite-Portable-${LAUNCHER}.exe &middot; ${LAUNCHER_SIZE}</span></div>
  </div>
</div></section>

<section><div class="wrap two">
  <div class="reveal">
    <span class="eyebrow">Getting started</span>
    <h2>Three steps</h2>
    <ol class="steps">
      <li><div><b>Run the installer</b><p>The builds aren’t code-signed yet, so Windows SmartScreen may say “Windows protected your PC”. Click <b class="inl">More info</b>, then <b class="inl">Run anyway</b>.</p></div></li>
      <li><div><b>Install the apps you want</b><p>Crystal Suite opens on All apps. Click Install next to an app: it downloads, checks itself and gets its own shortcut.</p></div></li>
      <li><div><b>Updates take care of themselves</b><p>New versions install in the background. An app that’s open switches over the next time you start it.</p></div></li>
    </ol>
  </div>
  <figure class="captioned reveal"><div class="shot">${img('launcher.webp', 'The Crystal Suite launcher listing the apps with Install buttons', '', true)}</div><figcaption>The launcher, with every app ready to install.</figcaption></figure>
</div></section>

<section><div class="wrap">
  <div class="section-head reveal"><span class="eyebrow">In the launcher</span><h2>The apps</h2></div>
  <div class="others">${APPS.map((o) => `<a class="other reveal" href="${o.id}.html"><img src="img/icons/${o.id}.png" alt="" width="48" height="48" loading="lazy"><b>${o.name} <small>${o.size}</small></b><span>${esc(o.sub)} &middot; replaces ${esc(o.replaces)}</span></a>`).join('')}</div>
</div></section>

<section style="padding-top:0"><div class="wrap two top">
  <div class="notes reveal">
    <div class="note"><b>Only want the browser?</b><p>Prism is also available on its own: <a href="${REPO}/releases/download/prism-v0.1.0/Prism-Setup-0.1.0.exe">Prism-Setup-0.1.0.exe</a> or the <a href="${REPO}/releases/download/prism-v0.1.0/Prism-Portable-0.1.0.exe">portable version</a>, no launcher needed.</p></div>
    <div class="note"><b>Uninstalling</b><p>Use ⋯ › Uninstall in the launcher to remove an app. Uninstalling Crystal Suite from Windows Settings removes its apps too.</p></div>
    <div class="note"><b>Every release</b><p>Older versions, release notes and the app packages are on the <a href="${REPO}/releases">GitHub releases page</a>.</p></div>
  </div>
  <div class="reveal" style="display:grid;gap:14px;min-width:0">
    <h2 class="h3">Build it yourself</h2>
    <p class="muted">You need <a href="https://nodejs.org">Node.js</a> 18 or newer.</p>
    <pre class="code"><span class="c"># get the code</span>
git clone ${REPO}.git
cd crystal-suite
npm install
<span class="c"># run the launcher, or one app on its own</span>
npm run app
npm run photon</pre>
  </div>
</div></section>`,
};

const appPage = (a) => {
  const others = APPS.filter((x) => x.id !== a.id);
  const rest = a.shots.slice(1);
  return {
    file: `${a.id}.html`, current: a.id, bodyClass: `app-${a.id}`, preload: a.shots[0][0], image: `img/og/${a.id}.jpg`,
    title: a.title, description: a.description,
    ldItems: [
      softwareLd(a.name, a.description, `${SITE_URL}${a.id}.html`, `${SITE_URL}img/og/${a.id}.jpg`, { softwareVersion: a.version, applicationCategory: a.category, applicationSubCategory: a.sub, screenshot: `${SITE_URL}img/${a.shots[0][0]}`, fileSize: a.size }),
      crumbsLd([['Crystal Suite', 'index.html'], [a.name, `${a.id}.html`]]),
      faqLd(a.faq),
    ],
    body: `<section class="hero app-hero"><div class="wrap center-col">
  <img class="icon" src="img/icons/${a.id}.png" alt="" width="88" height="88">
  <span class="eyebrow">${esc(a.name)} &middot; free ${esc(a.replaces)} alternative</span>
  <h1>${esc(a.h1)}</h1>
  <p class="lede">${esc(a.blurb)}</p>
  <div class="cta-row center"><a class="btn big" href="download.html">${ICON.download}Get ${a.name} free</a><a class="btn big ghost" href="${REPO}/tree/main/apps/${a.id}">${ICON.github}Source code</a></div>
  <p class="meta">Version ${a.version} &middot; ${a.size} download in Crystal Suite &middot; Windows 10 &amp; 11</p>
</div>
<div class="wrap big-shot"><figure class="shot tilt-up">${img(a.shots[0][0], a.shots[0][1], '', true)}</figure></div>
</section>

<section><div class="wrap">
  <div class="section-head reveal"><span class="eyebrow">What’s inside</span><h2>${esc(featureTitle(a))}</h2></div>
  <div class="features">${a.features.map(([t, d]) => `<div class="feature reveal"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
</div></section>
${rest.length ? `
<section style="padding-top:0"><div class="wrap pair">${rest.map(([s, alt, cap]) => `<figure class="captioned reveal"><div class="shot">${img(s, alt)}</div><figcaption>${esc(cap)}</figcaption></figure>`).join('')}</div></section>` : ''}

${faqBlock(a.faq, `${a.name}: FAQ`)}

<section style="padding-top:0"><div class="wrap">
  <div class="section-head reveal"><span class="eyebrow">Also in Crystal Suite</span><h2>More free apps</h2></div>
  <div class="others">${others.map((o) => `<a class="other reveal" href="${o.id}.html"><img src="img/icons/${o.id}.png" alt="" width="48" height="48" loading="lazy"><b>${o.name}</b><span>${esc(o.sub)} &middot; replaces ${esc(o.replaces)}</span></a>`).join('')}</div>
</div></section>

${cta(`Get ${a.name} free`, `${a.name} is part of Crystal Suite: install the launcher, then add ${a.name} with one click.`)}`,
  };
};
function featureTitle(a) {
  return { photon: 'A photo editor you already know', prism: 'The web, without the tracking', cut: 'Edit like it’s Vegas', facet: 'A desktop you’ll want to look at', quartz: 'Everything you do with PDFs', onyx: 'Never miss the moment', opal: 'Every photo, one key press away' }[a.id];
}

const notFound = {
  file: '404.html', current: '', noindex: true, absolute: true,
  title: 'Page not found | Crystal Suite',
  description: 'This page doesn’t exist. Crystal Suite: free, open-source creative apps for Windows.',
  body: `<section class="hero app-hero"><div class="wrap center-col">
  <span class="eyebrow">404</span>
  <h1>This page <span class="grad">isn’t here</span>.</h1>
  <p class="lede">It may have moved. Try the home page, or go straight to the download.</p>
  <div class="cta-row center"><a class="btn big" href="index.html">Home</a><a class="btn big ghost" href="download.html">${ICON.download}Download</a></div>
</div></section>`,
};

// ---------- write ----------
fs.mkdirSync(path.join(SITE, 'img', 'icons'), { recursive: true });
for (const a of APPS) fs.copyFileSync(path.join(ROOT, 'apps', a.id, 'icon.png'), path.join(SITE, 'img', 'icons', `${a.id}.png`));
fs.copyFileSync(path.join(ROOT, 'electron', 'suite.png'), path.join(SITE, 'img', 'icons', 'suite.png'));
const pages = [home, photoshopPage, adobePage, download, ...APPS.map(appPage), notFound];
for (const p of pages) fs.writeFileSync(path.join(SITE, p.file), page(p));
const indexed = pages.filter((p) => !p.noindex);
const priority = (f) => (f === 'index.html' ? '1.0' : /alternative|download/.test(f) ? '0.9' : '0.8');
fs.writeFileSync(path.join(SITE, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexed.map((p) => `  <url><loc>${SITE_URL}${p.file === 'index.html' ? '' : p.file}</loc><lastmod>${TODAY}</lastmod><priority>${priority(p.file)}</priority></url>`).join('\n')}
</urlset>
`);
fs.writeFileSync(path.join(SITE, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`);
fs.writeFileSync(path.join(SITE, '.nojekyll'), '');
console.log(`site: ${pages.map((p) => p.file).join(', ')}, sitemap.xml, robots.txt (${SITE_URL})`);
