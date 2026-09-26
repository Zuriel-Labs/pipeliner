'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('shellProbe', {
  ping: payload => ipcRenderer.invoke('shell:ping', payload),
  helper: payload => ipcRenderer.invoke('shell:helper', payload),
  dialog: () => ipcRenderer.invoke('shell:dialog', null),
  status: () => ipcRenderer.invoke('shell:status', null),
});
