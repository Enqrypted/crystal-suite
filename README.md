# Crystal Suite

A free, open-source, fully local creative suite. No accounts, no subscription, no cloud — everything runs on your computer.

The **Crystal Suite** app is a launcher (like Creative Cloud) that installs, updates and opens the suite's apps.

| App | Status | Like |
| --- | --- | --- |
| **Photon** | ✅ Available (install it from the launcher) | Photoshop |
| Vector | Planned | Illustrator |
| Darkroom | Planned | Lightroom |
| Cut | Planned | Premiere Pro |
| Motion | Planned | After Effects |
| Layout | Planned | InDesign |

## Download

Get **`CrystalSuite-Setup-x.y.z.exe`** from the [latest release](https://github.com/Enqrypted/crystal-suite/releases/latest) (or the portable **`CrystalSuite-Portable-x.y.z.exe`**, no installation needed).

Crystal Suite is a launcher, like Creative Cloud: open it, click **Install** next to Photon and it downloads (about 270 KB, because the apps share the launcher's runtime), verifies and installs it. From then on:

- **Open** starts the app; Photon also gets its own Start-menu (and optional desktop) shortcut and taskbar icon.
- New versions show up under **Updates** (with a count in the sidebar). They install in the background automatically unless you turn that off in **Settings**; an app that is open keeps running and switches to the new version the next time you start it.
- **⋯ → Uninstall** removes an app. Uninstalling Crystal Suite removes its apps too.
- Everything works offline once installed: the internet is only used to fetch the app catalog and downloads. No account, no telemetry.

Apps are stored in `%LOCALAPPDATA%\Crystal Suite\Apps`. The builds are not code-signed, so Windows SmartScreen may show "Windows protected your PC" the first time: click **More info → Run anyway**.

## Running from source

Requirements: [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm run app        # the Crystal Suite launcher (installs Photon from the published catalog)
npm run photon     # builds Photon from source and opens it directly
npm run dev        # Photon in your browser with hot reload: http://localhost:5173
```

On Windows you can also double-click **`Crystal Suite.cmd`** or **`Photon.cmd`** (the first run installs and builds automatically). You can drag image or PSD files onto `Photon.cmd` to open them.

`dist/photon/index.html` (from `npm run build`) is a single self-contained file: you can also open it straight in Chrome/Edge without the desktop shell (in a browser a few shortcuts like Ctrl+N / Ctrl+T / Ctrl+W are reserved by the browser itself; they all work in the desktop app).

## How the launcher gets apps

- `catalog.json` (in this repo, read from `raw.githubusercontent.com`) lists each app's version, download URL, size and SHA-256, plus the latest launcher version.
- Each app is a zip on a GitHub release (`photon-v0.1.0` → `photon-0.1.0.zip`) containing its single-file `index.html`, `app.json` manifest and icons.
- The launcher downloads it with progress, rejects it unless the size and SHA-256 match the catalog, unpacks it to `Apps\<id>\<version>` (checking that every path stays inside that folder) and runs it in a sandboxed window with a narrow file-access bridge.

To test against a local catalog: `node scripts/pack-apps.cjs --base http://127.0.0.1:8765/`, serve `release/apps`, and start the launcher with `CRYSTAL_CATALOG=http://127.0.0.1:8765/catalog.json` (and `CRYSTAL_HOME=<folder>` to keep test installs separate).

## Publishing a release

```bash
# A new Photon version: bump "version" in apps/photon/app.json, then
npm run pack:apps                     # builds Photon, writes release/apps/photon-<v>.zip and catalog.json
gh release create photon-v<v> release/apps/photon-<v>.zip --title "Photon <v>" --latest=false
git commit -am "Photon <v>" && git push   # launchers see the new version once catalog.json is pushed

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
electron/               Crystal Suite: launcher UI, app manager (catalog, download, verify, install,
                        update, shortcuts), zip reader, app windows, native file dialogs
scripts/pack-apps.cjs   packages apps into release zips and writes catalog.json
catalog.json            the published app catalog the launcher reads
```

Each layer is a canvas positioned in document space; undo is snapshot-based (structural changes swap canvas references, brush strokes store only the changed rectangle). The compositor re-renders only dirty rectangles and supports native and software blend modes, masks, clipping groups, layer styles and adjustment layers.

## License

MIT — see [LICENSE](LICENSE). PSD reading/writing uses [ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT). "Photoshop" is a trademark of Adobe; Crystal Suite is an independent project and is not affiliated with Adobe.
