'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { MemoryService } = require('../src/main/memory-service');
const { MemoryMaintenance } = require('../src/main/memory-maintenance');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-self-now-'));
const memory = new MemoryService({ dir: path.join(root, 'vault'), bin: path.resolve('bin/vault'), openKey: async () => Buffer.alloc(32, 47), getSettings: () => ({ enabled: true, extract: false, scene: 'life' }) });
let worker;
async function main() {
  await memory.init(); let view = await memory.cognition.ensure({ profile: '我温和而且诚实。' });
  const identity = view.entries[0].entryId;
  view = await memory.cognition.saveSettings({ identity: '我更外向、有主见，愿意尝试新事情。', behavior: '讨论方案时可以提出不同意见。', reflect: false, expectedRevision: view.revision });
  let calls = 0, finish;
  worker = new MemoryMaintenance({ memory, canRun: details => details.manual === true, setTimer: () => 1, clearTimer() {}, extract: async (messages, { analysisContext }) => {
    calls++; assert.equal(messages.length, 0); assert(analysisContext.manualUpdate); assert(analysisContext.settings.identity.includes('更外向'));
    assert(analysisContext.self.entries.some(e => e.text.includes('诚实')));
    await new Promise(resolve => { finish = resolve; });
    return { processedThrough: null, memories: [], selfSummary: '融合外向与主见，保留原有的诚实原则。', selfChanges: [
      { op: 'replace', entryId: identity, facet: 'identity', text: '我外向、诚实、有主见，也愿意尝试新事情。', sourceIds: [analysisContext.settings.sourceId] },
      { op: 'add', facet: 'behavior', text: '我在讨论方案时会清楚表达不同意见。', sourceIds: [analysisContext.settings.sourceId] },
    ] };
  } });
  const pending = worker.updateSelfNow(); assert.equal(worker.updateSelfNow(), pending, 'double clicks share one immediate update');
  for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1, 'manual update calls the model without waiting for a background tick or idle eligibility');
  assert.equal(worker.status().selfUpdate.status, 'running'); assert((await memory.cognition.loadRoleView()).pendingSettings);
  finish(); const result = await pending; assert(result.ok && result.changed); assert.equal(result.pendingSettings, false);
  view = await memory.cognition.loadRoleView(); assert(view.text.includes('外向')); assert(view.text.includes('不同意见'));
  assert.equal(view.understanding.summary, '融合外向与主见，保留原有的诚实原则。'); assert(view.understanding.at > 0);
  worker.extract = async () => { calls++; return { processedThrough: null, memories: [], selfChanges: [], selfSummary: '新设定已经包含在现有理解中，本次无需改动。' }; };
  const unchanged = await worker.updateSelfNow(); assert(unchanged.ok && !unchanged.changed); assert(unchanged.understanding.summary.includes('无需改动'));
  view = await memory.cognition.commitPatch({ requestId: 'lock', baseRevision: unchanged.revision, ops: [{ op: 'lock_all' }] }, { actor: 'owner', trustedUI: true });
  const before = calls; await assert.rejects(worker.updateSelfNow(), error => error.code === 'E_SELF_LOCKED'); assert.equal(calls, before);
  view = await memory.cognition.commitPatch({ requestId: 'unlock', baseRevision: view.revision, ops: [{ op: 'unlock_all' }] }, { actor: 'owner', trustedUI: true });
  worker.extract = async () => { throw Object.assign(new Error('synthetic model failure'), { code: 'E_UPSTREAM' }); };
  await assert.rejects(worker.updateSelfNow(), /synthetic model failure/); assert.equal(worker.status().selfUpdate.status, 'failed');
  assert.equal((await memory.cognition.loadRoleView()).text, view.text, 'failed calls preserve the existing understanding');
  console.log('Immediate self update passed: direct LLM invocation, single flight, fusion, durable completion summary, unchanged result, global lock and failure preservation.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await worker?.close(); await memory.close(); fs.rmSync(root, { recursive: true, force: true }); });
