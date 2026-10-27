'use strict';

// Explicit opt-in live acceptance: isolated vault, synthetic facts, currently
// verified zero-credit WorkBuddy model only. Never opens the user's real vault.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MemoryService } = require('../src/main/memory-service');
const { createSemanticDream } = require('../src/main/semantic-dream');
const { freeModel, analyzeRelations } = require('../src/main/workbuddy-free');
const { marker } = require('../src/main/knowledge-records');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-knowledge-live-'));
  let scene = 'work', calls = 0;
  const key = crypto.randomBytes(32);
  const memory = new MemoryService({ dir, bin: path.resolve(__dirname, '../bin/vault'), openKey: async () => Buffer.from(key),
    getSettings: () => ({ enabled: true, extract: false, scene }), random: () => 0 });
  try {
    await memory.init(); assert(memory.ready, memory.error);
    const rows = [
      ['coffee-a', '咖啡偏好', '我喜欢不加糖的黑咖啡。'], ['coffee-b', '咖啡偏好', '我喝咖啡不要加糖，喜欢黑咖啡。'],
      ['city-a', '居住城市', '以前我住在北京。'], ['city-b', '居住城市', '现在我搬到上海住了。'],
      ['pet-a', '养猫数量', '我家目前没有养猫。'], ['pet-b', '养猫数量', '我家目前养了两只猫。'],
    ];
    const base = Date.now();
    await memory.write(rows.map(([id, _tag, content], i) => ({ id: id + '-user', kind: 'message', ts: base + i,
      domain: 'work', visibilityFloor: 0, value: { role: 'user', content, sources: [] } })));
    await memory.write(rows.map(([id, tag, content], i) => ({ id, kind: 'memory', ts: base + 10 + i,
      domain: 'work', visibilityFloor: 0, value: { content, memoryKind: 'candidate', status: 'pending',
        origin: 'doze-candidate-v2', evidence: content, evidenceSourceId: id + '-user', sources: [id + '-user'], tags: [tag] } })));
    const model = await freeModel(), started = Date.now();
    const semantic = createSemanticDream({ memory, analyze: async (input, options) => {
      console.log(`live analysis ${++calls}: ${input.length} synthetic records`);
      const result = await analyzeRelations(input, options);
      console.log(JSON.stringify({ members: input.map(row => row.id), proposed: result }));
      return result;
    } });
    const outcome = await semantic.run({ reserveModelCall: async () => ({ ok: calls < 3 }) });
    assert.equal(outcome.status, 'done');
    const relations = await memory.query('state', 30, { scene, requiredMarkers: [marker('relation')] });
    const types = relations.map(row => row.value.relation).sort();
    console.log(JSON.stringify({ outcome, retained: relations.map(row => ({ type: row.value.relation, members: row.value.memberIds })) }));
    assert(types.includes('equivalent'), 'live equivalence not recognized');
    assert(types.includes('update'), 'explicit time update not recognized');
    assert(types.some(type => ['contradiction', 'uncertain'].includes(type)), 'incompatible claims not retained for review');
    await memory.knowledge.sync();
    const page = await memory.list({ kind: 'knowledge', category: 'doubt' });
    assert(page.rows.length > 0);
    scene = 'private'; await memory.changeScene(scene);
    const question = page.rows[0];
    await memory.knowledge.resolve(question.id, { action: 'choose', choiceId: question.memberChoices[0].id, scene });
    const privateRows = await memory.list({ kind: 'knowledge', category: 'doubt' });
    assert.equal(privateRows.rows.find(row => row.id === question.id)?.status, 'resolved');
    scene = 'work'; await memory.changeScene(scene);
    const workRows = await memory.list({ kind: 'knowledge', category: 'doubt' });
    assert.equal(workRows.rows.find(row => row.id === question.id)?.status, 'open');
    const repeated = await semantic.run();
    assert.equal(repeated.analyzed, 0);
    assert.equal(calls, 3);
    console.log(JSON.stringify({ passed: true, syntheticOnly: true, model, calls, types, ms: Date.now() - started,
      privateReviewDoesNotChangeWork: true, repeatedAnalysisCalls: repeated.analyzed }));
  } finally { await memory.close(); key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
