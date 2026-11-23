'use strict';
// Úvodní okno (načítání): jen příjem stavu startu z hlavního procesu.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onState: (cb) => ipcRenderer.on('splash:state', (_e, s) => cb(s)),
});
