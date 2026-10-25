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
const recallEntries = [
  { id: 'memory-pending-1', kind: 'memory', content: '我喜欢海边', ts: Date.now(), sources: ['source-1'] },
  { id: 'summary-recall-1', kind: 'summary', content: '本轮摘要：正在选旅行计划', ts: Date.now() - 5000, sources: [] },
];
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
let failNextMemorySources = false;
let monitorSnapshot = { tasks: [{ name: 'Fixture 正在整理', status: 'running' }] };
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
    init: (...a) => api('init', ...a), workbuddyOpen: (...a) => api('workbuddyOpen', ...a), say: (...a) => api('say', ...a),
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
      emitMonitor: value => ipcRenderer.invoke('fixture:control', 'emitMonitor', value),
      emitRecall: value => ipcRenderer.invoke('fixture:control', 'emitRecall', value),
      failMemorySources: () => ipcRenderer.invoke('fixture:control', 'failMemorySources'),
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
  if (action === 'emitMonitor') { monitorSnapshot = value; activeWindow?.webContents.send('fixture:event', { type: 'monitor', ...value }); return true; }
  if (action === 'emitRecall') { activeWindow?.webContents.send('fixture:event', { type: 'recall', entries: value }); return true; }
  if (action === 'failMemorySources') { failNextMemorySources = true; return true; }
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
  if (name === 'init') return { monitor: monitorSnapshot, desktop: status, currentRecall: recallEntries };
  if (name === 'workbuddyOpen') return { ok: true };
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
  if (name === 'memorySources') {
    if (failNextMemorySources) { failNextMemorySources = false; throw new Error('来源库暂不可读，请稍后重试'); }
    return sourceRows;
  }
  if (name === 'say') return { ok: true };
  if (name === 'memoryRemove') { const [id] = args; rows = rows.filter(row => row.id !== id); return { removed: true, removedSources: 1 }; }
  if (name === 'memoryClear') { rows = []; return { ok: true }; }
  if (name === 'memoryExport') return { ok: true };
  if (name === 'memoryRestore') return { canceled: true };
  if (name === 'taskStatus') return status;
  if (name === 'desktopPermission') return status.permissions;
  if (name === 'taskStart') { status = { ...status, running: true, task: { status: 'running', goal: args[0].goal, criteria: args[0].criteria, target: args[0].target, workModel: args[0].workModel, thinking: args[0].workModel === 'hy3' ? 'low' : 'high', note: '运行中' } }; return { ok: true }; }
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
async function evalIn(win, code) {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (error) { throw new Error(`fixture evaluation failed: ${code}: ${error.message}`); }
}
async function click(win, id) { await evalIn(win, `document.getElementById(${JSON.stringify(id)}).click()`); }

async function testMemory() {
  const win = await loadPage('memory');
  await waitFor(() => evalIn(win, "document.querySelectorAll('#memoryList .record').length" ).then(n => n === 2), 'memory list');
  assert.equal(await evalIn(win, "document.getElementById('currentRecallCard').hidden"), false, 'actual recall entries reveal the current-recall area');
  assert.equal(await evalIn(win, "document.querySelectorAll('#currentRecallList .recall-entry').length"), 2);
  const recallButtons = await evalIn(win, "[...document.querySelectorAll('#currentRecallList .recall-entry')].map(card=>[...card.querySelectorAll('button')].map(button=>button.textContent))");
  assert(recallButtons[0].includes('查看来源'));
  assert(!recallButtons[1].includes('查看来源'), 'an entry without sources has no source-view button');
  const memoryWritesBeforeSourceFailure = (calls.memoryUpdate || []).length + (calls.memoryRemove || []).length;
  await evalIn(win, "window.pet.__fixture.failMemorySources()");
  await evalIn(win, "document.querySelector('#currentRecallList .recall-entry button').click()");
  await waitFor(() => Promise.resolve((calls.memorySources || []).length === 1), 'current recall source failure');
  await waitFor(() => evalIn(win, "document.querySelector('#currentRecallList .recall-source-list').textContent").then(text => text.includes('来源库暂不可读')), 'readable source error');
  assert.equal((calls.memoryUpdate || []).length + (calls.memoryRemove || []).length, memoryWritesBeforeSourceFailure, 'source read failure never edits or removes memory');
  await evalIn(win, "document.querySelector('#currentRecallList .recall-entry button').click(); document.querySelector('#currentRecallList .recall-entry button').click()");
  await waitFor(() => Promise.resolve((calls.memorySources || []).length === 2), 'retry source query');
  assert.match(await evalIn(win, "document.querySelector('#currentRecallList .recall-source-list').textContent"), /我喜欢海边/);
  await evalIn(win, "window.pet.__fixture.emitRecall([])");
  assert.equal(await evalIn(win, "document.getElementById('currentRecallCard').hidden"), true, 'empty recall hides the area');
  await evalIn(win, `window.pet.__fixture.emitRecall(${JSON.stringify(recallEntries)})`);
  await waitFor(() => evalIn(win, "!document.getElementById('currentRecallCard').hidden"), 'current recall restored');
  await evalIn(win, "document.querySelector('#currentRecallList .recall-entry button:last-child').click()");
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=memory-pending-1]') !== null"), 'jump from recalled fact to the editable memory record');
  assert.equal(await evalIn(win, "document.getElementById('memorySearch').value"), '', 'an already loaded record opens without replacing the current query');
  const recalledRecordActions = await evalIn(win, "[...document.querySelector('#memoryList [data-record-id=memory-pending-1]').querySelectorAll('button')].map(button=>button.textContent)");
  assert(recalledRecordActions.includes('编辑') && recalledRecordActions.includes('删除'), 'recalled records retain existing edit and delete actions');
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
  const characterRenderer = fs.readFileSync(path.resolve(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(characterRenderer, /case 'desktop':\s*paintDesktopActivity\(ev\);/);
  assert.match(characterRenderer, /if \(init\?\.desktop\) paintDesktopActivity\(init\.desktop\)/, 'startup restores the current desktop state');
  assert.match(characterRenderer, /case 'recall':\s*paintRecallButton\(ev\.entries\);/);
  assert.match(characterRenderer, /pet\.open\('desktop'\)/, 'clicking an active desktop status opens the work panel');
  assert.match(characterRenderer, /recentTerminal && running\.length === 0/, 'recent terminal status cannot hide running WorkBuddy tasks');
  assert.match(characterRenderer, /desktopRecentUntil = Date\.now\(\) \+ 7000/, 'paused and completed status has a short lifetime');
  assert.match(characterRenderer, /desktopTask\.automaticAccepted \? 'Bunny 已核对代理结果' : '你已确认代理结果'/, 'automatic acceptance is not attributed to the user');
  assert.match(characterRenderer, /desktopTask\.origin === 'dialogue' \? '已有结果，Bunny 正在核对'/, 'dialogue review is not presented as awaiting user acceptance');
  const mainHtml = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.match(mainHtml, /id="memoryBasis"[^>]*hidden/, 'the main-window memory entry starts hidden');
  for (const state of ['monitoring', 'verifying', 'awaiting', 'paused', 'review', 'accepted']) assert(characterRenderer.includes(`'${state}'`), `main character handles desktop ${state} state`);
  status = { permissions: { accessibilityTrusted: true, screenCaptureAllowed: true, postEventAllowed: false }, running: false,
    task: { id: 'task-2', target: 'workbuddy', status: 'paused', goal: 'fixture paused task', note: '可以继续检查' }, screenshot: null };
  const win = await loadPage('desktop');
  await waitFor(() => Promise.resolve((calls.taskStatus || []).length > 0), 'initial task status');
  await waitFor(() => evalIn(win, "document.getElementById('workbuddyMonitorTasks').textContent").then(text => text.includes('Fixture 正在整理')), 'initial WorkBuddy monitor snapshot');
  assert.match(await evalIn(win, "document.getElementById('taskStateNote').textContent"), /代理已暂停.*可以继续检查/, 'restored paused status is visible as a report, not accepted');
  assert.equal(await evalIn(win, "document.getElementById('taskFormDetails').open"), false, 'manual task form is folded beneath the status view');
  assert.equal(await evalIn(win, "document.getElementById('desktopActions').hidden"), false, 'a paused task offers a continuation control');
  assert.equal(await evalIn(win, "document.getElementById('taskResume').hidden"), false);
  assert.equal(await evalIn(win, "document.getElementById('permissionsDetails').open"), true, 'missing system permission auto-opens the permission section');
  assert.equal(await evalIn(win, "!!(document.getElementById('taskStateCard').compareDocumentPosition(document.getElementById('taskFormDetails')) & 4)"), true, 'current status precedes the manual fallback');
  assert.match(await evalIn(win, "document.querySelector('#permissionList').textContent"), /辅助功能.*屏幕录制.*输入控制/);
  assert.match(await evalIn(win, "document.querySelector('#desktopPage').textContent"), /你可以直接告诉 Bunny 要办什么/);
  assert.match(await evalIn(win, "document.getElementById('taskPauseNote').textContent"), /暂停只停止 Bunny 的代理操作；WorkBuddy 已接收的会话可能仍在继续/);
  assert.equal(await evalIn(win, "document.getElementById('taskAccept').disabled"), true, 'paused tasks cannot be accepted');
  await click(win, 'taskResume');
  await waitFor(() => Promise.resolve((calls.say || []).length === 1), 'resume routes through normal dialogue');
  assert.equal(calls.say[0][0], '继续刚才的这件代办，请保留原任务，不重复发送。');
  assert.equal((calls.taskStart || []).length, 0, 'resume does not start a duplicate task');
  assert.equal((calls.taskStop || []).length, 0);
  assert.equal((calls.taskAccept || []).length, 0, 'resume request does not accept results');
  assert.equal(await evalIn(win, "document.getElementById('taskResume').disabled"), true, 'resume stays pending until actual desktop status changes');
  assert.match(await evalIn(win, "document.getElementById('desktopStatus').textContent"), /代理已暂停/, 'sending the request is not presented as a successful resume');
  await evalIn(win, "window.pet.__fixture.emitDesktop({permissions:{accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true},running:true,task:{id:'task-2',status:'awaiting',goal:'fixture paused task'}})");
  assert.match(await evalIn(win, "document.getElementById('desktopStatus').textContent"), /等待 WorkBuddy 开始处理/);
  assert.match(await evalIn(win, "document.getElementById('desktopActionNote').textContent"), /状态已更新/);
  assert.equal(await evalIn(win, "document.getElementById('taskResume').hidden"), true, 'active task no longer offers resume');
  await evalIn(win, "window.pet.__fixture.emitDesktop({permissions:{},running:false,task:null})");
  assert.equal(await evalIn(win, "document.getElementById('taskResume').hidden"), true, 'resume is absent without an existing task');
  await evalIn(win, "window.pet.__fixture.emitMonitor({tasks:[{sessionId:'session-1',name:'Monitor 实际进展',status:'running'}]})");
  await waitFor(() => evalIn(win, "document.getElementById('workbuddyMonitorTasks').textContent").then(text => text.includes('Monitor 实际进展')), 'WorkBuddy monitor event refresh');
  await evalIn(win, "window.pet.__fixture.emitDesktop({permissions:{accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true},running:false,task:{id:'task-2',status:'paused',goal:'fixture paused task',note:'可以继续检查'}})");
  assert.equal(await evalIn(win, "document.getElementById('permissionsDetails').open"), false, 'all required permissions collapse after they are granted');
  assert.match(await evalIn(win, "document.getElementById('workbuddyMonitorTasks').textContent"), /Monitor 实际进展/, 'paused status does not obscure the real WorkBuddy monitor');
  await evalIn(win, "window.pet.__fixture.emitDesktop({permissions:{},running:true,task:{id:'task-text-wechat',status:'paused',origin:'dialogue',inputSource:'text',target:'wechat',goal:'已提交任务'}})");
  await waitFor(() => evalIn(win, "document.getElementById('taskMeta').textContent").then(text => text.includes('文字交代 · 微信')), 'text source and WeChat target labels');
  assert.match(await evalIn(win, "document.getElementById('taskMeta').textContent"), /文字交代 · 微信/);
  assert.doesNotMatch(await evalIn(win, "document.getElementById('taskPauseNote').textContent"), /WorkBuddy/);
  await evalIn(win, "window.pet.__fixture.emitDesktop({permissions:{},running:true,task:{id:'task-awaiting',status:'awaiting',origin:'dialogue',inputSource:'text',target:'workbuddy',goal:'已提交任务'}})");
  assert.match(await evalIn(win, "document.getElementById('desktopStatus').textContent"), /等待 WorkBuddy 开始处理/);
  assert.equal(await evalIn(win, "document.getElementById('taskStop').hidden"), false, 'awaiting is an active state with a pause action');
  await evalIn(win, `window.pet.__fixture.emitDesktop({permissions:{},running:true,task:{id:'task-monitor',status:'monitoring',origin:'dialogue',inputSource:'voice',target:'workbuddy',goal:'检查交付',criteria:'在WorkBuddy会话中出现回复',report:'已收到回复',verification:{verdict:'revise',report:'请补充日期和金额',at:1761000000000},monitorSummary:'WorkBuddy 已收到任务，正在整理资料。\\n已找到相关记录，正在核对日期与金额。',monitorSessionId:'session-1',handoffSent:true,note:'正在观察'}})`);
  await waitFor(() => evalIn(win, "document.getElementById('desktopStatus').textContent").then(text => text.includes('观察 WorkBuddy')), 'monitoring status');
  const details = await evalIn(win, "document.getElementById('taskDetails').textContent");
  assert.match(await evalIn(win, "document.getElementById('taskMeta').textContent"), /口头交代 · WorkBuddy/);
  assert.match(await evalIn(win, "document.getElementById('taskSummary').textContent"), /检查交付/);
  assert.match(details, /任务：检查交付.*验收条件：在WorkBuddy会话中出现回复.*执行报告：已收到回复.*核对结论：需要 WorkBuddy 修改：请补充日期和金额/);
  assert.equal(await evalIn(win, "document.getElementById('taskEvidenceDetails').open"), false, 'full task and verification evidence starts folded');
  await evalIn(win, "document.getElementById('taskEvidenceDetails').open=true");
  assert.match(await evalIn(win, "document.getElementById('taskDetails').textContent"), /验收条件：在WorkBuddy会话中出现回复/);
  await evalIn(win, "document.getElementById('taskEvidenceDetails').open=false");
  await waitFor(() => evalIn(win, "!!document.querySelector('.task-monitor-summary summary')"), 'folded WorkBuddy summary');
  assert.equal(await evalIn(win, "document.querySelector('.task-monitor-summary').open"), false, 'long WorkBuddy reply summary is folded by default');
  assert.match(await evalIn(win, "document.querySelector('.task-monitor-summary summary').textContent"), /WorkBuddy 回复摘要/);
  assert.match(await evalIn(win, "document.getElementById('workbuddyMonitorTasks').textContent"), /Monitor 实际进展/, 'monitorSessionId selects the matching WorkBuddy session');
  await evalIn(win, `window.pet.__fixture.emitDesktop({permissions:{},running:false,task:{id:'task-monitor',status:'verifying',origin:'dialogue',inputSource:'voice',target:'workbuddy',goal:'检查交付',criteria:'可见回复',verification:{verdict:'need_user',report:'请确认这条回复符合预期',at:1761000000000},monitorSessionId:'session-1',handoffSent:true,note:'正在核对'}})`);
  assert.match(await evalIn(win, "document.getElementById('desktopStatus').textContent"), /核对结果/);
  assert.match(await evalIn(win, "document.getElementById('taskDetails').textContent"), /核对结论：需要你确认：请确认这条回复符合预期/);
  assert.equal(await evalIn(win, "document.getElementById('taskResume').hidden"), true, 'verifying tasks do not offer resume');
  assert.equal(await evalIn(win, "document.getElementById('taskStop').hidden"), false, 'independent verification is cancellable even when the desktop monitor has finished');
  assert.equal(await evalIn(win, "document.getElementById('taskStart').disabled"), true, 'verification prevents starting a competing task');
  await evalIn(win, `window.pet.__fixture.emitDesktop({permissions:{},running:false,task:{id:'task-monitor',status:'paused',origin:'dialogue',inputSource:'voice',target:'workbuddy',goal:'检查交付',monitorSessionId:'session-1',handoffSent:true,note:'用户暂停'}})`);
  assert.match(await evalIn(win, "document.getElementById('taskPauseNote').textContent"), /WorkBuddy 已接收的会话可能仍在继续/);
  assert.doesNotMatch(await evalIn(win, "document.getElementById('taskStateNote').textContent"), /WorkBuddy 会话可能仍在继续/);
  assert.doesNotMatch(await evalIn(win, "document.getElementById('taskStateNote').textContent"), /WorkBuddy 已停止/);
  await evalIn(win, "window.pet.__fixture.emitDesktop({permissions:{},running:false,task:{id:'task-panel',status:'paused',origin:'panel',inputSource:'panel',target:'wechat',goal:'手动交代测试'}})");
  await waitFor(() => evalIn(win, "document.getElementById('taskMeta').textContent").then(text => text.includes('手动交代 · 微信')), 'manual source and WeChat target labels');
  assert.match(await evalIn(win, "document.getElementById('taskMeta').textContent"), /手动交代 · 微信/);
  assert.match(await evalIn(win, "document.getElementById('taskPauseNote').textContent"), /暂停只停止 Bunny 的微信代理操作/);
  assert.doesNotMatch(await evalIn(win, "document.getElementById('taskPauseNote').textContent"), /WorkBuddy/);
  await evalIn(win, "window.pet.__fixture.emitDesktop({permissions:{},running:false,task:{id:'task-panel',status:'accepted',origin:'panel',inputSource:'panel',target:'wechat',goal:'手动交代测试',report:'已核对微信结果'}})");
  assert.equal(await evalIn(win, "document.getElementById('taskPauseNote').hidden"), true, 'completed tasks do not show pause instructions');
  await evalIn(win, "window.pet.__fixture.emitDesktop({permissions:{},running:false,task:{id:'task-monitor',status:'paused',origin:'dialogue',inputSource:'voice',target:'workbuddy',goal:'检查交付',monitorSessionId:'session-1',handoffSent:true,note:'用户暂停'}})");
  await evalIn(win, "window.pet.__fixture.emitMonitor({tasks:[{sessionId:'session-1',name:'Monitor 实际交付',status:'ok'}]})");
  await waitFor(() => evalIn(win, "document.getElementById('workbuddyMonitorTasks').textContent").then(text => text.includes('Monitor 实际交付 · 已有答复')), 'native monitor completion status');
  await evalIn(win, "document.getElementById('taskFormDetails').open=true");
  await waitFor(() => evalIn(win, "document.getElementById('taskStart').hidden").then(hidden => !hidden), 'manual fallback opens');
  await click(win, 'workbuddyOpen');
  await waitFor(() => Promise.resolve((calls.workbuddyOpen || []).length === 1), 'open WorkBuddy');
  const initialStatusCalls = (calls.taskStatus || []).length;
  await evalIn(win, `window.pet.__fixture.emitDesktop({permissions:{accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true},running:false,task:{id:'task-dialogue-review',status:'review',origin:'dialogue',goal:'交付验收',target:'workbuddy',verification:{verdict:'need_user',report:'请确认交付范围',at:1761000000000},note:'正在核对'}})`);
  assert.match(await evalIn(win, "document.getElementById('desktopStatus').textContent"), /已有结果，Bunny 正在核对/);
  assert.match(await evalIn(win, "document.getElementById('taskMeta').textContent"), /对话交代 · WorkBuddy/);
  assert.match(await evalIn(win, "document.getElementById('taskDetails').textContent"), /核对结论：需要你确认：请确认交付范围/);
  assert.equal(await evalIn(win, "document.getElementById('taskAccept').hidden"), true, 'dialogue review is not an invitation to accept yet');
  await evalIn(win, `window.pet.__fixture.emitDesktop({permissions:{accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true},running:false,task:{id:'task-3',target:'workbuddy',status:'review',goal:'review this',note:'视觉结果已完成'},screenshot:${JSON.stringify(pixel)}})`);
  await waitFor(() => evalIn(win, "document.getElementById('taskAccept').disabled").then(disabled => !disabled), 'review state event');
  assert.equal(await evalIn(win, "document.getElementById('taskResume').hidden"), false, 'review tasks can be explicitly continued through dialogue');
  assert.equal((calls.taskStatus || []).length, initialStatusCalls, 'desktop events paint directly without a second native status call');
  assert.equal(await evalIn(win, "document.getElementById('taskPreview').hidden"), false);
  assert.equal(await evalIn(win, "document.getElementById('taskPreview').open"), false, 'the recent screenshot stays folded by default');
  await evalIn(win, "document.querySelector('#taskPreview summary').click()");
  assert.equal(await evalIn(win, "document.getElementById('taskPreview').open"), true, 'the screenshot remains available on demand');
  assert.match(await evalIn(win, "document.getElementById('taskScreenshot').src"), /^data:image\//);
  assert.match(await evalIn(win, "document.getElementById('taskStateNote').textContent"), /待你确认.*视觉结果已完成/);
  await click(win, 'taskAccept');
  await waitFor(() => Promise.resolve((calls.taskAccept || []).length === 1), 'task acceptance');
  assert.equal(status.task.status, 'accepted');
  await waitFor(() => evalIn(win, "document.getElementById('taskAccept').disabled"), 'accepted state paint');
  assert.equal(await evalIn(win, "document.getElementById('desktopStatus').textContent"), '你已确认', 'manual acceptance is correctly attributed to the user');
  await evalIn(win, "window.pet.__fixture.emitDesktop({permissions:{accessibilityTrusted:true,screenCaptureAllowed:true,postEventAllowed:true},running:false,task:{id:'task-auto',status:'accepted',origin:'dialogue',target:'workbuddy',automaticAccepted:true,report:'已核对交付',verification:{verdict:'pass',report:'所有条件均已满足',at:1761000000000}}})");
  assert.match(await evalIn(win, "document.getElementById('desktopStatus').textContent"), /Bunny 已核对代理结果/);
  assert.match(await evalIn(win, "document.getElementById('taskDetails').textContent"), /核对结论：核对通过：所有条件均已满足/);
  assert.equal(await evalIn(win, "document.getElementById('taskPauseNote').hidden"), true, 'accepted tasks do not retain pause instructions');

  const permissionCalls = (calls.desktopPermission || []).length;
  await click(win, 'desktopPermission');
  await waitFor(() => Promise.resolve((calls.desktopPermission || []).length === permissionCalls + 1), 'permission prompt');
  assert.equal((calls.desktopPermission || []).length, permissionCalls + 1, 'permission is requested once per button press');

  assert.equal(await evalIn(win, "document.getElementById('workModel').value"), 'deepseek-v4.1-flash', 'Flash high is the default task profile');
  assert.equal(await evalIn(win, "document.getElementById('workbuddyMonitorCard').hidden"), false);
  await evalIn(win, "document.getElementById('taskTarget').value='wechat'; document.getElementById('taskTarget').dispatchEvent(new Event('change',{bubbles:true}))");
  assert.equal(await evalIn(win, "document.getElementById('workModelRow').hidden"), true, 'WorkBuddy profile is hidden for other targets');
  assert.equal(await evalIn(win, "document.getElementById('workbuddyMonitorCard').hidden"), true, 'WorkBuddy monitor is hidden for the WeChat route');
  assert.equal(await evalIn(win, "document.getElementById('taskGoalLabel').textContent"), '想在微信做什么');
  assert.equal(await evalIn(win, "document.getElementById('taskCriteriaLabel').textContent"), '如何确认完成');
  assert.equal(await evalIn(win, "document.getElementById('taskStart').textContent"), '开始代办');
  await evalIn(win, "document.getElementById('taskTarget').value='workbuddy'; document.getElementById('taskTarget').dispatchEvent(new Event('change',{bubbles:true}))");

  await evalIn(win, "document.getElementById('taskGoal').value='  原样交给 WorkBuddy\\n保留第二行  '; document.getElementById('taskStart').click()");
  assert.equal((calls.taskStart || []).length, 0, 'tasks require explicit acceptance criteria');
  await evalIn(win, "document.getElementById('taskCriteria').value='WorkBuddy 会话中显示回复'; document.getElementById('taskStart').click()");
  await waitFor(() => Promise.resolve((calls.taskStart || []).length === 1), 'task start');
  assert.equal(calls.taskStart[0][0].workModel, 'deepseek-v4.1-flash', 'selected execution profile is passed to main');
  assert.equal(calls.taskStart[0][0].goal, '  原样交给 WorkBuddy\n保留第二行  ', 'the entered WorkBuddy request reaches main unchanged');
  assert.equal(calls.taskStart[0][0].criteria, 'WorkBuddy 会话中显示回复');
  assert.equal(status.task.thinking, 'high');
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
