// Bridge for the Crystal Suite launcher window: app catalog, installs, updates and settings.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('crystalSuite', {
  getState: call('suite:state'),
  refresh: call('suite:refresh'),
  install: call('suite:install'),
  cancel: call('suite:cancel'),
  uninstall: call('suite:uninstall'),
  launch: call('suite:launch'),
  reveal: call('suite:reveal'),
  openAppsFolder: call('suite:open-apps-folder'),
  setSetting: call('suite:set-setting'),
  clearError: call('suite:clear-error'),
  dismissNotice: call('suite:dismiss-notice'),
  openUrl: call('suite:open-url'),
  onState: (cb) => ipcRenderer.on('suite:state', (_e, state) => cb(state)),
});
