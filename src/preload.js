const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (c) => ipcRenderer.invoke('config:set', c),
  ask: (q) => ipcRenderer.invoke('agent:ask', q),
  reset: () => ipcRenderer.invoke('agent:reset'),
  abort: () => ipcRenderer.invoke('agent:abort'),
  openExternal: (u) => ipcRenderer.invoke('open:external', u),
  onEvent: (cb) => ipcRenderer.on('agent:event', (_e, ev) => cb(ev)),
});
