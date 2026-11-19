// Makes the website's generated images (run with Electron: npx electron scripts/build-site-images.cjs):
// site/img/og/<page>.jpg — 1200×630 social cards (link previews in search, chats and social media) — and the
// favicon / Apple touch icon. Rerun when an app's screenshot, name or tagline changes.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const OG = path.join(SITE, 'img', 'og');
const url = (p) => 'file:///' + p.replace(/\\/g, '/');

const CARDS = [
  { file: 'home', icon: 'suite', eyebrow: 'Free & open source', title: 'The free alternative to Adobe Creative Cloud', sub: 'Photo editor, PDF editor, video editor and more for Windows', shot: 'photon-layers.webp', c1: '#6d4bff', c2: '#1f8fff' },
  { file: 'photon', icon: 'photon', eyebrow: 'Photon', title: 'The free Photoshop alternative', sub: 'Layers, masks, blend modes, filters and PSD files', shot: 'photon-layers.webp', c1: '#1b6dff', c2: '#31a8ff' },
  { file: 'prism', icon: 'prism', eyebrow: 'Prism', title: 'A private browser with the ad blocker built in', sub: 'Chromium, no account, no telemetry', shot: 'prism-browsing.webp', c1: '#8a5cff', c2: '#c27bff' },
  { file: 'cut', icon: 'cut', eyebrow: 'Cut', title: 'A free video editor laid out like Vegas Pro', sub: 'Timeline, transitions, titles, 4K MP4 export', shot: 'cut-timeline.webp', c1: '#5b57ff', c2: '#8f8dff' },
  { file: 'facet', icon: 'facet', eyebrow: 'Facet', title: 'iPhone-style folders and widgets for Windows', sub: 'Clock, Spotify, Control Center, in liquid glass', shot: 'facet-desktop.webp', c1: '#1fc7a6', c2: '#36b8d9' },
  { file: 'quartz', icon: 'quartz', eyebrow: 'Quartz', title: 'A free PDF editor, no Acrobat subscription', sub: 'Annotate, fill, sign, merge and split PDFs', shot: 'quartz-annotate.webp', c1: '#ff5a5a', c2: '#ff8a6b' },
  { file: 'onyx', icon: 'onyx', eyebrow: 'Onyx', title: 'Instant replay for every game you play', sub: 'Ctrl+Shift+G saves the last 15 s to 2 min', shot: 'onyx-picker.webp', c1: '#6fdc2f', c2: '#2fbf7a' },
  { file: 'opal', icon: 'opal', eyebrow: 'Opal', title: 'Open iPhone HEIC photos on Windows, free', sub: 'Fast photo viewer, HEIC to JPEG converter', shot: 'opal-viewer.webp', c1: '#ffad2f', c2: '#ff7a45' },
];

function cardHtml(c) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#07070d;font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;color:#f4f3ff}
  .bg{position:absolute;inset:0;background:radial-gradient(60% 80% at 0% 0%,${c.c1}cc,transparent 60%),radial-gradient(50% 70% at 100% 10%,${c.c2}99,transparent 60%),radial-gradient(60% 60% at 80% 120%,#ff4fc855,transparent 60%),#07070d}
  .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:48px 48px}
  .copy{position:absolute;left:68px;top:70px;width:560px;display:flex;flex-direction:column;gap:22px}
  .row{display:flex;align-items:center;gap:16px;font-size:24px;font-weight:600;letter-spacing:.02em;color:#d9d8f2}
  .row img{width:64px;height:64px}
  h1{margin:0;font-size:62px;line-height:1.02;font-weight:800;letter-spacing:-.03em}
  p{margin:0;font-size:27px;line-height:1.3;color:#c4c3e0}
  .chips{display:flex;gap:10px;margin-top:6px}
  .chips span{font-size:19px;padding:9px 16px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18)}
  .shot{position:absolute;left:640px;top:96px;width:720px;border-radius:18px;overflow:hidden;box-shadow:0 40px 90px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.12);transform:perspective(1400px) rotateY(-16deg) rotateX(6deg)}
  .shot img{display:block;width:100%}
  .brand{position:absolute;left:68px;bottom:44px;display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700;color:#e9e8fb}
  .brand img{width:34px;height:34px}
  </style></head><body><div class="bg"></div><div class="grid"></div>
  <div class="shot"><img src="${url(path.join(SITE, 'img', c.shot))}"></div>
  <div class="copy"><div class="row"><img src="${url(path.join(SITE, 'img', 'icons', `${c.icon}.png`))}">${c.eyebrow}</div><h1>${c.title}</h1><p>${c.sub}</p>
  <div class="chips"><span>Free</span><span>No account</span><span>Windows</span></div></div>
  ${c.icon === 'suite' ? '' : `<div class="brand"><img src="${url(path.join(SITE, 'img', 'icons', 'suite.png'))}">Crystal Suite</div>`}
  </body></html>`;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OG, { recursive: true });
  const w = new BrowserWindow({ show: false, width: 1200, height: 630, useContentSize: true, webPreferences: { offscreen: true } });
  w.webContents.setFrameRate(30);
  const tmp = path.join(OG, '_card.html');
  for (const c of CARDS) {
    fs.writeFileSync(tmp, cardHtml(c));
    await w.loadFile(tmp);
    await w.webContents.executeJavaScript('Promise.all([...document.images].map((i) => i.decode().catch(() => {})))');
    await new Promise((r) => setTimeout(r, 400));
    const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 630 });
    fs.writeFileSync(path.join(OG, `${c.file}.jpg`), img.resize({ width: 1200, height: 630 }).toJPEG(84));
    console.log('og', c.file);
  }
  fs.rmSync(tmp, { force: true });
  const icon = nativeImage.createFromPath(path.join(ROOT, 'electron', 'suite.png'));
  fs.writeFileSync(path.join(SITE, 'img', 'icons', 'favicon-64.png'), icon.resize({ width: 64, height: 64, quality: 'best' }).toPNG());
  fs.writeFileSync(path.join(SITE, 'img', 'icons', 'apple-touch-icon.png'), icon.resize({ width: 180, height: 180, quality: 'best' }).toPNG());
  console.log('icons done');
  app.quit();
});
