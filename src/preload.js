'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const h = (_e, d) => cb(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listModels: (force) => ipcRenderer.invoke('models:list', force),
  testProvider: (id, model) => ipcRenderer.invoke('provider:test', id, model),
  wizardSmoke: () => ipcRenderer.invoke('wizard:smoke'),
  modelsBench: () => ipcRenderer.invoke('models:bench'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (id) => ipcRenderer.invoke('sessions:get', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  renameSession: (id, t) => ipcRenderer.invoke('sessions:rename', id, t),
  pickWorkspace: (cur) => ipcRenderer.invoke('workspace:pick', cur),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  reveal: (p) => ipcRenderer.invoke('open:reveal', p),
  send: (o) => ipcRenderer.invoke('agent:send', o),
  stop: (id) => ipcRenderer.invoke('agent:stop', id),
  running: () => ipcRenderer.invoke('agent:running'),
  replyPermission: (reqId, decision, note) => ipcRenderer.invoke('permission:reply', reqId, decision, note),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  about: () => ipcRenderer.invoke('app:about'),
  diagData: (sessionId) => ipcRenderer.invoke('diag:data', sessionId),
  diagExport: () => ipcRenderer.invoke('diag:export'),
  diagOpenFolder: () => ipcRenderer.invoke('diag:openFolder'),
  openDataDir: () => ipcRenderer.invoke('app:openData'),
  configureOpencode: () => ipcRenderer.invoke('proxy:opencode'),
  openOpencode: () => ipcRenderer.invoke('opencode:open'),
  openOmni: () => ipcRenderer.invoke('omni:open'),
  keyHealth: (force) => ipcRenderer.invoke('keys:health', force),
  onKeyHealth: on('keys:health'),
  keysFile: () => ipcRenderer.invoke('keysfile:get'),
  keysFileSync: () => ipcRenderer.invoke('keysfile:sync'),
  keysFilePick: () => ipcRenderer.invoke('keysfile:pick'),
  vault: (op, arg) => ipcRenderer.invoke('vault:' + ({ get: 'get', sync: 'sync', create: 'create', join: 'join', unlink: 'unlink', exportFile: 'exportFile', importFile: 'importFile' }[op] || 'get'), arg),
  onKeysChanged: on('keys:changed'),
  copyText: (t) => ipcRenderer.invoke('clipboard:write', t),
  closeWindow: () => ipcRenderer.invoke('win:close'),
  getTiers: (force) => ipcRenderer.invoke('tiers:get', force),
  openSkills: () => ipcRenderer.invoke('skills:show'),
  onProxyChanged: on('proxy:changed'),
  onNav: on('nav'),
  onEvent: on('agent:event'),
  onSessionsChanged: on('sessions:changed'),
});
