// Opal's viewer page -> dist/opal/web (the main process, preload and libheif files are handled by scripts/build-opal.cjs).
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'apps/opal/src/web'),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: resolve(__dirname, 'dist/opal/web'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    reportCompressedSize: false,
  },
  worker: { format: 'iife' },
});
