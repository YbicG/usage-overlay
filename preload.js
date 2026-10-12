'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  getState: () => ipcRenderer.invoke('get-state'),
  update: patch => ipcRenderer.send('update', patch),
  hide: () => ipcRenderer.send('hide'),
  refresh: () => ipcRenderer.send('refresh'),
  cycleMode: () => ipcRenderer.send('cycle-mode'),
  openData: () => ipcRenderer.send('open-data'),
  copy: t => ipcRenderer.send('copy', t),
  quit: () => ipcRenderer.send('quit'),
  contentHeight: h => ipcRenderer.send('content-height', h),
  on: (ch, fn) => { ipcRenderer.on(ch, (_e, d) => fn(d)); },
});
