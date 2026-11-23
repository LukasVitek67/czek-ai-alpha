'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  data: () => ipcRenderer.invoke('picker:data'),
  choose: (p) => ipcRenderer.invoke('picker:choose', p),
  browse: () => ipcRenderer.invoke('picker:browse'),
  addPinned: () => ipcRenderer.invoke('picker:addPinned'),
  pin: (p, on) => ipcRenderer.invoke('picker:pin', p, on),
  forget: (p) => ipcRenderer.invoke('picker:forget', p),
  cancel: () => ipcRenderer.invoke('picker:cancel'),
});
