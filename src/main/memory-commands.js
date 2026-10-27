'use strict';
const crypto = require('node:crypto');
const { containsSecret } = require('./conversation-input');
const { readRecords, snapshotsOf } = require('./memory-evidence');
const { tagged } = require('./memory-tags');
const scopes = require('./memory-scope');
function explicitRequest(text) {
  if (typeof text !== 'string' || containsSecret(text) || /(?:别|不要|不用|无需|不必).{0,12}(?:记住|记下|记录|保存|整理)|\b(?:do not|don't|never)\s+(?:remember|save|record)/iu.test(text) ||
      /(?:如果|假如|假设|例如|比如).{0,24}(?:记住|记下|记录|保存|整理)/u.test(text) || /[“「『"].*(?:记住|记下|保存).*[”」』"]/u.test(text)) return false;
  return /记住|记一下|记着|记下来|记下|存下来|保存.{0,12}(?:记忆|经验|方法)|整理.{0,16}(?:经验|方法)|总结.{0,16}(?:经验|方法)|\b(?:remember|save (?:this|that)|record (?:this|that))\b/iu.test(text);
}
function validateMemoryIntent(value) {
  if (!value || !['remember', 'learn_experience'].includes(value.action) || Object.keys(value).some(k => !['action', 'content', 'quotes'].includes(k)) ||
      typeof value.content !== 'string' || !value.content.trim() || value.content.length > 1200 || containsSecret(value.content) ||
      !Array.isArray(value.quotes) || value.quotes.length < 1 || value.quotes.length > 4 ||
      value.quotes.some(q => typeof q !== 'string' || q.length < 3 || q.length > 500 || containsSecret(q))) throw new Error('记忆请求缺少有效内容和原文依据');
  return Object.freeze({ action: value.action, content: value.content.trim(), quotes: [...new Set(value.quotes)] });
}
async function rememberRequest(memory, intent, { userRecord, scene = memory.scene(), signal, isCurrent = () => true } = {}) {
  intent = validateMemoryIntent(intent);
  const generation = memory.generation, sceneEpoch = memory.sceneEpoch;
  return memory.serial(async () => {
    const current = () => !signal?.aborted && isCurrent() && generation === memory.generation && sceneEpoch === memory.sceneEpoch && scene === memory.scene();
    if (!current() || !memory.getSettings().enabled || !userRecord?.id) throw new Error('本轮记忆请求已失效');
    const request = (await readRecords(memory, [userRecord.id], { scene }))[0];
    if (!request || request.kind !== 'message' || request.value.role !== 'user' || !explicitRequest(request.value.content))
      return { ok: false, text: '如果希望我长期保存，请明确告诉我要记住什么。' };
    const recent = await memory.query('message', 80, { scene, sort: 'ingestion' });
    const sources = [request];
    for (const quote of intent.quotes) {
      const matches = recent.filter(r => (intent.action === 'learn_experience' || r.value.role === 'user') && r.value.content.includes(quote));
      // Repeated identical quotes are safe only within the same partition and text.
      if (!matches.length || new Set(matches.map(r => `${r.domain}:${r.visibilityFloor}:${r.value.content}`)).size > 1)
        return { ok: false, text: '这段内容的来源还不够明确，请告诉我具体要记住哪一条。' };
      sources.push(matches[0]);
    }
    const unique = [...new Map(sources.map(r => [r.id, r])).values()];
    const scope = scopes.withSources(scene, unique, scopes.rank(scene));
    const rid = 'explicit-memory:v1:' + crypto.createHash('sha256').update(JSON.stringify([request.id, intent.action, intent.content, intent.quotes])).digest('hex');
    if ((await readRecords(memory, [rid], { scene })).length) return { ok: true, duplicate: true, text: '这条已经记下了。', id: rid };
    const same = (await memory.search(intent.content, ['memory'], 20, scope)).find(r => r.value.content === intent.content && r.value.sources.includes(request.id));
    if (same && intent.action === 'remember') return { ok: true, duplicate: true, text: '已经记住了。', id: same.id };
    const evidence = unique.find(r => r.value.role === 'user' && intent.quotes.some(q => r.value.content.includes(q))) || request;
    const quote = intent.quotes.find(q => evidence.value.content.includes(q)) || request.value.content.slice(0, 500);
    const experience = intent.action === 'learn_experience';
    const value = tagged({ content: intent.content, origin: experience ? 'user-experience-v1' : 'user-statement',
      status: experience ? 'unverified' : 'confirmed', memoryKind: 'fact', importance: 1,
      outcome: experience ? 'user-taught-unverified' : undefined,
      evidence: quote, evidenceSourceId: evidence.id, sources: unique.map(r => r.id),
      analysisSnapshots: snapshotsOf(unique) }, ['active']);
    // JSON bodies have no undefined properties (fingerprints intentionally reject them).
    if (!experience) delete value.outcome;
    if (!current()) throw new Error('场景或轮次已变化，本次没有保存');
    await memory.write([{ id: rid, kind: experience ? 'state' : 'memory', ts: memory.clock(), ...scope, value }]);
    return { ok: true, id: rid, text: experience ? '已经记为你教给我的经验，实际使用时我会核对适用条件。' : '已经记住了。' };
  });
}
module.exports = { explicitRequest, validateMemoryIntent, rememberRequest };
