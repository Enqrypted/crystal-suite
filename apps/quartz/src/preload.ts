// Bridge between Quartz's sandboxed window and its main process.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('quartzNative', {
  openDialog: call('quartz:open-dialog'),
  imageDialog: call('quartz:image-dialog'),
  saveDialog: call('quartz:save-dialog'),
  folderDialog: call('quartz:folder-dialog'),
  read: call('quartz:read'),
  stat: call('quartz:stat'),
  write: call('quartz:write'),
  recent: call('quartz:recent'),
  addRecent: call('quartz:add-recent'),
  removeRecent: call('quartz:remove-recent'),
  signatures: call('quartz:signatures'),
  setSignatures: call('quartz:set-signatures'),
  asset: call('quartz:asset'),
  showInFolder: call('quartz:show-in-folder'),
  openPath: call('quartz:open-path'),
  openUrl: call('quartz:open-url'),
  setTitle: call('quartz:set-title'),
  print: call('quartz:print'),
  defaultStatus: call('quartz:default-status'),
  makeDefault: call('quartz:make-default'),
  about: call('quartz:about'),
  /** Absolute path of a file dropped from Explorer. */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onOpen: (cb: (paths: string[]) => void) => { ipcRenderer.on('quartz:open', (_e, paths) => cb(paths)); },
});
