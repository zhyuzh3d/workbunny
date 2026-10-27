'use strict';
const crypto = require('node:crypto');
const actors = require('./message-identity');
const { containsSecret } = require('./conversation-input');
const { readRecords, snapshotsOf, verifySnapshots } = require('./memory-evidence');
const critical = row => /^(?:error|failed|cancelled|confirmation|result|completed|blocked)$/u.test(row.value.eventType || '') ||
  (!actors.isDialogue(row.value) && /(?:失败|错误|取消|请.{0,8}确认|等待.{0,8}确认|验收|error|failed|cancelled|confirmation)/iu.test(row.value.content));
const key = row => JSON.stringify([row.domain, row.visibilityFloor, actors.character(row.value), row.value.channel || '', row.value.taskId || '', row.value.conversationId || '']);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function groups(rows) {
  const output = [];
  for (const row of rows) {
    if (row.kind !== 'message' || typeof row.value?.content !== 'string' || containsSecret(row.value.content)) continue;
    const last = output.at(-1), previous = last?.at(-1);
    if (last && key(previous) === key(row) && ((!critical(previous) && !critical(row)) || previous.value.content === row.value.content) && row.ts - previous.ts < 15 * 60_000) last.push(row);
    else output.push([row]);
  }
  return output;
}
function excerpt(text, n = 160) { return Array.from(text).slice(0, n).join(''); }
function localBlock(rows) {
  const unique = [...new Map(rows.map(row => [row.value.content, row])).values()];
  const selected = [...new Map([unique[0], ...unique.filter(critical), ...unique.slice(-3)].filter(Boolean).map(r => [r.id, r])).values()].slice(-6);
  const quotes = selected.map(row => ({ sourceId: row.id, characterId: actors.character(row.value), quote: excerpt(row.value.content, 160) }));
  return { content: `原文摘录索引：${rows.length}条消息，${unique.length}种内容；以下未涵盖的细节须回查原文。\n` + quotes.map(q => q.quote).join('\n'), quotes };
}
function validateBlock(result, rows) {
  if (!result || typeof result.content !== 'string' || !result.content.trim() || result.content.length > 1400 || containsSecret(result.content) ||
      !Array.isArray(result.quotes) || !result.quotes.length || result.quotes.length > 6) throw Object.assign(new Error('消息块缺少有效原文证据'), { code: 'E_INVALID_MODEL_OUTPUT' });
  for (const item of result.quotes) {
    const source = rows.find(r => r.id === item.sourceId);
    if (!source || typeof item.quote !== 'string' || item.quote.length < 1 || item.quote.length > 220 || !source.value.content.includes(item.quote) || containsSecret(item.quote))
      throw Object.assign(new Error('消息块引文未通过核验'), { code: 'E_INVALID_MODEL_OUTPUT' });
  }
  return { content: result.content, quotes: result.quotes.map(q => ({ sourceId: q.sourceId, characterId: actors.character(rows.find(r => r.id === q.sourceId).value), quote: q.quote })) };
}
class MessageBlocks {
  constructor({ memory, summarize, clock = Date.now }) { Object.assign(this, { memory, summarize, clock }); }
  async prepare(rows, { signal, allowModel = false, reserveModelCall = async () => ({ ok: true }) } = {}) {
    const generation = this.memory.generation, units = [], blockIds = [];
    for (const group of groups(rows)) {
      if (signal?.aborted || generation !== this.memory.generation) return { status: 'paused', units: [], blockIds: [] };
      if (group.length < 4) { units.push(...group.map(actors.inputRow)); continue; }
      const pieces = [];
      const known = await this.memory.query('state', 64, { scene: null, domain: group[0].domain, visibilityFloor: group[0].visibilityFloor, requiredMarkers: ['bunny_message_block'] });
      const candidateAt = new Map();
      for (const row of known) {
        const ids = row.value.sources || [], start = group.findIndex(r => r.id === ids[0]);
        if (row.value.origin !== 'message-block-v1' || start < 0 || !ids.length || ids.some((id, n) => group[start + n]?.id !== id)) continue;
        if (!candidateAt.has(start) || candidateAt.get(start).value.sources.length < ids.length) candidateAt.set(start, row);
      }
      // Fixed-size immutable prefixes let growing streams reuse old blocks.
      for (let offset = 0; offset < group.length;) {
        const reusable = candidateAt.get(offset);
        const nextStart = [...candidateAt.keys()].filter(n => n > offset).sort((a, b) => a - b)[0] ?? group.length;
        const length = reusable?.value.sources.length || Math.min(32, nextStart - offset);
        const part = group.slice(offset, offset + length), snapshots = snapshotsOf(part), first = part[0];
        const id = 'message-block:v1:' + hash([key(first), snapshots]);
        const existing = reusable || (await readRecords(this.memory, [id]))[0];
        let value;
        if (existing && existing.value.origin === 'message-block-v1' && (await verifySnapshots(this.memory, existing.value.analysisSnapshots)).ok) {
          value = existing.value; blockIds.push(id);
        } else {
          value = localBlock(part);
          let persist = allowModel;
          const exactRepeat = new Set(part.map(r => r.value.content)).size === 1;
          if (allowModel && this.summarize && !exactRepeat && part.reduce((n, r) => n + Buffer.byteLength(r.value.content), 0) <= 16000) {
            const reserved = await reserveModelCall(signal);
            if (reserved === false || reserved?.ok === false) persist = false;
            else try { value = validateBlock(await this.summarize(part.map(actors.inputRow), { signal }), part); }
            catch (error) { if (signal?.aborted) return { status: 'paused', units: [], blockIds: [] }; /* keep literal fallback */ }
          }
          if (persist && !part.some(r => containsSecret(r.value.content))) {
            const stored = { ...value, origin: 'message-block-v1', characterId: actors.character(first.value),
              analysisSnapshots: snapshots, sources: part.map(r => r.id), rawCount: part.length };
            const committed = await this.memory.serial(async () => {
              if (signal?.aborted || generation !== this.memory.generation || !(await verifySnapshots(this.memory, snapshots)).ok) return false;
              await this.memory.write([{ id, kind: 'state', ts: part.at(-1).ts, domain: first.domain, visibilityFloor: first.visibilityFloor, value: stored }], this.memory.epoch, { notify: false });
              return true;
            });
            if (!committed) return { status: 'paused', units: [], blockIds: [] };
            blockIds.push(id);
          }
        }
        pieces.push({ ...value, last: part.at(-1) });
        offset += length;
      }
      const first = group[0], last = group.at(-1);
      units.push({ id: last.id, role: actors.isBunny(first.value) ? 'assistant' : 'user', characterId: actors.character(first.value),
        characterName: first.value.characterName || actors.character(first.value), time: first.ts, endTime: last.ts,
        firstMessageId: first.id, endMessageId: last.id, rawCount: group.length,
        taskId: first.value.taskId || '', conversationId: first.value.conversationId || '',
        content: pieces.map(p => p.content).join('\n'), sourceQuotes: pieces.flatMap(p => p.quotes),
        sourceIds: group.map(r => r.id), block: true });
    }
    return { status: 'done', units, blockIds };
  }
}
module.exports = { MessageBlocks, groups, localBlock, validateBlock, critical };
