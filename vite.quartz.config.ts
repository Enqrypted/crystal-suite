// Quartz's reader/editor UI -> dist/quartz/web (the main process and preload are bundled by scripts/build-quartz.cjs).
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'apps/quartz/src/web'),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: resolve(__dirname, 'dist/quartz/web'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 4000,
  },
});
