'use strict';

// Bridge between the app UI (renderer/) and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['guest:console', 'guest:open-url', 'menu', 'watch:changed', 'watch:error']);
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('wt', {
  appInfo: () => invoke('app:info'),
  configurePane: (id, cfg) => invoke('pane:configure', id, cfg),
  capture: (id, opts) => invoke('pane:capture', id, opts),
  mouseMove: (id, x, y) => invoke('pane:mouse-move', id, x, y),
  storeGet: (key) => invoke('store:get', key),
  storeSet: (key, value) => invoke('store:set', key, value),
  saveImage: (data, name) => invoke('file:save-image', { data, name }),
  showInFolder: (file) => invoke('file:show', file),
  openShotsFolder: () => invoke('file:open-shots'),
  openFileDialog: () => invoke('file:open-dialog'),
  pickFolder: () => invoke('watch:pick'),
  watchStart: (dir) => invoke('watch:start', dir),
  watchStop: () => invoke('watch:stop'),
  clearSiteData: () => invoke('session:clear'),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event channel: ${channel}`);
    const listener = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
