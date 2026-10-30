#!/usr/bin/env node
'use strict';

// Isolated end-to-end smoke test for the real Electron renderer -> IPC ->
// WorkBuddy free Hy3 web-search path. Run only when a live request is approved:
// node_modules/.bin/electron test/test-web-search-live.cjs
// It uses a random temporary profile and never reads or changes WorkBuddy config.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow } = electron;
if (!app || !BrowserWindow || !process.versions.electron) throw new Error('请使用 Electron 运行联网端到端验收');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-web-search-live-'));
const userData = path.join(temp, 'profile');
const vaultDir = path.join(userData, 'vault');
const testKey = crypto.randomBytes(32);
const query = '请联网核实腾讯WorkBuddy开放平台官网，简单告诉我是否找到。';
let hiddenWindow = null;
let finished = false;
let deadlineTimer = null;
process.once('exit', () => {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  testKey.fill(0);
});

function prepareIsolatedProfile() {
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  const config = {
    memory: { enabled: true, extract: false, scene: 'life', recentRounds: 8 },
    voice: { enabled: false, autoSpeak: false, alwaysListen: false },
    tts: { enabled: false, engine: 'system' },
    monitor: { enabled: false, root: path.join(temp, 'empty-monitor-root') },
    brain: { source: 'workbuddy', model: 'hy3', thinking: 'low', provider: 'deepseek', apiKey: '', profiles: {} },
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  // Hy3 has a source fallback entry, so no account-specific catalog/config is copied.
  process.env.BUDDY_PET_HOME = userData;
  process.env.BUDDY_PET_NO_SANDBOX = '1';
  try { app.setPath('userData', userData); } catch {}
  try { app.commandLine.appendSwitch('no-sandbox'); app.commandLine.appendSwitch('disable-gpu-sandbox'); } catch {}
}

function isolateDesktopSideEffects() {
  // The real main entry still creates its windows and IPC handlers, but keeps
  // this verification hidden and cannot steal global shortcuts or request mic access.
  try { app.requestSingleInstanceLock = () => true; } catch {}
  try { BrowserWindow.prototype.showInactive = function () {}; } catch {}
  try { BrowserWindow.prototype.show = function () {}; } catch {}
  try { electron.globalShortcut.register = () => true; electron.globalShortcut.unregisterAll = () => {}; } catch {}
  try {
    electron.systemPreferences.getMediaAccessStatus = () => 'granted';
    electron.systemPreferences.askForMediaAccess = async () => false;
  } catch {}
  try {
    electron.Tray = class HiddenFixtureTray {
      constructor() { throw new Error('hidden live fixture suppresses the system tray'); }
    };
  } catch {}
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function eventually(check, label, timeoutMs = 68000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await wait(100);
  }
  throw new Error(`90秒验收预算内未完成：${label}`);
}
async function evaluate(script) {
  if (!hiddenWindow || hiddenWindow.isDestroyed()) throw new Error('隔离 Electron 窗口已关闭');
  return hiddenWindow.webContents.executeJavaScript(script, true);
}

function installTestKeyInjection() {
  const { MemoryService } = require('../src/main/memory-service');
  const originalInit = MemoryService.prototype.init;
  MemoryService.prototype.init = async function (...args) {
    if (this.dir === vaultDir) {
      this.openKey = async () => Buffer.from(testKey);
      global.__wbWebSearchTestMemory = this;
    }
    return originalInit.apply(this, args);
  };
}

function installUnlockedSessionFixture() {
  const { SessionGate } = require('../src/main/session-gate');
  const originalStart = SessionGate.prototype.start;
  SessionGate.prototype.start = async function (...args) {
    // This synthetic precondition is local to this test Electron process. It
    // does not unlock or inspect the host session and is not evidence about it.
    this.readLocked = async () => false;
    return originalStart.apply(this, args);
  };
}

function scheduleProfileCleanup() {
  try {
    const cleaner = spawn('/usr/bin/env', ['node', '-e',
      'const fs=require("node:fs");const p=process.argv.at(-1);setTimeout(()=>{try{fs.rmSync(p,{recursive:true,force:true})}catch{}},1500)', temp],
    { detached: true, stdio: 'ignore' });
    cleaner.unref();
  } catch {}
}

async function run() {
  prepareIsolatedProfile();
  isolateDesktopSideEffects();
  installTestKeyInjection();
  installUnlockedSessionFixture();
  // Requiring the actual application entry wires the production IPC, preload,
  // session gate, memory vault, reply gate, search loop and renderer window.
  require('../src/main/index');

  await app.whenReady();
  const window = await eventually(() => BrowserWindow.getAllWindows().find(w =>
    !w.isDestroyed() && w.webContents.getURL().endsWith('/src/renderer/index.html')),
  '主窗 renderer 加载');
  hiddenWindow = window;
  await eventually(() => window.webContents.isLoading() === false, 'renderer 完成加载', 20000);
  const mem = await eventually(() => global.__wbWebSearchTestMemory?.ready ? global.__wbWebSearchTestMemory : null,
    '临时 SQLite vault 解锁', 20000);

  await evaluate(`window.__liveWebEvents=[]; window.pet.on(e=>{if(['chat','delta','webSources','audio'].includes(e.type))window.__liveWebEvents.push(e)});`);
  const sent = await evaluate(`window.pet.say(${JSON.stringify(query)})`);
  assert.equal(sent?.ok, true, `synthetic public query accepted: ${sent?.error || ''}`);

  const finishedAssistant = await eventually(async () => {
    const events = await evaluate('window.__liveWebEvents');
    return events.findLast?.(event => event.type === 'chat' && event.role === 'assistant') || null;
  }, 'WorkBuddy 回复完成');
  const sourceEvent = await eventually(async () => {
    const events = await evaluate('window.__liveWebEvents');
    return events.findLast?.(event => event.type === 'webSources') || null;
  }, '真实搜索来源事件');

  assert.equal(sourceEvent.used, true, '公开查询确实调用并使用了搜索结果');
  assert(Array.isArray(sourceEvent.sources) && sourceEvent.sources.length > 0);
  assert(sourceEvent.sources.length <= 3, 'UI来源数量有上限');
  for (const source of sourceEvent.sources) {
    assert.equal(typeof source.title, 'string');
    const url = new URL(source.url);
    assert(['http:', 'https:'].includes(url.protocol));
    assert(!/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/i.test(url.hostname));
  }
  assert(finishedAssistant.text && finishedAssistant.text.trim());
  assert(!/workbunny_web_search|tool_calls|<\s*function|"kind"\s*:\s*"(?:chat|action|skip)"/i.test(finishedAssistant.text),
    'the displayed assistant text is ordinary conversation, not tool or reply-protocol payload');
  assert(!/https?:\/\//i.test(finishedAssistant.text), 'spoken/display conversation does not contain source URLs');

  const ui = await eventually(async () => {
    const result = await evaluate(`(() => ({
      text: document.getElementById('bubbleText')?.textContent || '',
      sources: [...document.querySelectorAll('#webSourceLinks .web-source-link')].map(node=>node.textContent),
      visible: !document.getElementById('webSources')?.classList.contains('hidden'),
    }))()`);
    return result.visible && result.sources.length ? result : null;
  }, '主气泡显示来源标题');
  assert.equal(ui.text, finishedAssistant.text, 'source metadata remains outside the spoken bubble text');
  assert.deepEqual(ui.sources, sourceEvent.sources.map(source => source.title));

  const records = await eventually(async () => {
    const rows = await mem.query('message', 50, { scene: 'life', sort: 'ingestion', order: 'asc' });
    const user = rows.find(row => row.value.role === 'user' && row.value.content === query);
    const assistant = user && rows.find(row => row.value.role === 'assistant' && row.value.turnId === user.value.turnId);
    return user && assistant?.value.webSources?.length ? { user, assistant } : null;
  }, '临时 SQLite 写入两条对话及助手来源元数据');
  assert.equal(records.user.value.content, query);
  assert.equal(records.assistant.value.role, 'assistant');
  assert(sourceEvent.sources.every(source => records.assistant.value.webSources.some(row => row.url === source.url && row.title === source.title)),
    'the assistant row persists the same real source metadata shown in the UI');
  const audioSummary = await evaluate(`(() => {
    const events=window.__liveWebEvents.filter(event=>event.type==='audio');
    return {count:events.length,speech:events.filter(event=>event.buffer || event.stream).length};
  })()`);
  assert.equal(audioSummary.speech, 0, 'TTS is disabled; protocol stop/reset events do not contain speech audio');

  console.log(JSON.stringify({ passed: true, model: 'hy3', provider: 'WorkBuddy', queryKind: 'synthetic public info',
    sources: sourceEvent.sources.length, persistedDialogueRows: 2, assistantSourceRows: records.assistant.value.webSources.length,
    assistantCharacters: finishedAssistant.text.length, ttsAudioEvents: audioSummary.speech,
    audioControlEvents: audioSummary.count - audioSummary.speech, isolatedProfile: true,
    sessionGate: 'unlocked test fixture only; host lock state was not checked' }));
}

async function finish(code, error) {
  if (finished) return;
  finished = true;
  process.exitCode = code;
  clearTimeout(deadlineTimer);
  if (error) console.error(error?.stack || error);
  try { if (hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.destroy(); } catch {}
  scheduleProfileCleanup();
  app.once('will-quit', () => {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    testKey.fill(0);
    process.exit(code);
  });
  app.quit();
  // Main's real before-quit handler flushes and closes the temporary vault.
  setTimeout(() => {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    testKey.fill(0);
    process.exit(code);
  }, 12000).unref();
}

deadlineTimer = setTimeout(() => finish(1, new Error('真实联网验收超过90秒预算')), 90000);
deadlineTimer.unref?.();
run().then(() => finish(0), error => finish(1, error));
