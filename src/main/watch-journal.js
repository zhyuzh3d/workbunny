'use strict';

const crypto = require('crypto');

const MAX_VALUE_BYTES = 1_400_000;
const MAX_SOURCES = 200;

function recordId(key, namespace, value) {
  return `wb-${namespace}-${crypto.createHmac('sha256', key)
    .update(`workbunny:${namespace}:v1\0${value}`, 'utf8').digest('base64url')}`;
}

function cloneValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式不合法`);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new Error(`${label}必须是可保存的数据`); }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_VALUE_BYTES) throw new Error(`${label}内容过大`);
  try { return JSON.parse(encoded); } catch { throw new Error(`${label}格式不合法`); }
}

function sourceIdsOf(value, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > MAX_SOURCES || value.some(id => typeof id !== 'string' || !id || id.length > 256)) {
    throw new Error('监测任务来源数量或格式不合法');
  }
  const ids = [...new Set(value)];
  if (required && ids.length === 0) throw new Error('持久监测任务必须保留用户交办来源');
  return ids;
}

function sameSet(a, b) {
  const left = [...a].sort(), right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stamp(value, fallback, label) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label}时间不合法`);
  return result;
}

function createWatchJournal(memory) {
  const assertReady = () => { memory.check(); };
  const assertEpoch = epoch => {
    if (!Number.isSafeInteger(epoch) || epoch !== memory.generation) throw new Error('监测任务隐私版本已变更，停止写入');
  };

  async function getRaw(id) {
    const row = (await memory.db.request('get', { ids: [id] })).rows[0];
    return row ? memory.decode(row) : null;
  }

  async function loadWatch(watch) {
    const current = await getRaw(watch.id);
    if (!current || current.kind !== 'task' || current.value.taskType !== 'watch') throw new Error('监测任务已删除或不存在');
    if (current.value.privacyEpoch !== watch.privacyEpoch || !sameSet(current.value.sources || [], watch.sources || [])) {
      throw new Error('监测任务来源或隐私版本已变更');
    }
    const sources = sourceIdsOf(current.value.sources, { required: true });
    const existing = await memory.db.request('get', { ids: sources });
    if (existing.rows.length !== sources.length) throw new Error('监测任务来源已删除');
    return current;
  }

  async function saveWatch(watch) {
    assertReady();
    const input = cloneValue(watch, '监测任务');
    if (typeof input.id !== 'string' || !input.id || input.id.length > 256) throw new Error('监测任务 ID 不合法');
    assertEpoch(input.privacyEpoch);
    const sources = sourceIdsOf(input.sources, { required: true });
    return memory.serial(async () => {
      assertEpoch(input.privacyEpoch);
      const sourceRows = await memory.db.request('get', { ids: sources });
      if (sourceRows.rows.length !== sources.length) throw new Error('监测任务来源已删除或不存在');
      const existing = await getRaw(input.id);
      if (existing) {
        if (existing.kind !== 'task' || existing.value.taskType !== 'watch') throw new Error('监测任务 ID 已被其他记录占用');
        if (!sameSet(existing.value.sources || [], sources)) throw new Error('监测任务来源不可在更新时替换');
        if (existing.value.privacyEpoch !== input.privacyEpoch) throw new Error('旧监测任务隐私版本已变更');
      }
      const value = { ...input, id: input.id, taskType: 'watch', privacyEpoch: input.privacyEpoch, sources };
      value.content = typeof value.content === 'string' ? value.content : [value.goal, value.note].filter(Boolean).join('\n');
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) throw new Error('监测任务内容过大');
      const ts = stamp(value.startedAt, memory.clock(), '监测任务');
      const updatedAt = memory.clock();
      await memory.write([{ id: input.id, kind: 'task', ts, updatedAt, value }]);
      return { ...value, ts, updatedAt };
    });
  }

  async function listWatches() {
    assertReady();
    return memory.serial(async () => {
      const watches = [];
      let cursor = {};
      for (;;) {
        const page = await memory.query('task', 200, { ...cursor, state: 'all' });
        for (const row of page) if (row.value.taskType === 'watch') {
          watches.push({ ...row.value, id: row.id, ts: row.ts, updatedAt: row.updatedAt });
        }
        if (page.length < 200) break;
        const last = page.at(-1);
        cursor = { before: last.ts, beforeId: last.id };
      }
      return watches;
    });
  }

  function eventId(watchId, identityString) {
    assertReady();
    if (typeof watchId !== 'string' || !watchId || watchId.length > 256 || typeof identityString !== 'string' ||
        !identityString || Buffer.byteLength(identityString, 'utf8') > 8192) throw new Error('监测事件身份不合法');
    return recordId(memory.key, 'watch-event', `${watchId}\0${identityString}`);
  }

  async function saveEvent(watch, event) {
    assertReady();
    const input = cloneValue(event, '监测事件');
    assertEpoch(watch?.privacyEpoch);
    if (typeof watch?.id !== 'string' || !watch.id || typeof input.identityString !== 'string' || !input.identityString) {
      throw new Error('监测事件缺少任务或稳定身份');
    }
    const id = eventId(watch.id, input.identityString);
    if (input.id !== undefined && input.id !== id) throw new Error('监测事件 ID 与稳定身份不匹配');
    if (typeof input.phase !== 'string' || !input.phase.trim() || input.phase.length > 80) throw new Error('监测事件阶段不合法');
    const phase = input.phase;
    delete input.identityString;
    delete input.id;
    delete input.taskType;
    delete input.watchId;
    delete input.privacyEpoch;
    delete input.sources;
    return memory.serial(async () => {
      assertEpoch(watch.privacyEpoch);
      const root = await loadWatch(watch);
      const existing = await getRaw(id);
      let value;
      if (existing) {
        if (existing.kind !== 'task' || existing.value.taskType !== 'watch-event' || existing.value.watchId !== watch.id) {
          throw new Error('监测事件 ID 已被其他记录占用');
        }
        value = { ...existing.value, ...input, phase, id, watchId: watch.id,
          taskType: 'watch-event', privacyEpoch: watch.privacyEpoch, sources: [watch.id] };
      } else {
        value = { ...input, phase, id, watchId: watch.id, taskType: 'watch-event',
          privacyEpoch: watch.privacyEpoch, sources: [watch.id] };
      }
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) throw new Error('监测事件内容过大');
      const ts = stamp(existing?.ts, stamp(input.ts ?? input.occurredAt, memory.clock(), '监测事件'), '监测事件');
      const updatedAt = memory.clock();
      await memory.write([{ id, kind: 'task', ts, updatedAt, value }]);
      return { ...value, ts, updatedAt };
    });
  }

  async function getEvent(id) {
    assertReady();
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('监测事件 ID 不合法');
    return memory.serial(async () => {
      const event = await getRaw(id);
      if (!event || event.kind !== 'task' || event.value.taskType !== 'watch-event') return null;
      if (event.value.privacyEpoch !== memory.generation) throw new Error('监测事件隐私版本已变更');
      return { ...event.value, id: event.id, ts: event.ts, updatedAt: event.updatedAt };
    });
  }

  async function receipt(event, text) {
    assertReady();
    if (!event || typeof event.id !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 12000) {
      throw new Error('监测事件汇报格式不合法');
    }
    const epoch = memory.generation;
    const verified = await memory.serial(async () => {
      const stored = await getRaw(event.id);
      if (!stored || stored.kind !== 'task' || stored.value.taskType !== 'watch-event') throw new Error('监测事件已删除或不存在');
      assertEpoch(stored.value.privacyEpoch);
      const watch = await getRaw(stored.value.watchId);
      if (!watch || watch.kind !== 'task' || watch.value.taskType !== 'watch' || watch.value.privacyEpoch !== epoch) {
        throw new Error('监测任务已删除或隐私版本已变更');
      }
      return stored;
    });
    const id = recordId(memory.key, 'watch-receipt', verified.id);
    return memory.addMessageOnce(id, 'assistant', text, {
      delivery: 'task-receipt', sources: [verified.id], privacyEpoch: epoch,
    });
  }

  return { saveWatch, listWatches, eventId, saveEvent, getEvent, receipt };
}

module.exports = { createWatchJournal };
