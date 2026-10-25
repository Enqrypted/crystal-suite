// Narrow bridge between a sandboxed app window (Photon, ...) and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photonNative', {
  openFiles: (filters) => ipcRenderer.invoke('open-files', filters),
  saveFile: (o) => ipcRenderer.invoke('save-file', o),
  writeFile: (path, data) => ipcRenderer.invoke('write-file', path, data),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  chooseFolder: (o) => ipcRenderer.invoke('choose-folder', o),
  onOpenPaths: (cb) => ipcRenderer.on('open-paths', (_e, paths) => cb(paths)),
  /** The app asks about unsaved work itself: closing the window calls `cb` instead of showing the generic prompt. */
  onCloseRequest: (cb) => { ipcRenderer.send('app:handles-close'); ipcRenderer.on('app:close-request', () => cb()); },
});
