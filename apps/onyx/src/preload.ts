// Bridge between Onyx's sandboxed windows (the main window and the in-game overlay) and its main process.
import { contextBridge, ipcRenderer } from 'electron';

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('onyxNative', {
  init: call('onyx:init'),
  settings: call('onyx:settings'),
  save: call('onyx:save'),
  clips: call('onyx:clips'),
  thumb: call('onyx:thumb'),
  windows: call('onyx:windows'),
  pickWindow: call('onyx:pick-window'),
  rule: call('onyx:rule'),
  hotkeyCapture: call('onyx:hotkey-capture'),
  setHotkey: call('onyx:set-hotkey'),
  folderDialog: call('onyx:folder-dialog'),
  openFolder: call('onyx:open-folder'),
  reveal: call('onyx:reveal'),
  open: call('onyx:open'),
  trash: call('onyx:trash'),
  quit: call('onyx:quit'),
  onState: (cb: (s: unknown) => void) => { ipcRenderer.on('onyx:state', (_e, s) => cb(s)); },
  onClipsChanged: (cb: () => void) => { ipcRenderer.on('onyx:clips-changed', () => cb()); },
  onOverlay: (cb: (m: unknown) => void) => { ipcRenderer.on('onyx:overlay', (_e, m) => cb(m)); },
  /** The overlay: the pointer is over (or has left) the notice's button, and its button was clicked. */
  overlayHover: (on: boolean) => ipcRenderer.send('onyx:overlay-hover', !!on),
  overlayAction: call('onyx:overlay-action'),
});
