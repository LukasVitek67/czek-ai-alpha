'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  snapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  call: (id) => ipcRenderer.invoke('monitor:call', String(id)),
  openLogs: () => ipcRenderer.invoke('monitor:openLogs'),
  openCalls: () => ipcRenderer.invoke('monitor:openCalls'),
  report: () => ipcRenderer.invoke('monitor:report'),
  copy: (text) => ipcRenderer.invoke('monitor:copy', String(text)),
  fullLog: (on) => ipcRenderer.invoke('monitor:fullLog', !!on),
});
