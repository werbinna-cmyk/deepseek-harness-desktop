'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('owApi', {
  get: () => ipcRenderer.invoke('ow:get'),
  save: (cfg) => ipcRenderer.invoke('ow:save', cfg),
  connect: () => ipcRenderer.invoke('ow:connect'),
});
