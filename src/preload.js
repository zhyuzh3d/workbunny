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
  audioStarted: () => ipcRenderer.send('pet:audio-started'),
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
  // 独立窗口（设置 / 动作列表）用：拿初始数据、把动作转给角色窗口演
  panelInit: () => ipcRenderer.invoke('pet:panel-init'),
  panelMotion: (key) => ipcRenderer.send('pet:panel-motion', key),
  // 大脑 / 嘴巴
  brainInfo: () => ipcRenderer.invoke('pet:brain-info'),
  workbuddyOpen: () => ipcRenderer.invoke('pet:workbuddy-open'),
  brainModels: (brain) => ipcRenderer.invoke('pet:brain-models', brain),
  brainTest: (brain) => ipcRenderer.invoke('pet:brain-test', brain),
  ttsInfo: () => ipcRenderer.invoke('pet:tts-info'),
  chpDiscover: (patch) => ipcRenderer.invoke('pet:chp-discover', patch),
  chpHelp: () => ipcRenderer.send('pet:chp-help'),
  ttsDownload: () => ipcRenderer.invoke('pet:tts-download'),
  ttsCheck: () => ipcRenderer.invoke('pet:tts-check'),
  ttsDlState: () => ipcRenderer.invoke('pet:tts-dl-state'),
  ttsCancel: () => ipcRenderer.send('pet:tts-cancel'),
  ttsDelete: () => ipcRenderer.invoke('pet:tts-delete'),
  ttsTest: () => ipcRenderer.invoke('pet:tts-test'),
  on: (cb) => {
    ipcRenderer.on('pet:ev', (_e, d) => cb(d));
  },
});
