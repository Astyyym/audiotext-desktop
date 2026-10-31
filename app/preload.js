'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listModels: () => ipcRenderer.invoke('models:list'),
  getModelCatalog: () => ipcRenderer.invoke('models:catalog'),
  downloadModel: (key) => ipcRenderer.invoke('model:download', key),
  cancelModelDownload: (key) => ipcRenderer.invoke('model:cancel', key),
  openModelsDir: () => ipcRenderer.invoke('models:openDir'),
  onModelEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('model:event', handler);
    return () => ipcRenderer.removeListener('model:event', handler);
  },
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),

  getTerms: () => ipcRenderer.invoke('terms:get'),
  saveTerms: (t) => ipcRenderer.invoke('terms:save', t),

  listHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  getHistoryPath: () => ipcRenderer.invoke('history:path'),
  revealHistory: () => ipcRenderer.invoke('history:reveal'),

  pickFiles: () => ipcRenderer.invoke('files:pick'),
  probe: (p) => ipcRenderer.invoke('file:probe', p),
  startTask: (payload) => ipcRenderer.invoke('transcribe:start', payload),
  cancelTask: (id) => ipcRenderer.send('transcribe:cancel', id),
  readText: (p) => ipcRenderer.invoke('preview:read', p),
  copyText: (t) => ipcRenderer.send('clipboard:write', t),
  showInFolder: (p) => ipcRenderer.send('shell:showInFolder', p),
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  onEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('transcribe:event', handler);
    return () => ipcRenderer.removeListener('transcribe:event', handler);
  },

  winMinimize: () => ipcRenderer.send('win:minimize'),
  winToggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
  winClose: () => ipcRenderer.send('win:close'),
});
