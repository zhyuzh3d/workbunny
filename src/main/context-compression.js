'use strict';

const crypto = require('node:crypto');
const { SCENES, rank } = require('./memory-scope');

const MAX_RECENT_ROUNDS = 24;
const HARD_MAX_MESSAGES = 40;
const HARD_MAX_CHARS = 28_000;
const MAX_SEGMENTS = 4;
const MAX_EXCERPTS = 8;
const MIN_EXCERPT_CHARS = 3;
const MAX_EXCERPT_CHARS = 220;
const HEAD_TEXT_BUDGET = 1_800;
const MAX_SOURCE_IDS = 200;
const HEAD_PREFIX = 'context-head:v1:';
const SEGMENT_PREFIX = 'context-segment:v1:';
const { containsSecret } = require('./conversation-input');
const SECRET = { test: containsSecret };

function digest(value, length = 48) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function compareSeq(a, b) {
  return Number(a.ingestionSeq) - Number(b.ingestionSeq);
}

function normalizeRecord(row) {
  if (!row || typeof row.id !== 'string' || !Number.isSafeInteger(row.ingestionSeq) || row.ingestionSeq <= 0 ||
      row.kind !== 'message' || !row.value || !['user', 'assistant'].includes(row.value.role) || typeof row.value.content !== 'string') return null;
  return row;
}

function isReviewed(row) { return row.value?.source === 'user-reviewed'; }
function isReceipt(row) { return row.value?.delivery === 'task-receipt'; }

// User messages establish boundaries. Assistants attach only to the immediately
// preceding user round, and explicit mismatched turn IDs are treated as orphaned.
function groupTurns(rows) {
  const groups = [];
  let current = null;
  for (const row of [...rows].sort(compareSeq)) {
    if (!normalizeRecord(row)) continue;
    if (isReviewed(row)) { current = null; continue; }
    if (row.value.role === 'user') {
      current = { turnId: row.value.turnId || null, rows: [row] };
      groups.push(current);
      continue;
    }
    if (isReceipt(row)) continue;
    if (!current) continue;
    const assistantTurnId = row.value.turnId || null;
    if (assistantTurnId && current.turnId && assistantTurnId !== current.turnId) continue;
    current.rows.push(row);
  }
  return groups;
}

function sourceDigest(rows) {
  return digest(JSON.stringify([...rows].sort(compareSeq).map(row => [
    row.id, row.ingestionSeq, row.ts, row.domain, row.visibilityFloor,
    row.value.role, row.value.turnId || '', row.value.content,
  ])), 64);
}

function headId(scene) { return HEAD_PREFIX + scene; }

class ContextCompression {
  constructor({ memory, summarize, clock = Date.now, recentRounds = 8, maxMessages = HARD_MAX_MESSAGES, maxChars = HARD_MAX_CHARS } = {}) {
    if (!memory || typeof memory.query !== 'function' || typeof memory.write !== 'function' || typeof memory.serial !== 'function')
      throw new TypeError('ContextCompression requires MemoryService query/write/serial');
    if (typeof summarize !== 'function') throw new TypeError('ContextCompression requires a bounded summarize function');
    this.memory = memory;
    this.summarize = summarize;
    this.clock = clock;
    this.recentRounds = Math.max(1, Math.min(MAX_RECENT_ROUNDS, Number.isSafeInteger(recentRounds) ? recentRounds : 8));
    this.maxMessages = Math.max(1, Math.min(HARD_MAX_MESSAGES, Number.isSafeInteger(maxMessages) ? maxMessages : HARD_MAX_MESSAGES));
    this.maxChars = Math.max(1, Math.min(HARD_MAX_CHARS, Number.isSafeInteger(maxChars) ? maxChars : HARD_MAX_CHARS));
    this.running = null;
  }

  async getDecoded(ids, scene) {
    const unique = [...new Set(ids)];
    const rows = [];
    for (let offset = 0; offset < unique.length; offset += MAX_SOURCE_IDS) {
      const result = await this.memory.db.request('get', { ids: unique.slice(offset, offset + MAX_SOURCE_IDS), scene });
      rows.push(...(result?.rows || []));
    }
    const decoded = [];
    for (const row of rows) {
      try { decoded.push(this.memory.decode(row)); }
      catch { return null; }
    }
    return decoded;
  }

  isValidHead(head, scene) {
    const value = head?.value;
    const segmentMeta = Array.isArray(value?.segments) ? value.segments : [];
    const segmentIds = segmentMeta.map(item => item?.id);
    const sourceIds = Array.isArray(value?.sources) ? value.sources : [];
    const batchIds = Array.isArray(value?.batchSourceIds) ? value.batchSourceIds : [];
    return !!head && head.kind === 'state' && head.state === 'active' && head.id === headId(scene) && head.domain === scene && head.visibilityFloor === rank(scene) &&
      value?.origin === 'context-head-v1' && value.scene === scene && Number.isSafeInteger(value.version) && value.version >= 1 &&
      value.watermark && Number.isSafeInteger(value.watermark.ingestionSeq) && Array.isArray(value.segments) &&
      value.segments.length >= 1 && value.segments.length <= MAX_SEGMENTS && typeof value.text === 'string' && value.text.length <= HEAD_TEXT_BUDGET &&
      sourceIds.length <= this.maxMessages + MAX_SEGMENTS && new Set(sourceIds).size === sourceIds.length &&
      batchIds.length > 0 && batchIds.length <= this.maxMessages && new Set(batchIds).size === batchIds.length &&
      segmentMeta.every(item => item && typeof item.id === 'string' && typeof item.sourceHash === 'string' && item.range &&
        Number.isSafeInteger(item.range.firstSeq) && Number.isSafeInteger(item.range.lastSeq)) &&
      new Set(segmentIds).size === segmentIds.length &&
      (segmentMeta.length === 0 || segmentMeta.at(-1).range.lastSeq === value.watermark.ingestionSeq) &&
      typeof value.batchSourceHash === 'string' && Number.isSafeInteger(value.skippedSecretRounds) && value.skippedSecretRounds >= 0;
  }

  async inspectHead(scene) {
    const raw = await this.memory.db.request('get', { ids: [headId(scene)], scene });
    if (!raw?.rows?.length) {
      // A fixed lane ID that exists under another visibility floor is a
      // collision/corruption, not a missing checkpoint to rebuild over.
      const anyScope = await this.memory.db.request('get', { ids: [headId(scene)] });
      return anyScope?.rows?.length ? { head: null, invalid: true } : { head: null, invalid: false };
    }
    let head;
    try { head = this.memory.decode(raw.rows[0]); } catch { return { head: null, invalid: true }; }
    return this.isValidHead(head, scene) ? { head, invalid: false } : { head: null, invalid: true };
  }

  async snapshot(scene) {
    rank(scene);
    if (!this.memory.db?.request || typeof this.memory.decode !== 'function') return this.emptySnapshot();
    const { head, invalid } = await this.inspectHead(scene);
    if (!head || invalid || containsSecret(head.value.text)) return this.emptySnapshot();
    return {
      text: head.value.text,
      sourceIds: [...new Set([head.id, ...head.value.sources])],
      version: head.value.version,
      coveredThrough: { ...head.value.watermark },
      recordId: head.id,
      updatedAt: head.updatedAt,
      scene,
    };
  }

  emptySnapshot() { return { text: '', sourceIds: [], version: 0, coveredThrough: null, recordId: null, updatedAt: null }; }

  async recentCutoff(scene, signal) {
    let beforeSeq;
    let userCount = 0;
    const pageSize = this.maxMessages;
    while (!signal?.aborted) {
      const page = await this.memory.query('message', pageSize, {
        scene, sort: 'ingestion', order: 'desc', ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      if (!page.length) return null;
      for (const row of page) {
        if (!Number.isSafeInteger(row.ingestionSeq) || row.ingestionSeq <= 0) throw new Error('上下文压缩遇到缺少稳定序号的消息');
        if (row.value?.role === 'user' && !isReviewed(row)) {
          userCount++;
          if (userCount === this.recentRounds) return row.ingestionSeq;
        }
      }
      const last = page.at(-1);
      if (page.length < pageSize) return null;
      beforeSeq = last.ingestionSeq;
    }
    return null;
  }

  toInputRow(row) {
    const accepted = normalizeRecord(row);
    if (!accepted || isReviewed(row) || isReceipt(row)) return null;
    return {
      id: row.id,
      role: row.value.role,
      content: row.value.content,
      time: row.ts,
      ...(row.value.turnId ? { turnId: row.value.turnId } : {}),
    };
  }

  async readNextBatch(scene, afterSeq, beforeSeq, signal) {
    let scanAfter = afterSeq;
    let current = null;
    const chosen = [];
    let chars = 0, turns = 0, skippedSecretRounds = 0;
    const closeRound = () => {
      if (!current) return { done: false };
      if (current.hasSecret) {
        current = null;
        skippedSecretRounds++;
        return { secretSkipped: true };
      }
      const input = current.rows.filter(row => this.toInputRow(row));
      current = null;
      if (!input.length) return { done: false };
      const groupChars = input.reduce((sum, row) => sum + row.value.content.length, 0);
      if (input.length > this.maxMessages || groupChars > this.maxChars || input.some(row => row.value.content.length > this.maxChars))
        return chosen.length ? { batchFull: true } : { oversized: true };
      if (chosen.length + input.length > this.maxMessages || chars + groupChars > this.maxChars)
        return { batchFull: true };
      chosen.push(...input);
      chars += groupChars;
      turns++;
      return { done: false };
    };

    for (;;) {
      if (signal?.aborted) return { rows: [], turns: 0, chars: 0, oversized: false, aborted: true, skippedSecretRounds };
      const page = await this.memory.query('message', this.maxMessages + 1, {
        scene, sort: 'ingestion', order: 'asc', afterSeq: scanAfter, beforeSeq,
      });
      if (!page.length) {
        const closed = closeRound();
        if (closed.oversized) return { rows: [], turns: 0, chars: 0, oversized: true, skippedSecretRounds };
        return { rows: chosen, turns, chars, oversized: false, lastSeq: chosen.at(-1)?.ingestionSeq, skippedSecretRounds };
      }
      const previousScanAfter = scanAfter;
      scanAfter = page.at(-1).ingestionSeq;
      if (!Number.isSafeInteger(scanAfter) || scanAfter <= previousScanAfter) throw new Error('上下文压缩遇到无效摄入序号');
      for (const row of page) {
        if (signal?.aborted) return { rows: [], turns: 0, chars: 0, oversized: false, aborted: true, skippedSecretRounds };
        if (!normalizeRecord(row)) continue;
        if (isReviewed(row)) {
          const closed = closeRound();
          if (closed.oversized) return chosen.length ? this.finishBatch(chosen, turns, chars, skippedSecretRounds) : { rows: [], turns: 0, chars: 0, oversized: true, skippedSecretRounds };
          if (closed.batchFull) return this.finishBatch(chosen, turns, chars, skippedSecretRounds);
          continue;
        }
        if (row.value.role === 'user') {
          const closed = closeRound();
          if (closed.oversized) return chosen.length ? this.finishBatch(chosen, turns, chars, skippedSecretRounds) : { rows: [], turns: 0, chars: 0, oversized: true, skippedSecretRounds };
          if (closed.batchFull) return this.finishBatch(chosen, turns, chars, skippedSecretRounds);
          current = { turnId: row.value.turnId || null, rows: [row], hasSecret: SECRET.test(row.value.content) };
          const firstInput = this.toInputRow(row);
          if (!current.hasSecret && firstInput && firstInput.content.length > this.maxChars) return { rows: [], turns: 0, chars: 0, oversized: true, skippedSecretRounds };
          continue;
        }
        if (isReceipt(row) || !current) continue;
        const assistantTurnId = row.value.turnId || null;
        if (assistantTurnId && current.turnId && assistantTurnId !== current.turnId) continue;
        if (SECRET.test(row.value.content)) {
          current.hasSecret = true;
          continue;
        }
        const asInput = this.toInputRow(row);
        if (asInput && !current.hasSecret && (current.rows.filter(item => this.toInputRow(item)).length >= this.maxMessages ||
            current.rows.reduce((sum, item) => sum + (this.toInputRow(item)?.content.length || 0), 0) + asInput.content.length > this.maxChars))
          return chosen.length ? this.finishBatch(chosen, turns, chars, skippedSecretRounds) : { rows: [], turns: 0, chars: 0, oversized: true, skippedSecretRounds };
        if (!current.hasSecret) current.rows.push(row);
      }
      if (page.length < this.maxMessages + 1) {
        const closed = closeRound(); // The scene-specific cutoff closes the last older round.
        if (closed.oversized) return chosen.length ? this.finishBatch(chosen, turns, chars, skippedSecretRounds) : { rows: [], turns: 0, chars: 0, oversized: true, skippedSecretRounds };
        if (closed.batchFull) return this.finishBatch(chosen, turns, chars, skippedSecretRounds);
        return { rows: chosen, turns, chars, oversized: false, lastSeq: chosen.at(-1)?.ingestionSeq, skippedSecretRounds };
      }
      // A full page may end mid-round. Continue reading only that lane until
      // its boundary is known; current holds at most maxMessages rows.
    }
  }

  finishBatch(rows, turns, chars, skippedSecretRounds = 0) {
    return { rows, turns, chars, oversized: false, lastSeq: rows.at(-1)?.ingestionSeq, skippedSecretRounds };
  }

  validateSummary(result, inputRows) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.content !== 'string' || result.content.length > 1200 || SECRET.test(result.content))
      throw new Error('上下文摘要格式无效');
    if (!Array.isArray(result.excerpts) || result.excerpts.length < 1) throw new Error('上下文摘要必须包含可核验的原文引文');
    const content = result.content.trim();
    if (content.length < 3 || !/[\p{L}\p{N}]/u.test(content)) throw new Error('上下文摘要内容为空或无意义');
    const sourceMap = new Map(inputRows.map(row => [row.id, row.content]));
    if (result.excerpts.length > MAX_EXCERPTS) throw new Error('上下文摘要引文数量超限');
    const excerpts = [];
    const seen = new Set();
    for (const excerpt of result.excerpts) {
      if (!excerpt || typeof excerpt.sourceId !== 'string' || typeof excerpt.quote !== 'string' ||
          excerpt.quote.length < MIN_EXCERPT_CHARS || excerpt.quote.length > MAX_EXCERPT_CHARS || SECRET.test(excerpt.quote)) throw new Error('上下文摘要引文格式无效');
      const source = sourceMap.get(excerpt.sourceId);
      if (!source || !source.includes(excerpt.quote)) throw new Error('上下文摘要引文来源校验失败');
      const key = `${excerpt.sourceId}\n${excerpt.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      excerpts.push({ sourceId: excerpt.sourceId, quote: excerpt.quote });
    }
    if (!excerpts.length) throw new Error('上下文摘要缺少可核验的原文引文');
    return { content, excerpts };
  }

  async verifyOldHeadGraph(head, scene) {
    const direct = [...new Set(head.value.sources)];
    if (direct.length > this.maxMessages + MAX_SEGMENTS) return false;
    const decoded = await this.getDecoded(direct, scene);
    if (!decoded || decoded.length !== direct.length) return false;
    if (decoded.some(row => row.visibilityFloor > rank(scene))) return false;
    const segmentIds = head.value.segments.map(item => item?.id);
    if (segmentIds.some(id => typeof id !== 'string')) return false;
    const missingSegmentIds = segmentIds.filter(id => !direct.includes(id));
    const missingSegments = await this.getDecoded(missingSegmentIds, scene);
    if (!missingSegments || missingSegments.length !== missingSegmentIds.length) return false;
    const byId = new Map([...decoded, ...missingSegments].map(row => [row.id, row]));
    const batchIds = head.value.batchSourceIds;
    if (!Array.isArray(batchIds) || batchIds.length > this.maxMessages || batchIds.some(id => !byId.has(id))) return false;
    if (sourceDigest(batchIds.map(id => byId.get(id))) !== head.value.batchSourceHash) return false;
    const expectedDirect = [...batchIds, ...segmentIds.slice(0, -1)];
    if (new Set(expectedDirect).size !== expectedDirect.length || expectedDirect.length !== direct.length ||
        expectedDirect.some(id => !direct.includes(id))) return false;
    for (let index = 0; index < segmentIds.length; index++) {
      const id = segmentIds[index];
      const meta = head.value.segments[index];
      const segment = byId.get(id);
      if (segment.kind !== 'state' || segment.domain !== scene || segment.visibilityFloor !== rank(scene) ||
          segment.value?.origin !== 'context-segment-v1' || segment.value.scene !== scene ||
          segment.value.version !== meta.version || segment.value.sourceHash !== meta.sourceHash ||
          segment.value.range?.firstSeq !== meta.range.firstSeq || segment.value.range?.lastSeq !== meta.range.lastSeq ||
          !Array.isArray(segment.value.sources) || segment.value.sources.length > this.maxMessages) return false;
      const sources = await this.getDecoded(segment.value.sources, scene);
      if (!sources || sources.length !== segment.value.sources.length) return false;
      if (sources.some(source => source.visibilityFloor > rank(scene) || source.kind !== 'message' ||
          typeof source.value?.content !== 'string' || SECRET.test(source.value.content))) return false;
      if (sourceDigest(sources) !== segment.value.sourceHash) return false;
    }
    return true;
  }

  async verifyCurrentBatch(batch, scene, expectedHash) {
    const current = await this.getDecoded(batch.map(row => row.id), scene);
    if (!current || current.length !== batch.length) return false;
    const byId = new Map(current.map(row => [row.id, row]));
    const normalized = batch.map(expected => {
      const row = byId.get(expected.id);
      if (!row || row.kind !== 'message' || row.value.role !== expected.value.role || row.value.content !== expected.value.content ||
          row.ingestionSeq !== expected.ingestionSeq || row.ts !== expected.ts || row.domain !== expected.domain ||
          row.visibilityFloor !== expected.visibilityFloor || row.visibilityFloor > rank(scene)) return null;
      return row;
    });
    return normalized.every(Boolean) && sourceDigest(normalized) === expectedHash;
  }

  async findReusableSegment(scene, batch, turns, inputs) {
    const sourceHashValue = sourceDigest(batch);
    const id = SEGMENT_PREFIX + scene + ':' + digest(`${scene}\n${sourceHashValue}`, 48);
    const raw = await this.memory.db.request('get', { ids: [id], scene });
    if (!raw?.rows?.length) {
      const anyScope = await this.memory.db.request('get', { ids: [id] });
      return anyScope?.rows?.length ? { invalid: true } : { invalid: false, segment: null, sourceHash: sourceHashValue };
    }
    let segment;
    try { segment = this.memory.decode(raw.rows[0]); } catch { return { invalid: true }; }
    const first = batch[0], last = batch.at(-1);
    const expectedSources = batch.map(row => row.id);
    const range = segment.value?.range;
    if (segment.kind !== 'state' || segment.id !== id || segment.domain !== scene || segment.visibilityFloor !== rank(scene) ||
        segment.value?.origin !== 'context-segment-v1' || segment.value.scene !== scene ||
        segment.value.sourceHash !== sourceHashValue || !Number.isSafeInteger(segment.value.version) || segment.value.version < 1 ||
        JSON.stringify(segment.value.sources) !== JSON.stringify(expectedSources) ||
        range?.firstSeq !== first.ingestionSeq || range?.firstId !== first.id || range?.lastSeq !== last.ingestionSeq ||
        range?.lastId !== last.id || range?.turnCount !== turns || range?.messageCount !== batch.length) return { invalid: true };
    const sources = await this.getDecoded(expectedSources, scene);
    if (!sources || sources.length !== expectedSources.length || sourceDigest(sources) !== sourceHashValue ||
        sources.some(source => typeof source.value?.content !== 'string' || SECRET.test(source.value.content))) return { invalid: true };
    try {
      const summary = this.validateSummary({ content: segment.value.content, excerpts: segment.value.excerpts }, inputs);
      return { invalid: false, segment, summary, sourceHash: sourceHashValue };
    } catch { return { invalid: true }; }
  }

  makeSegment(scene, batch, summary, turns, sourceHashValue) {
    const first = batch[0], last = batch.at(-1);
    const segmentId = SEGMENT_PREFIX + scene + ':' + digest(`${scene}\n${sourceHashValue}`, 48);
    return {
      id: segmentId,
      kind: 'state',
      ts: last.ts,
      updatedAt: this.clock(),
      domain: scene,
      visibilityFloor: rank(scene),
      value: {
        origin: 'context-segment-v1', scene, version: last.ingestionSeq,
        range: { firstSeq: first.ingestionSeq, firstId: first.id, lastSeq: last.ingestionSeq, lastId: last.id, turnCount: turns, messageCount: batch.length },
        sourceHash: sourceHashValue,
        content: summary.content,
        excerpts: summary.excerpts,
        sources: batch.map(row => row.id),
      },
    };
  }

  composeHeadText(segmentsNewestFirst) {
    const newest = segmentsNewestFirst[0];
    if (!newest || typeof newest.value?.content !== 'string' || newest.value.content.length > 1200) return '';
    const blocks = [newest.value.content];
    let used = newest.value.content.length;
    const excerpts = segmentsNewestFirst.flatMap(segment => (segment.value.excerpts || []).map(excerpt => ({
      block: `原文摘录：${excerpt.quote}`, segment,
    })));
    for (const { block } of excerpts) {
      const cost = block.length + 1;
      if (used + cost > HEAD_TEXT_BUDGET) continue;
      blocks.push(block);
      used += cost;
    }
    for (const segment of segmentsNewestFirst.slice(1)) {
      const block = `较早摘要：${segment.value.content}`;
      const cost = block.length + 1;
      if (!segment.value.content || used + cost > HEAD_TEXT_BUDGET) continue;
      blocks.push(block);
      used += cost;
    }
    return blocks.join('\n');
  }

  async commitBatch({ scene, batch, summary, turns, skippedSecretRounds, head, oldSegments, generation, sceneEpoch, signal, reusableSegment = null }) {
    const sourceHashValue = sourceDigest(batch);
    const segment = reusableSegment || this.makeSegment(scene, batch, summary, turns, sourceHashValue);
    const priorMetadata = head?.value.segments || [];
    const retainedPrior = priorMetadata.slice(-(MAX_SEGMENTS - 1));
    const retainedSegmentRecords = oldSegments.filter(row => retainedPrior.some(meta => meta.id === row.id));
    const allSegmentsNewestFirst = [segment, ...retainedSegmentRecords.slice().reverse()];
    const metadata = [...retainedPrior, {
      id: segment.id, version: segment.value.version, range: segment.value.range, sourceHash: sourceHashValue,
    }].slice(-MAX_SEGMENTS);
    const sourceIds = [...new Set([
      ...batch.map(row => row.id),
      ...retainedPrior.map(item => item.id),
    ])];
    if (sourceIds.length > MAX_SOURCE_IDS) throw new Error('上下文摘要来源数量超限');
    const last = batch.at(-1);
    const nextHead = {
      id: headId(scene), kind: 'state', ts: 0, updatedAt: this.clock(), domain: scene, visibilityFloor: rank(scene),
      value: {
        origin: 'context-head-v1', scene, version: (head?.value.version || 0) + 1,
        watermark: { ingestionSeq: last.ingestionSeq, id: last.id, ts: last.ts },
        coveredThrough: { ingestionSeq: last.ingestionSeq, id: last.id, ts: last.ts },
        segments: metadata,
        text: this.composeHeadText(allSegmentsNewestFirst),
        batchSourceIds: batch.map(row => row.id),
        batchSourceHash: sourceHashValue,
        skippedSecretRounds: (head?.value.skippedSecretRounds || 0) + skippedSecretRounds,
        sources: sourceIds,
      },
    };

    return this.memory.serial(async () => {
      if (signal?.aborted || this.memory.closed || this.memory.generation !== generation ||
          (sceneEpoch !== undefined && this.memory.sceneEpoch !== sceneEpoch)) return false;
      const currentRaw = await this.memory.db.request('get', { ids: [headId(scene)], scene });
      let currentHead = null;
      if (currentRaw?.rows?.length) {
        try { currentHead = this.memory.decode(currentRaw.rows[0]); } catch { return false; }
        if (!this.isValidHead(currentHead, scene)) return false;
      } else {
        const anyScope = await this.memory.db.request('get', { ids: [headId(scene)] });
        if (anyScope?.rows?.length) return false;
      }
      if ((head?.value.version || 0) !== (currentHead?.value?.version || 0)) return false;
      if (head && (!currentHead || currentHead.value.watermark?.ingestionSeq !== head.value.watermark?.ingestionSeq ||
          !(await this.verifyOldHeadGraph(currentHead, scene)))) return false;
      if (!await this.verifyCurrentBatch(batch, scene, sourceHashValue)) return false;
      const existingSegment = await this.memory.db.request('get', { ids: [segment.id], scene });
      let writeSegment = true;
      if (existingSegment?.rows?.length) {
        let prior;
        try { prior = this.memory.decode(existingSegment.rows[0]); } catch { return false; }
        if (prior.kind !== 'state' || prior.domain !== scene || prior.visibilityFloor !== rank(scene) ||
            prior.value?.origin !== 'context-segment-v1' || prior.value.scene !== scene ||
            prior.value.sourceHash !== segment.value.sourceHash || prior.value.version !== segment.value.version ||
            JSON.stringify(prior.value.sources) !== JSON.stringify(segment.value.sources) ||
            JSON.stringify(prior.value.range) !== JSON.stringify(segment.value.range) ||
            prior.value.content !== segment.value.content || JSON.stringify(prior.value.excerpts) !== JSON.stringify(segment.value.excerpts)) return false;
        writeSegment = false;
      } else {
        const anyScope = await this.memory.db.request('get', { ids: [segment.id] });
        if (anyScope?.rows?.length) return false;
      }
      if (signal?.aborted || this.memory.generation !== generation ||
          (sceneEpoch !== undefined && this.memory.sceneEpoch !== sceneEpoch)) return false;
      await this.memory.write(writeSegment ? [segment, nextHead] : [nextHead], this.memory.epoch, { notify: false });
      return true;
    });
  }

  async run(options = {}) {
    if (this.running) return this.running;
    this.running = this.runInternal(options).finally(() => { this.running = null; });
    return this.running;
  }

  async runInternal({ signal, canRun = () => true, reserveModelCall = () => true } = {}) {
    const controller = signal || new AbortController().signal;
    const processedByScene = Object.fromEntries(SCENES.map(scene => [scene, 0]));
    const skippedByScene = Object.fromEntries(SCENES.map(scene => [scene, 0]));
    const versions = {};
    const outcome = (status, note) => ({ status,
      processed: Object.values(processedByScene).reduce((a, b) => a + b, 0),
      skippedSecretRounds: { ...skippedByScene }, versions,
      ...(note ? { note } : {}),
    });
    if (!this.memory.db || this.memory.closed || this.memory.ready === false) return outcome('paused');
    const runGeneration = this.memory.generation;
    const runSceneEpoch = this.memory.sceneEpoch;
    for (const scene of SCENES) {
      if (controller.aborted || this.memory.closed || this.memory.generation !== runGeneration ||
          (runSceneEpoch !== undefined && this.memory.sceneEpoch !== runSceneEpoch))
        return outcome('paused');
      if (!await canRun({ mode: 'context-compression', scene, signal: controller })) return outcome('paused');
      const headState = await this.inspectHead(scene);
      if (headState.invalid) return outcome('paused', '场景压缩索引未通过校验，已保留原始对话');
      let head = headState.head;
      let version = head?.value.version || 0;
      versions[scene] = version;
      if (head && !await this.verifyOldHeadGraph(head, scene))
        return outcome('paused', '场景压缩来源已变化，未提交新的版本');
      const cutoffSeq = await this.recentCutoff(scene, controller);
      if (controller.aborted) return outcome('paused');
      if (cutoffSeq === null) continue;
      let cursorSeq = head?.value.watermark.ingestionSeq || 0;
      if (cursorSeq >= cutoffSeq) continue;
      for (;;) {
        if (controller.aborted || this.memory.closed || this.memory.generation !== runGeneration ||
            (runSceneEpoch !== undefined && this.memory.sceneEpoch !== runSceneEpoch))
          return outcome('paused');
        if (!await canRun({ mode: 'context-compression', scene, signal: controller })) return outcome('paused');
        const chosen = await this.readNextBatch(scene, cursorSeq, cutoffSeq, controller);
        skippedByScene[scene] += chosen.skippedSecretRounds || 0;
        if (chosen.aborted) return outcome('paused');
        if (chosen.oversized) return outcome('paused', '单个完整轮超过批次上限，未截断也未推进水位');
        if (!chosen.rows.length) break;
        const batch = chosen.rows;
        const batchChars = batch.reduce((sum, row) => sum + row.value.content.length, 0);
        if (batch.length > this.maxMessages || batchChars > this.maxChars || batch.some(row => row.visibilityFloor > rank(scene)))
          throw new Error('上下文压缩批次边界校验失败');
        const inputs = batch.map(row => this.toInputRow(row));
        const oldSegments = await this.loadSegments(head, scene);
        if (head && !oldSegments) return outcome('paused');
        const reusable = await this.findReusableSegment(scene, batch, chosen.turns, inputs);
        if (reusable.invalid) return outcome('paused', '历史压缩段未通过校验，已保留原始对话');
        let summary, reusableSegment = reusable.segment;
        if (reusableSegment) summary = reusable.summary;
        else {
          const allowed = await reserveModelCall(controller);
          if (allowed === false || allowed?.ok === false) return outcome('budget');
          const summaryRaw = await this.summarize(inputs, { scene, signal: controller });
          if (controller.aborted || this.memory.generation !== runGeneration ||
              (runSceneEpoch !== undefined && this.memory.sceneEpoch !== runSceneEpoch)) return outcome('paused');
          summary = this.validateSummary(summaryRaw, inputs);
        }
        const committed = await this.commitBatch({ scene, batch, summary, turns: chosen.turns,
          skippedSecretRounds: chosen.skippedSecretRounds || 0, head, oldSegments: oldSegments || [],
          generation: runGeneration, sceneEpoch: runSceneEpoch, signal: controller, reusableSegment });
        if (!committed) return outcome('paused');
        processedByScene[scene] += batch.length;
        version++;
        versions[scene] = version;
        const last = batch.at(-1);
        cursorSeq = last.ingestionSeq;
        const nextState = await this.inspectHead(scene);
        head = nextState.head;
        if (!head || nextState.invalid || head.value.version !== version) return outcome('paused');
      }
    }
    return outcome('done');
  }

  async loadSegments(head, scene) {
    if (!head) return [];
    const metadata = head.value.segments;
    const ids = metadata.map(item => item.id);
    if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) return null;
    const rows = await this.getDecoded(ids, scene);
    if (!rows || rows.length !== ids.length) return null;
    const byId = new Map(rows.map(row => [row.id, row]));
    const out = [];
    for (const item of metadata) {
      const row = byId.get(item.id);
      if (!row || row.kind !== 'state' || row.domain !== scene || row.visibilityFloor !== rank(scene) ||
          row.value?.origin !== 'context-segment-v1' || row.value.scene !== scene || row.value.sourceHash !== item.sourceHash ||
          !Array.isArray(row.value.sources) || row.value.sources.length > this.maxMessages ||
          typeof row.value.content !== 'string' || row.value.content.length > 1200 || !Array.isArray(row.value.excerpts) ||
          row.value.excerpts.length > MAX_EXCERPTS || !row.value.range || !Number.isSafeInteger(row.value.range.firstSeq) ||
          !Number.isSafeInteger(row.value.range.lastSeq) || row.value.range.lastSeq < row.value.range.firstSeq ||
          row.value.range.firstSeq !== item.range.firstSeq || row.value.range.lastSeq !== item.range.lastSeq || row.value.version !== item.version) return null;
      const sources = await this.getDecoded(row.value.sources, scene);
      if (!sources || sources.length !== row.value.sources.length || sourceDigest(sources) !== row.value.sourceHash ||
          sources.some(source => typeof source.value?.content !== 'string' || SECRET.test(source.value.content))) return null;
      try {
        this.validateSummary({ content: row.value.content, excerpts: row.value.excerpts }, sources.map(source => ({
          id: source.id, content: source.value.content,
        })));
      } catch { return null; }
      out.push(row);
    }
    return out;
  }
}

module.exports = {
  ContextCompression, groupTurns, sourceDigest, HEAD_TEXT_BUDGET,
  MAX_SEGMENTS, MAX_SOURCE_IDS, HEAD_PREFIX, SEGMENT_PREFIX,
};
