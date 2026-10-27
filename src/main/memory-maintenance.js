'use strict';

const crypto = require('node:crypto');
const { containsSecret } = require('./conversation-input');
const SECRET = { test: containsSecret };

const PARTITIONS = [
  { domain: 'work', visibilityFloor: 0 }, { domain: 'work', visibilityFloor: 1 }, { domain: 'work', visibilityFloor: 2 },
  { domain: 'life', visibilityFloor: 1 }, { domain: 'life', visibilityFloor: 2 },
  { domain: 'private', visibilityFloor: 2 },
];
const MAX_MESSAGES = 40;
const MAX_CHARS = 28000;
const MAX_CALLS = 3;
const WINDOW_MS = 60_000;
const DAILY_CALL_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_DAILY_CALLS = 100;
const MAX_CANDIDATES = 6;
const CHECKPOINT_PREFIX = 'maintenance:';
const SCHEDULE_ID = 'maintenance:daily-schedule';
const BUDGET_ID = 'maintenance:budget';
const ABORTED = Symbol('memory-maintenance-aborted');

function digest(value, size = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, size);
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const tags = new Set();
  for (const raw of value.slice(0, 64)) {
    if (typeof raw !== 'string') continue;
    const tag = raw.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ').slice(0, 48);
    if (!tag || SECRET.test(tag) || /[\u0000-\u001f]/u.test(tag)) continue;
    tags.add(tag);
    if (tags.size >= 8) break;
  }
  return [...tags];
}

function validPartition(row, partition) {
  return row && row.domain === partition.domain && Number(row.visibilityFloor) === partition.visibilityFloor;
}

function validRole(row) {
  return row?.kind === 'message' && ['user', 'assistant'].includes(row.value?.role) && typeof row.value.content === 'string';
}

class MemoryMaintenance {
  constructor({ memory, extract, compression, analyzeRelations, canRun = () => true, allowAutomatic = () => true, onStatus = () => {}, clock = Date.now,
    maxMessages = MAX_MESSAGES, maxChars = MAX_CHARS, maxCalls = MAX_CALLS, windowMs = WINDOW_MS, maxCallsPerDay = DEFAULT_DAILY_CALLS,
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!memory || typeof memory.query !== 'function' || typeof memory.write !== 'function' || typeof memory.serial !== 'function')
      throw new TypeError('MemoryMaintenance requires MemoryService query/write/serial');
    if (typeof extract !== 'function') throw new TypeError('MemoryMaintenance requires the verified free-model extract function');
    Object.assign(this, { memory, extract, compression, canRun, allowAutomatic, onStatus, clock, maxMessages, maxChars, maxCalls, windowMs, maxCallsPerDay, setTimer, clearTimer });
    this.analyzeRelations = analyzeRelations;
    this.maxMessages = Math.max(1, Math.min(MAX_MESSAGES, Number.isSafeInteger(maxMessages) ? maxMessages : MAX_MESSAGES));
    this.maxChars = Math.max(1, Math.min(MAX_CHARS, Number.isSafeInteger(maxChars) ? maxChars : MAX_CHARS));
    this.maxCalls = Math.max(1, Math.min(MAX_CALLS, Number.isSafeInteger(maxCalls) ? maxCalls : MAX_CALLS));
    this.windowMs = Math.max(WINDOW_MS, Number.isSafeInteger(windowMs) ? windowMs : WINDOW_MS);
    this.maxCallsPerDay = Math.max(1, Math.min(1000, Number.isSafeInteger(maxCallsPerDay) ? maxCallsPerDay : DEFAULT_DAILY_CALLS));
    this.queue = [];
    this.dozeDirty = false;
    this.requestSources = new Map();
    this.controller = null;
    this.activeMode = null;
    this.tickPromise = null;
    this.closed = false;
    this.timer = null;
    this.calls = [];
    this.budgetReason = '达到每分钟整理预算';
    this.budgetDelayMs = WINDOW_MS;
    this.automaticRetryAfter = 0;
    this.scheduleRevision = 0;
    this.statusValue = { status: 'idle', mode: null, processed: 0, note: '', lastSuccessAt: null };
  }

  status() { return { ...this.statusValue }; }

  publish(patch) {
    this.statusValue = { ...this.statusValue, ...patch };
    try { this.onStatus(this.status()); } catch { /* A UI notification cannot affect a committed batch. */ }
  }

  hasQueued(mode) { return this.queue.includes(mode) || this.activeMode === mode; }

  request(mode, { automatic = false } = {}) {
    if (!['doze', 'dream', 'deepdream'].includes(mode)) return { ok: false, error: '整理模式无效' };
    if (this.closed) return { ok: false, error: '记忆整理器已关闭' };
    if (automatic && this.clock() < this.automaticRetryAfter) return { ok: false, error: '后台整理暂缓，可手动重试' };
    if (mode === 'doze') this.dozeDirty = true;
    if (!automatic || !this.requestSources.has(mode)) this.requestSources.set(mode, automatic ? 'automatic' : 'manual');
    if (this.hasQueued(mode)) {
      if (!automatic) this.scheduleTick();
      return { ok: true, queued: true };
    }
    if (!this.hasQueued(mode)) {
      this.queue.push(mode);
      if (!this.activeMode) this.publish({ processed: 0, scanned: 0, archived: 0 });
    }
    this.publish({ status: 'queued', mode, note: ({ doze: 'Doze 对话压缩已排队', dream: 'Dream 新记忆提炼已排队', deepdream: 'Deepdream 记忆整理已排队' })[mode] });
    this.scheduleTick();
    return { ok: true, queued: true };
  }

  scheduleTick(delayMs = 0) {
    if (this.closed || this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, Math.max(0, delayMs));
  }

  nextBudgetDelay() {
    const now = this.clock();
    const recentMinute = this.calls.filter(at => now - at < this.windowMs);
    const recentDay = this.calls.filter(at => now - at < DAILY_CALL_WINDOW_MS);
    const minuteDelay = recentMinute.length >= this.maxCalls ? Math.max(1, Math.min(...recentMinute) + this.windowMs - now) : 0;
    const dayDelay = recentDay.length >= this.maxCallsPerDay ? Math.max(1, Math.min(...recentDay) + DAILY_CALL_WINDOW_MS - now) : 0;
    return Math.max(minuteDelay, dayDelay);
  }

  async reserveModelCall(signal) {
    return this.memory.serial(async () => {
      if (signal.aborted || this.closed || this.memory.closed) throw ABORTED;
      const saved = (await this.readState(BUDGET_ID))?.value?.calls;
      const now = this.clock();
      const calls = (Array.isArray(saved) ? saved : []).filter(at => Number.isSafeInteger(at) && now - at < DAILY_CALL_WINDOW_MS);
      const recentMinute = calls.filter(at => now - at < this.windowMs);
      if (recentMinute.length >= this.maxCalls) {
        this.calls = calls;
        this.budgetReason = '达到每分钟整理预算';
        this.budgetDelayMs = this.nextBudgetDelay();
        return { ok: false };
      }
      if (calls.length >= this.maxCallsPerDay) {
        this.calls = calls;
        this.budgetReason = '达到每日整理预算';
        this.budgetDelayMs = this.nextBudgetDelay();
        return { ok: false };
      }
      const nextCalls = [...calls, now];
      const state = { id: BUDGET_ID, kind: 'state', ts: 0, updatedAt: now, domain: 'private', visibilityFloor: 2,
        value: { calls: nextCalls, sources: [] } };
      await this.memory.write([state], this.memory.epoch);
      this.calls = nextCalls;
      return { ok: true };
    });
  }

  async tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.runQueue().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }

  async permitted(details) {
    if (this.requestSources.get(this.activeMode) === 'automatic' && !this.allowAutomatic()) return false;
    return this.canRun(details);
  }

  async runQueue() {
    while (!this.closed && this.queue.length) {
      const mode = this.queue.shift();
      this.activeMode = mode;
      this.controller = new AbortController();
      this.pauseNote = '';
      this.publish({ status: 'running', mode, note: ({ doze: '正在压缩历史对话', dream: '正在形成新增记忆', deepdream: '正在整理新记忆及相关历史' })[mode] });
      try {
        const canRun = await this.permitted({ mode, signal: this.controller.signal });
        if (!canRun) {
          this.queue.unshift(mode);
          this.publish({ status: 'paused', mode, note: '记忆未解锁或当前不适合整理，稍后可继续' });
          break;
        }
        const outcome = mode === 'doze' ? await this.runDoze(this.controller.signal) : mode === 'dream' ? await this.runExtract(this.controller.signal) : await this.runDeepdream(this.controller.signal);
        if (outcome === 'budget') {
          this.queue.unshift(mode);
          this.publish({ status: 'queued', mode, note: `${this.budgetReason}，等待后继续` });
          this.scheduleTick(this.budgetDelayMs || this.nextBudgetDelay());
          break;
        }
        if (outcome === 'paused' || this.controller.signal.aborted) {
          if (!this.closed && !this.queue.includes(mode)) this.queue.unshift(mode);
          this.publish({ status: 'paused', mode, note: this.pauseNote || '整理已暂停，进度可从上次水位继续' });
          break;
        }
        if (outcome === 'continue') {
          if (!this.queue.includes(mode)) this.queue.push(mode);
          this.publish({ status: 'queued', mode, note: '已保存本批整理进度，稍后继续检查更早记忆' });
          this.scheduleTick(1500);
          break;
        }
        if (mode !== 'doze' || this.automaticRetryAfter) await this.saveDailyScheduleIfDue(mode);
        if (mode === 'doze' && this.dozeDirty && !this.queue.includes(mode)) this.queue.push(mode);
        else this.requestSources.delete(mode);
        const finishedAt = this.clock();
        this.publish({ status: 'idle', mode: null, stage: null, note: '整理已完成', lastSuccessAt: finishedAt });
      } catch (error) {
        if (this.controller?.signal.aborted || error === ABORTED) {
          if (!this.closed && !this.queue.includes(mode)) this.queue.unshift(mode);
          this.publish({ status: 'paused', mode, note: '整理已暂停，进度可从上次水位继续' });
        } else {
          this.requestSources.delete(mode);
          // A failed automatic daily check otherwise requeues every 15 seconds.
          // Persist a cooldown; manual retry remains available immediately.
          const retryAfter = this.clock() + 30 * 60_000;
          this.automaticRetryAfter = retryAfter;
          this.scheduleRevision++;
          try {
            await this.memory.serial(async () => {
              const previous = await this.readDailySchedule();
              await this.memory.write([{ id: SCHEDULE_ID, kind: 'state', ts: 0, updatedAt: this.clock(), domain: 'private', visibilityFloor: 2,
                value: { ...(previous?.value || {}), retryAfter, retryMode: mode, sources: [] } }], this.memory.epoch, { notify: false });
            });
          } catch { /* A failed store must not hide the original failure. */ }
          this.publish({ status: 'failed', mode, note: this.safeError(error) });
        }
        break;
      } finally {
        this.controller = null;
        this.activeMode = null;
      }
    }
  }

  safeError(error) {
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(error.code) ? error.code : '';
    const known = {
      stale_epoch: '本地记忆刚有更新，整理没有提交',
      invalid_source: '来源依赖校验未通过，已保留原文与进度',
      invalid_record: '本地记录校验未通过，整理没有提交',
      database_operation_failed: '本地记忆暂时无法整理',
      request_timed_out: '本地记忆响应超时，整理可稍后继续',
      E_FREE_MODEL_CATALOG: '暂时读不到免费模型目录，稍后可继续',
      E_FREE_MODEL_UNAVAILABLE: '目前没有确认可用的免费模型，已保留进度',
      E_OUTPUT_LIMIT: '本批输出预算不足，已保留未处理进度',
      E_EMPTY_RESPONSE: '模型没有返回正文，已保留未处理进度',
      E_INVALID_MODEL_OUTPUT: '本批整理结果不完整，未推进进度',
      E_UPSTREAM: 'WorkBuddy 服务暂时不可用，已保留进度，可稍后手动重试',
      E_PAYLOAD_TOO_LARGE: '模型返回超过本地转发上限，已保留进度',
    };
    if (code && known[code]) return `${known[code]}（${code}）`;
    return code ? `整理暂未完成（错误码 ${code}）` : '整理暂未完成，请稍后再试';
  }

  cancel() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (this.activeMode && !this.queue.includes(this.activeMode)) this.queue.unshift(this.activeMode);
    this.controller?.abort();
    const mode = this.activeMode || this.queue[0] || null;
    this.publish({ status: 'paused', mode, note: '整理已暂停，进度可从上次水位继续' });
    return { ok: true };
  }

  async close() {
    this.closed = true;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    this.controller?.abort();
    await this.tickPromise?.catch(() => {});
    this.publish({ status: 'paused', mode: this.activeMode || this.queue[0] || null, note: '应用关闭，整理进度已保存' });
  }

  async readPartitionState(domain, visibilityFloor) {
    const id = `${CHECKPOINT_PREFIX}${domain}:${visibilityFloor}`;
    return this.readState(id);
  }

  async readState(id) {
    const result = await this.memory.db.request('get', { ids: [id] });
    const row = result.rows?.find(record => record.id === id);
    if (!row) return null;
    const decoded = this.memory.decode(row);
    if (decoded.kind !== 'state') throw new Error('整理水位格式不正确');
    return decoded;
  }

  async readDailySchedule() {
    // Internal scheduler state is deliberately private, regardless of the
    // visible scene. Point reads also cannot lose it behind years of indexes.
    return this.readState(SCHEDULE_ID);
  }

  async readMessagePage(partition, watermark) {
    const cursor = { scene: null, domain: partition.domain, visibilityFloor: partition.visibilityFloor, sort: 'ingestion', order: 'asc' };
    if (watermark && Number.isSafeInteger(watermark.ingestionSeq)) cursor.afterSeq = watermark.ingestionSeq;
    return this.memory.query('message', this.maxMessages, cursor);
  }

  async snapshotPartition(partition, signal) {
    return this.memory.serial(async () => {
      if (signal.aborted) throw ABORTED;
      if (this.memory.closed || this.closed) throw ABORTED;
      const state = await this.readPartitionState(partition.domain, partition.visibilityFloor);
      const watermark = state?.value?.watermark || null;
      const page = await this.readMessagePage(partition, watermark);
      return { epoch: this.memory.epoch, generation: this.memory.generation, state, watermark, page };
    });
  }

  buildBatch(rows) {
    const consumed = [];
    const input = [];
    let chars = 0;
    for (const row of rows.slice(0, this.maxMessages)) {
      if (!validRole(row)) { consumed.push(row); continue; }
      const content = row.value.content;
      if (chars + content.length > this.maxChars) {
        if (!consumed.length) throw new Error('单条消息超过整理字符预算，原文未截断且进度未推进');
        break;
      }
      consumed.push(row);
      chars += content.length;
      if (!SECRET.test(content)) input.push({ id: row.id, role: row.value.role, content, time: row.ts });
    }
    return { consumed, input, chars };
  }

  validCandidates(candidates, batch, partition) {
    const messages = new Map(batch.map(row => [row.id, row]));
    const outputs = [];
    const seen = new Set();
    for (const item of (Array.isArray(candidates?.memories) ? candidates.memories : []).slice(0, MAX_CANDIDATES)) {
      if (!item || typeof item !== 'object') continue;
      const source = messages.get(item.sourceId);
      if (!source || source.value.role !== 'user' || !validPartition(source, partition)) continue;
      if (typeof item.evidence !== 'string' || item.evidence.length < 3 || item.evidence.length > 2000 || !source.value.content.includes(item.evidence)) continue;
      if (typeof item.content !== 'string' || !item.content.trim() || item.content.length > 400 || SECRET.test(item.content)) continue;
      const content = item.content.trim();
      const key = `${source.id}\n${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      outputs.push({ source, content, evidence: item.evidence, tags: normalizeTags(item.tags) });
    }
    return outputs;
  }

  buildDreamRecords(candidates, batch, consumed, partition, snapshot) {
    const records = [];
    const inputSources = [...new Set(batch.map(row => row.id))];
    for (const item of this.validCandidates(candidates, batch, partition)) {
      const id = `dream-memory:v3:${digest(`${partition.domain}:${partition.visibilityFloor}:${item.source.id}:${item.evidence}:${item.content}`, 40)}`;
      records.push({ id, kind: 'memory', ts: item.source.ts, domain: partition.domain, visibilityFloor: partition.visibilityFloor,
        searchText: `${item.content} ${item.tags.join(' ')}`.trim(),
        value: require('./memory-tags').tagged({ content: item.content, memoryKind: 'candidate', status: 'pending', importance: 0.6,
          evidence: item.evidence, evidenceSourceId: item.source.id, sources: [item.source.id, ...inputSources.filter(source => source !== item.source.id)], origin: 'dream-candidate-v3', ...(item.tags.length ? { tags: item.tags } : {}) }, ['automatic']) });
    }
    const last = consumed.at(-1);
    if (last) records.push({ id: `${CHECKPOINT_PREFIX}${partition.domain}:${partition.visibilityFloor}`, kind: 'state', ts: 0, updatedAt: this.clock(), domain: partition.domain, visibilityFloor: partition.visibilityFloor,
      value: { job: 'dream', domain: partition.domain, visibilityFloor: partition.visibilityFloor,
        watermark: { ingestionSeq: last.ingestionSeq, ts: last.ts, id: last.id }, snapshotEpoch: snapshot.epoch,
        snapshotHash: snapshot.snapshotHash, processed: (this.currentProcessed || 0) + consumed.length, sources: [] } });
    return records;
  }

  sourceHash(batch) {
    return digest(JSON.stringify(batch.map(row => [row.id, row.ingestionSeq, row.ts, row.domain, row.visibilityFloor, row.value.role, row.value.content])), 64);
  }

  async verifySources(batch, partition, generation) {
    if (this.memory.generation !== generation) return false;
    const ids = batch.map(row => row.id);
    if (!ids.length) return true;
    if (!this.memory.db?.request || typeof this.memory.decode !== 'function') throw new Error('无法核验整理来源，拒绝提交');
    const result = await this.memory.db.request('get', { ids });
    const rows = result?.rows || [];
    if (rows.length !== ids.length) return false;
    const byId = new Map(rows.map(row => [row.id, row]));
    return batch.every(snapshot => {
      const row = byId.get(snapshot.id);
      if (!row || row.kind !== 'message' || row.domain !== partition.domain || Number(row.visibilityFloor) !== partition.visibilityFloor) return false;
      const value = this.memory.decode(row).value;
      return value.role === snapshot.value.role && value.content === snapshot.value.content && row.ts === snapshot.ts && Number(row.ingestionSeq) === snapshot.ingestionSeq;
    });
  }

  async commitDream(records, batch, partition, snapshot) {
    return this.memory.serial(async () => {
      if (this.closed || this.controller?.signal.aborted) throw ABORTED;
      if (!await this.verifySources(batch, partition, snapshot.generation) || this.sourceHash(batch) !== snapshot.snapshotHash) return false;
      const epoch = this.memory.epoch;
      await this.memory.write(records, epoch);
      return true;
    });
  }

  async runExtract(signal) {
    this.publish({ stage: 'dream' });
    this.currentProcessed = 0;
    if (!this.extractionLimit) {
      const saved = (await this.readState('maintenance:extract-tuning'))?.value?.batchSize;
      this.extractionLimit = Number.isSafeInteger(saved) && saved > 0 ? Math.min(saved, this.maxMessages) : this.maxMessages;
    }
    for (const partition of PARTITIONS) {
      for (;;) {
        if (signal.aborted || this.closed) return 'paused';
        const canRun = await this.permitted({ mode: 'dream', partition, signal });
        if (!canRun) return 'paused';
        const snapshot = await this.snapshotPartition(partition, signal);
        if (!snapshot.page.length) break;
        const { consumed, input } = this.buildBatch(snapshot.page.slice(0, this.extractionLimit));
        if (!consumed.length) break;
        if (consumed.some(row => !Number.isSafeInteger(row.ingestionSeq))) throw new Error('消息缺少稳定入库序号，整理未推进');
        const eligible = consumed.filter(validRole).filter(row => !SECRET.test(row.value.content));
        snapshot.snapshotHash = this.sourceHash(eligible);
        const batchEnd = consumed.at(-1);
        let candidates = { memories: [], excerpts: [] };
        if (input.some(item => item.role === 'user')) {
          const reserved = await this.reserveModelCall(signal);
          if (!reserved.ok) return 'budget';
          try { candidates = await this.extract(input, { signal }); }
          catch (error) {
            if (signal.aborted || this.closed) return 'paused';
            if (consumed.length > 1 && ['E_UPSTREAM', 'E_PAYLOAD_TOO_LARGE', 'E_OUTPUT_LIMIT', 'E_INVALID_MODEL_OUTPUT'].includes(error.code)) {
              this.extractionLimit = Math.max(1, Math.floor(consumed.length / 2));
              await this.memory.serial(async () => {
                if (signal.aborted || this.memory.generation !== snapshot.generation) throw ABORTED;
                await this.memory.write([{ id: 'maintenance:extract-tuning', kind: 'state', ts: 0, updatedAt: this.clock(), domain: 'private', visibilityFloor: 2,
                  value: { batchSize: this.extractionLimit, sources: [] } }], this.memory.epoch, { notify: false });
              });
              this.publish({ note: '本批响应未完成，已保留水位并改用更小批次继续' });
              continue;
            }
            throw error;
          }
          if (signal.aborted || this.closed) return 'paused';
          if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates)) throw new Error('记忆整理模型返回格式无效');
        }
        const records = this.buildDreamRecords(candidates, eligible, consumed, partition, snapshot);
        // This watermark update and all derivatives are committed in one native write.
        const committed = await this.commitDream(records, eligible, partition, snapshot);
        if (!committed) return 'paused';
        this.currentProcessed += consumed.length;
        this.publish({ status: 'running', mode: this.activeMode, processed: this.statusValue.processed + consumed.length, note: '已保存一批有来源的记忆整理结果' });
        if (consumed.length < snapshot.page.length || consumed.length >= this.maxMessages) {
          // Continue from the exact last consumed row; the next query detects completion.
        }
        if (batchEnd === snapshot.page.at(-1) && snapshot.page.length < this.maxMessages) break;
      }
    }
    return 'done';
  }

  async runDoze(signal) {
    this.dozeDirty = false;
    this.publish({ stage: 'doze' });
    if (!this.compression) return 'done';
    const result = await this.compression.run({ signal, canRun: details => this.permitted(details),
      reserveModelCall: budgetSignal => this.reserveModelCall(budgetSignal) });
    this.pauseNote = result.note || '';
    this.publish({ processed: (this.statusValue.processed || 0) + (result.processed || 0), versions: result.versions });
    return result.status;
  }

  async runDeepdream(signal) {
    const extracted = await this.runExtract(signal);
    if (extracted !== 'done') return extracted;
    this.publish({ stage: 'deepdream' });
    this.deepdream ||= require('./deepdream').createDeepdream({ memory: this.memory, analyze: this.analyzeRelations, clock: this.clock });
    const result = await this.deepdream.run({ signal, canRun: details => this.permitted(details),
      reserveModelCall: budgetSignal => this.reserveModelCall(budgetSignal) });
    this.publish({ scanned: (this.statusValue.scanned || 0) + (result.scanned || 0) });
    if (result.status !== 'done') return result.status;
    let more = result.more;
    if (this.memory.knowledge) {
      this.publish({ stage: 'knowledge' });
      for (const method of ['sync', 'backfillExperiences']) {
        const outcome = await this.memory.knowledge[method]({ signal, canRun: () => this.permitted({ mode: 'deepdream', signal }) });
        if (outcome.status !== 'done') return outcome.status;
        more ||= outcome.more;
      }
    }
    return more ? 'continue' : 'done';
  }

  localDayKey(value) {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  async pendingMessages() {
    let users = 0, any = false;
    for (const partition of PARTITIONS) {
      const state = await this.readPartitionState(partition.domain, partition.visibilityFloor);
      const rows = await this.memory.query('message', 200, { scene: null, ...partition, sort: 'ingestion', order: 'asc',
        afterSeq: state?.value?.watermark?.ingestionSeq || 0 });
      any ||= rows.length > 0;
      users += rows.filter(row => row.value.role === 'user').length;
    }
    return { any, users };
  }

  async checkDue(now = this.clock()) {
    if (this.closed || !this.allowAutomatic()) return false;
    try {
      const revision = this.scheduleRevision;
      const schedule = await this.readDailySchedule();
      if (revision !== this.scheduleRevision) return false;
      this.automaticRetryAfter = Number.isSafeInteger(schedule?.value?.retryAfter) ? schedule.value.retryAfter : 0;
      if (now < this.automaticRetryAfter) return false;
      const date = this.localDayKey(now), hour = new Date(now).getHours();
      const pending = await this.pendingMessages();
      let queued = false;
      if (this.automaticRetryAfter && ['doze', 'dream', 'deepdream'].includes(schedule?.value?.retryMode)) {
        queued = this.request(schedule.value.retryMode, { automatic: true }).ok;
      }
      if (pending.users >= 100 || (hour >= 4 && schedule?.value?.dreamDate !== date && pending.any)) {
        queued = this.request('dream', { automatic: true }).ok || queued;
      }
      if (hour >= 5 && schedule?.value?.deepdreamDate !== date) queued = this.request('deepdream', { automatic: true }).ok || queued;
      return queued;
    } catch { return false; }
  }

  async saveDailyScheduleIfDue(mode) {
    await this.memory.serial(async () => {
      if (this.closed || this.controller?.signal.aborted) throw ABORTED;
      const existing = await this.readDailySchedule(), now = this.clock();
      const value = { ...(existing?.value || {}), lifecycleVersion: 3, lastSuccessAt: now, retryAfter: 0, retryMode: null, sources: [] };
      if (mode !== 'doze' && new Date(now).getHours() >= 4) value.dreamDate = this.localDayKey(now);
      if (mode === 'deepdream' && new Date(now).getHours() >= 5) value.deepdreamDate = this.localDayKey(now);
      await this.memory.write([{ id: SCHEDULE_ID, kind: 'state', ts: 0, updatedAt: now, domain: 'private', visibilityFloor: 2, value }], this.memory.epoch);
    });
    this.automaticRetryAfter = 0;
    this.scheduleRevision++;
  }

}

module.exports = { MemoryMaintenance, normalizeTags, PARTITIONS, MAX_MESSAGES, MAX_CHARS, MAX_CALLS, WINDOW_MS };
