import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'path';

// Photon builds to one self-contained HTML file so it runs from disk
// (double-click) or inside the Electron shell with no server.
export default defineConfig({
  root: resolve(__dirname, 'apps/photon'),
  base: './',
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(__dirname, 'dist/photon'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5173, open: false },
});
