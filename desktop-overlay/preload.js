/* Electron preload. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  setMouse: (over) => ipcRenderer.send('set-mouse', !!over),
  close: () => ipcRenderer.send('close'),
  setSide: (v) => ipcRenderer.send('set-side', v),
  setAuto: (v) => ipcRenderer.send('set-auto', !!v),
  setHz: (v) => ipcRenderer.send('set-hz', v),
  onState: (cb) => ipcRenderer.on('state', (_e, st) => cb(st)),
});
