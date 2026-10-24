'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  init: () => ipcRenderer.invoke('pet:init'),
  say: (text) => ipcRenderer.invoke('pet:say', { text }),
  config: (patch) => ipcRenderer.invoke('pet:config', patch),
  probe: () => ipcRenderer.invoke('pet:probe'),
  avatars: () => ipcRenderer.invoke('pet:avatars'),
  scale: (k) => ipcRenderer.invoke('pet:scale', { scale: k }),
  resize: (w, h) => ipcRenderer.invoke('pet:resize', { w, h }),
  hit: (v) => ipcRenderer.send('pet:hit', v),
  audioDone: () => ipcRenderer.send('pet:audio-done'),
  record: () => ipcRenderer.send('pet:record'),
  listen: (v) => ipcRenderer.send('pet:listen', v),
  asrStatus: (opts) => ipcRenderer.invoke('pet:asr-status', opts || {}),
  openPrivacy: (kind) => ipcRenderer.send('pet:open-privacy', kind),
  drag: (a) => ipcRenderer.send('pet:drag', a),
  vis: (v) => ipcRenderer.send('pet:vis', v),
  quit: () => ipcRenderer.send('pet:quit'),
  stopSpeak: () => ipcRenderer.send('pet:stop-speak'),
  log: (m) => ipcRenderer.send('pet:log', m),
  open: (what) => ipcRenderer.send('pet:open', what),
  on: (cb) => {
    ipcRenderer.on('pet:ev', (_e, d) => cb(d));
  },
});
