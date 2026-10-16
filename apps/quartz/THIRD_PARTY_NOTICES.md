# Third-party software in Quartz

Quartz itself is MIT licensed (see LICENSE). It bundles:

- **PDF.js** (`pdfjs-dist`) — Apache License 2.0, © Mozilla Foundation. Source: https://github.com/mozilla/pdf.js. Used unmodified (its "legacy" build) for reading, rendering, searching, filling forms, annotating and saving PDFs. Its licence is in `web/pdfjs/LICENSE`. PDF.js comes with data files that keep their own licences, next to them in `web/pdfjs/`:
  - character maps (`cmaps/`) — © Adobe Systems, BSD-3-Clause (`cmaps/LICENSE`);
  - the standard fonts (`standard_fonts/`) — Foxit fonts from PDFium, BSD-3-Clause (`LICENSE_FOXIT`), and Liberation Sans, © Red Hat, GPLv2 with the font exception (`LICENSE_LIBERATION`);
  - image decoders compiled to WebAssembly (`wasm/`) — OpenJPEG (BSD-2-Clause, `LICENSE_OPENJPEG`), PDFium's JBIG2 decoder (BSD-3-Clause, `LICENSE_JBIG2`) and qcms colour management (MIT, `LICENSE_QCMS`), with Mozilla's wrappers (`LICENSE_PDFJS_*`);
  - interface icons (`images/`) — part of PDF.js, Apache-2.0.
- **pdf-lib** — MIT License, © Andrew Dillon. Source: https://github.com/Hopding/pdf-lib. Used unmodified for organizing pages (reorder, rotate, delete, insert, extract), combining and splitting documents, and document properties.
- **Electron / Chromium** — MIT and BSD-style licences, provided by the Crystal Suite launcher. Printing uses Chromium's print support.
