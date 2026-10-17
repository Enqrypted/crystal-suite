// Onyx's two pages -> dist/onyx/web (main process, preload and helper are built by scripts/build-onyx.cjs).
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'apps/onyx/src/web'),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: resolve(__dirname, 'dist/onyx/web'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'apps/onyx/src/web/index.html'),
        overlay: resolve(__dirname, 'apps/onyx/src/web/overlay.html'),
      },
    },
  },
});
