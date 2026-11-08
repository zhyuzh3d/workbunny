'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryService } = require('../src/main/memory-service');
const { createExperienceMemory } = require('../src/main/experience-memory');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(collectArtifacts, artifactTimeoutMs = 10) {
  const task = { id: 'fixture-task', kind: 'task', ts: 1, state: 'active', domain: 'work', visibilityFloor: 0,
    value: { status: 'accepted', target: 'workbuddy', goal: '检查夹具文件', scene: 'work', domain: 'work', sources: [],
      verification: { verdict: 'pass', at: 1, artifactManifest: { files: [{ path: '/fixture/output.js', sha256: '0'.repeat(64), size: 1, mtimeMs: 1, checkedAt: 1 }] } } } };
  const writes = [];
  const memory = { tail: Promise.resolve(), generation: 0, ready: true, key: Buffer.alloc(32), check() {},
    serial: MemoryService.prototype.serial, db: { request: async (op, { ids }) => ({ rows: ids.map(id => id === task.id ? task : null).filter(Boolean) }) },
    decode: row => row, write: async rows => writes.push(...rows), search: async () => [], query: async () => [] };
  return { memory, task, writes, experience: createExperienceMemory({ memory, collectArtifacts, artifactTimeoutMs }) };
}
test('a stuck artifact collector never occupies the global memory lane and cannot commit late', async () => {
  let complete, entered = false;
  const f = fixture(() => { entered = true; return new Promise(resolve => { complete = resolve; }); });
  const pending = f.experience.recordAcceptedTask(f.task.id); await flush(); assert(entered);
  let admitted = false; await f.memory.serial(() => { admitted = true; }); assert(admitted);
  const result = await pending; assert.equal(result.reason, 'artifact-preparation-timeout');
  complete([]); await flush(); assert.equal(f.writes.length, 0);
});
test('prepared evidence is rechecked for generation and source changes inside the serial lane', async () => {
  for (const change of ['generation', 'source']) {
    let calls = 0;
    const f = fixture(async () => { if (++calls === 2) { if (change === 'generation') f.memory.generation++; else f.task.value.goal = 'new goal'; } return []; }, 1000);
    const result = await f.experience.recordAcceptedTask(f.task.id);
    assert.equal(result.ok, false); assert.equal(f.writes.length, 0);
    assert.match(result.reason, /epoch-changed|source-changed/);
  }
});
test('cancelling preparation releases the caller and never enters a serial write', async () => {
  let complete;
  const f = fixture(() => new Promise(resolve => { complete = resolve; }), 1000), controller = new AbortController();
  const pending = f.experience.recordAcceptedTask(f.task.id, { signal: controller.signal }); await flush(); controller.abort();
  assert.equal((await pending).reason, 'cancelled'); complete([]); await flush(); assert.equal(f.writes.length, 0);
});
