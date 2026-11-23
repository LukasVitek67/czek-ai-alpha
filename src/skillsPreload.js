'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('skills', {
  data: () => ipcRenderer.invoke('skills:data'),
  resync: () => ipcRenderer.invoke('skills:resync'),
  openFolder: () => ipcRenderer.invoke('skills:openFolder'),
  copy: (text) => ipcRenderer.invoke('skills:copy', text),
  openUrl: (url) => ipcRenderer.invoke('skills:openUrl', url),
});
