// Cut's editor UI -> dist/cut/web (the main process and preload are bundled by scripts/build-cut.cjs).
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'apps/cut/src/web'),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: resolve(__dirname, 'dist/cut/web'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000,
  },
});
