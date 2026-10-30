#!/usr/bin/env node
'use strict';

/* Hidden Electron fixture for the real settings panel renderer. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
if (!app || !BrowserWindow || !process.versions.electron) throw new Error('Run with node_modules/.bin/electron test/test-panel-scene-settings.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-panel-scenes-'));
app.setPath('userData', path.join(tmp, 'userData'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
const preload = path.join(tmp, 'panel-fixture-preload.cjs');
const panelHtml = path.resolve(__dirname, '../src/renderer/panel.html');
const calls = [];
let listeners = [];
let failNextConfig = false;
let settings = {
  settingsRevision: 1,
  avatar: 'fixture-avatar',
  window: { scale: 1 },
  buddy: { name: 'Fixture', ownerName: '主人', profile: '共通角色设定必须保持五行。', sceneProfiles: { private: '私聊原设定', life: '生活原设定', work: '工作原设定' } },
  memory: { enabled: true, extract: false, scene: 'life' },
  voice: { alwaysListen: true }, asr: { judge: true },
  brain: { source: 'workbuddy', provider: 'deepseek', model: 'hy3', thinking: 'low', apiKey: 'brain-secret', profiles: { deepseek: { apiKey: 'deepseek-secret', modelId: 'deepseek-v4.1-flash', thinking: 'high' } } },
  tts: { enabled: true, engine: 'system', voice: 'Tingting', rate: 200, hasApiKey: true, apiKey: 'tts-secret', baseURL: 'http://fixture', qwen: { voice: 'serena' }, chp: { voice: 'fixture' } },
  motions: { disabled: [] },
};
const windows = [];

fs.writeFileSync(preload, `
  const { contextBridge, ipcRenderer } = require('electron');
  const api = (name, ...args) => ipcRenderer.invoke('panel-fixture:api', name, ...args);
  contextBridge.exposeInMainWorld('pet', {
    log: () => {}, selfView: () => api('selfView'), selfSettings: value => api('selfSettings', value), portability: () => api('portability'), ttsHTTPTemplate: kind => api('ttsHTTPTemplate', kind),
    panelInit: (...a) => api('panelInit', ...a), brainInfo: (...a) => api('brainInfo', ...a), ttsInfo: (...a) => api('ttsInfo', ...a),
    config: (...a) => api('config', ...a), on: cb => ipcRenderer.on('panel-fixture:event', (_e, value) => cb(value)),
    __fixture: { emitConfig: value => ipcRenderer.invoke('panel-fixture:control', 'emitConfig', value),
      failNextConfig: () => ipcRenderer.invoke('panel-fixture:control', 'failNextConfig'), getCalls: () => ipcRenderer.invoke('panel-fixture:control', 'getCalls') }
  });
`);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) target[key] = merge({ ...(target[key] || {}) }, value);
    else target[key] = value;
  }
  return target;
}
function applyConfig(patch) {
  settings = merge(settings, patch);
  settings.settingsRevision++;
  return clone(settings);
}

ipcMain.handle('panel-fixture:control', (_event, action, patch) => {
  if (action === 'failNextConfig') { failNextConfig = true; return true; }
  if (action === 'getCalls') return calls;
  if (action === 'emitConfig') {
    const config = applyConfig(patch);
    for (const win of windows) if (!win.isDestroyed()) win.webContents.send('panel-fixture:event', { type: 'config', config });
    return true;
  }
  return false;
});

ipcMain.handle('panel-fixture:api', async (_event, name, ...args) => {
  if (name === 'selfView') return { revision: settings.settingsRevision, settings: { identity: settings.buddy.profile, behavior: '' } };
  if (name === 'selfSettings') { settings.buddy.profile = args[0].identity; return { revision: settings.settingsRevision, settings: args[0] }; }
  if (name === 'portability') return { connection: { ready: true, note: '已连接' }, storage: { ok: true, dir: '/fixture/vault' }, asrMode: 'continuous', capabilities: {} };
  if (name === 'ttsHTTPTemplate') return require('../src/main/tts-http-profile').template(args[0]);
  if (name === 'panelInit') return { config: clone(settings), avatars: [{ key: 'fixture-avatar', label: '测试角色' }], avatar: 'fixture-avatar',
    motions: [], motionGroups: [], asr: { speech: 3, micSystem: 'granted' } };
  if (name === 'brainInfo') return { providers: [{ id: 'deepseek', label: 'DeepSeek', hint: 'fixture provider' }, { id: 'grok', label: 'Grok' }],
    workbuddyModels: [{ id: 'hy3', label: 'Hy3', thinking: [{ id: 'low', label: '低' }] }], workbuddyThinking: [{ id: 'low', label: '低' }], thinkingLevels: [] };
  if (name === 'ttsInfo') return { engines: [{ id: 'system', label: '系统语音' }, { id: 'qwen', label: 'Qwen' }, { id: 'remote', label: 'CHP' }],
    systemVoices: [{ id: 'Tingting', lang: 'zh-CN' }], qwen: { ready: false, downloaded: false, hasRuntime: true, hasFiles: false, voices: [] }, dl: {}, chp: null };
  if (name === 'config') {
    const patch = args[0] || {};
    calls.push(clone(patch));
    if (failNextConfig) { failNextConfig = false; throw new Error('fixture config rejected'); }
    return applyConfig(patch);
  }
  throw new Error(`unexpected panel fixture API: ${name}`);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  throw new Error(`fixture timeout: ${label}`);
}
async function evalIn(win, code) { return win.webContents.executeJavaScript(code, true); }
async function click(win, id) { await evalIn(win, `document.getElementById(${JSON.stringify(id)}).click()`); }

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 520, height: 720, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windows.push(win);
  win.webContents.on('console-message', (_e, level, message, line) => console.error(`panel fixture console[${level}] ${line}: ${message}`));
  await win.loadFile(panelHtml, { query: { p: 'settings' } });
  await waitFor(() => evalIn(win, "document.getElementById('setProfile').value" ).then(value => value.includes('共通角色设定')), 'settings profile rendered');

  const scene = () => evalIn(win, "document.querySelector('#panelScene [aria-pressed=true]')?.dataset.scene");
  const select = name => evalIn(win, `document.querySelector('#panelScene [data-scene=${name}]').click()`);
  assert.equal(await scene(), 'life');
  assert.equal(await evalIn(win, "document.getElementById('setProfile').rows"), 6);
  await evalIn(win, "document.getElementById('setAlways').checked=false; document.getElementById('setAlways').dispatchEvent(new Event('change',{bubbles:true}))");
  await select('work');
  await waitFor(() => Promise.resolve(settings.memory.scene === 'work'), 'work scene persisted');
  assert.deepEqual(calls.at(-1), { memory: { scene: 'work' } });
  assert.equal(await evalIn(win, "document.getElementById('setAlways').checked"), false);
  await click(win, 'saveBtn');
  await waitFor(() => Promise.resolve(settings.voice.alwaysListen === false), 'draft saved');
  assert.equal(settings.brain.apiKey, 'brain-secret');
  assert.equal(settings.brain.profiles.deepseek.apiKey, 'deepseek-secret');
  assert.equal(settings.tts.apiKey, 'tts-secret');
  failNextConfig = true; await select('private');
  await waitFor(() => evalIn(win, "document.getElementById('panelSceneProfileStatus').textContent.includes('fixture config rejected')"), 'failure shown');
  assert.equal(await scene(), 'work');
  assert.equal(settings.memory.scene, 'work');

  await win.close();
  console.log('panel scene-settings fixture passed (hidden Electron window, stub APIs, isolated userData)');
  app.exit(0);
}

main().catch(error => {
  console.error(error.stack || error);
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  app.exit(1);
})
  .finally(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
