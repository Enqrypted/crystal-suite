// Preload for Prism's own UI (tab strip + toolbar, and the address-bar suggestion list).
import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = new Set(['state', 'focus-omnibox', 'focus-find', 'suggest', 'omnibox-done']);

contextBridge.exposeInMainWorld('prismUI', {
  send: (action: string, ...args: unknown[]) => ipcRenderer.invoke('ui', action, ...args),
  on: (channel: string, cb: (data: unknown) => void) => {
    if (CHANNELS.has(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});
