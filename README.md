# Crystal Suite

A free, open-source, fully local creative suite. No accounts, no subscription, no cloud — everything runs on your computer.

The **Crystal Suite** app is a launcher (like Creative Cloud) that installs, updates and opens the suite's apps.

| App | Status | Like |
| --- | --- | --- |
| **Photon** | ✅ Available (install it from the launcher) | Photoshop |
| **Prism** | ✅ Available (from the launcher, or as its own Prism.exe) | Chrome, minus the tracking |
| **Cut** | ✅ Available (install it from the launcher) | Sony Vegas Pro |
| **Facet** | ✅ Available (install it from the launcher) | iPhone-style folders and widgets for the Windows desktop |
| Vector | Planned | Illustrator |
| Darkroom | Planned | Lightroom |
| Motion | Planned | After Effects |
| Layout | Planned | InDesign |

## Download

Get **`CrystalSuite-Setup-x.y.z.exe`** from the [latest release](https://github.com/Enqrypted/crystal-suite/releases/latest) (or the portable **`CrystalSuite-Portable-x.y.z.exe`**, no installation needed).

Crystal Suite is a launcher, like Creative Cloud: open it, click **Install** next to an app and it downloads (Photon, Cut and Facet are under 300 KB, Prism about 3 MB, because the apps share the launcher's runtime), verifies and installs it. From then on:

- **Open** starts the app; each app also gets its own Start-menu (and optional desktop) shortcut and taskbar icon.
- New versions show up under **Updates** (with a count in the sidebar). They install in the background automatically unless you turn that off in **Settings**; an app that is open keeps running and switches to the new version the next time you start it.
- **⋯ → Uninstall** removes an app. Uninstalling Crystal Suite removes its apps too.
- Everything works offline once installed: the internet is only used to fetch the app catalog and downloads. No account, no telemetry.

Prism is also available on its own: **`Prism-Setup-x.y.z.exe`** / **`Prism-Portable-x.y.z.exe`** on the [Prism release](https://github.com/Enqrypted/crystal-suite/releases?q=prism) (no launcher needed).

Apps are stored in `%LOCALAPPDATA%\Crystal Suite\Apps`. The builds are not code-signed, so Windows SmartScreen may show "Windows protected your PC" the first time: click **More info → Run anyway**.

## Running from source

Requirements: [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm run app        # the Crystal Suite launcher (installs Photon from the published catalog)
npm run photon     # builds Photon from source and opens it directly
npm run prism      # builds Prism from source and opens it as a standalone app
npm run cut        # builds Cut from source and opens it
npm run facet      # builds Facet from source and runs it (widgets on your desktop + its window)
npm run dev        # Photon in your browser with hot reload: http://localhost:5173
```

On Windows you can also double-click **`Crystal Suite.cmd`** or **`Photon.cmd`** (the first run installs and builds automatically). You can drag image or PSD files onto `Photon.cmd` to open them.

`dist/photon/index.html` (from `npm run build`) is a single self-contained file: you can also open it straight in Chrome/Edge without the desktop shell (in a browser a few shortcuts like Ctrl+N / Ctrl+T / Ctrl+W are reserved by the browser itself; they all work in the desktop app).

## How the launcher gets apps

- `catalog.json` (in this repo, read from `raw.githubusercontent.com`) lists each app's version, download URL, size and SHA-256, plus the latest launcher version.
- Each app is a zip on a GitHub release (`photon-v0.1.0` → `photon-0.1.0.zip`) with an `app.json` manifest and icons. A *page app* (Photon) is a single `index.html` that runs in a sandboxed window with a narrow file-access bridge. A *module app* (Prism) ships a `main.cjs` that the launcher loads to create its own windows.
- The launcher downloads it with progress, rejects it unless the size and SHA-256 match the catalog, and unpacks it to `Apps\<id>\<version>` (checking that every path stays inside that folder). An app's manifest can require a minimum launcher version (`minLauncher`); older launchers then offer the launcher update instead.

To test against a local catalog: `node scripts/pack-apps.cjs --base http://127.0.0.1:8765/`, serve `release/apps`, and start the launcher with `CRYSTAL_CATALOG=http://127.0.0.1:8765/catalog.json` (and `CRYSTAL_HOME=<folder>` to keep test installs separate).

## Publishing a release

```bash
# A new Photon version: bump "version" in apps/photon/app.json, then
npm run pack:apps                     # builds Photon, writes release/apps/photon-<v>.zip and catalog.json
gh release create photon-v<v> release/apps/photon-<v>.zip --title "Photon <v>" --latest=false
git commit -am "Photon <v>" && git push   # launchers see the new version once catalog.json is pushed

# A new Cut version: bump "version" in apps/cut/app.json, then
npm run pack:apps
gh release create cut-v<v> release/apps/cut-<v>.zip --title "Cut <v>" --latest=false
git commit -am "Cut <v>" && git push

# A new Facet version: bump "version" in apps/facet/app.json, then
npm run pack:apps
gh release create facet-v<v> release/apps/facet-<v>.zip --title "Facet <v>" --latest=false
git commit -am "Facet <v>" && git push

# A new Prism version: bump "version" in apps/prism/app.json, then
npm run pack:apps && npm run dist:prism  # the launcher package + the standalone Prism-Setup/Portable exes
gh release create prism-v<v> release/apps/prism-<v>.zip release/prism/Prism-Setup-<v>.exe release/prism/Prism-Portable-<v>.exe --title "Prism <v>" --latest=false
git commit -am "Prism <v>" && git push

# A new launcher version: bump "version" in package.json, then
npm run pack:apps && npm run dist     # catalog.json now advertises the new launcher too
gh release create v<v> release/CrystalSuite-Setup-<v>.exe release/CrystalSuite-Portable-<v>.exe
git commit -am "Crystal Suite <v>" && git push
```

`npm run dist` (and `npm install`) automatically apply `scripts/patch-nsis-template.cjs`, which fixes an electron-builder installer bug that made Setup crash on launch on some Windows 11 PCs.

If `npm run dist` fails with *"Cannot create symbolic link: A required privilege is not held"*, either enable Windows Developer Mode once, or pre-extract the signing tools (the macOS files are the only ones that need symlinks):

```bash
cd %LOCALAPPDATA%\electron-builder\Cache\winCodeSign
<path-to-this-repo>\node_modules\7zip-bin\win\x64\7za.exe x <the-downloaded-file>.7z -owinCodeSign-2.6.0 -xr!darwin
```

## Cut features

A video editor laid out like Sony Vegas Pro: Project Media, Properties, Generators & Transitions, the Video Preview and the Master bus on top, the timeline with track headers below. Dark, clean, and it all runs locally.

- **Timeline** — video and audio tracks (video files land as a grouped video + audio pair), drag events between tracks, Ctrl+drag to copy, trim either edge, **S** to split at the cursor, ripple editing (Ctrl+L), snapping to edges, the cursor, markers and the time selection (F8), quantize to frames, zoom with the arrow keys / Ctrl+wheel / slider / `` ` `` to fit, thumbnails on video events and waveforms on audio events, markers (M), time selection & loop playback (Q, I, O).
- **Vegas-style handles** — drag an event's top corners for fade in/out (smooth, linear, fast or slow curves) and its top edge for volume (audio) or opacity (video); overlap two events on a track for an automatic crossfade.
- **Audio** — event volume and pan, track volume/pan, mute & solo, normalize, master fader with peak meters; sample-accurate mixing.
- **Video** — event opacity, transitions (crossfade, dip to black, wipe, slide, push), Pan/Crop (position, zoom, rotation, crop, with an animated "Ken Burns" end state), Video FX (brightness, contrast, saturation, hue, blur, black & white, sepia, invert, presets), playback rate, track level, compositing of multiple video tracks.
- **Media generators** — text, titles, lower thirds, solid colours and gradients.
- **Render As** — MP4 (H.264 + AAC) or WebM (VP9 + Opus), project or preset resolution (up to 4K), frame rate, quality, audio bitrate, whole project or time selection, size estimate, live preview and progress; uses the computer's hardware encoder when available.
- **Projects** — .cutproj files (media found again if the folder moves), relink offline media, undo/redo of every edit, autosave and crash recovery; imports MP4, MOV, MKV, WebM, MP3, WAV, M4A, OGG, FLAC, PNG, JPEG, WebP, GIF and BMP.

## Facet features

Folders and widgets that live on the Windows desktop itself: below your apps like desktop icons, still there after **Show desktop** (Win+D), and click-through everywhere else so the desktop keeps working.

- **Folders like on an iPhone** — a frosted tile showing the first nine icons and the folder's name. Click it and it opens in place (click the title to rename it); click a shortcut to launch it. Drag apps, shortcuts, files or folders onto a folder from Explorer or the desktop, drag icons to reorder them or onto another folder to move them, right-click for Open / Show in folder / Rename / Remove. Or show a folder as an always-open **panel** with its own columns and rows.
- **Crisp icons** — large Windows icons (apps that only ship small icons are shown at their best size instead of in Windows' white frame), real thumbnails for photos and videos, and game artwork from Steam's library for Steam shortcuts.
- **Clock** — four faces (minimal, card, analog, stacked), six fonts, weight, size, colour and accent, 12/24-hour, seconds or a second hand, short or long date, glass or dark background, alignment, shadow and a blinking colon. Changes show live.
- **Spotify** — album art, title and artist, a live progress bar (click to seek), play/pause, next/previous, shuffle and repeat, in three sizes on a blurred-album-art, glass or dark card. It reads Windows’ own media controls, so it works with the Spotify app without signing in, and can follow any player instead.
- **Control Center** — iPhone-style tiles: Wi-Fi, Bluetooth, night light and dark mode toggles (right-click for their Windows settings), now playing, the time, CPU and memory (and battery on laptops), big brightness and volume sliders, and Screenshot, Calculator, Lock and Settings buttons. Brightness uses the monitor’s own control where it allows it (DDC/CI, laptop panels) and dims the screen otherwise.
- **Recent folders** — the folders you opened most recently in File Explorer, as a list (with where they are and when) or as icons.
- **Liquid glass** — folders, panels, clocks and menus are clear glass slabs over your actual wallpaper (as Windows draws it on each display): lightly blurred, bent at the rim with a little colour fringing, with a bright specular edge and a highlight that follows the pointer. Clear or dark, with an optional tint per folder. Painted once per move, so it costs nothing at rest.
- **Organize desktop** — sorts what's on your desktop into Apps, Games, Folders, Documents, Pictures, Videos, Music, Archives and more in one go, then optionally hides the Windows desktop icons while Facet runs (they come back when it quits, even after a crash; dragging on the desktop still draws a selection box, which also selects and moves widgets). Nothing is moved or deleted: folders hold shortcuts.
- **Everyday bits** — starts the moment you sign in (a sign-in task rather than a Run entry, which Windows holds back for a while), tray icon, lock widgets in place, names under icons on/off, every display gets its own widgets. Idles at well under 1% CPU.

The desktop pinning, icons, wallpaper and desktop-icon toggle come from a small helper (`FacetHelper.exe`, about 25 KB) compiled from [apps/facet/native/FacetHelper.cs](apps/facet/native/FacetHelper.cs) with the C# compiler that ships with Windows.

## Prism features

A clean Chromium browser (same engine as Chrome and Edge) with privacy built in and nothing extra: no account, no sync, no news feed, no sponsored tiles, no telemetry.

- **Ad & tracker blocking** on by default — EasyList, EasyPrivacy and uBlock Origin filters (via Ghostery's open-source engine): blocks ad and tracker requests, hides leftover ad slots, runs uBlock's anti-ad scriptlets. A shield in the toolbar shows the count per page and switches protections off for a site. The lists ship with Prism and refresh in the background every few days.
- **Privacy defaults** — third-party cookies blocked, every site upgraded to HTTPS (falls back to http:// and says "Not secure" when a site has no HTTPS), Global Privacy Control + Do Not Track sent, WebRTC can't leak your local IP, a plain Chrome user agent, DuckDuckGo search (or Brave Search, Startpage, Ecosia, Google, Bing), optional "clear everything when Prism closes".
- **Private windows** (Ctrl+Shift+N) — nothing is written to disk; all their cookies and data are dropped when the last private window closes.
- **A Chrome-like UI** — tabs (drag to reorder, mute, duplicate, reopen closed), address bar with history/bookmark suggestions, bookmarks + bookmarks bar, history, downloads (pause, resume, retry), find in page, zoom per site, full screen, print, save page, view source, developer tools, pop-up blocker, permission prompts (camera, microphone, location, notifications…) remembered per site, its own error pages, light/dark/system theme, session restore.
- **Default browser** — Settings → Make default registers Prism with Windows and opens the Default apps page.

Not included (on purpose or not yet): extensions, sync, a built-in password manager, and DRM-protected streaming (Netflix and similar sites need Widevine, which is only available to licensed browsers).

## Photon features

**Interface** — Photoshop's layout and dark UI (4 interface themes in Preferences), menu bar, options bar, tool groups with flyouts, document tabs, rulers & guides, status bar, docked tabbed panels and the collapsed icon strip, welcome screen, screen modes (F), hide panels (Tab).

**Tools** — Move (auto-select, align, transform controls) · Rectangular / Elliptical / Single Row / Single Column Marquee · Lasso / Polygonal / Magnetic Lasso · Quick Selection · Magic Wand · Crop (ratios, rule of thirds, delete/keep cropped pixels) · Eyedropper (sample sizes) · Ruler (with Straighten Layer) · Spot Healing Brush · Healing Brush · Red Eye · Brush · Pencil · Color Replacement · Clone Stamp (aligned, sample current/below/all) · History Brush · Eraser · Magic Eraser · Gradient (linear, radial, angle, reflected, diamond + Gradient Editor) · Paint Bucket · Blur · Sharpen · Smudge · Dodge · Burn · Sponge · Pen / Freeform Pen / Add / Delete / Convert Anchor · Path Selection / Direct Selection · Horizontal Type (edit on canvas) · Rectangle / Ellipse / Triangle / Polygon (stars) / Line / Custom Shape (shape layers, paths or pixels) · Hand · Zoom (scrubby) · Free Transform (scale, rotate, skew, distort, perspective).

**Brush engine** — size, hardness, opacity vs. flow (like Photoshop), spacing, angle, roundness, pen pressure for size/opacity, jitter, scattering, smoothing, blend modes incl. Behind/Clear, procedural brush tips (chalk, spatter, dry brush, star, leaf, grass), Brushes & Brush Settings panels.

**Layers** — pixel, type, shape, solid/gradient fill and adjustment layers · **layer groups** (Ctrl+G / Shift+Ctrl+G, nesting, collapse, drag in/out, Pass Through or isolated blending, group masks, Merge Group) · all 27 Photoshop blend modes + Pass Through · opacity & fill · layer masks (paint, view with Alt+click, rubylith with `\`, apply/disable) · clipping masks · locks · label colors · drag to reorder · merge down / visible / flatten / stamp · layer via copy/cut · layer styles: Drop Shadow, Inner Shadow, Outer Glow, Inner Glow, Stroke, Color Overlay, Gradient Overlay (copy/paste styles).

**Selections** — Magic Wand (tolerance, contiguous, sample all layers), Quick Selection, marquees, lassos; add/subtract/intersect with Shift/Alt, feather, anti-alias, drag or arrow-key the outline, Transform Selection, select all/inverse/reselect, Color Range, Select Subject, Select and Mask, grow/similar, border/smooth/expand/contract, save/load to alpha channels, Quick Mask (Q).

**Adjustments** (destructive or as adjustment layers, with presets) — Brightness/Contrast, Levels, Curves, Exposure, Vibrance, Hue/Saturation, Color Balance, Black & White, Photo Filter, Channel Mixer, Color Lookup, Invert, Posterize, Threshold, Gradient Map, Selective Color, Shadows/Highlights, Desaturate, Equalize, Auto Tone / Contrast / Color.

**Filters** (live preview) — Camera Raw Filter, Lens Correction, Liquify, Blur (Average, Blur, Blur More, Box, Gaussian, Motion, Radial, Surface), Blur Gallery (Tilt-Shift, Iris), Distort (Pinch, Polar Coordinates, Ripple, Spherize, Twirl, Wave, ZigZag), Noise (Add Noise, Despeckle, Dust & Scratches, Median, Reduce Noise), Pixelate (Color Halftone, Crystallize, Fragment, Mezzotint, Mosaic, Pointillize), Render (Clouds, Difference Clouds, Fibers, Lens Flare), Sharpen (Sharpen, Sharpen Edges, Sharpen More, Smart Sharpen, Unsharp Mask), Stylize (Diffuse, Emboss, Find Edges, Oil Paint, Solarize, Tiles, Trace Contour, Wind), Other (Custom, High Pass, Maximum, Minimum, Offset), Last Filter.

**Image** — Image Size (resampling methods), Canvas Size (anchor), rotate 90/180/arbitrary, flip canvas, crop to selection, trim, reveal all, duplicate, grayscale.

**Edit** — undo/redo with a History panel (snapshots, history brush source), cut/copy/copy merged/paste/paste in place (system clipboard), Fill (incl. Content-Aware), Stroke, Content-Aware Fill, transform submenu, Preferences, keyboard shortcuts.

**Export** — File › Export › Export As (whole document) and **Export Layer As** (Layers panel right-click or Layer menu): each layer is exported on its own canvas trimmed to its content (optional padding, clip to document, include effects), PNG/JPG/WebP with quality and matte, resize by width/height/scale with high-quality downsampling, and a live preview of the exact output (Fit / 100% / zoom) with dimensions and file size. Export several layers at once or Export Layers to Files; Quick Export as PNG for documents and layers.

**Files** — open PNG, JPEG, GIF, WebP, BMP, SVG, ICO, AVIF and **PSD** (layers, masks, blend modes, opacity, clipping). Save as **PSD** (opens in Photoshop, GIMP, Photopea; Photon keeps type/shape/fill/adjustment layers editable via embedded metadata), **Photon Project (.phtn)** (lossless, everything editable), PNG, JPEG, WebP; Export As with preview and scaling; Quick Export PNG; Place Embedded; drag & drop; recent files; print.

**Panels** — Layers, Channels (RGB/R/G/B views, alpha channels), Paths, Color (hue cube / RGB), Swatches, Gradients, Properties (context-sensitive, adjustment layer controls), Adjustments, History, Navigator, Info, Histogram, Character, Paragraph, Brushes, Brush Settings.

## Keyboard shortcuts

Photoshop's defaults: `V` move, `M` marquee, `L` lasso, `W` quick selection/wand, `C` crop, `I` eyedropper, `J` healing, `B` brush, `S` clone, `Y` history brush, `E` eraser, `G` gradient, `O` dodge, `P` pen, `T` type, `A` path selection, `U` shapes, `H` hand, `Z` zoom (Shift+letter cycles a group); `D`/`X` colors, `Q` quick mask, `F` screen mode, `Tab` panels, `[` `]` brush size, `Shift+[` `]` hardness, `1`…`0` opacity, `Space` hand, `Ctrl+Z` / `Shift+Ctrl+Z` undo/redo, `Ctrl+X` / `Ctrl+C` / `Ctrl+V` cut/copy/paste (pastes back in place), `Shift+Ctrl+C` copy merged, `Ctrl+T` transform, `Ctrl+J` layer via copy (duplicate layer without a selection), `Shift+Ctrl+J` layer via cut, `Ctrl+G` group, `Shift+Ctrl+G` ungroup, `Ctrl+E` merge down, `Ctrl+L` levels, `Ctrl+M` curves, `Ctrl+U` hue/sat, `Ctrl+D` deselect, `Shift+Ctrl+I` inverse … The full list is under Help › Keyboard Shortcuts.

## Project layout

```
apps/photon/            Photon (TypeScript, no UI framework)
  src/core/             document model, layers, history, compositor, blend modes, brush engine,
                        selections, effects, adjustments, filters, text, shapes, paths, healing
  src/ops/              operations behind the menus (layers, edit, image, select, io/PSD, transforms)
  src/tools/            every tool (one class each)
  src/ui/               viewport, menus, toolbar, dock, widgets, icons
  src/panels/           Layers, Properties, Color, History, Channels, Paths, …
  src/dialogs/          dialogs: adjustments, filters, Liquify, Camera Raw, Layer Style, color picker, …
apps/photon/app.json    Photon manifest (version, window, file types), packaged with the app
apps/cut/               Cut (TypeScript)
  src/main/             main process: windows, dialogs, ranged file reads and render writes
  src/web/core/         project model, undo, media library (Mediabunny), frame streams, compositor,
                        audio mixer, transport, editing operations, renderer
  src/web/ui/           timeline, track headers, preview, media bin, properties, generators, dialogs
apps/facet/             Facet (TypeScript)
  src/main/             main process: desktop layers (one per display), click-through hit testing, icons,
                        wallpaper, start with Windows, Organize desktop, the Facet window and tray
  src/web/              the desktop layer (folders, open folders, clock, menus) and the Facet window
  native/FacetHelper.cs Windows helper: desktop pinning, shell icons and thumbnails, wallpaper, desktop icons
apps/prism/             Prism (TypeScript)
  src/main/             main process: windows & tabs, profiles/privacy, ad blocking, downloads, history,
                        bookmarks, permissions, menus, default-browser registration, prism:// pages
  src/ui/               the tab strip + toolbar UI and the address-bar suggestion overlay
  src/pages/            New Tab, Settings, History, Downloads and Bookmarks pages
  src/preload/          bridges for the UI and for web pages (element hiding, internal-page API)
  standalone/main.cjs   host for running Prism as its own Prism.exe
electron/               Crystal Suite: launcher UI, app manager (catalog, download, verify, install,
                        update, shortcuts), zip reader, app windows, native file dialogs
scripts/build-prism.cjs bundles Prism (esbuild + vite) and snapshots the filter lists
scripts/dist-prism.cjs  builds the standalone Prism installers
scripts/build-cut.cjs   bundles Cut (esbuild + vite)
scripts/build-facet.cjs bundles Facet (esbuild + vite) and compiles FacetHelper.exe
scripts/pack-apps.cjs   packages apps into release zips and writes catalog.json
catalog.json            the published app catalog the launcher reads
```

Each layer is a canvas positioned in document space; undo is snapshot-based (structural changes swap canvas references, brush strokes store only the changed rectangle). The compositor re-renders only dirty rectangles and supports native and software blend modes, masks, clipping groups, layer styles and adjustment layers.

## License

MIT — see [LICENSE](LICENSE). PSD reading/writing uses [ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT). Prism's ad blocking uses [@ghostery/adblocker](https://github.com/ghostery/adblocker) (MPL-2.0) — see [apps/prism/THIRD_PARTY_NOTICES.md](apps/prism/THIRD_PARTY_NOTICES.md). Cut reads and writes media with [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0) — see [apps/cut/THIRD_PARTY_NOTICES.md](apps/cut/THIRD_PARTY_NOTICES.md). Facet uses no third-party code. "Photoshop" is a trademark of Adobe, "Chrome" of Google, "Vegas Pro" of MAGIX and "iPhone" of Apple; Crystal Suite is an independent project and is not affiliated with any of them.
