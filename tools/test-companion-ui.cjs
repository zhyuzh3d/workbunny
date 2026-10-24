#!/usr/bin/env node
'use strict';

/* Run with: node_modules/.bin/electron tools/test-companion-ui.cjs
 * This launches only hidden fixture BrowserWindows, stubs every pet API through
 * a contextBridge preload, and writes Electron userData into a temporary folder.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
if (!app || !BrowserWindow || !process.versions.electron) {
  throw new Error('请使用 node_modules/.bin/electron tools/test-companion-ui.cjs 运行隐藏 Electron fixture');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-companion-fixture-'));
app.setPath('userData', path.join(tmp, 'userData'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
const preload = path.join(tmp, 'fixture-preload.cjs');
const html = path.resolve(__dirname, '../src/renderer/companion.html');
const calls = Object.create(null);
const fixtureWindows = [];
let activeWindow = null;
const sourceRows = [{ id: 'source-1', kind: 'message', ts: Date.now(), role: 'user', content: '我喜欢海边' }];
let rows = [
  { id: 'memory-pending-1', kind: 'memory', ts: Date.now(), content: '我喜欢海边 <img src=x onerror=alert(1)>', role: '', status: 'pending', sources: ['source-1'], evidence: '我喜欢海边' },
  { id: 'memory-confirmed-2', kind: 'memory', ts: Date.now() - 1000, content: '安静的音乐', status: 'confirmed', sources: [] },
  { id: 'message-1', kind: 'message', ts: Date.now(), role: 'user', content: '你好' },
];
let settings = { memory: { enabled: true, extract: true } };
let failConfig = false;
let holdConfig = false, heldConfigResolve = null;
let holdNextMemoryList = false, heldMemoryListResolve = null;
let insertFinish = null;
let status = {
  permissions: { accessibilityTrusted: true, screenCaptureAllowed: true, postEventAllowed: false },
  running: false, task: { id: 'task-1', status: 'paused', goal: 'fixture paused task', note: '可以继续检查' },
  screenshot: null,
};
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ZkAAAAASUVORK5CYII=';

fs.writeFileSync(preload, `
  const { contextBridge, ipcRenderer } = require('electron');
  const api = (name, ...args) => ipcRenderer.invoke('fixture:api', name, ...args);
  contextBridge.exposeInMainWorld('pet', {
    on: cb => ipcRenderer.on('fixture:event', (_event, value) => cb(value)),
    memoryStats: (...a) => api('memoryStats', ...a), memoryList: (...a) => api('memoryList', ...a),
    memoryUpdate: (...a) => api('memoryUpdate', ...a), memoryRemove: (...a) => api('memoryRemove', ...a),
    memoryClear: (...a) => api('memoryClear', ...a), memorySources: (...a) => api('memorySources', ...a),
    memoryExport: (...a) => api('memoryExport', ...a), memoryRestore: (...a) => api('memoryRestore', ...a),
    config: (...a) => api('config', ...a), taskStatus: (...a) => api('taskStatus', ...a),
    taskStart: (...a) => api('taskStart', ...a), taskStop: (...a) => api('taskStop', ...a),
    taskAccept: (...a) => api('taskAccept', ...a), desktopPermission: (...a) => api('desktopPermission', ...a),
    desktopRefresh: (...a) => api('taskStatus', ...a), desktopInsert: (...a) => api('desktopInsert', ...a),
    __fixture: { failConfig: () => ipcRenderer.invoke('fixture:control', 'failConfig'),
      holdConfig: () => ipcRenderer.invoke('fixture:control', 'holdConfig'),
      releaseConfig: () => ipcRenderer.invoke('fixture:control', 'releaseConfig'),
      holdNextMemoryList: () => ipcRenderer.invoke('fixture:control', 'holdNextMemoryList'),
      releaseMemoryList: () => ipcRenderer.invoke('fixture:control', 'releaseMemoryList'),
      emitDesktop: value => ipcRenderer.invoke('fixture:control', 'emitDesktop', { type: 'desktop', ...value }),
      emitMemoryChange: () => ipcRenderer.invoke('fixture:control', 'emitMemoryChange'),
      getCalls: () => ipcRenderer.invoke('fixture:control', 'getCalls') },
  });
`);

function called(name, ...args) { (calls[name] ||= []).push(args); }
function emptyCounts() { return { memory: rows.filter(r => r.kind === 'memory').length, message: 1, summary: 0 }; }
ipcMain.handle('fixture:control', (_event, action, value) => {
  if (action === 'failConfig') { failConfig = true; return true; }
  if (action === 'holdConfig') { holdConfig = true; return true; }
  if (action === 'releaseConfig') { holdConfig = false; heldConfigResolve?.(); heldConfigResolve = null; return true; }
  if (action === 'holdNextMemoryList') { holdNextMemoryList = true; return true; }
  if (action === 'releaseMemoryList') { heldMemoryListResolve?.(); heldMemoryListResolve = null; return true; }
  if (action === 'emitDesktop') { status = value; activeWindow?.webContents.send('fixture:event', value); return true; }
  if (action === 'emitMemoryChange') {
    rows.push({ id: `memory-live-${Date.now()}`, kind: 'memory', ts: Date.now(), content: '海边新记忆', status: 'pending', sources: [] });
    activeWindow?.webContents.send('fixture:event', { type: 'memory-changed', counts: emptyCounts() });
    return true;
  }
  if (action === 'getCalls') return calls;
  return false;
});
ipcMain.handle('fixture:api', async (_event, name, ...args) => {
  called(name, ...args);
  if (name === 'memoryStats') return { ready: true, counts: emptyCounts(), state: { mood: '愉快', energy: 72, interactions: 5 } };
  if (name === 'config') {
    if (failConfig) { failConfig = false; return { ok: false, error: 'fixture write failure' }; }
    const commit = () => { if (args[0]?.memory) settings.memory = { ...settings.memory, ...args[0].memory }; return settings; };
    if (holdConfig) return new Promise(resolve => { heldConfigResolve = () => resolve(commit()); });
    return commit();
  }
  if (name === 'memoryList') {
    const options = args[0] || {};
    let found = rows.filter(row => row.kind === options.kind);
    if (options.query) found = found.filter(row => row.content.toLowerCase().includes(options.query.toLowerCase()));
    const result = { rows: found, hasMore: true };
    if (holdNextMemoryList) {
      holdNextMemoryList = false;
      return new Promise(resolve => { heldMemoryListResolve = () => resolve(result); });
    }
    return result;
  }
  if (name === 'memoryUpdate') {
    const [id, content] = args, row = rows.find(item => item.id === id);
    if (row) { row.content = content; row.status = 'confirmed'; }
    return { ok: !!row };
  }
  if (name === 'memorySources') return sourceRows;
  if (name === 'memoryRemove') { const [id] = args; rows = rows.filter(row => row.id !== id); return { removed: true, removedSources: 1 }; }
  if (name === 'memoryClear') { rows = []; return { ok: true }; }
  if (name === 'memoryExport') return { ok: true };
  if (name === 'memoryRestore') return { canceled: true };
  if (name === 'taskStatus') return status;
  if (name === 'desktopPermission') return status.permissions;
  if (name === 'taskStart') { status = { ...status, running: true, task: { status: 'running', goal: args[0].goal, note: '运行中' } }; return { ok: true }; }
  if (name === 'taskStop') {
    status = { ...status, running: false, task: { ...(status.task || {}), status: 'stopped', note: '已停止' } };
    if (insertFinish) { const done = insertFinish; insertFinish = null; done({ ok: false, error: '输入已取消' }); }
    return { ok: true };
  }
  if (name === 'taskAccept') {
    if (status.task?.status !== 'review') return { ok: false, error: '当前没有待验收任务' };
    status = { ...status, task: { ...status.task, status: 'accepted' } }; return { ok: true };
  }
  if (name === 'desktopInsert') return new Promise(resolve => { insertFinish = resolve; });
  throw new Error(`unexpected fixture API: ${name}`);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 4000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await delay(35); }
  throw new Error(`fixture timeout: ${label}`);
}
async function loadPage(page) {
  const win = new BrowserWindow({ width: 560, height: 760, show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  fixtureWindows.push(win); activeWindow = win;
  win.webContents.on('did-fail-load', (_event, code, description, url) => console.error(`fixture load failure (${code}): ${description} ${url}`));
  win.webContents.on('console-message', (_event, level, message, line) => console.error(`fixture console[${level}] ${line}: ${message}`));
  await win.loadFile(html, { query: { p: page } });
  return win;
}
async function evalIn(win, code) { return win.webContents.executeJavaScript(code, true); }
async function click(win, id) { await evalIn(win, `document.getElementById(${JSON.stringify(id)}).click()`); }

async function testMemory() {
  const win = await loadPage('memory');
  await waitFor(() => evalIn(win, "document.querySelectorAll('#memoryList .record').length" ).then(n => n === 2), 'memory list');
  assert.match(await evalIn(win, "document.getElementById('memoryStatus').textContent"), /愉快.*72/);
  assert.equal(await evalIn(win, "document.querySelector('#memoryList img') === null"), true, 'record text must not create markup');
  assert.equal(await evalIn(win, "document.querySelector('#memoryList .pending')?.textContent"), '待确认');
  assert.equal(await evalIn(win, "document.querySelector('#memoryList textarea')"), null);
  assert.equal(await evalIn(win, "document.getElementById('memoryMore').hidden"), false);
  const listCallsBeforeRace = (calls.memoryList || []).length;
  await evalIn(win, "window.pet.__fixture.holdNextMemoryList().then(()=>window.pet.__fixture.emitMemoryChange())");
  await waitFor(() => Promise.resolve((calls.memoryList || []).length > listCallsBeforeRace), 'delayed refresh request');
  await evalIn(win, "document.querySelector('#memoryTabs .tab[data-kind=message]').click()");
  await waitFor(() => evalIn(win, "[...document.querySelectorAll('#memoryList .record-content')].some(el=>el.textContent==='你好')"), 'new tab result before delayed refresh');
  await evalIn(win, 'window.pet.__fixture.releaseMemoryList()');
  await delay(250);
  assert.equal(await evalIn(win, "[...document.querySelectorAll('#memoryList .record-content')].some(el=>el.textContent==='你好')"), true, 'stale refresh cannot replace newer tab results');
  await evalIn(win, "document.querySelector('#memoryTabs .tab[data-kind=memory]').click()");
  await waitFor(() => evalIn(win, "document.querySelectorAll('#memoryList .record').length").then(n => n >= 2), 'memory tab restored');
  const rowCountBeforePageRace = await evalIn(win, "document.querySelectorAll('#memoryList .record').length");
  const listCallsBeforePageRace = (calls.memoryList || []).length;
  await evalIn(win, "window.pet.__fixture.holdNextMemoryList().then(()=>window.pet.__fixture.emitMemoryChange())");
  await waitFor(() => Promise.resolve((calls.memoryList || []).length > listCallsBeforePageRace), 'delayed pagination refresh request');
  await click(win, 'memoryMore');
  await waitFor(() => evalIn(win, "document.querySelectorAll('#memoryList .record').length").then(n => n > rowCountBeforePageRace), 'older page appended');
  const rowCountAfterPage = await evalIn(win, "document.querySelectorAll('#memoryList .record').length");
  await evalIn(win, 'window.pet.__fixture.releaseMemoryList()');
  await delay(250);
  assert.equal(await evalIn(win, "document.querySelectorAll('#memoryList .record').length"), rowCountAfterPage, 'stale refresh cannot replace paginated results');
  const listCallsBeforeSearchRace = (calls.memoryList || []).length;
  await evalIn(win, "window.pet.__fixture.holdNextMemoryList().then(()=>window.pet.__fixture.emitMemoryChange())");
  await waitFor(() => Promise.resolve((calls.memoryList || []).length > listCallsBeforeSearchRace), 'delayed search refresh request');
  await evalIn(win, "document.getElementById('memorySearch').value='音乐'; document.getElementById('memorySearchBtn').click()");
  await waitFor(() => evalIn(win, "[...document.querySelectorAll('#memoryList .record-content')].some(el=>el.textContent==='安静的音乐')"), 'new search result before delayed refresh');
  await evalIn(win, 'window.pet.__fixture.releaseMemoryList()');
  await delay(250);
  assert.equal(await evalIn(win, "document.querySelectorAll('#memoryList .record').length"), 1, 'stale refresh cannot replace newer search results');
  await evalIn(win, "document.getElementById('memorySearch').value='海边'; document.getElementById('memorySearch').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('memorySearchBtn').click()");
  const expectedSeaResults = rows.filter(row => row.kind === 'memory' && row.content.includes('海边')).length;
  await waitFor(() => evalIn(win, "document.querySelectorAll('#memoryList .record').length").then(n => n === expectedSeaResults), 'memory search');
  assert.equal(await evalIn(win, "document.getElementById('memoryMore').hidden"), true, 'search results do not paginate');
  await evalIn(win, "document.querySelector('#memoryTabs .tab[data-kind=memory]').click()");
  const beforeConfirm = (calls.memoryUpdate || []).length;
  await evalIn(win, "[...document.querySelectorAll('#memoryList button')].find(b=>b.textContent==='确认').click()");
  await waitFor(() => Promise.resolve((calls.memoryUpdate || []).length > beforeConfirm), 'pending confirmation');
  assert.equal(calls.memoryUpdate.at(-1)[0], 'memory-pending-1');
  assert.equal(calls.memoryUpdate.at(-1)[1], rows.find(r => r.id === 'memory-pending-1').content);
  await waitFor(() => evalIn(win, "![...document.querySelectorAll('#memoryList .record')].find(card=>card.querySelector('.record-content')?.textContent.startsWith('我喜欢海边 <img'))?.querySelector('.pending')"), 'confirmed badge');
  const maxLength = await evalIn(win, "(() => { document.querySelector('#memoryList button').click(); return document.querySelector('#memoryList textarea')?.maxLength })()");
  assert.equal(maxLength, 1000);
  await evalIn(win, "document.getElementById('backupPassphrase').value='fixture-pass'; document.getElementById('memoryExport').click()");
  await waitFor(() => Promise.resolve((calls.memoryExport || []).length === 1), 'memory export');
  await waitFor(() => evalIn(win, "document.getElementById('backupPassphrase').value").then(v => v === ''), 'passphrase cleared');
  assert.equal(calls.memoryExport[0][0], 'fixture-pass');

  await evalIn(win, "window.pet.__fixture.failConfig().then(()=>{document.getElementById('memoryEnabled').checked=false; document.getElementById('memoryEnabled').dispatchEvent(new Event('change',{bubbles:true}))})");
  await waitFor(() => evalIn(win, "document.getElementById('memoryConfigNote').textContent").then(t => t.includes('保存失败')), 'failed setting save');
  assert.equal(await evalIn(win, "document.getElementById('memoryEnabled').checked"), true, 'checkbox restores persisted state');
  assert.match(await evalIn(win, "document.getElementById('memoryConfigNote').textContent"), /未保存选择/);

  const configCalls = (calls.config || []).length;
  await evalIn(win, "window.pet.__fixture.holdConfig().then(()=>{document.getElementById('memoryExtract').checked=false;document.getElementById('memoryExtract').dispatchEvent(new Event('change',{bubbles:true}))})");
  await waitFor(() => Promise.resolve((calls.config || []).length === configCalls + 1), 'pending config write');
  assert.equal(await evalIn(win, "(() => { const e=new Event('beforeunload',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented })()"), true, 'pending settings writes guard window close');
  await evalIn(win, 'window.pet.__fixture.releaseConfig()');
  await waitFor(() => evalIn(win, "document.getElementById('memoryConfigNote').textContent").then(t => t === '已保存'), 'setting write completes');
  assert.equal(settings.memory.extract, false);

  // A delayed list response must not erase an editor opened while it is pending.
  await evalIn(win, "document.querySelector('#memoryList .record button').click()");
  const listCallsBeforeEditorRace = (calls.memoryList || []).length;
  await evalIn(win, "window.pet.__fixture.holdNextMemoryList().then(()=>window.pet.__fixture.emitMemoryChange())");
  await waitFor(() => Promise.resolve((calls.memoryList || []).length > listCallsBeforeEditorRace), 'delayed editor refresh request');
  await evalIn(win, "document.querySelector('#memoryList .record button').click(); document.querySelector('#memoryList textarea').value='延迟期间打开的草稿'");
  await evalIn(win, 'window.pet.__fixture.releaseMemoryList()');
  await delay(150);
  assert.equal(await evalIn(win, "document.querySelector('#memoryList textarea')?.value"), '延迟期间打开的草稿', 'stale refresh cannot erase a newly opened editor draft');
  await evalIn(win, "document.querySelector('#memoryList .record button').click()");
  await waitFor(() => evalIn(win, "[...document.querySelectorAll('#memoryList .record-content')].some(el=>el.textContent==='海边新记忆')"), 'deferred editor refresh');

  // While an editor is already open, later notifications still preserve its draft and query.
  await evalIn(win, "document.querySelector('#memoryList .record button').click()");
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList textarea') !== null"), 'memory editor open');
  await evalIn(win, "document.querySelector('#memoryList textarea').value='编辑中的草稿'; window.pet.__fixture.emitMemoryChange()");
  const expectedMemoryCount = rows.filter(r => r.kind === 'memory').length;
  await waitFor(() => evalIn(win, "document.querySelector('#memoryCounts').textContent").then(text => text.includes(String(expectedMemoryCount))), 'memory changed count');
  assert.equal(await evalIn(win, "document.querySelector('#memoryList textarea').value"), '编辑中的草稿', 'change event preserves editor draft');
  assert.equal(await evalIn(win, "document.getElementById('memorySearch').value"), '海边', 'change event preserves search text');
  await evalIn(win, "document.querySelector('#memoryList .record button').click()");
  await waitFor(() => evalIn(win, "[...document.querySelectorAll('#memoryList .record-content')].some(el=>el.textContent==='海边新记忆')"), 'deferred memory list refresh');
  win.hide();
}

async function testDesktop() {
  status = { permissions: { accessibilityTrusted: true, screenCaptureAllowed: true, postEventAllowed: false }, running: false,
    task: { id: 'task-2', status: 'paused', goal: 'fixture paused task', note: '可以继续检查' }, screenshot: null };
  const win = await loadPage('desktop');
  await waitFor(() => Promise.resolve((calls.taskStatus || []).length > 0), 'initial task status');
  assert.match(await evalIn(win, "document.querySelector('#permissionList').textContent"), /辅助功能.*屏幕录制.*输入控制/);
  assert.equal(await evalIn(win, "document.getElementById('taskAccept').disabled"), true, 'paused tasks cannot be accepted');
  const initialStatusCalls = (calls.taskStatus || []).length;
  await evalIn(win, `window.pet.__fixture.emitDesktop({permissions:{accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true},running:false,task:{id:'task-3',status:'review',goal:'review this',note:'视觉结果已完成'},screenshot:${JSON.stringify(pixel)}})`);
  await waitFor(() => evalIn(win, "document.getElementById('taskAccept').disabled").then(disabled => !disabled), 'review state event');
  assert.equal((calls.taskStatus || []).length, initialStatusCalls, 'desktop events paint directly without a second native status call');
  assert.equal(await evalIn(win, "document.getElementById('taskPreview').hidden"), false);
  assert.match(await evalIn(win, "document.getElementById('taskStateNote').textContent"), /等待验收.*视觉结果已完成/);
  await click(win, 'taskAccept');
  await waitFor(() => Promise.resolve((calls.taskAccept || []).length === 1), 'task acceptance');
  assert.equal(status.task.status, 'accepted');
  await waitFor(() => evalIn(win, "document.getElementById('taskAccept').disabled"), 'accepted state paint');

  const permissionCalls = (calls.desktopPermission || []).length;
  await click(win, 'desktopPermission');
  await waitFor(() => Promise.resolve((calls.desktopPermission || []).length === permissionCalls + 1), 'permission prompt');
  assert.equal((calls.desktopPermission || []).length, permissionCalls + 1, 'permission is requested once per button press');

  await evalIn(win, "document.getElementById('taskGoal').value='fixture task'; document.getElementById('taskStart').click()");
  await waitFor(() => Promise.resolve((calls.taskStart || []).length === 1), 'task start');
  await evalIn(win, "window.dispatchEvent(new Event('beforeunload',{cancelable:true}))");
  assert.equal((calls.taskStop || []).length, 0, 'closing UI does not cancel a background task');
  await click(win, 'taskStop');
  await waitFor(() => Promise.resolve((calls.taskStop || []).length === 1), 'explicit stop');

  await evalIn(win, "document.getElementById('desktopInsertText').value='fixture text'; document.getElementById('desktopInsert').click()");
  await waitFor(() => Promise.resolve((calls.desktopInsert || []).length === 1), 'insert invoked immediately');
  assert.equal(await evalIn(win, "document.getElementById('desktopInsertCancel').hidden"), false);
  assert.match(await evalIn(win, "document.getElementById('desktopInsertNote').textContent"), /3 秒/);
  await click(win, 'desktopInsertCancel');
  await waitFor(() => Promise.resolve((calls.taskStop || []).length === 2), 'insert cancellation');
  await waitFor(() => evalIn(win, "document.getElementById('desktopInsertCancel').hidden"), 'insert settles after cancel');
  win.hide();
}

async function run() {
  app.commandLine.appendSwitch('disable-gpu');
  await app.whenReady();
  try {
    await testMemory();
    await testDesktop();
    console.log('companion Electron fixture: memory and desktop flows passed (hidden windows, stub APIs, isolated userData)');
    for (const win of fixtureWindows) if (!win.isDestroyed()) win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    for (const win of fixtureWindows) if (!win.isDestroyed()) win.destroy();
    app.exit(1);
  }
}
app.on('will-quit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
run();
