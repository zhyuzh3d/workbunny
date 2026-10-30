'use strict';
// Hidden Electron windows, actual renderer HTML/JS/preload, isolated real Vault.
// Only UI contracts are exercised; no screenshots, real app instance or accounts.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { MemoryService } = require('../src/main/memory-service');
const { CompanionAutonomy } = require('../src/main/companion-autonomy');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const config = require('../src/main/config');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-ui-'));
app.setPath('userData', path.join(root, 'electron')); config.setPath(path.join(root, 'config.json'));
let m, autonomy, selfWorker, finishUnderstanding; const windows = [], errors = [];
let reflectionCalls = 0, failSceneWrite = false;
const opened = [], configWrites = [];
const settings = { scene: 'life', enabled: true, extract: false };
function handle(name, fn) { ipcMain.handle('pet:' + name, (_e, ...args) => fn(...args)); }
async function page(file, query) {
  const w = new BrowserWindow({ show: false, width: 560, height: 820, webPreferences: { preload: path.resolve('src/preload.js'), contextIsolation: true, sandbox: false } });
  windows.push(w); w.webContents.on('console-message', (_e, level, text) => { if (level >= 3) errors.push(text); });
  await w.loadFile(path.resolve('src/renderer/' + file), { query }); return w;
}
async function wait(w, expression) {
  for (let i = 0; i < 50; i++) { if (await w.webContents.executeJavaScript(expression)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('UI timeout: ' + expression + ' / ' + errors.join(';'));
}
async function exec(w, expression) { try { return await w.webContents.executeJavaScript(expression); } catch(e) { throw new Error(expression.slice(0,400) + '\n' + e.message); } }
async function run() {
  await app.whenReady();
  m = new MemoryService({ dir: path.join(root, 'vault'), bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 36), getSettings: () => settings });
  await m.init(); await m.cognition.ensure(config.load().buddy);
  selfWorker = new MemoryMaintenance({ memory: m, setTimer: () => 1, clearTimer() {}, extract: async (_messages, { analysisContext }) => {
    await new Promise(resolve => { finishUnderstanding = resolve; });
    return { processedThrough: null, memories: [], selfSummary: '已融合你的新设定，保留独立表达与认真倾听。', selfChanges: [
      { op: 'replace', entryId: analysisContext.self.entries[0].entryId, facet: 'identity', text: '我好奇、有主见，愿意先听完再一起想办法。', sourceIds: [analysisContext.settings.sourceId] },
    ] };
  } });
  autonomy = new CompanionAutonomy({ memory: m, getScene: () => settings.scene, defaultDirectory: path.join(root, 'creations'), canRun: () => false, propose: async () => ({ kind: 'none' }) });
  handle('speaker-status', () => ({ ready: false, enabled: false, samples: 0 }));
  handle('panel-init', () => ({ config: config.publicConfig(), avatars: [], motions: [], asr: {} }));
  handle('portability', () => ({ connection: { ready: true, note: '已连接' }, storage: { ok: true, dir: '/fixture/vault' }, asrMode: 'continuous', capabilities: {} }));
  handle('tts-http-template', kind => require('../src/main/tts-http-profile').template(kind));
  handle('brain-info', () => ({ providers: config.PROVIDERS, thinkingLevels: config.THINKING_LEVELS, workbuddyModels: [] }));
  handle('tts-info', () => ({ doubao: { models: require('../src/main/doubao-tts').MODELS, voices: require('../src/main/doubao-tts').VOICES, url: require('../src/main/doubao-tts').URL }, engines: config.TTS_ENGINES, systemVoices: [], qwen: {}, dl: {} }));
  handle('self-view', () => m.cognition.loadRoleView());
  handle('self-settings', value => m.cognition.saveSettings(value));
  handle('self-patch', value => m.cognition.commitPatch({ ...value, requestId: 'ui-test:' + require('crypto').randomUUID() }, { actor: 'owner', trustedUI: true }));
  handle('self-history', id => m.cognition.history(id));
  handle('self-reflect', async () => { reflectionCalls++; return selfWorker.updateSelfNow(); });
  handle('config', patch => {
    if (!patch) return config.publicConfig();
    configWrites.push(patch);
    if (failSceneWrite && patch.memory?.scene) { failSceneWrite = false; throw new Error('synthetic scene failure'); }
    const saved = config.save(patch); settings.scene = saved.memory.scene;
    return config.publicConfig(saved);
  });
  ipcMain.on('pet:open', (_event, target) => opened.push(target));
  handle('autonomy-status', () => autonomy.status()); handle('autonomy-save', value => autonomy.save(value)); handle('autonomy-control', action => autonomy.control(action));
  handle('growth-dismiss', async id => { await m.growth.dismiss(id); return autonomy.status(); });
  const directory = fs.realpathSync(root); handle('autonomy-directory', () => autonomy.setDirectory(directory));
  handle('task-status', () => ({ running: false, task: null, permissions: {} })); ipcMain.handle('watch:list', () => []);
  handle('init', () => ({ config: config.publicConfig(), watches: [] }));
  handle('memory-stats', () => m.stats()); handle('memory-list', () => ({ rows: [], hasMore: false }));
  handle('memory-maintenance-status', () => ({ status: 'idle' }));
  const panel = await page('panel.html', { p: 'settings' });
  await wait(panel, "document.getElementById('setProfile').value.length > 0");
  assert.deepEqual(await exec(panel, "[...document.querySelectorAll('#tabs button')].map(b=>b.textContent)"), ['外观', '设定', '场景', '听力', '智力', '语音', '数据']);
  assert.equal(await exec(panel, "document.querySelectorAll('.self-entry').length"), 0, 'settings only show owner inputs');
  await exec(panel, `document.querySelector('[data-t=persona]').click(); document.getElementById('setName').value='露露'; document.getElementById('setName').dispatchEvent(new Event('input')); document.getElementById('setProfile').value='我好奇、有主见'; document.getElementById('setProfile').dispatchEvent(new Event('input')); document.getElementById('setBehavior').value='先听完，再问是否需要建议'; document.getElementById('setBehavior').dispatchEvent(new Event('input')); document.getElementById('saveBtn').click();`);
  await wait(panel, "document.getElementById('sfNote').textContent.includes('已保存')");
  assert.equal((await m.cognition.loadRoleView()).settings.behavior, '先听完，再问是否需要建议');
  assert.equal((await m.cognition.loadRoleView()).pendingSettings, false, 'saving raw inputs alone does not request automatic updates');
  assert.equal(reflectionCalls, 0);
  await exec(panel, "document.getElementById('selfUnderstand').click()");
  await wait(panel, "document.getElementById('selfSettingsStatus').textContent.includes('露露正在理解') && document.getElementById('selfUnderstand').disabled");
  for (let i = 0; i < 100 && !finishUnderstanding; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(typeof finishUnderstanding, 'function'); finishUnderstanding();
  await wait(panel, "document.getElementById('selfSettingsStatus').textContent.includes('露露更新完毕') && !document.getElementById('selfUnderstand').disabled");
  assert.equal(reflectionCalls, 1); assert(!(await m.cognition.loadRoleView()).pendingSettings);
  await exec(panel, "document.getElementById('setName').value='超级长的名字用来检查省略'; document.getElementById('setName').dispatchEvent(new Event('input'))");
  assert.equal(await exec(panel, "document.getElementById('selfUnderstand').textContent"), '让超级长的名字…自己理解并更新');
  await exec(panel, "document.getElementById('setName').value='露露'; document.getElementById('setName').dispatchEvent(new Event('input'))");
  await exec(panel, "document.getElementById('selfManual').click()");
  await new Promise(r => setTimeout(r, 50)); assert.deepEqual(opened, ['self']);
  const memory = await page('companion.html', {p:'memory'});
  const selfWindow = await page('self.html', {p:'self'});
  await wait(selfWindow, "document.querySelectorAll('.self-entry').length > 0");
  await wait(selfWindow, "document.getElementById('selfDialogTitle').textContent.includes('露露')");
  await exec(selfWindow, "document.getElementById('selfGlobalLock').click()");
  await wait(selfWindow, "document.getElementById('selfGlobalLock').textContent === '解锁自我理解' && !document.getElementById('selfGlobalLock').disabled");
  panel.webContents.send('pet:ev', { type: 'memory-changed' });
  await wait(panel, "document.getElementById('selfUnderstand').disabled");
  assert.equal(await exec(selfWindow, "document.querySelectorAll('#selfEntries input,#selfEntries textarea').length"), 0);
  await exec(selfWindow, "document.querySelector('.self-edit').click(); document.getElementById('selfEntryText').value='我愿意表达自己的看法，也会认真倾听。'; document.getElementById('selfEntrySave').click()");
  await wait(selfWindow, "!document.getElementById('selfEntryDialog').open && !document.getElementById('selfGlobalLock').disabled");
  assert((await m.cognition.loadRoleView()).text.includes('认真倾听'));
  assert((await m.cognition.loadRoleView()).locked, 'manual edits retain the global lock');
  for (const text of ['我在对方倾诉时会耐心听完。', '我在讨论方案时愿意清楚表达不同意见。']) {
    await exec(selfWindow, "document.getElementById('selfAdd').click()");
    await exec(selfWindow, `document.getElementById('selfEntryFacet').value='behavior'; document.getElementById('selfEntryText').value=${JSON.stringify(text)}; document.getElementById('selfEntryCondition').value='认真交流时'; document.getElementById('selfEntrySave').click()`);
    await wait(selfWindow, "!document.getElementById('selfEntryDialog').open && !document.getElementById('selfGlobalLock').disabled");
  }
  assert.equal((await m.cognition.loadRoleView()).entries.filter(e => e.facet === 'behavior').length, 2);
  assert.equal(await exec(selfWindow, "document.querySelectorAll('.self-entry[data-facet=behavior]').length"), 2);
  await exec(selfWindow, "document.querySelector('.self-edit').click()");
  assert.equal(await exec(selfWindow, "document.getElementById('selfEntryHistory').open"), false);
  await exec(selfWindow, "document.getElementById('selfEntryHistory').open=true");
  await wait(selfWindow, "document.getElementById('selfEntryHistoryList').textContent.includes('手工微调')");
  await exec(selfWindow, "document.getElementById('selfEntryHistory').open=false; document.getElementById('selfEntryCancel').click(); document.querySelector('.self-edit').click()");
  assert.equal(await exec(selfWindow, "document.getElementById('selfEntryHistory').open"), false);
  await exec(selfWindow, "document.getElementById('selfEntryCancel').click()");
  await exec(memory, "document.getElementById('openSelfSettings').click()");
  await new Promise(r=>setTimeout(r,20)); assert.deepEqual(opened,['self','self']);
  await wait(selfWindow, "document.getElementById('selfDialog').tagName === 'MAIN'");
  assert.equal(await exec(selfWindow, "[...document.querySelectorAll('#selfDialog button')].filter(b=>/锁定条目|解锁条目/.test(b.textContent)).length"), 0, 'one global lock control');
  await exec(panel, "document.querySelector('[data-t=scene]').click(); document.querySelector('#panelScene [data-scene=work]').click()");
  await wait(panel, "document.querySelector('#panelScene [data-scene=work]').getAttribute('aria-pressed') === 'true' && document.getElementById('panelSceneProfileStatus').textContent === ''");
  assert.deepEqual(configWrites.at(-1), { memory: { scene: 'work' } });
  failSceneWrite = true;
  await exec(panel, "document.querySelector('#panelScene [data-scene=private]').click()");
  await wait(panel, "document.getElementById('panelSceneProfileStatus').textContent.includes('已恢复')");
  assert.equal(await exec(panel, "document.querySelector('#panelScene [aria-pressed=true]').dataset.scene"), 'work');
  await exec(selfWindow, "document.getElementById('selfGlobalLock').click()");
  await wait(selfWindow, "document.getElementById('selfGlobalLock').textContent === '锁定自我理解' && !document.getElementById('selfGlobalLock').disabled");
  assert.equal(await exec(selfWindow, "document.querySelectorAll('dialog#selfDialog').length"),0);
  settings.scene = 'life';
  const owner = await m.addMessage('user', '讨论方案时我希望先弄清目标。');
  const bunny = await m.addMessage('assistant', '我想试着写一个对话短篇，先写开场。');
  const self = await m.cognition.learningInput(), growth = await m.growth.view({ domain: 'life', visibilityFloor: 1 });
  const plan = await m.growth.prepare([
    { op: 'add', type: 'user_model', content: '讨论方案时先弄清目标。', condition: '共同讨论方案', support: [{ sourceId: owner.id, quote: owner.value.content }] },
    { op: 'add', type: 'pursuit', content: '尝试一个对话短篇', status: 'active', nextStep: '写一个开场', feeling: 'curious', support: [{ sourceId: bunny.id, quote: bunny.value.content }] },
  ], { rows: [owner, bunny], view: growth, self, domain: 'life', visibilityFloor: 1 });
  await m.cognition.commitPatch({ requestId: 'seed-growth', baseRevision: self.revision, ops: [] }, { sourceRows: [owner, bunny], extraRecords: plan.records, validateExtra: plan.guard });
  const desktop = await page('companion.html', { p: 'desktop' });
  await wait(desktop, "document.getElementById('autonomyStatus').textContent.length > 0");
  assert.equal((await autonomy.status()).grants.length, 3, 'local life starts without a setup form');
  assert.deepEqual(await exec(desktop, "[...document.querySelectorAll('#desktopTabs button')].map(b=>b.textContent)"), ['当前任务','持续关注','WorkBuddy','自主生活','系统权限']);
  await exec(desktop, "document.querySelector('[data-desktop-tab=autonomy]').click(); document.getElementById('autonomyPause').click()");
  await wait(desktop, "document.getElementById('autonomyResume').hidden === false");
  assert((await autonomy.status()).paused);
  await exec(desktop, "document.getElementById('autonomyResume').click()");
  await wait(desktop, "document.getElementById('autonomyResume').hidden === true");
  await exec(desktop, "document.getElementById('autonomyDirectory').click()");
  await wait(desktop, `document.getElementById('autonomyPath').textContent === ${JSON.stringify(directory)}`);
  await wait(memory, "document.getElementById('memoryStatus').textContent.includes('已就绪')");
  assert.equal(errors.length, 0, errors.join(';'));
  console.log('real renderer/preload UI passed: seven settings tabs, explicit understanding, independent self window, multiple entries per category, global lock/manual edits/history, scene button persistence/rollback, growth and authorization');
}
run().then(() => finish(0), e => { console.error(e, errors.join('; ')); finish(1); });
async function finish(code) { for (const w of windows) if (!w.isDestroyed()) w.destroy(); await autonomy?.close(); await selfWorker?.close(); await m?.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); app.exit(code); }
