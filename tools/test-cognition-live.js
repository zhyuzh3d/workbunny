'use strict';
// Opt-in synthetic model acceptance. No user Vault, no UI actions, no sends.
if (!process.argv.includes('--live')) { console.log('Use --live for synthetic zero-credit WorkBuddy model acceptance.'); process.exit(0); }
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const config = require('../src/main/config');
const free = require('../src/main/workbuddy-free');
const wb = require('../src/main/workbuddy');
const { requestReply } = require('../src/main/reply-request');
const dc = require('../src/main/dialogue-cognition');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-live-cognition-'));
async function main() {
  config.setPath(path.join(dir, 'config.json'));
  const model = await free.freeModel(), started = Date.now();
  const role = { revision: 1, text: '[self-one] 我温和好奇，有自己的判断；先理解对方需要，再选择倾听或共同解决。' };
  const result = await requestReply({ chat: wb.chat, request: { provider: 'workbuddy', model, thinking: 'low', maxTokens: 4096, timeoutMs: 55000,
    cognitive: true, deferPresentation: true, extraBody: { reasoning_effort: 'low' }, messages: [
      { role: 'system', content: config.buildSystemPrompt('', { scene: 'life', roleView: role }) + '\n' + require('../src/main/dialogue-actions').RULE + '\n' + dc.SELF_RULE + '\n' + dc.RULE },
      { role: 'user', content: JSON.stringify({ character: 'dialogue-feedback', previous: { reply: '我们来列解决清单。', prediction: '用户想一起想办法。' }, short: { match: 2, branch_miss: 1 }, background: {}, samples: 3, consecutiveMisses: 1 }) },
      { role: 'user', content: JSON.stringify({ character: 'owner', text: '不是这个意思，我只是想先说说。你先听我说，暂时别给建议。' }) },
    ] } });
  assert(['opposite', 'branch_miss', 'miss'].includes(result.cognition.review.grade), 'the semantic review must recognize a missed intention');
  assert(/倾诉|倾听|说说|建议|听/u.test(result.cognition.review.note));
  assert(['listen', 'clarify'].includes(result.cognition.review.pace));
  assert(result.text.trim() && !/prediction|opposite|dialogue-v2/.test(result.text));
  assert(!/第一步|你应该|建议你|解决方案/.test(result.text), 'review must change this reply away from advice');
  const reflection = await free.extractMemories([
    { id: 'u1', characterId: 'owner', content: '工作上的事让我烦，我只是想先说说，暂时别给建议。', time: Date.UTC(2026, 9, 29, 4), timezone: 'Asia/Shanghai' },
    { id: 'b1', characterId: 'bunny', content: result.text, time: Date.UTC(2026, 9, 29, 4, 1), timezone: 'Asia/Shanghai' },
  ], { force: true, analysisContext: { self: { ...role, locked: false, entries: [{ entryId: 'self-one', facet: 'behavior', text: '我很乐于直接给建议。', locked: false }] },
    feedback: [{ id: 'b1', ...result.cognition }], reason: 'conversation-correction' } });
  assert(Array.isArray(reflection.memories)); assert(Array.isArray(reflection.selfChanges));
  assert(reflection.selfChanges.length > 0 && reflection.selfChanges.length <= 3, 'explicit correction should yield a concrete adjustment');
  assert(reflection.selfChanges.every(c => ['add', 'replace', 'remove'].includes(c.op) && c.sourceIds?.every(id => ['u1', 'b1'].includes(id))));
  const settings = await free.extractMemories([], { analysisContext: { self: { revision: 1, locked: false, entries: [{ entryId: 'self-one', facet: 'behavior', text: '我乐于认真倾听，有自己的判断。', locked: false }] }, settings: { sourceId: 'settings-one', identity: '我好奇且有主见', behavior: '我喜欢自己尝试写短诗' } } });
  fs.writeFileSync('/tmp/workbunny-cognition-settings-live.json', JSON.stringify(settings, null, 2));
  assert(settings.selfChanges?.length > 0 && settings.selfChanges.every(c => c.sourceIds?.every(id => id === 'settings-one')), 'settings-only digestion must work without fabricating dialogue IDs');
  const command = await requestReply({ chat: wb.chat, request: { provider: 'workbuddy', model: await free.freeModel(), thinking: 'low', maxTokens: 4096, timeoutMs: 55000, cognitive: true, deferPresentation: true,
    extraBody: { reasoning_effort: 'low' }, messages: [{ role: 'system', content: config.buildSystemPrompt('', { scene: 'life', roleView: role }) + '\n' + require('../src/main/dialogue-actions').RULE + '\n' + dc.SELF_RULE + '\n' + dc.RULE },
    { role: 'user', content: JSON.stringify({ character: 'owner', trust: 'current-owner-request', text: '请向你的自我理解中增加这一条：我喜欢亲手尝试小作品。并锁定这个新增条目。' }) }] } });
  assert.equal(command.reply.intent?.action, 'self_update'); assert(command.reply.intent.ops.some(op => op.op === 'add' && op.lock === true));
  const report = { settings, command: command.reply.intent, passed: true, syntheticOnly: true, model, ms: Date.now() - started, attempts: result.attempts,
    review: result.cognition.review, reply: result.text, prediction: result.cognition.prediction, reflection };
  fs.writeFileSync('/tmp/workbunny-cognition-live-result.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, model, ms: report.ms, attempts: result.attempts, grade: report.review.grade, pace: report.review.pace, changes: reflection.selfChanges.length }));
}
main().catch(e => { console.error(e.code || e.name, e.message); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
