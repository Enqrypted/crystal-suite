# Third-party software in Opal

Opal itself is MIT licensed (see LICENSE). It bundles:

- **libheif** — GNU Lesser General Public License 3.0, © Dirk Farin and the libheif contributors. Source: https://github.com/strukturag/libheif. Decodes HEIC/HEIF photos. It ships compiled to WebAssembly by the **libheif-js** project (https://github.com/catdad-experiments/libheif-js, version 1.23.5), together with the **libde265** HEVC decoder (LGPL 3.0, © struktur AG, https://github.com/strukturag/libde265). Both are used unmodified and kept as their own files, `web/libheif/libheif.js` and `web/libheif/libheif.wasm`, which Opal loads at run time: you may replace them with your own build of the same interface. Their licence (LGPL 3.0, with the GNU GPL 3.0 it builds on) is in `web/libheif/LICENSE`; the source code is at the links above.
- **exifr** — MIT License, © Mike Kovařík. Source: https://github.com/MikeKovarik/exifr. Reads photo details (date taken, camera, exposure, location).
- **Electron / Chromium** — MIT and BSD-style licences, provided by the Crystal Suite launcher. Chromium decodes JPEG, PNG, GIF, WebP, AVIF, BMP and ICO.
