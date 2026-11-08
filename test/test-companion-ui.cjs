#!/usr/bin/env node
'use strict';

/* Run with: node_modules/.bin/electron test/test-companion-ui.cjs [--memory-only]
 * This launches only hidden fixture BrowserWindows, stubs every pet API through
 * a contextBridge preload, and writes Electron userData into a temporary folder.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
if (!app || !BrowserWindow || !process.versions.electron) {
  throw new Error('请使用 node_modules/.bin/electron test/test-companion-ui.cjs 运行隐藏 Electron fixture');
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
let importReports=[];
let knowledgeRows = [
  { id: 'innate:fixture', kind: 'state', ts: 0, domain: 'work', visibilityFloor: 0, knowledgeType: 'experience', label: '先天经验', origin: 'innate', readOnly: true, status: 'bundled', content: '安装包只读经验夹具', sources: [] },
  { id: 'knowledge-relation', kind: 'state', ts: 180, domain: 'work', visibilityFloor: 0, knowledgeType: 'relation', label: '记忆关联', status: 'active', content: '合成关系记录', sources: [] },
  { id: 'doubt-choose', kind: 'state', ts: 170, domain: 'life', visibilityFloor: 1, knowledgeType: 'doubt', label: '记忆疑问', status: 'pending', content: '合成冲突：周五或周六', memberChoices: [{ id: 'choice-fri', content: '周五' }, { id: 'choice-sat', content: '周六' }], sources: ['source-1'] },
  { id: 'doubt-snooze', kind: 'state', ts: 160, domain: 'life', visibilityFloor: 1, knowledgeType: 'doubt', label: '记忆疑问', status: 'pending', content: '合成冲突：早上或下午', memberChoices: [{ id: 'choice-am', content: '早上' }, { id: 'choice-pm', content: '下午' }], sources: ['source-1'] },
  { id: 'doubt-both', kind: 'state', ts: 150, domain: 'life', visibilityFloor: 1, knowledgeType: 'doubt', label: '记忆疑问', status: 'pending', content: '合成冲突：工作日或周末', memberChoices: [{ id: 'choice-weekday', content: '工作日' }, { id: 'choice-weekend', content: '周末' }], sources: ['source-1'] },
  { id: 'doubt-dismiss', kind: 'state', ts: 140, domain: 'life', visibilityFloor: 1, knowledgeType: 'doubt', label: '记忆疑问', status: 'pending', content: '合成冲突：地点A或地点B', memberChoices: [{ id: 'choice-a', content: '地点A' }, { id: 'choice-b', content: '地点B' }], sources: ['source-1'] },
  { id: 'doubt-stale', kind: 'state', ts: 130, domain: 'life', visibilityFloor: 1, knowledgeType: 'doubt', label: '记忆疑问', status: 'pending', content: '合成冲突：新场景下不可见', memberChoices: [{ id: 'choice-old', content: '旧场景说法' }, { id: 'choice-new', content: '另一说法' }], sources: ['source-1'] },
  { id: 'knowledge-tool', kind: 'state', ts: 120, domain: 'life', visibilityFloor: 1, knowledgeType: 'tool', label: '工具', status: 'verified', fileStatus: 'unknown', artifact: '/private/tmp/fixture-tool/helper.js', snapshotAvailable: true, code: 'FIXTURE_CODE_SHOULD_NOT_RENDER', content: '合成工具验收记录', sources: [] },
  { id: 'knowledge-experience', kind: 'state', ts: 110, domain: 'work', visibilityFloor: 0, knowledgeType: 'experience', label: '经验', status: 'active', content: '合成工作经验', sources: [] },
];
let settings = {
  memory: { enabled: true, extract: true, scene: 'life' },
  buddy: { name: 'Fixture', ownerName: '主人', profile: '共通角色设定', sceneProfiles: { private: '私聊补充', life: '生活补充', work: '工作补充' } },
  voice: { alwaysListen: true }, tts: { enabled: true, apiKey: 'fixture-tts-secret' },
  brain: { model: 'hy3', thinking: 'low', apiKey: 'fixture-brain-secret', profiles: { deepseek: { apiKey: 'fixture-provider-secret', modelId: 'deepseek-v4.1-flash' } } },
};
let failConfig = false;
let holdConfig = false, heldConfigResolve = null;
let holdNextMemoryList = false, heldMemoryListResolve = null;
let holdNextDoubtResolve = false, heldDoubtResolve = null;
let insertFinish = null;
let failNextMemorySources = false;
let maintenanceStatus = { status: 'idle', mode: null, processed: 0, note: '暂无待整理内容', lastSuccessAt: null };
let monitorSnapshot = { tasks: [{ name: 'Fixture 正在整理', status: 'running' }] };
let watches = [
  { id: 'watch-wechat-alice', target: 'wechat', recipient: 'Alice', goal: '有新消息时提醒我', mode: 'notify', policy: '只通知我，不自动回复', status: 'active', note: '正在关注', intervalSeconds: 60, expiresAt: Date.now() + 3600000, lastCheckedAt: Date.now() - 60000, eventCount: 2 },
  { id: 'watch-workbuddy', target: 'workbuddy', recipient: 'WorkBuddy', goal: '观察已有会话', mode: 'reply', policy: '只回复明确询问进度的问题，不提供其他信息', status: 'paused', note: '已暂停', intervalSeconds: 120, lastCheckedAt: 0, eventCount: 0 },
  { id: 'watch-old', target: 'wechat', recipient: '旧关注', goal: '归档项', mode: 'notify', status: 'stopped', note: '用户停止', intervalSeconds: 60, eventCount: 0 },
];
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
    memoryStats: (...a) => api('memoryStats', ...a), memoryList: (...a) => api('memoryList', ...a), experienceImport: (...a) => api('experienceImport', ...a), memoryImportStatus: (...a)=>api('memoryImportStatus',...a),
    memoryUpdate: (...a) => api('memoryUpdate', ...a), memoryRemove: (...a) => api('memoryRemove', ...a),
    memoryResolveConflict: (...a) => api('memoryResolveConflict', ...a),
    memoryResolveDoubt: (...a) => api('memoryResolveDoubt', ...a),
    memoryClear: (...a) => api('memoryClear', ...a), memorySources: (...a) => api('memorySources', ...a),
    memoryExport: (...a) => api('memoryExport', ...a), memoryRestore: (...a) => api('memoryRestore', ...a),
    memoryMaintain: (...a) => api('memoryMaintain', ...a), memoryMaintenanceStatus: (...a) => api('memoryMaintenanceStatus', ...a),
    config: (...a) => api('config', ...a), taskStatus: (...a) => api('taskStatus', ...a),
    taskStart: (...a) => api('taskStart', ...a), taskStop: (...a) => api('taskStop', ...a), taskCancel: (...a) => api('taskCancel', ...a),
    agentStatus:()=>api('agentStatus'),agentControl:(...a)=>api('agentControl',...a),agentArtifact:(...a)=>api('agentArtifact',...a),
    taskAccept: (...a) => api('taskAccept', ...a), desktopPermission: (...a) => api('desktopPermission', ...a),
    autonomyStatus: () => api('autonomyStatus'), autonomyControl: action => api('autonomyControl', action), autonomyDirectory: () => api('autonomyDirectory'),
    desktopRefresh: (...a) => api('taskStatus', ...a), desktopInsert: (...a) => api('desktopInsert', ...a),
    watchList: (...a) => api('watchList', ...a), watchPause: (...a) => api('watchPause', ...a),
    watchResume: (...a) => api('watchResume', ...a), watchStop: (...a) => api('watchStop', ...a), watchCheck: (...a) => api('watchCheck', ...a),
    __fixture: { failConfig: () => ipcRenderer.invoke('fixture:control', 'failConfig'),
      holdConfig: () => ipcRenderer.invoke('fixture:control', 'holdConfig'),
      releaseConfig: () => ipcRenderer.invoke('fixture:control', 'releaseConfig'),
      holdNextMemoryList: () => ipcRenderer.invoke('fixture:control', 'holdNextMemoryList'),
      releaseMemoryList: () => ipcRenderer.invoke('fixture:control', 'releaseMemoryList'),
      holdNextDoubtResolve: () => ipcRenderer.invoke('fixture:control', 'holdNextDoubtResolve'),
      releaseDoubtResolve: () => ipcRenderer.invoke('fixture:control', 'releaseDoubtResolve'),
      emitDesktop: value => ipcRenderer.invoke('fixture:control', 'emitDesktop', { type: 'desktop', ...value }),
      emitMonitor: value => ipcRenderer.invoke('fixture:control', 'emitMonitor', value),
      emitWatches: value => ipcRenderer.invoke('fixture:control', 'emitWatches', value),
      emitRecall: value => ipcRenderer.invoke('fixture:control', 'emitRecall', value),
      emitConfig: value => ipcRenderer.invoke('fixture:control', 'emitConfig', value),
      failMemorySources: () => ipcRenderer.invoke('fixture:control', 'failMemorySources'),
      emitMemoryChange: () => ipcRenderer.invoke('fixture:control', 'emitMemoryChange'),
      injectConflictRows: () => ipcRenderer.invoke('fixture:control', 'injectConflictRows'),
      emitMaintenance: value => ipcRenderer.invoke('fixture:control', 'emitMaintenance', value),
      completeImport: ()=>ipcRenderer.invoke('fixture:control','completeImport'),
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
  if (action === 'holdNextDoubtResolve') { holdNextDoubtResolve = true; return true; }
  if (action === 'releaseDoubtResolve') { heldDoubtResolve?.(); heldDoubtResolve = null; return true; }
  if (action === 'emitDesktop') { status = value; activeWindow?.webContents.send('fixture:event', value); return true; }
  if (action === 'emitMonitor') { monitorSnapshot = value; activeWindow?.webContents.send('fixture:event', { type: 'monitor', ...value }); return true; }
  if (action === 'emitWatches') { watches = value; activeWindow?.webContents.send('fixture:event', { type: 'watches', watches: value }); return true; }
  if (action === 'emitRecall') { activeWindow?.webContents.send('fixture:event', { type: 'recall', entries: value }); return true; }
  if (action === 'emitConfig') {
    if (value.memory) settings.memory = { ...settings.memory, ...value.memory };
    if (value.buddy) settings.buddy = { ...settings.buddy, ...value.buddy,
      ...(value.buddy.sceneProfiles ? { sceneProfiles: { ...settings.buddy.sceneProfiles, ...value.buddy.sceneProfiles } } : {}) };
    settings.settingsRevision = (settings.settingsRevision || 0) + 1;
    activeWindow?.webContents.send('fixture:event', { type: 'config', config: JSON.parse(JSON.stringify(settings)) });
    return true;
  }
  if (action === 'emitMaintenance') { maintenanceStatus = value; activeWindow?.webContents.send('fixture:event', { type: 'memory-maintenance', ...value }); return true; }
  if (action === 'failMemorySources') { failNextMemorySources = true; return true; }
  if (action === 'emitMemoryChange') {
    rows.push({ id: `memory-live-${Date.now()}`, kind: 'memory', ts: Date.now(), content: '海边新记忆', status: 'pending', sources: [] });
    activeWindow?.webContents.send('fixture:event', { type: 'memory-changed', counts: emptyCounts() });
    return true;
  }
  if (action === 'injectConflictRows') {
    rows.push(
      { id: 'memory-user-conflict-fixture', kind: 'memory', ts: Date.now(), content: '用户生日冲突fixture', status: 'pending', origin: 'user-key-conflict-v1', sources: ['source-1'], evidence: '我的生日是3月4日' },
      { id: 'memory-imported-fixture', kind: 'memory', ts: Date.now() - 2, content: '资料作者说法fixture', status: 'pending', origin: 'imported-memory-v1', sources: ['source-1'] },
      { id: 'memory-doze-candidate-fixture', kind: 'memory', ts: Date.now() - 1, content: '普通整理候选fixture', status: 'pending', origin: 'doze-candidate-v1', sources: ['source-1'], evidence: '候选来源' },
    );
    activeWindow?.webContents.send('fixture:event', { type: 'memory-changed', counts: emptyCounts() });
    return true;
  }
  if(action==='completeImport'){knowledgeRows.push({id:'imported-fixture',kind:'state',ts:190,domain:'work',visibilityFloor:0,knowledgeType:'experience',label:'导入经验',origin:'imported',status:'candidate',content:'导入后自动吸收的经验夹具',sources:[]});importReports=[{...importReports[0],status:'completed',processed:1,summary:'新增经验1条；忽略1项',counts:{experiences:1},ignored:[{file:'unsupported.pdf',reason:'当前格式不支持',risk:false}],results:[{type:'experience',title:'自动吸收的经验夹具',action:'added'}]}];activeWindow?.webContents.send('fixture:event',{type:'memory-changed'});return true;}
  if (action === 'getCalls') return calls;
  return false;
});
ipcMain.handle('fixture:api', async (_event, name, ...args) => {
  called(name, ...args);
  if (name === 'init') return { monitor: monitorSnapshot, desktop: status, currentRecall: recallEntries, watches };
  if (name === 'workbuddyOpen') return { ok: true };
  if (name === 'memoryStats') return { ready: true, counts: emptyCounts(), scene: settings.memory.scene,
    compression: { version: { private: 3, life: 2, work: 1 }[settings.memory.scene], updatedAt: Date.now() },
    state: { mood: '愉快', energy: 72, interactions: 5 } };
  if (name === 'memoryMaintenanceStatus') return maintenanceStatus;
  if (name === 'memoryMaintain') { maintenanceStatus = { status: 'queued', mode: args[0], processed: 0, note: args[0] === 'doze' ? '小憩已排队' : '记忆整理已排队' }; return { ok: true, queued: true }; }
  if (name === 'config') {
    if (!args[0]) {
      const config = JSON.parse(JSON.stringify(settings));
      delete config.tts.apiKey; delete config.brain.apiKey;
      for (const profile of Object.values(config.brain.profiles || {})) delete profile.apiKey;
      return config;
    }
    if (failConfig) { failConfig = false; return { ok: false, error: 'fixture write failure' }; }
    const commit = () => {
      const patch = args[0] || {};
      if (patch.memory) settings.memory = { ...settings.memory, ...patch.memory };
      if (patch.buddy) settings.buddy = { ...settings.buddy, ...patch.buddy,
        ...(patch.buddy.sceneProfiles ? { sceneProfiles: { ...settings.buddy.sceneProfiles, ...patch.buddy.sceneProfiles } } : {}) };
      return settings;
    };
    if (holdConfig) return new Promise(resolve => { heldConfigResolve = () => resolve(commit()); });
    return commit();
  }
  if (name === 'memoryList') {
    const options = args[0] || {};
    const knowledge = options.kind === 'knowledge';
    const rank = { work: 0, life: 1, private: 2 }[settings.memory.scene] ?? 1;
    let found = (knowledge ? knowledgeRows : rows).filter(row => knowledge ? row.kind === 'state' : row.kind === options.kind);
    if (knowledge) found = options.category === 'innate' ? found.filter(row=>row.origin==='innate') : found.filter(row=>row.origin!=='innate');
    if (knowledge && options.category && !['all','innate'].includes(options.category)) found = found.filter(row => row.knowledgeType === options.category);
    if (knowledge) found = found.filter(row => Number(row.visibilityFloor ?? 2) <= rank);
    if (options.query) found = found.filter(row => String(row.content || '').toLowerCase().includes(options.query.toLowerCase()));
    if (knowledge) found.sort((a, b) => b.ts - a.ts || String(b.id).localeCompare(String(a.id)));
    if (knowledge && Number.isSafeInteger(options.before)) found = found.filter(row => row.ts < options.before || (row.ts === options.before && String(row.id) < String(options.beforeId || '')));
    const pageSize = knowledge ? 2 : found.length;
    const page = found.slice(0, pageSize);
    const result = { rows: page, hasMore: knowledge ? found.length > page.length : true,
      ...(knowledge && found.length > page.length && page.length ? { next: { ts: page.at(-1).ts, id: page.at(-1).id } } : {}) };
    if (holdNextMemoryList) {
      holdNextMemoryList = false;
      return new Promise(resolve => { heldMemoryListResolve = () => resolve(result); });
    }
    return result;
  }
  if(name==='memoryImportStatus')return importReports;
  if (name === 'experienceImport') {
    importReports=[{id:'fixture-import',title:'合成资料包',status:'queued',processed:0,total:1,counts:{},ignored:[],results:[],summary:'已接收，等待分析',note:'无需审批'}];
    return {ok:true,queued:true,importId:'fixture-import',report:importReports[0]};
  }
  if (name === 'memoryResolveDoubt') {
    const [id, resolution] = args;
    const row = knowledgeRows.find(item => item.id === id && item.knowledgeType === 'doubt' && item.status === 'pending');
    const apply = () => {
      if (!row) return { ok: false, error: '该待核对项已不可用' };
      row.status = resolution.action === 'snooze' ? 'snoozed' : resolution.action === 'dismiss' ? 'dismissed' : 'resolved';
      row.resolution = { ...resolution };
      return { ok: true };
    };
    if (holdNextDoubtResolve) {
      holdNextDoubtResolve = false;
      return new Promise(resolve => { heldDoubtResolve = () => resolve(apply()); });
    }
    return apply();
  }
  if (name === 'memoryUpdate') {
    const [id, content] = args, row = rows.find(item => item.id === id);
    if (row) { row.content = content; row.status = 'confirmed'; }
    return { ok: !!row };
  }
  if (name === 'memoryResolveConflict') {
    const [id] = args, row = rows.find(item => item.id === id && item.origin === 'user-key-conflict-v1' && item.status === 'pending');
    if (row) row.status = 'confirmed';
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
  if (name === 'agentStatus') return agentView();
  if (name === 'agentControl') return agentControlReply(...args);
  if (name === 'taskStatus') return status;
  if (name === 'watchList') return watches.map(row => ({ ...row }));
  if (['watchPause', 'watchResume', 'watchStop', 'watchCheck'].includes(name)) {
    const id = args[0], row = watches.find(item => item.id === id);
    if (!row) return { ok: false, error: '关注项不存在' };
    if (name === 'watchPause') row.status = 'paused';
    if (name === 'watchResume') row.status = 'active';
    if (name === 'watchStop') row.status = 'stopped';
    if (name === 'watchCheck') row.lastCheckedAt = Date.now();
    return { ok: true };
  }
  if (name === 'desktopPermission') return status.permissions;
  if (name === 'autonomyStatus') return { note:'等待空闲', paused:false, running:false, directory:'/fixture/creations', history:[] };
  if (name === 'taskCancel') { status = { ...status, running:false, task:{...status.task,status:'cancelled'} }; return {ok:true}; }
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

let archivedAgentTasks=[],agentTasks=[],agentControlReply=async()=>({ok:true});
const agentView=()=>({tasks:agentTasks,archivedCount:archivedAgentTasks.length,archivedTaskIds:archivedAgentTasks.map(t=>t.id),skills:[],capacity:{active:agentTasks.filter(t=>!['stopped','completed','expired','paused','queued'].includes(t.status)).length,limit:5,queued:0}});
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
  await waitFor(() => evalIn(win, "document.getElementById('maintenanceStatus').textContent").then(text => text.includes('空闲')), 'initial maintenance status');
  assert.equal(await evalIn(win, "document.getElementById('experienceImportSection').hidden"),false,'mixed intake is visible on first opening, before any tab click');
  assert((calls.memoryImportStatus||[]).length>0,'saved import reports are loaded on first opening');
  assert.match(await evalIn(win, "document.querySelector('.maintenance-scope').textContent"), /Doze.*Dream.*04:00.*Deepdream.*05:00.*场景边界/);
  assert.match(await evalIn(win, "document.getElementById('contextStatus').textContent"), /生活.*压缩版本 2/);
  await click(win, 'maintenanceDoze');
  await waitFor(() => Promise.resolve((calls.memoryMaintain || []).length === 1), 'doze request');
  assert.equal(calls.memoryMaintain[0][0], 'doze');
  await waitFor(() => evalIn(win, "document.getElementById('maintenanceStatus').textContent").then(text => /排队中.*小憩已排队/.test(text)), 'doze queued status');
  assert.match(await evalIn(win, "document.getElementById('maintenanceStatus').textContent"), /排队中.*小憩已排队/);
  await evalIn(win, `window.pet.__fixture.emitMaintenance(${JSON.stringify({ status: 'running', mode: 'dream', processed: 12, note: '仅整理最近范围' })})`);
  await waitFor(() => evalIn(win, "document.getElementById('maintenanceStatus').textContent").then(text => text.includes('整理中') && text.includes('已处理 12 条')), 'maintenance status event');
  await click(win, 'maintenanceDream');
  await waitFor(() => Promise.resolve((calls.memoryMaintain || []).length === 2), 'dream request');
  assert.equal(calls.memoryMaintain[1][0], 'dream');
  await waitFor(() => evalIn(win, '!document.getElementById("maintenanceDeepdream").disabled'), 'deepdream button enabled');
  await click(win, 'maintenanceDeepdream');
  await waitFor(() => Promise.resolve((calls.memoryMaintain || []).length === 3), 'deepdream request');
  assert.equal(calls.memoryMaintain[2][0], 'deepdream');
  assert.equal(await evalIn(win, "document.getElementById('memoryScene').value"), 'life', 'life is the default scene');
  assert.equal(await evalIn(win, "document.getElementById('memorySceneScope').textContent"), '生活：可按需参考生活与工作资料');
  await evalIn(win, "document.getElementById('memoryScene').value='work';document.getElementById('memoryScene').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitFor(() => Promise.resolve(settings.memory.scene === 'work'), 'work scene persisted');
  assert.deepEqual(calls.config.at(-1)[0], {memory:{scene:'work'}});
  await evalIn(win, "document.getElementById('memoryScene').value='life';document.getElementById('memoryScene').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitFor(() => Promise.resolve(settings.memory.scene === 'life'), 'life scene restored');
  await evalIn(win, "window.pet.__fixture.failConfig().then(()=>{document.getElementById('memoryScene').value='work';document.getElementById('memoryScene').dispatchEvent(new Event('change',{bubbles:true}))})");
  await waitFor(() => evalIn(win, "document.getElementById('memoryConfigNote').textContent").then(text => text.includes('场景切换失败')), 'scene switch failure feedback');
  assert.equal(await evalIn(win, "document.getElementById('memoryScene').value"), 'life', 'failed scene write restores the last saved scene');
  assert.equal(await evalIn(win, "document.getElementById('memorySceneScope').textContent"), '生活：可按需参考生活与工作资料');

  await evalIn(win, `window.pet.__fixture.emitRecall(${JSON.stringify(recallEntries)})`);
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
  await waitFor(() => evalIn(win, "document.querySelector('#currentRecallList .recall-source-list')?.textContent").then(text => !!text && text.includes('我喜欢海边')), 'retry source list paint');
  assert.match(await evalIn(win, "document.querySelector('#currentRecallList .recall-source-list').textContent"), /我喜欢海边/);
  await evalIn(win, "window.pet.__fixture.emitRecall([])");
  assert.equal(await evalIn(win, "document.getElementById('currentRecallCard').hidden"), true, 'empty recall hides the area');
  await evalIn(win, `window.pet.__fixture.emitRecall(${JSON.stringify(recallEntries)})`);
  await waitFor(() => evalIn(win, "!document.getElementById('currentRecallCard').hidden"), 'current recall restored');
  await evalIn(win, "document.querySelector('#currentRecallList .recall-entry button:last-child').click()");
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=memory-pending-1]') !== null"), 'jump from recalled fact to the editable memory record');
  assert.equal(await evalIn(win, "document.getElementById('memorySearch').value"), '', 'an already loaded record opens without replacing the current query');
  const recalledRecordActions = await evalIn(win, "[...document.querySelector('#memoryList [data-record-id=memory-pending-1]').querySelectorAll('button')].map(button=>button.textContent)");
  assert(recalledRecordActions.includes('编辑') && recalledRecordActions.includes('彻底遗忘'), 'recalled records retain existing edit and delete actions');
  assert.match(await evalIn(win, "document.getElementById('memoryStatus').textContent"), /(?:工作|生活|私聊).*已就绪/);
  assert.doesNotMatch(await evalIn(win, "document.getElementById('memoryStatus').textContent"), /72|精力/);
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

  // A source-aware user conflict has a dedicated resolution action. It must not
  // expose generic edit/confirm controls or mutate profile/settings state.
  await evalIn(win, 'window.pet.__fixture.injectConflictRows()');
  await evalIn(win, "document.getElementById('memorySearch').value=''; document.getElementById('memorySearchBtn').click()");
  await waitFor(() => evalIn(win, "document.querySelectorAll('#memoryList .record').length").then(n => n >= 4), 'conflict and doze fixtures loaded');
  await evalIn(win, "document.getElementById('memorySearch').value='用户生日冲突fixture'; document.getElementById('memorySearchBtn').click()");
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=memory-user-conflict-fixture]') !== null"), 'conflict row search');
  const conflictCard = "document.querySelector('#memoryList [data-record-id=memory-user-conflict-fixture]')";
  assert.equal(await evalIn(win, `${conflictCard}.querySelector('.pending')?.textContent`), '用户说法待核对');
  const conflictActions = await evalIn(win, `[...${conflictCard}.querySelectorAll('.record-actions button')].map(button=>button.textContent)`);
  assert(conflictActions.includes('采用这次说法'));
  assert(!conflictActions.includes('确认') && !conflictActions.includes('编辑'), 'conflict has no generic confirmation or edit action');
  const beforeConflictResolve = (calls.memoryResolveConflict || []).length;
  const beforeConflictUpdate = (calls.memoryUpdate || []).length;
  const beforeConflictConfig = JSON.stringify({ memory: settings.memory, buddy: settings.buddy });
  await evalIn(win, `${conflictCard}.querySelectorAll('.record-actions button')[0].click()`);
  await waitFor(() => Promise.resolve((calls.memoryResolveConflict || []).length === beforeConflictResolve + 1), 'dedicated conflict resolution');
  assert.deepEqual(calls.memoryResolveConflict.at(-1), ['memory-user-conflict-fixture']);
  assert.equal((calls.memoryUpdate || []).length, beforeConflictUpdate, 'conflict did not use generic memoryUpdate');
  assert.equal(JSON.stringify({ memory: settings.memory, buddy: settings.buddy }), beforeConflictConfig, 'resolving conflict does not change profiles or settings');

  // A model/doze candidate remains an ordinary editable candidate, not a user conflict.
  await evalIn(win, "document.getElementById('memorySearch').value='普通整理候选fixture'; document.getElementById('memorySearchBtn').click()");
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=memory-doze-candidate-fixture]') !== null"), 'doze candidate search');
  const candidateCard = "document.querySelector('#memoryList [data-record-id=memory-doze-candidate-fixture]')";
  assert.equal(await evalIn(win, `${candidateCard}.querySelector('.pending')?.textContent`), '整理候选');
  const candidateActions = await evalIn(win, `[...${candidateCard}.querySelectorAll('.record-actions button')].map(button=>button.textContent)`);
  assert(candidateActions.includes('确认') && candidateActions.includes('编辑'));
  assert(!candidateActions.includes('采用这次说法'));
  const beforeCandidateUpdate = (calls.memoryUpdate || []).length;
  await evalIn(win, `[...${candidateCard}.querySelectorAll('.record-actions button')].find(button=>button.textContent==='确认').click()`);
  await waitFor(() => Promise.resolve((calls.memoryUpdate || []).length === beforeCandidateUpdate + 1), 'ordinary candidate confirmation');
  assert.equal(calls.memoryUpdate.at(-1)[0], 'memory-doze-candidate-fixture');
  assert.equal(calls.memoryUpdate.at(-1)[1], '普通整理候选fixture');
  assert.equal((calls.memoryResolveConflict || []).length, beforeConflictResolve + 1, 'ordinary candidate did not use conflict resolution');
  await evalIn(win, "document.getElementById('memorySearch').value='资料作者说法fixture'; document.getElementById('memorySearchBtn').click()");
  await waitFor(()=>evalIn(win,"document.querySelector('#memoryList [data-record-id=memory-imported-fixture]') !== null"),'imported source memory');
  assert.match(await evalIn(win,"document.querySelector('#memoryList [data-record-id=memory-imported-fixture]').textContent"),/导入资料 · 来源说法/);
  assert.equal(await evalIn(win,"[...document.querySelector('#memoryList [data-record-id=memory-imported-fixture]').querySelectorAll('button')].some(b=>b.textContent==='确认')"),false,'absorbed source data never asks for another confirmation');
  await evalIn(win, "document.getElementById('memorySearch').value='海边'; document.getElementById('memorySearchBtn').click()");
  await waitFor(() => evalIn(win, "[...document.querySelectorAll('#memoryList .record-content')].some(el=>el.textContent==='海边新记忆')"), 'restore existing memory query');

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

async function testKnowledge() {
  const win = await loadPage('memory');
  await waitFor(() => evalIn(win, "document.querySelector('#memoryTabs [data-kind=knowledge]') !== null"), 'knowledge tab ready');
  const listStart = (calls.memoryList || []).length;
  await evalIn(win, "document.querySelector('#memoryTabs [data-kind=knowledge]').click()");
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=knowledge-relation]') !== null"), 'knowledge tab first page');
  await waitFor(() => Promise.resolve((calls.memoryList || []).length > listStart), 'knowledge category all IPC');
  assert.deepEqual(calls.memoryList.at(-1)[0], { kind: 'knowledge', query: '', category: 'all' }, 'knowledge IPC sends its category');
  assert.equal(await evalIn(win, "document.querySelectorAll('#memoryList .record').length"), 2, 'knowledge results are paged');
  assert.equal(await evalIn(win, "document.getElementById('knowledgeFilters').hidden"), false);
  assert.equal(await evalIn(win, "document.querySelector('#knowledgeCategory option[value=innate]')"), null);
  assert.equal(await evalIn(win, "document.getElementById('experienceImportSection').hidden"), false);
  await evalIn(win, "document.querySelector('#memoryTabs [data-kind=innate]').click()");
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=\"innate:fixture\"]') !== null"), 'dedicated innate view');
  assert.deepEqual(calls.memoryList.at(-1)[0],{kind:'knowledge',query:'',category:'innate'});
  assert.equal(await evalIn(win, "document.getElementById('knowledgeFilters').hidden && document.getElementById('experienceImportSection').hidden"),true);
  assert.equal(await evalIn(win, "document.querySelector('#memoryList .record').querySelectorAll('button,textarea').length"),0,'packaged entries expose no mutating actions');
  assert.match(await evalIn(win,"document.getElementById('innateExperienceNote').textContent"),/只能随安装包更新/);
  await evalIn(win, "document.querySelector('#memoryTabs [data-kind=knowledge]').click()");
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=knowledge-relation]') !== null"),'return to learned collections');

  await evalIn(win, "document.getElementById('knowledgeCategory').value='doubt'; document.getElementById('knowledgeCategory').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitFor(() => evalIn(win, "document.querySelectorAll('#memoryList .knowledge-card').length").then(n => n === 2), 'first doubt page');
  assert.equal(calls.memoryList.at(-1)[0].category, 'doubt');
  assert.equal(await evalIn(win,"document.getElementById('experienceImportSection').hidden"),false,'the independent import card is not a category destination');
  assert.match(await evalIn(win,"document.getElementById('knowledgeCategoryNote').textContent"),/与导入经验无关/);
  assert.equal(await evalIn(win, "[...document.querySelectorAll('#memoryList .record')].every(card=>card.textContent.includes('记忆疑问'))"), true);
  await evalIn(win, "[...document.querySelector('#memoryList [data-record-id=doubt-choose]').querySelectorAll('button')].find(b=>b.textContent==='采用第 1 项').click()");
  await waitFor(() => Promise.resolve((calls.memoryResolveDoubt || []).length === 1), 'choose doubt');
  assert.deepEqual(calls.memoryResolveDoubt[0], ['doubt-choose', { action: 'choose', choiceId: 'choice-fri' }]);
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=doubt-choose] .badge:last-of-type')?.textContent").then(t => t === '已澄清'), 'choose result refreshed');

  // Snooze the second row on the first page. The first resolved item remains listed.
  await evalIn(win, "[...document.querySelector('#memoryList [data-record-id=doubt-snooze]').querySelectorAll('button')].find(b=>b.textContent==='稍后').click()");
  await waitFor(() => Promise.resolve((calls.memoryResolveDoubt || []).length === 2), 'snooze doubt');
  assert.deepEqual(calls.memoryResolveDoubt[1], ['doubt-snooze', { action: 'snooze' }]);
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=doubt-snooze] .badge:last-of-type')?.textContent").then(t => t === '稍后查看'), 'snooze result refreshed');

  await click(win, 'memoryMore');
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=doubt-both]') !== null"), 'second doubt page');
  const pageCall = calls.memoryList.at(-1)[0];
  assert.equal(pageCall.category, 'doubt');
  assert.equal(pageCall.before, 160);
  assert.equal(pageCall.beforeId, 'doubt-snooze', 'pagination carries a stable tie-break cursor');
  await evalIn(win, "[...document.querySelector('#memoryList [data-record-id=doubt-both]').querySelectorAll('button')].find(b=>b.textContent==='两种都适用').click()");
  assert.equal(await evalIn(win, "document.querySelector('#memoryList .knowledge-both-editor textarea') !== null"), true, 'both action asks inline for conditions');
  const listCallsBeforeBothRefresh = (calls.memoryList || []).length;
  await evalIn(win, "const field=document.querySelector('#memoryList .knowledge-both-editor textarea'); field.value='工作日按第一种，周末按第二种'; document.querySelector('#memoryList .knowledge-both-editor button.primary').click()");
  await waitFor(() => Promise.resolve((calls.memoryResolveDoubt || []).length === 3), 'save both conditions');
  assert.deepEqual(calls.memoryResolveDoubt[2], ['doubt-both', { action: 'both', note: '工作日按第一种，周末按第二种' }]);
  await waitFor(() => Promise.resolve((calls.memoryList || []).length > listCallsBeforeBothRefresh), 'both result refresh');
  await click(win, 'memoryMore');
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=doubt-dismiss]') !== null"), 'dismiss doubt page after refresh');
  await evalIn(win, "[...document.querySelector('#memoryList [data-record-id=doubt-dismiss]').querySelectorAll('button')].find(b=>b.textContent==='不再提醒').click()");
  await waitFor(() => Promise.resolve((calls.memoryResolveDoubt || []).length === 4), 'dismiss doubt');
  assert.deepEqual(calls.memoryResolveDoubt[3], ['doubt-dismiss', { action: 'dismiss' }]);

  await evalIn(win, "document.getElementById('knowledgeCategory').value='tool'; document.getElementById('knowledgeCategory').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=knowledge-tool]') !== null"), 'tool knowledge');
  const toolText = await evalIn(win, "document.querySelector('#memoryList [data-record-id=knowledge-tool]').textContent");
  assert.match(toolText, /helper\.js/);
  assert.match(toolText, /历史验收；当前文件未复验/);
  assert.doesNotMatch(toolText, /FIXTURE_CODE_SHOULD_NOT_RENDER|\/private\/tmp/, 'tool cards hide code and full paths');
  const clarificationsBeforeImport=(calls.memoryResolveDoubt||[]).length;
  await click(win,'experienceImportZip');
  await waitFor(()=>evalIn(win,"document.getElementById('memoryImportReports').textContent.includes('等待分析')"),'intake progress is not presented as completed');
  assert.equal(await evalIn(win,"document.querySelector('#memoryList [data-record-id=imported-fixture]')"),null);
  await evalIn(win,'window.pet.__fixture.completeImport()');
  await waitFor(()=>evalIn(win,"document.querySelector('#memoryList [data-record-id=imported-fixture]') !== null"),'completed absorption shows actual stored experience');
  assert.match(await evalIn(win,"document.getElementById('memoryImportReports').textContent"),/新增经验1条/);
  assert.match(await evalIn(win,"document.getElementById('memoryImportReports').textContent"),/unsupported.pdf/);
  assert.deepEqual(calls.experienceImport.at(-1),['zip'],'imports have no innate destination parameter');
  assert.equal(calls.memoryList.at(-1)[0].category,'all');
  assert.match(await evalIn(win,"document.getElementById('experienceImportNote').textContent"),/自动分析吸收，无需再次确认/);
  assert.match(await evalIn(win,"document.querySelector('#memoryList [data-record-id=imported-fixture]').textContent"),/参考经验/);
  assert.equal(await evalIn(win,"[...document.querySelector('#memoryList [data-record-id=imported-fixture]').querySelectorAll('button')].some(b=>/采用|确认|澄清/.test(b.textContent))"),false);
  assert.equal((calls.memoryResolveDoubt||[]).length,clarificationsBeforeImport);

  await evalIn(win, "document.getElementById('knowledgeCategory').value='doubt'; document.getElementById('knowledgeCategory').dispatchEvent(new Event('change',{bubbles:true}))");
  await click(win, 'memoryMore');
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=doubt-both]') !== null"), 'second page before stale doubt');
  await click(win, 'memoryMore');
  await waitFor(() => evalIn(win, "document.querySelector('#memoryList [data-record-id=doubt-stale]') !== null"), 'stale doubt page');
  await evalIn(win, 'window.pet.__fixture.holdNextDoubtResolve()');
  await evalIn(win, "[...document.querySelector('#memoryList [data-record-id=doubt-stale]').querySelectorAll('button')].find(b=>b.textContent==='采用第 1 项').click()");
  await waitFor(() => Promise.resolve(!!heldDoubtResolve), 'delayed doubt resolution held');
  const beforeSceneSwitchCalls = (calls.memoryList || []).length;
  await evalIn(win, "document.getElementById('memoryScene').value='work'; document.getElementById('memoryScene').dispatchEvent(new Event('change',{bubbles:true}))");
  await waitFor(() => Promise.resolve(settings.memory.scene === 'work'), 'switch to work scene during pending resolution');
  await waitFor(() => evalIn(win, "document.querySelectorAll('#memoryList .record').length").then(n => n === 0), 'life-only knowledge hidden in work scene');
  const afterSceneRefreshCalls = (calls.memoryList || []).length;
  assert(afterSceneRefreshCalls > beforeSceneSwitchCalls, 'scene switch refreshed scoped knowledge');
  await evalIn(win, 'window.pet.__fixture.releaseDoubtResolve()');
  await delay(250);
  assert.equal((calls.memoryList || []).length, afterSceneRefreshCalls, 'late resolve from prior scene does not refresh the new scene');
  assert.equal(await evalIn(win, "document.querySelectorAll('#memoryList .record').length"), 0, 'late resolution cannot reinsert old-scene rows');
  win.hide();
}

async function testDesktop() {
  const {taskPresentation}=require('../src/main/task-presentation'),presentation=task=>({...task,presentation:taskPresentation(task)});
  agentTasks=[presentation({id:'control-fixture',skill:'system.operate',goal:'核对独立进程停止',status:'waiting',createdAt:Date.now(),updatedAt:Date.now(),state:{},subjects:[{application:'system'}],schedule:{intervalSeconds:60}})];
  const win=await loadPage('desktop'),emit=()=>win.webContents.send('fixture:event',{type:'agent',...agentView()});
  await waitFor(()=>evalIn(win,'!!document.querySelector("#agentTaskList [data-operation=stop]")'),'current task card initializes');
  let finish;agentControlReply=async(operation,id)=>{assert.equal(operation,'stop');assert.equal(id,'control-fixture');const stopRequest={phase:'pending',deadlineAt:Date.now()+30000};agentTasks=[presentation({...agentTasks[0],status:'stopped',stopRequest,resources:[{id:'process',kind:'process',phase:'running',ownership:'owned'}],state:{stopRequest}})];emit();return new Promise(r=>finish=r);};
  await evalIn(win,'document.querySelector("#agentTaskList [data-operation=stop]").click();document.querySelector("#agentTaskList [data-operation=stop]").click()');
  await waitFor(()=>evalIn(win,'!!document.querySelector("[data-cleanup-countdown]")'),'external cleanup countdown');
  assert.equal((calls.agentControl||[]).length,1);assert.equal(agentView().capacity.active,0);assert.equal(agentTasks[0].status,'stopped');assert.match(await evalIn(win,'document.querySelector("#agentTaskList .task-card-status").textContent'),/已停止/);assert.equal(await evalIn(win,'document.querySelector("#agentTaskList [data-operation=stop]")===null'),true);
  const before=await evalIn(win,'document.querySelector("[data-cleanup-countdown]").textContent');await waitFor(()=>evalIn(win,'document.querySelector("[data-cleanup-countdown]").textContent').then(text=>text!==before),'countdown advances');fs.writeFileSync(path.join(tmp,'desktop-stop-countdown.png'),(await win.webContents.capturePage()).toPNG(),{mode:0o600});
  const stopRequest={...agentTasks[0].stopRequest,phase:'failed'};agentTasks=[presentation({...agentTasks[0],stopRequest,state:{stopRequest},cleanupLog:[{kind:'process',label:'独立命令',verified:false,reason:'停止尚未确认'}]})];emit();finish({ok:true,localStopped:true,cleanupVerified:false,message:'Bunny 已停止；独立命令停止尚未确认'});
  await waitFor(()=>evalIn(win,'document.getElementById("agentCommandNote").textContent').then(text=>text.includes('停止尚未确认')),'partial cleanup feedback');emit();await delay(100);assert.match(await evalIn(win,'document.querySelector("#agentTaskList").textContent'),/停止尚未确认/);assert.equal(await evalIn(win,'document.querySelector("#agentTaskList [data-operation=stop]")===null'),true);assert.equal(await evalIn(win,'document.querySelector("[data-cleanup-countdown]")===null'),true);
  agentControlReply=async operation=>{if(operation==='archive'||operation==='clearList'){archivedAgentTasks.push(...agentTasks);agentTasks=[];}else if(operation==='restoreList'){agentTasks=archivedAgentTasks;archivedAgentTasks=[];}else throw Error('unexpected repeat control '+operation);emit();return {ok:true,message:'任务列表已更新；保留记忆与产物'};};
  await evalIn(win,'document.querySelector("#agentTaskList [data-operation=archive]").click()');await waitFor(()=>evalIn(win,'document.querySelector("#agentTaskList .task-card")===null'),'archive removes row');await waitFor(()=>evalIn(win,'!document.getElementById("agentRestoreList").hidden'),'restore available');await evalIn(win,'document.getElementById("agentRestoreList").click()');await waitFor(()=>evalIn(win,'!!document.querySelector("#agentTaskList [data-operation=archive]")'),'undo restores ended row');assert.equal(agentTasks[0].status,'stopped');assert.equal(agentTasks[0].cleanupLog[0].reason,'停止尚未确认');
  await evalIn(win,'document.getElementById("agentClearList").click()');await waitFor(()=>evalIn(win,'document.querySelector("#agentTaskList .task-card")===null'),'clear removes list');assert.equal(archivedAgentTasks[0].status,'stopped');assert.equal((calls.agentControl||[]).filter(args=>args[0]==='stop').length,1);
  agentTasks=[presentation({id:'failed-command',skill:'system.operate',goal:'错误反馈夹具',status:'waiting',state:{},createdAt:Date.now(),updatedAt:Date.now()})];emit();await delay(100);agentControlReply=async()=>{throw Error('任务服务暂不可用');};await evalIn(win,'document.querySelector("#agentTaskList [data-operation=stop]").click()');await waitFor(()=>evalIn(win,'document.getElementById("agentCommandNote").textContent').then(text=>text.includes('任务服务暂不可用')),'IPC exception feedback');assert.equal(agentTasks[0].status,'waiting');assert.equal(await evalIn(win,'document.querySelector("#agentTaskList [data-operation=stop]").disabled'),false);win.hide();
}

async function run() {
  app.commandLine.appendSwitch('disable-gpu');
  await app.whenReady();
  try {
    await testMemory();
    await testKnowledge();
    const memoryOnly=process.argv.includes('--memory-only');
    if(!memoryOnly)await testDesktop();
    console.log(`companion Electron fixture: ${memoryOnly?'memory and knowledge':'memory, knowledge and desktop'} flows passed (hidden windows, stub APIs, isolated userData)`);
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
