// Bridge between Facet's sandboxed pages (the desktop layer and the Facet window) and its main process.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
const listen = (channel: string) => (cb: (value: unknown) => void) => { ipcRenderer.on(channel, (_e, v) => cb(v)); };

contextBridge.exposeInMainWorld('facet', {
  init: call('facet:init'),
  put: call('facet:put'),
  add: call('facet:add'),
  remove: call('facet:remove'),
  addItems: call('facet:add-items'),
  settings: call('facet:settings'),
  icon: call('facet:icon'),
  exists: call('facet:exists'),
  open: call('facet:open'),
  reveal: call('facet:reveal'),
  pick: call('facet:pick'),
  desktop: call('facet:desktop'),
  categorize: call('facet:categorize'),
  organize: call('facet:organize'),
  desktopIcons: call('facet:desktop-icons'),
  home: call('facet:home'),
  quit: call('facet:quit'),
  command: call('facet:command'),
  rects: call('facet:rects'),
  keyboard: call('facet:keyboard'),
  readWall: call('facet:read-wall'),
  onState: listen('facet:state'),
  onWall: listen('facet:wall'),
  onInteractive: listen('facet:interactive'),
  onCommand: listen('facet:command'),
  /** Absolute path of a file dropped from Explorer. */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
});
