'use strict';
// Real Keychain wrapping + SQLite + free WorkBuddy model. Synthetic persona/data only.
// Run: node_modules/.bin/electron tools/test-memory-live.cjs
const { app, safeStorage } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { MemoryService } = require('../src/main/memory-service');
const config = require('../src/main/config');
const wb = require('../src/main/workbuddy');
const { freeModel } = require('../src/main/workbuddy-free');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-live-'));
app.setPath('userData', path.join(root, 'electron'));
let memory, now = Date.UTC(2020, 2, 4, 8), model;
const results = [];
function createMemory() { return new MemoryService({ dir: path.join(root, 'vault'), bin: path.resolve(__dirname, '../bin/vault'), safeStorage, getSettings: () => ({ enabled: true, extract: false }), clock: () => now++, random: () => 0 }); }
async function ask(question, expected, excluded = []) {
  const start = Date.now(), context = await memory.context(question);
  const r = await wb.chat({ model, thinking: 'low', maxTokens: 4096, messages: [
    { role: 'system', content: config.buildSystemPrompt(context.text) }, ...context.messages, { role: 'user', content: question },
  ] });
  if (expected) assert.ok(r.text.includes(expected), `missing expected memory: ${r.text}`);
  for (const word of excluded) assert.ok(!r.text.includes(word), `forgotten fact leaked: ${r.text}`);
  results.push({ question, answer: r.text, recalled: context.recalled, contextChars: context.used, ms: Date.now() - start });
  await memory.addMessage('assistant', r.text, { delivery: 'generated', sources: context.sourceIds || [] });
}
async function run() {
  await app.whenReady(); model = await freeModel();
  config.setPath(path.join(root, 'config.json'));
  config.save({ buddy: { name: 'bunny', ownerName: '朋友' } });
  memory = await createMemory().init(); assert.ok(memory.db, memory.error);
  await memory.addMessage('user', '请记住：我养的小猫名字叫芋圆。');
  now = Date.UTC(2026, 9, 25, 8);
  await memory.write(Array.from({ length: 80 }, (_, i) => ({ id: 'synthetic-' + i, kind: 'message', ts: now++, value: { role: i % 2 ? 'assistant' : 'user', content: '今天整理桌面上的公共测试资料，编号' + i, sources: [] } })));
  await memory.close(); memory = await createMemory().init();
  assert.equal(memory.recent.length, 40);
  assert.ok(memory.recent.every(r => !r.value.content.includes('芋圆')));
  await ask('你还记得我养的小猫叫什么吗？', '芋圆');
  const fact = (await memory.list({ kind: 'memory', query: '小猫' }))[0];
  await memory.updateMemory(fact.id, '我养的小猫现在改名叫棉花。');
  await ask('我养的小猫现在叫什么？', '棉花', ['芋圆']);
  const corrected = (await memory.list({ kind: 'memory', query: '棉花' }))[0];
  await memory.remove(corrected.id);
  await ask('你记得我养的小猫名字吗？不记得就直说。', null, ['棉花', '芋圆']);
  const file = path.join(os.tmpdir(), 'workbunny-030-memory-live-result.json');
  fs.writeFileSync(file, JSON.stringify({ model, synthetic: true, keychainAvailable: safeStorage.isEncryptionAvailable(), cases: results }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, model, cases: results.length, file }));
}
async function finish(code) { await memory?.close(); fs.rmSync(root, { recursive: true, force: true }); app.exit(code); }
run().then(() => finish(0), error => { console.error(error.stack || error); finish(1); });
