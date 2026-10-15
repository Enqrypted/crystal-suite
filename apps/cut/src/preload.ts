// Bridge between Cut's sandboxed editor window and its main process.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('cutNative', {
  openMedia: call('cut:open-media'),
  openProject: call('cut:open-project'),
  saveProject: call('cut:save-project'),
  saveRender: call('cut:save-render'),
  defaultRenderPath: call('cut:default-render-path'),
  stat: call('cut:stat'),
  read: call('cut:read'),
  readText: call('cut:read-text'),
  writeText: call('cut:write-text'),
  openWrite: call('cut:open-write'),
  writeAt: call('cut:write-at'),
  closeWrite: call('cut:close-write'),
  showInFolder: call('cut:show-in-folder'),
  openPath: call('cut:open-path'),
  recent: call('cut:recent'),
  addRecent: call('cut:add-recent'),
  autosave: call('cut:autosave'),
  recovery: call('cut:recovery'),
  setTitle: call('cut:set-title'),
  about: call('cut:about'),
  openUrl: call('cut:open-url'),
  /** Absolute path of a file dropped from Explorer. */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onOpen: (cb: (req: { project?: string; media?: string[] }) => void) => { ipcRenderer.on('cut:open', (_e, req) => cb(req)); },
});
