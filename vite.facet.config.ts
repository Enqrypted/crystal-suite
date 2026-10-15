// Facet's two pages -> dist/facet/web (main process, preload and helper are built by scripts/build-facet.cjs).
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'apps/facet/src/web'),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: resolve(__dirname, 'dist/facet/web'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        desk: resolve(__dirname, 'apps/facet/src/web/desk.html'),
        home: resolve(__dirname, 'apps/facet/src/web/home.html'),
      },
    },
  },
});
