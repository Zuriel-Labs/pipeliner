'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pipeliner', Object.freeze({
  request: payload => ipcRenderer.invoke('connections:control', payload),
  onStatus: callback => { ipcRenderer.on('connections:status', (_event, value) => callback(value)); },
}));
