'use strict';

// Bounded synthetic load check against the real encrypted MemoryService and
// native SQLite process. No model calls, network, or user data are involved.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { MemoryService } = require('../src/main/memory-service');
const { ORIGINS, marker } = require('../src/main/knowledge-records');

const bin = path.resolve(__dirname, '../bin/vault');
const scenes = ['work', 'life', 'private'];
const floors = { work: 0, life: 1, private: 2 };
const sceneMarks = {
  work: 'SCALE_WORK_ONLY_CONTEXT_MARK_Q8F1',
  life: 'SCALE_LIFE_ONLY_CONTEXT_MARK_M4P2',
  private: 'SCALE_PRIVATE_ONLY_CONTEXT_MARK_R6D3',
};
const oldMarkers = {
  work: 'SCALE_RARE_OLD_WORK_NEEDLE_Q8F1',
  life: 'SCALE_RARE_OLD_LIFE_NEEDLE_M4P2',
  private: 'SCALE_RARE_OLD_PRIVATE_NEEDLE_R6D3',
};
const shared = 'fixturehot';
const samples = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => Number(sorted[Math.ceil(p * sorted.length) - 1].toFixed(2));
  return { samples: values.length, p50Ms: percentile(.5), p95Ms: percentile(.95) };
};

async function writeBatches(memory, records, size = 200) {
  for (let at = 0; at < records.length; at += size) await memory.write(records.slice(at, at + size), memory.epoch, { notify: false });
}

async function main() {
  if (!fs.existsSync(bin)) throw new Error('先运行 tools/build-vault.sh 生成隔离测试所用的 bin/vault');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-knowledge-scale-'));
  const dir = path.join(temp, 'vault');
  const key = crypto.randomBytes(32);
  const settings = { enabled: true, extract: false, recentRounds: 8, scene: 'work' };
  const memory = new MemoryService({ dir, bin, getSettings: () => settings,
    openKey: async () => Buffer.from(key), clock: () => Date.now(), random: () => 0 });
  const counts = { memory: 0, knowledge: 0 };
  const insertTimes = [];
  const queryTimes = [], contextTimes = [];
  try {
    await memory.init();
    assert.equal(memory.ready, true, `isolated vault init failed: ${memory.error}`);
    const started = performance.now();
    const memoriesPerScene = [1667, 1667, 1666];
    const knowledgePerScene = [500, 500, 500];
    let ordinal = 1;
    const expectedRare = {};
    const expectedRelation = {};

    for (let si = 0; si < scenes.length; si++) {
      const scene = scenes[si], floor = floors[scene];
      const memories = [];
      for (let i = 0; i < memoriesPerScene[si]; i++) {
        const id = `scale-${scene}-memory-${String(i).padStart(5, '0')}`;
        const isRare = i === 0;
        const content = `${shared} synthetic ${scene} long-term fact ${String(i).padStart(5, '0')} ` +
          (isRare ? oldMarkers[scene] : i === memoriesPerScene[si] - 1 ? sceneMarks[scene] : 'fictional preference, retained for scale measurement');
        memories.push({ id, kind: 'memory', ts: 1_600_000_000_000 + ordinal++, domain: scene,
          visibilityFloor: floor, state: 'active', value: { origin: 'user-reviewed', status: 'confirmed', memoryKind: 'fact', importance: isRare ? 1 : 0.5,
            content, evidence: `Synthetic evidence for ${scene} fixture record ${i}.`, sources: [], tags: [shared] } });
        if (isRare) expectedRare[scene] = id;
      }
      const knowledge = [];
      const typeNames = ['relation', 'doubt', 'experience', 'tool'];
      for (let i = 0; i < knowledgePerScene[si]; i++) {
        const type = typeNames[i % typeNames.length];
        const id = `scale-${scene}-knowledge-${String(i).padStart(4, '0')}`;
        const ts = 1_500_000_000_000 + ordinal++;
        if (type === 'relation') expectedRelation[scene] = id;
        knowledge.push({ id, kind: 'state', ts, domain: scene, visibilityFloor: floor, state: 'active',
          value: { origin: ORIGINS[type], status: 'active', relation: 'contextual', content: `${shared} synthetic ${type} note ${i}`,
            sources: [], tags: [shared] } });
      }

      for (const [type, batch] of [['memory', memories], ['knowledge', knowledge]]) {
        const batchStart = performance.now();
        await writeBatches(memory, batch);
        insertTimes.push({ scene, type, ms: performance.now() - batchStart, count: batch.length });
        counts[type] += batch.length;
      }
    }
    const insertTotalMs = Number((performance.now() - started).toFixed(2));
    assert.deepEqual(counts, { memory: 5000, knowledge: 1500 });

    // One distinct old marker in each floor must stay reachable at scale.
    for (const scene of scenes) {
      for (const other of scenes) {
        const visible = floors[other] <= floors[scene];
        const rows = await memory.search(oldMarkers[other], ['memory'], 10, { scene });
        assert.equal(rows.some(row => row.id === expectedRare[other]), visible,
          `scope mismatch ${scene} querying ${other}`);
      }
    }

    // Markers must be applied inside SQLite before ranking and LIMIT: ordinary
    // memories share the query term, but cannot crowd required knowledge types.
    const required = await memory.search(shared, ['memory', 'state'], 1,
      { scene: 'work', requiredMarkers: [marker('relation')] });
    assert.equal(required[0]?.id, expectedRelation.work, 'required marker must filter before top-1 LIMIT');
    const excluded = await memory.search(shared, ['memory', 'state'], 1,
      { scene: 'work', requiredMarkers: [marker('all')], excludedMarkers: [marker('relation')] });
    assert.equal(excluded[0]?.kind, 'state', 'excluded relation markers must filter before top-1 LIMIT');
    assert.notEqual(excluded[0]?.id, expectedRelation.work);

    for (const scene of scenes) {
      settings.scene = scene;
      await memory.changeScene(scene);
      for (let i = 0; i < 3; i++) {
        let t = performance.now();
        const hits = await memory.search(shared, ['memory', 'state'], 30, { scene });
        queryTimes.push(performance.now() - t);
        assert(hits.length > 0);
        t = performance.now();
        const context = await memory.context(shared, { scene, budget: 8500 });
        contextTimes.push(performance.now() - t);
        const contextText = `${context.text}\n${context.messages.map(m => m.content).join('\n')}`;
        const contextChars = context.text.length + context.messages.reduce((sum, row) => sum + JSON.stringify(row).length, 0);
        assert(contextChars <= 8500 && context.used <= 8500, `context budget overflow in ${scene}: ${contextChars}`);
        assert(contextText.includes(sceneMarks[scene]), `context omitted this scene's synthetic marker in ${scene}`);
        for (const other of scenes) if (floors[other] > floors[scene]) assert.equal(contextText.includes(sceneMarks[other]), false,
          `context exposed ${other} into ${scene}`);
      }
    }

    const report = {
      fixture: 'synthetic-only; real MemoryService + native SQLite; isolated temp directory',
      records: { memory: counts.memory, knowledge: counts.knowledge, total: counts.memory + counts.knowledge },
      insert: { batches: insertTimes.length, totalMs: insertTotalMs,
        perScopeKindMs: insertTimes.map(item => ({ scene: item.scene, kind: item.type, count: item.count, ms: Number(item.ms.toFixed(2)) })) },
      search: samples(queryTimes),
      context: samples(contextTimes),
      contextBudgetChars: 8500,
      requiredExcludedMarkersBeforeLimit: 'passed',
      oldRareRecordPerScene: 'passed',
      limits: 'Synthetic scale and local latency only; not a real-world recall or long-term reliability claim.',
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await memory.close().catch(() => {});
    key.fill(0);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
