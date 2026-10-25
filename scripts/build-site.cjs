// Builds the Crystal Suite website into site/: the home page, the download page and a page for each app.
// Versions and download sizes come from catalog.json; screenshots live in site/img (see site/README.md).
//
//   node scripts/build-site.cjs              -> site/*.html (full pages, e.g. for GitHub Pages)
//   node scripts/build-site.cjs --fragment X -> also X/index.html without the <html>/<head>/<body> shell
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const REPO = 'https://github.com/Enqrypted/crystal-suite';
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const LAUNCHER = catalog.launcher.version;
const LAUNCHER_SIZE = '71 MB'; // CrystalSuite-Setup-<v>.exe on the release
const SETUP = `${REPO}/releases/download/v${LAUNCHER}/CrystalSuite-Setup-${LAUNCHER}.exe`;
const PORTABLE = `${REPO}/releases/download/v${LAUNCHER}/CrystalSuite-Portable-${LAUNCHER}.exe`;

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
];
for (const a of APPS) {
  const c = catalog.apps.find((x) => x.id === a.id);
  a.version = c?.version ?? '';
  a.size = c ? mb(c.size) : '';
}

const ICON = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';

function header(current) {
  const menu = APPS.map((a) => `<a href="${a.id}.html"${current === a.id ? ' aria-current="page"' : ''}><img src="img/icons/${a.id}.png" alt="" width="36" height="36"><b>${a.name}</b><span>${esc(a.tag)}</span></a>`).join('');
  return `<header class="site-header"><div class="wrap">
  <a class="brand" href="index.html"><img src="img/icons/suite.png" alt="" width="30" height="30">Crystal Suite</a>
  <nav class="nav" aria-label="Main">
    <details class="apps-menu"><summary>Apps</summary><div class="menu">${menu}</div></details>
    <a class="hide-sm" href="download.html"${current === 'download' ? ' aria-current="page"' : ''}>Download</a>
    <a class="hide-sm" href="${REPO}">GitHub</a>
    <a class="btn small header-dl" href="download.html">${ICON.download}Download</a>
  </nav>
</div></header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="wrap">
  <div class="foot-top">
    <a class="brand" href="index.html"><img src="img/icons/suite.png" alt="" width="30" height="30">Crystal Suite</a>
    <div class="foot-links">
      ${APPS.map((a) => `<a href="${a.id}.html">${a.name}</a>`).join('')}
      <a href="download.html">Download</a>
      <a href="${REPO}">Source code</a>
      <a href="${REPO}/releases">Releases</a>
      <a href="${REPO}/blob/main/LICENSE">MIT license</a>
    </div>
  </div>
  <p class="fine">Crystal Suite is free and open-source software under the MIT license, made by independent contributors. Photoshop and Acrobat are trademarks of Adobe, Chrome of Google, Vegas Pro of MAGIX, iPhone of Apple and ShadowPlay of NVIDIA; Crystal Suite is not affiliated with any of them.</p>
</div></footer>`;
}

function page({ file, title, description, body, current, bodyClass = '' }, fragment) {
  const head = `<title>${esc(title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<link rel="icon" href="img/icons/suite.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="style.css">`;
  const content = `${header(current)}
<main>
${body}
</main>
${footer()}
<script src="site.js"></script>`;
  if (fragment) return `${head}\n<div class="${bodyClass}" id="page">\n${content}\n</div>\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${content}
</body>
</html>
`;
}

// ---------- pages ----------
const appRow = (a) => `<article class="app-row">
  <div class="app-copy">
    <div class="app-title"><img src="img/icons/${a.id}.png" alt="" width="56" height="56"><h3>${a.name}<small>${esc(a.tag)}</small></h3></div>
    <span class="alt">${esc(a.alt)}</span>
    <p>${esc(a.blurb)}</p>
    <ul class="ticks">${a.ticks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <a class="more" href="${a.id}.html">See ${a.name} ${ICON.arrow}</a>
  </div>
  <figure class="shot">${img(a.shots[0][0], a.shots[0][1])}</figure>
</article>`;

const band = () => `<section class="band waved"><canvas class="waves" data-shape="band" aria-hidden="true"></canvas><div class="wrap">
  <h2>Get Crystal Suite</h2>
  <p class="lede">Free for Windows 10 and 11. Install the launcher, then add any app with one click.</p>
  <div class="cta-row"><a class="btn" href="download.html">${ICON.download}Download for Windows</a><a class="btn ghost" href="${REPO}">${ICON.github}Source on GitHub</a></div>
</div></section>`;

const home = {
  file: 'index.html', title: 'Crystal Suite', current: 'home',
  description: 'Crystal Suite is a free, open-source creative suite for Windows: photo editing, a private browser, video editing, desktop widgets, a PDF editor and instant replay for games. No account, no subscription.',
  body: `<section class="hero waved"><canvas class="waves" aria-hidden="true"></canvas><div class="wrap hero-grid">
  <div class="hero-copy">
    <span class="pill"><i></i>Free &amp; open source &middot; MIT license</span>
    <h1>The free creative suite for Windows.</h1>
    <p class="lede">Photo editing, a private browser, video editing, desktop widgets, a PDF editor and instant replay for games, in one small launcher. No account, no subscription, no telemetry.</p>
    <div class="cta-row"><a class="btn" href="download.html">${ICON.download}Download for Windows</a><a class="btn ghost" href="${REPO}">${ICON.github}View on GitHub</a></div>
    <p class="meta">Version ${LAUNCHER} &middot; Windows 10 &amp; 11, 64-bit &middot; ${LAUNCHER_SIZE}</p>
  </div>
  <div class="collage">
    <figure class="shot main">${img('photon-layers.webp', 'Photon, the suite’s photo editor, with a layered landscape open', '', true)}</figure>
    ${img('facet-desktop.webp', 'Facet’s glass folders and clock on a desktop', 'side a')}
    ${img('quartz-annotate.webp', 'Quartz annotating a PDF', 'side b')}
  </div>
</div></section>

<section id="apps"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Six apps, one launcher</span><h2>Everything in the suite</h2><p class="lede">Install only the apps you want. Each one gets its own shortcut, opens on its own and keeps itself up to date.</p></div>
  <div class="app-rows">${APPS.map(appRow).join('\n')}</div>
</div></section>

<section><div class="wrap">
  <div class="section-head"><span class="eyebrow">Free means free</span><h2>No account. No subscription.</h2><p class="lede">Crystal Suite runs on your computer and stays there. The code is public, and anyone can use, change and share it.</p></div>
  <div class="facts">
    <div class="fact"><b>$0, for good</b><p>Every app is free under the MIT license. There is no paid tier and nothing to unlock.</p></div>
    <div class="fact"><b>No sign-in</b><p>Nothing to sign up for. Your files never leave your PC.</p></div>
    <div class="fact"><b>Small downloads</b><p>The apps share one runtime, so Photon is ${APPS[0].size}, Cut ${APPS[2].size} and Facet ${APPS[3].size}.</p></div>
    <div class="fact"><b>Works offline</b><p>The internet is only used to check for apps and updates. No telemetry, no ads.</p></div>
  </div>
</div></section>

${band()}`,
};

const download = {
  file: 'download.html', title: 'Download Crystal Suite', current: 'download',
  description: `Download Crystal Suite ${LAUNCHER} for Windows 10 and 11: the free launcher for Photon, Prism, Cut, Facet, Quartz and Onyx.`,
  body: `<section class="hero waved app-hero"><canvas class="waves" data-shape="low" aria-hidden="true"></canvas><div class="wrap">
  <span class="pill"><i></i>Version ${LAUNCHER} &middot; free</span>
  <h1>Download Crystal Suite</h1>
  <p class="lede">For Windows 10 and 11 (64-bit). Install the launcher, then pick the apps you want. Each is a small download.</p>
</div></section>

<section style="padding-top:0"><div class="wrap">
  <div class="dl-grid">
    <div class="dl"><span class="tag">Recommended</span><h3>Installer</h3><p>Installs Crystal Suite for your account, with Start menu and desktop shortcuts. No admin rights needed.</p><a class="btn" href="${SETUP}">${ICON.download}Download installer</a><span class="file">CrystalSuite-Setup-${LAUNCHER}.exe &middot; ${LAUNCHER_SIZE}</span></div>
    <div class="dl"><span class="tag">No install</span><h3>Portable</h3><p>One file you can run from anywhere, such as a USB stick. Apps still install to your user folder.</p><a class="btn ghost" href="${PORTABLE}">${ICON.download}Download portable</a><span class="file">CrystalSuite-Portable-${LAUNCHER}.exe &middot; ${LAUNCHER_SIZE}</span></div>
  </div>
</div></section>

<section><div class="wrap two">
  <div style="display:grid;gap:28px">
    <div class="section-head" style="margin:0"><span class="eyebrow">Getting started</span><h2>Three steps</h2></div>
    <ol class="steps">
      <li><div><b>Run the installer</b><p>The builds aren’t code-signed yet, so Windows SmartScreen may say “Windows protected your PC”. Click <b style="display:inline">More info</b>, then <b style="display:inline">Run anyway</b>.</p></div></li>
      <li><div><b>Install the apps you want</b><p>Crystal Suite opens on All apps. Click Install next to an app: it downloads, checks itself and gets its own shortcut.</p></div></li>
      <li><div><b>Updates take care of themselves</b><p>New versions install in the background. An app that’s open switches over the next time you start it.</p></div></li>
    </ol>
  </div>
  <figure class="captioned"><div class="shot">${img('launcher.webp', 'The Crystal Suite launcher listing Photon, Prism, Cut, Facet and Quartz with Install buttons')}</div><figcaption>The launcher, with every app ready to install.</figcaption></figure>
</div></section>

<section style="padding-top:0"><div class="wrap two">
  <div class="notes">
    <div class="note"><b>Only want the browser?</b><p>Prism is also available on its own: <a href="${REPO}/releases/download/prism-v0.1.0/Prism-Setup-0.1.0.exe">Prism-Setup-0.1.0.exe</a> or the <a href="${REPO}/releases/download/prism-v0.1.0/Prism-Portable-0.1.0.exe">portable version</a>, no launcher needed.</p></div>
    <div class="note"><b>Uninstalling</b><p>Use ⋯ › Uninstall in the launcher to remove an app. Uninstalling Crystal Suite from Windows Settings removes its apps too.</p></div>
    <div class="note"><b>Every release</b><p>Older versions, release notes and the app packages are on the <a href="${REPO}/releases">GitHub releases page</a>.</p></div>
  </div>
  <div style="display:grid;gap:14px;min-width:0">
    <h3>Build it yourself</h3>
    <p style="color:var(--muted)">You need <a href="https://nodejs.org">Node.js</a> 18 or newer.</p>
    <pre class="code"><span class="c"># get the code</span>
git clone ${REPO}.git
cd crystal-suite
npm install
<span class="c"># run the launcher, or one app on its own</span>
npm run app
npm run quartz</pre>
  </div>
</div></section>`,
};

const appPage = (a) => {
  const others = APPS.filter((x) => x.id !== a.id);
  const rest = a.shots.slice(1);
  return {
    file: `${a.id}.html`, title: `${a.name} · Crystal Suite`, current: a.id, bodyClass: `app-${a.id}`,
    description: `${a.name}: ${a.tag.toLowerCase()} for Windows. ${a.blurb} Free and open source, part of Crystal Suite.`,
    body: `<section class="hero waved app-hero"><canvas class="waves" data-shape="low" aria-hidden="true"></canvas><div class="wrap">
  <img class="icon" src="img/icons/${a.id}.png" alt="" width="84" height="84">
  <span class="eyebrow">${esc(a.tag)}</span>
  <h1>${a.name}</h1>
  <p class="lede">${esc(a.blurb)}</p>
  <div class="cta-row"><a class="btn" href="download.html">${ICON.download}Get ${a.name} free</a><a class="btn ghost" href="${REPO}/tree/main/apps/${a.id}">${ICON.github}Source code</a></div>
  <p class="meta">Version ${a.version} &middot; ${a.size} download in Crystal Suite &middot; ${esc(a.alt)}</p>
</div></section>

<div class="wrap big-shot"><figure class="shot">${img(a.shots[0][0], a.shots[0][1], '', true)}</figure></div>

<section><div class="wrap">
  <div class="section-head"><span class="eyebrow">What’s inside</span><h2>${esc(featureTitle(a))}</h2></div>
  <div class="features">${a.features.map(([t, d]) => `<div class="feature"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
</div></section>
${rest.length ? `
<section style="padding-top:0"><div class="wrap pair">${rest.map(([s, alt, cap]) => `<figure class="captioned"><div class="shot">${img(s, alt)}</div><figcaption>${esc(cap)}</figcaption></figure>`).join('')}</div></section>` : ''}

<section style="padding-top:0"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Also in Crystal Suite</span><h2>More free apps</h2></div>
  <div class="others">${others.map((o) => `<a class="other" href="${o.id}.html"><img src="img/icons/${o.id}.png" alt="" width="48" height="48"><b>${o.name}</b><span>${esc(o.tag)}</span></a>`).join('')}</div>
</div></section>

${band()}`,
  };
};
function featureTitle(a) {
  return { photon: 'A photo editor you already know', prism: 'The web, without the tracking', cut: 'Edit like it’s Vegas', facet: 'A desktop you’ll want to look at', quartz: 'Everything you do with PDFs', onyx: 'Never miss the moment' }[a.id];
}

// ---------- write ----------
const argv = process.argv.slice(2);
const fragIdx = argv.indexOf('--fragment');
const fragDir = fragIdx >= 0 ? path.resolve(argv[fragIdx + 1]) : null;
fs.mkdirSync(path.join(SITE, 'img', 'icons'), { recursive: true });
for (const a of APPS) fs.copyFileSync(path.join(ROOT, 'apps', a.id, 'icon.png'), path.join(SITE, 'img', 'icons', `${a.id}.png`));
fs.copyFileSync(path.join(ROOT, 'electron', 'suite.png'), path.join(SITE, 'img', 'icons', 'suite.png'));
const pages = [home, download, ...APPS.map(appPage)];
for (const p of pages) fs.writeFileSync(path.join(SITE, p.file), page(p, false));
if (fragDir) {
  fs.mkdirSync(fragDir, { recursive: true });
  fs.writeFileSync(path.join(fragDir, 'index.html'), page(home, true));
}
console.log(`site: ${pages.map((p) => p.file).join(', ')}`);
