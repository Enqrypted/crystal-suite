// Prism's browser UI and internal pages -> dist/prism/web (the main process is bundled by scripts/build-prism.cjs).
import { defineConfig } from 'vite';
import { resolve } from 'path';

const root = resolve(__dirname, 'apps/prism/src');
const page = (p: string) => resolve(root, p);

export default defineConfig({
  root,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: resolve(__dirname, 'dist/prism/web'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        ui: page('ui/index.html'),
        suggest: page('ui/suggest.html'),
        newtab: page('pages/newtab.html'),
        settings: page('pages/settings.html'),
        history: page('pages/history.html'),
        downloads: page('pages/downloads.html'),
        bookmarks: page('pages/bookmarks.html'),
      },
    },
  },
});
