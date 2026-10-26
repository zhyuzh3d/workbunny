'use strict';

const crypto = require('crypto');
const { SCENES, rank, scopeOf, withSources } = require('./memory-scope');

const MAX_VALUE_BYTES = 1_400_000;
const MAX_SOURCES = 200;

function recordId(key, namespace, value) {
  return `wb-${namespace}-${crypto.createHmac('sha256', key)
    .update(`workbunny:${namespace}:v1\0${value}`, 'utf8').digest('base64url')}`;
}
function stableReceiptId(eventId) {
  return `wb-watch-receipt-v2-${crypto.createHash('sha256').update(`workbunny:watch-receipt:v2\0${eventId}`, 'utf8').digest('base64url')}`;
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

  async function loadWatchRoot(id, { generation = memory.generation, requireCurrent = true } = {}) {
    assertEpoch(generation);
    const current = await getRaw(id);
    assertEpoch(generation);
    if (!current || current.kind !== 'task' || current.value.taskType !== 'watch' || current.id !== id) throw new Error('监测任务已删除或不存在');
    const sources = sourceIdsOf(current.value.sources, { required: true });
    const sourceResult = await memory.db.request('get', { ids: sources });
    assertEpoch(generation);
    if (sourceResult.rows.length !== sources.length) throw new Error('监测任务来源已删除');
    const parents = sourceResult.rows.map(row => memory.decode(row));
    const scene = current.value.scene ?? current.domain ?? 'private';
    const domain = current.value.domain ?? current.domain ?? scene;
    const visibilityFloor = current.value.visibilityFloor ?? current.visibilityFloor ?? rank(domain);
    if (!SCENES.includes(scene) || domain !== scene || !Number.isInteger(visibilityFloor) || visibilityFloor < rank(domain) || visibilityFloor > 2) {
      throw new Error('持续关注场景范围不合法');
    }
    withSources(domain, parents, visibilityFloor);
    if (requireCurrent) assertEpoch(current.value.privacyEpoch);
    return { current, sources, scene, domain, visibilityFloor };
  }

  async function loadWatch(watch) {
    const loaded = await loadWatchRoot(watch.id);
    if (loaded.current.value.privacyEpoch !== watch.privacyEpoch || !sameSet(loaded.sources, watch.sources || [])) {
      throw new Error('监测任务来源或隐私版本已变更');
    }
    return loaded.current;
  }

  async function loadAuthorizedEvent(id, generation = memory.generation) {
    assertEpoch(generation);
    const event = await getRaw(id);
    assertEpoch(generation);
    if (!event || event.kind !== 'task' || event.value.taskType !== 'watch-event' || event.id !== id || typeof event.value.watchId !== 'string') return null;
    const root = await loadWatchRoot(event.value.watchId, { generation, requireCurrent: true });
    const eventSources = sourceIdsOf(event.value.sources, { required: true });
    if (eventSources.length !== 1 || eventSources[0] !== event.value.watchId) throw new Error('监测事件来源与任务不匹配');
    const scene = event.value.scene ?? event.domain ?? 'private';
    const domain = event.value.domain ?? event.domain ?? scene;
    const visibilityFloor = event.value.visibilityFloor ?? event.visibilityFloor ?? 2;
    if (scene !== root.scene || domain !== root.domain || visibilityFloor !== root.visibilityFloor) throw new Error('监测事件场景范围与任务不匹配');
    assertEpoch(generation);
    return { event, root };
  }

  async function restoreWatch(id) {
    assertReady();
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('监测任务 ID 不合法');
    const generation = memory.generation;
    return memory.serial(async () => {
      assertEpoch(generation);
      const loaded = await loadWatchRoot(id, { generation, requireCurrent: false });
      const value = loaded.current.value;
      if (typeof value.recipient !== 'string' || !value.recipient.trim() || value.recipient.length > 100 ||
          typeof value.goal !== 'string' || !value.goal.trim() || typeof value.policy !== 'string' ||
          !['notify', 'reply'].includes(value.mode)) throw new Error('监测任务内容不完整');
      const now = memory.clock();
      const preservedTerminal = ['stopped', 'expired'].includes(value.status);
      const note = preservedTerminal || value.userInterventionAt ? String(value.note || '持续关注保持暂停')
        : value.pendingSend ? '应用已恢复；上次发送结果不确定，已暂停且不会重发。请先核对微信。'
          : '应用已恢复；已重建当前基线，不自动回复离线期间的消息。';
      const restored = { ...value, scene: loaded.scene, domain: loaded.domain, visibilityFloor: loaded.visibilityFloor,
        privacyEpoch: generation, status: preservedTerminal ? value.status : 'paused', note, baseline: [], baselineReady: false, bound: false,
        updatedAt: now, content: [value.goal, note].filter(Boolean).join('\n') };
      assertEpoch(generation);
      const [saved] = await memory.write([{ id, kind: 'task', ts: loaded.current.ts, updatedAt: now,
        domain: loaded.domain, visibilityFloor: loaded.visibilityFloor, value: restored }]);
      assertEpoch(generation);
      return { ...restored, id, ts: saved.ts, updatedAt: saved.updatedAt };
    });
  }

  async function saveWatch(watch) {
    assertReady();
    const input = cloneValue(watch, '监测任务');
    if (typeof input.id !== 'string' || !input.id || input.id.length > 256) throw new Error('监测任务 ID 不合法');
    assertEpoch(input.privacyEpoch);
    if (!SCENES.includes(input.scene) || input.domain !== input.scene ||
        !Number.isInteger(input.visibilityFloor) || input.visibilityFloor < rank(input.scene) || input.visibilityFloor > 2) {
      throw new Error('持续关注场景范围不合法');
    }
    const sources = sourceIdsOf(input.sources, { required: true });
    return memory.serial(async () => {
      assertEpoch(input.privacyEpoch);
      const sourceRows = await memory.db.request('get', { ids: sources });
      assertEpoch(input.privacyEpoch);
      if (sourceRows.rows.length !== sources.length) throw new Error('监测任务来源已删除或不存在');
      const existing = await getRaw(input.id);
      assertEpoch(input.privacyEpoch);
      if (existing) {
        if (existing.kind !== 'task' || existing.value.taskType !== 'watch') throw new Error('监测任务 ID 已被其他记录占用');
        if (!sameSet(existing.value.sources || [], sources)) throw new Error('监测任务来源不可在更新时替换');
        if (existing.value.privacyEpoch !== input.privacyEpoch) throw new Error('旧监测任务隐私版本已变更');
        const legacyUnscoped = existing.value.scene === undefined && existing.value.domain === undefined && existing.value.visibilityFloor === undefined;
        if (legacyUnscoped ? input.scene !== 'private' || input.domain !== 'private' || input.visibilityFloor !== 2
          : existing.value.scene !== input.scene || existing.value.domain !== input.domain || existing.value.visibilityFloor !== input.visibilityFloor) {
          throw new Error('持续关注场景范围创建后不可变更');
        }
      }
      const value = { ...input, id: input.id, taskType: 'watch', privacyEpoch: input.privacyEpoch, sources };
      value.content = typeof value.content === 'string' ? value.content : [value.goal, value.note].filter(Boolean).join('\n');
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) throw new Error('监测任务内容过大');
      const ts = stamp(value.startedAt, memory.clock(), '监测任务');
      const updatedAt = memory.clock();
      await memory.write([{ id: input.id, kind: 'task', ts, updatedAt, domain: input.domain, visibilityFloor: input.visibilityFloor, value }]);
      assertEpoch(input.privacyEpoch);
      return { ...value, ts, updatedAt };
    });
  }

  async function listWatches() {
    assertReady();
    return memory.serial(async () => {
      const watches = [];
      let cursor = {};
      for (;;) {
        // This is an internal restore path; UI exposure and execution are
        // filtered again by WatchService's current-scene scope gate.
        const page = await memory.query('task', 200, { ...cursor, state: 'all', scene: null });
        for (const row of page) if (row.value.taskType === 'watch') {
          const domain = row.value.domain || row.domain || 'private';
          watches.push({ ...row.value, scene: row.value.scene || 'private', domain,
            visibilityFloor: row.value.visibilityFloor ?? row.visibilityFloor ?? 2,
            id: row.id, ts: row.ts, updatedAt: row.updatedAt });
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
    delete input.receiptVersion;
    delete input.receiptId;
    return memory.serial(async () => {
      assertEpoch(watch.privacyEpoch);
      const root = await loadWatch(watch);
      const existing = await getRaw(id);
      assertEpoch(watch.privacyEpoch);
      let value;
      if (existing) {
        if (existing.kind !== 'task' || existing.value.taskType !== 'watch-event' || existing.value.watchId !== watch.id) {
          throw new Error('监测事件 ID 已被其他记录占用');
        }
        const authorized = await loadAuthorizedEvent(id, watch.privacyEpoch);
        if (!authorized || authorized.root.current.id !== root.id) throw new Error('监测事件来源或场景范围已变更');
        value = { ...existing.value, ...input, phase, id, watchId: watch.id,
          scene: watch.scene, domain: watch.domain, visibilityFloor: watch.visibilityFloor,
          taskType: 'watch-event', privacyEpoch: watch.privacyEpoch, sources: [watch.id] };
      } else {
        value = { ...input, phase, id, watchId: watch.id, scene: watch.scene, domain: watch.domain,
          visibilityFloor: watch.visibilityFloor, taskType: 'watch-event',
          privacyEpoch: watch.privacyEpoch, sources: [watch.id] };
      }
      if (!existing) { value.receiptVersion = 2; value.receiptId = stableReceiptId(id); }
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) throw new Error('监测事件内容过大');
      const ts = stamp(existing?.ts, stamp(input.ts ?? input.occurredAt, memory.clock(), '监测事件'), '监测事件');
      const updatedAt = memory.clock();
      assertEpoch(watch.privacyEpoch);
      await memory.write([{ id, kind: 'task', ts, updatedAt, domain: watch.domain, visibilityFloor: watch.visibilityFloor, value }]);
      assertEpoch(watch.privacyEpoch);
      return { ...value, ts, updatedAt };
    });
  }

  async function getEvent(id) {
    assertReady();
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('监测事件 ID 不合法');
    return memory.serial(async () => {
      const generation = memory.generation;
      const loaded = await loadAuthorizedEvent(id, generation);
      if (!loaded) return null;
      return { ...loaded.event.value, scene: loaded.root.scene, domain: loaded.root.domain,
        visibilityFloor: loaded.root.visibilityFloor, privacyEpoch: generation,
        id: loaded.event.id, ts: loaded.event.ts, updatedAt: loaded.event.updatedAt };
    });
  }

  async function findLegacyReceipt(eventId, text) {
    let cursor = {};
    for (;;) {
      // Legacy receipt recovery is lineage-scoped. Never decrypt/page through
      // unrelated vault messages just to find a derived receipt.
      const rows = await memory.query('message', 200, { ...cursor, state: 'all', scene: null, sourceId: eventId });
      const matches = rows.filter(row => row.value?.delivery === 'task-receipt' &&
        Array.isArray(row.value.sources) && row.value.sources.length === 1 && row.value.sources[0] === eventId);
      if (matches.length) {
        const exact = matches.find(row => row.value.content === text);
        if (!exact || matches.some(row => row.value.content !== text)) throw new Error('监测事件已有内容不同的receipt');
        return exact;
      }
      if (rows.length < 200) return null;
      const last = rows.at(-1); cursor = { before: last.ts, beforeId: last.id };
    }
  }

  async function markReceipt(eventId, receiptId, generation) {
    return memory.serial(async () => {
      assertEpoch(generation);
      const loaded = await loadAuthorizedEvent(eventId, generation);
      if (!loaded) throw new Error('监测事件已删除或不存在');
      const oldReceiptId = loaded.event.value.receiptId;
      if (loaded.event.value.receiptVersion === 2 && oldReceiptId !== receiptId) throw new Error('监测事件receipt身份不匹配');
      if (loaded.event.value.receiptVersion === 2) return;
      const value = { ...loaded.event.value, receiptVersion: 2, receiptId, privacyEpoch: generation,
        scene: loaded.root.scene, domain: loaded.root.domain, visibilityFloor: loaded.root.visibilityFloor };
      const updatedAt = memory.clock();
      await memory.write([{ id: eventId, kind: 'task', ts: loaded.event.ts, updatedAt,
        domain: loaded.root.domain, visibilityFloor: loaded.root.visibilityFloor, value }]);
      assertEpoch(generation);
    });
  }

  async function receipt(event, text) {
    assertReady();
    if (!event || typeof event.id !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 12000) {
      throw new Error('监测事件汇报格式不合法');
    }
    const epoch = memory.generation;
    const verified = await memory.serial(async () => {
      assertEpoch(epoch);
      const loaded = await loadAuthorizedEvent(event.id, epoch);
      if (!loaded) throw new Error('监测事件已删除或不存在');
      assertEpoch(epoch);
      return loaded;
    });
    let receiptId = verified.event.value.receiptVersion === 2
      ? verified.event.value.receiptId : stableReceiptId(verified.event.id);
    if (verified.event.value.receiptVersion === 2 && receiptId !== stableReceiptId(verified.event.id) &&
        (typeof receiptId !== 'string' || !/^wb-watch-receipt-[A-Za-z0-9_-]{43}$/u.test(receiptId))) {
      throw new Error('监测事件receipt身份不合法');
    }
    if (verified.event.value.receiptVersion !== 2) {
      const legacy = await findLegacyReceipt(verified.event.id, text);
      if (legacy) receiptId = legacy.id;
      await markReceipt(verified.event.id, receiptId, epoch);
    }
    return memory.addMessageOnce(receiptId, 'assistant', text, {
      delivery: 'task-receipt', sources: [verified.event.id], privacyEpoch: epoch,
      scene: verified.root.scene, domain: verified.root.domain, visibilityFloor: verified.root.visibilityFloor,
    });
  }

  return { saveWatch, restoreWatch, listWatches, eventId, saveEvent, getEvent, receipt };
}

module.exports = { createWatchJournal };
