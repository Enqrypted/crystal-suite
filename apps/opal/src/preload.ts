// Bridge between Opal's sandboxed window and its main process.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('opalNative', {
  openDialog: call('opal:open-dialog'),
  folderDialog: call('opal:folder-dialog'),
  saveDialog: call('opal:save-dialog'),
  read: call('opal:read'),
  stat: call('opal:stat'),
  list: call('opal:list'),
  write: call('opal:write'),
  exists: call('opal:exists'),
  trash: call('opal:trash'),
  shellThumb: call('opal:shell-thumb'),
  thumbGet: call('opal:thumb-get'),
  thumbPut: call('opal:thumb-put'),
  asset: call('opal:asset'),
  copyImage: call('opal:copy-image'),
  showInFolder: call('opal:show-in-folder'),
  openUrl: call('opal:open-url'),
  edit: call('opal:edit'),
  recent: call('opal:recent'),
  addRecent: call('opal:add-recent'),
  clearRecent: call('opal:clear-recent'),
  settings: call('opal:settings'),
  setSettings: call('opal:set-settings'),
  setTitle: call('opal:set-title'),
  setFullscreen: call('opal:set-fullscreen'),
  isFullscreen: call('opal:is-fullscreen'),
  defaultStatus: call('opal:default-status'),
  makeDefault: call('opal:make-default'),
  about: call('opal:about'),
  /** Absolute path of a file dropped from Explorer. */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onOpen: (cb: (path: string) => void) => { ipcRenderer.on('opal:open', (_e, p) => cb(p)); },
  onFolderChanged: (cb: (folder: string) => void) => { ipcRenderer.on('opal:folder-changed', (_e, f) => cb(f)); },
  onFullscreen: (cb: (on: boolean) => void) => { ipcRenderer.on('opal:fullscreen', (_e, v) => cb(v)); },
});
