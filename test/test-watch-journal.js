'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MemoryService } = require('../src/main/memory-service');
const { createWatchJournal } = require('../src/main/watch-journal');
const { WatchService } = require('../src/main/watch-service');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const services = new Set();
const safeStorageKey = crypto.randomBytes(32);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function stubSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', safeStorageKey, nonce);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]);
    },
    decryptString(envelope) {
      const nonce = envelope.subarray(0, 12), tag = envelope.subarray(12, 28), data = envelope.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', safeStorageKey, nonce); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}

async function openMemory(dir, safeStorage) {
  const memory = new MemoryService({ dir, bin, safeStorage, getSettings: () => ({ enabled: true, extract: false }) });
  services.add(memory);
  await memory.init();
  assert(memory.ready, `isolated MemoryService failed to open: ${memory.error}`);
  return memory;
}

async function testWatchAndEvents(temp, safeStorage) {
  const dir = path.join(temp, 'watch-vault');
  const memory = await openMemory(dir, safeStorage);
  const source = await memory.addMessage('user', '请持续监测联系人阿岚的新消息，并按约定回复后告诉我。');
  const watchId = crypto.randomUUID();
  const watch = {
    id: watchId, taskType: 'forged-type', privacyEpoch: memory.generation,
    sources: [source.id], status: 'monitoring', recipient: '阿岚', goal: '监测指定会话并汇报',
    note: '等待新消息', startedAt: memory.clock(), scene: 'life', domain: 'life', visibilityFloor: 1,
  };
  const journal = createWatchJournal(memory);
  const savedWatch = await journal.saveWatch(watch);
  assert.equal(savedWatch.taskType, 'watch', 'journal owns the root task type');
  assert.deepEqual(savedWatch.sources, [source.id]);
  assert.deepEqual([savedWatch.scene, savedWatch.domain, savedWatch.visibilityFloor], ['life', 'life', 1]);
  assert.deepEqual((await journal.listWatches()).map(row => row.id), [watchId], 'only watch roots are listed');

  const legacyWatchId = 'legacy-unscoped-watch';
  await memory.write([{ id: legacyWatchId, kind: 'task', ts: memory.clock(), domain: 'private', visibilityFloor: 2,
    value: { taskType: 'watch', privacyEpoch: memory.generation, sources: [source.id], status: 'paused', startedAt: memory.clock() } }]);
  const legacy = (await journal.listWatches()).find(row => row.id === legacyWatchId);
  assert.deepEqual([legacy.scene, legacy.domain, legacy.visibilityFloor], ['private', 'private', 2], 'legacy watch scope defaults conservatively to private');
  const upgraded = await journal.saveWatch(legacy);
  assert.deepEqual([upgraded.scene, upgraded.domain, upgraded.visibilityFloor], ['private', 'private', 2], 'legacy watch can only be upgraded without lowering its scope');

  const identity = ['阿岚', '2026-10-26T10:00', '今天晚点到'].join('\0');
  const eventId = journal.eventId(watchId, identity);
  assert.equal(eventId, journal.eventId(watchId, identity), 'same identity maps to the same HMAC ID');
  assert.notEqual(eventId, journal.eventId(watchId, identity + 'x'));
  assert(!eventId.includes('今天晚点到'), 'event ID does not expose its identity string');
  const eventText = 'SYNTHETIC-PRIVATE-MESSAGE-阿岚-今天晚点到';
  const event = await journal.saveEvent(savedWatch, {
    id: eventId, identityString: identity, taskType: 'forged', watchId: 'wrong',
    privacyEpoch: -1, sources: ['forged-source'], phase: 'reply_intent',
    content: eventText, occurredAt: memory.clock(),
  });
  assert.equal(event.taskType, 'watch-event');
  assert.equal(event.watchId, watchId);
  assert.deepEqual(event.sources, [watchId], 'event lineage is fixed to its watch');
  assert.equal(event.privacyEpoch, memory.generation);
  assert.equal(event.phase, 'reply_intent', 'event phase is caller-owned');
  assert.equal('identityString' in event, false, 'raw identity string is not persisted');
  assert.equal((await journal.listWatches()).length, 2, 'event records are excluded from watch roots');

  const updated = await journal.saveEvent(savedWatch, { identityString: identity, phase: 'send_unknown', note: '送出结果不明' });
  assert.equal(updated.id, eventId);
  assert.equal(updated.phase, 'send_unknown');
  assert.equal(updated.content, eventText, 'phase update preserves prior event payload');
  assert.equal((await journal.getEvent(eventId)).phase, 'send_unknown');
  await assert.rejects(journal.saveEvent(savedWatch, { id: eventId, identityString: identity + 'x', phase: 'sent_confirmed' }), /不匹配/);

  const reportText = '已收到阿岚的新消息，暂未自动发送回复。';
  const first = await journal.receipt(updated, reportText);
  assert.equal(first.inserted, true);
  assert.equal(first.record.value.delivery, 'task-receipt');
  assert.deepEqual([first.record.domain, first.record.visibilityFloor], ['life', 1]);
  assert.deepEqual(first.record.value.sources, [eventId]);
  const second = await journal.receipt(updated, reportText);
  assert.equal(second.inserted, false, 'repeated event receipt is idempotent');
  assert.equal(second.record.id, first.record.id);
  await assert.rejects(journal.receipt(updated, reportText + '修改'), /内容或来源不一致/);
  await assert.rejects(memory.addMessageOnce(first.record.id, 'assistant', reportText, { sources: [] }), /内容或来源不一致/);
  await assert.rejects(memory.addMessageOnce('missing-source-receipt', 'assistant', 'no source', { sources: ['missing'] }), /来源已删除/);

  const onceUser = await memory.addMessageOnce('once-user-record', 'user', '这是幂等用户消息');
  const repeatedUser = await memory.addMessageOnce('once-user-record', 'user', '这是幂等用户消息');
  assert.equal(onceUser.inserted, true);
  assert.equal(repeatedUser.inserted, false);
  assert.equal(repeatedUser.record.value.userOrdinal, onceUser.record.value.userOrdinal);

  await memory.close(); services.delete(memory);
  const bytes = ['companion.db', 'companion.db-wal', 'companion.db-shm']
    .filter(name => fs.existsSync(path.join(dir, name)))
    .map(name => fs.readFileSync(path.join(dir, name)));
  const stored = Buffer.concat(bytes).toString('utf8');
  assert(!stored.includes(eventText), 'event bodies are encrypted at rest');
  assert(!stored.includes(reportText), 'receipt bodies are encrypted at rest');

  const reopened = await openMemory(dir, safeStorage);
  const reopenedJournal = createWatchJournal(reopened);
  const watches = await reopenedJournal.listWatches();
  assert.equal(watches.length, 2);
  assert.equal((await reopenedJournal.getEvent(eventId)).phase, 'send_unknown', 'event phase survives restart');
  const duplicate = await reopenedJournal.receipt(await reopenedJournal.getEvent(eventId), reportText);
  assert.equal(duplicate.inserted, false, 'receipt dedupe survives restart');
  const allMessages = await reopened.query('message', 200, { state: 'all' });
  assert.equal(allMessages.filter(row => row.id === first.record.id).length, 1);

  const removed = await reopened.remove(source.id);
  assert(removed.removed >= 4, 'forgetting the user source cascades to watch, event and receipt');
  assert.equal(await reopenedJournal.getEvent(eventId), null);
  assert.deepEqual(await reopenedJournal.listWatches(), []);
  assert.equal((await reopened.db.request('get', { ids: [watchId, eventId, first.record.id] })).rows.length, 0);
  await assert.rejects(reopenedJournal.saveWatch(savedWatch), /隐私版本已变更/);
}

async function testStaleAndMissingSources(temp, safeStorage) {
  const memory = await openMemory(path.join(temp, 'invalid-watch-vault'), safeStorage);
  const journal = createWatchJournal(memory);
  const source = await memory.addMessage('user', '请监测我的测试会话。');
  const watch = { id: crypto.randomUUID(), privacyEpoch: memory.generation, sources: [source.id], status: 'monitoring', startedAt: memory.clock(), scene: 'life', domain: 'life', visibilityFloor: 1 };
  await assert.rejects(journal.saveWatch({ ...watch, sources: ['missing-source'] }), /已删除或不存在/);
  await assert.rejects(journal.saveWatch({ ...watch, privacyEpoch: memory.generation + 1 }), /隐私版本已变更/);
  const saved = await journal.saveWatch(watch);
  memory.generation++;
  await assert.rejects(journal.saveEvent(saved, { identityString: 'new-event', phase: 'detected' }), /隐私版本已变更/);
  await memory.close(); services.delete(memory);
}

async function testRestoreRebindsWatchAndOldEventAcrossRestartAndBackup(temp, safeStorage) {
  const dir = path.join(temp, 'rebind-source-vault');
  const memory = await openMemory(dir, safeStorage);
  const warm = await memory.addMessage('user', '合成的generation递增前置记录一。');
  await memory.remove(warm.id);
  const unrelated = await memory.addMessage('user', '合成的generation递增前置记录二。');
  const source = await memory.addMessage('user', '仅用于isolated watch restore fixture的来源。');
  assert.equal(memory.generation, 1);

  const journal = createWatchJournal(memory);
  const watchId = crypto.randomUUID();
  const identityString = JSON.stringify(['fixture incoming', 'send uncertain']);
  const eventId = journal.eventId(watchId, identityString);
  const reportText = '隔离fixture：发送结果不确定，请核对。';
  const watch = await journal.saveWatch({ id: watchId, privacyEpoch: memory.generation, sources: [source.id],
    taskType: 'watch', target: 'wechat', recipient: 'fixture contact', goal: 'isolate restore rebind', criteria: '',
    mode: 'reply', policy: 'no real UI', status: 'monitoring', note: 'fixture', startedAt: memory.clock(),
    scene: 'life', domain: 'life', visibilityFloor: 1, pendingSend: eventId, pendingSendReported: true,
    pendingEventIds: [], pendingReports: [] });
  const event = await journal.saveEvent(watch, { identityString, phase: 'send_unknown', message: 'synthetic only' });
  const firstReceipt = await journal.receipt(event, reportText);
  assert.equal(firstReceipt.inserted, true);

  // Model an older vault entry whose receipt ID was HMAC-derived from the
  // source vault key and whose event has no receipt-version marker.
  const legacyIdentity = 'legacy receipt identity';
  const legacyEventId = journal.eventId(watchId, legacyIdentity);
  const legacyText = '隔离fixture：旧版幂等receipt。';
  await journal.saveEvent(watch, { identityString: legacyIdentity, phase: 'observed', message: 'legacy synthetic only' });
  const legacyRow = (await memory.db.request('get', { ids: [legacyEventId] })).rows[0];
  const legacyEvent = memory.decode(legacyRow);
  const legacyValue = { ...legacyEvent.value };
  delete legacyValue.receiptVersion; delete legacyValue.receiptId;
  await memory.write([{ id: legacyEventId, kind: 'task', ts: legacyRow.ts, domain: legacyEvent.domain,
    visibilityFloor: legacyEvent.visibilityFloor, value: legacyValue }]);
  const legacyReceiptId = `wb-watch-receipt-${crypto.createHmac('sha256', memory.key)
    .update(`workbunny:watch-receipt:v1\0${legacyEventId}`, 'utf8').digest('base64url')}`;
  await memory.addMessageOnce(legacyReceiptId, 'assistant', legacyText, { delivery: 'task-receipt', sources: [legacyEventId],
    privacyEpoch: memory.generation, scene: 'life', domain: 'life', visibilityFloor: 1 });

  // A write already in flight under an old memory generation must still fail.
  const request = memory.db.request.bind(memory.db);
  const entered = deferred(), release = deferred();
  let blocked = false;
  memory.db.request = (op, args) => {
    if (!blocked && op === 'get' && args?.ids?.includes(watchId)) {
      blocked = true; entered.resolve();
      return release.promise.then(() => request(op, args));
    }
    return request(op, args);
  };
  const oldWrite = journal.saveEvent(watch, { identityString: 'old inflight write', phase: 'observed' });
  await entered.promise;
  const removed = memory.remove(unrelated.id); // increments generation before joining the serialized database tail
  assert.equal(memory.generation, 2);
  release.resolve();
  await assert.rejects(oldWrite, /隐私版本已变更/);
  await removed;
  memory.db.request = request;

  const currentRoot = await journal.restoreWatch(watchId);
  assert.equal(currentRoot.privacyEpoch, 2);
  assert.equal(currentRoot.status, 'paused');
  assert.equal(currentRoot.pendingSend, eventId);
  assert.equal((await journal.getEvent(eventId)).privacyEpoch, 2, 'old event is read through its rebound current root');
  assert.equal((await journal.receipt(await journal.getEvent(eventId), reportText)).inserted, false);
  const originalQuery = memory.query.bind(memory), queryFilters = [];
  memory.query = async (kind, limit, cursor) => { queryFilters.push({ kind, ...cursor }); return originalQuery(kind, limit, cursor); };
  assert.equal((await journal.receipt(await journal.getEvent(legacyEventId), legacyText)).inserted, false,
    'legacy HMAC receipt is found by event source after rebind');
  memory.query = originalQuery;
  assert(queryFilters.some(query => query.kind === 'message' && query.sourceId === legacyEventId && query.scene === null),
    'legacy receipt lookup uses sourceId-indexed vault query rather than decrypting unrelated messages');

  // This malformed root is still structurally writable, but restoreWatch must
  // reject it without preventing other valid roots from restoring.
  const badRootId = 'missing-source-watch-fixture';
  await memory.write([{ id: badRootId, kind: 'task', ts: memory.clock(), domain: 'life', visibilityFloor: 1,
    value: { taskType: 'watch', privacyEpoch: memory.generation, sources: [], scene: 'life', domain: 'life', visibilityFloor: 1,
      recipient: 'bad fixture', goal: 'invalid', mode: 'notify', policy: '', status: 'waiting', startedAt: memory.clock() } }]);
  await assert.rejects(journal.restoreWatch(badRootId), /保留用户交办来源/);

  const passphrase = 'isolated-watch-rebind-backup-passphrase';
  const backup = await memory.export(passphrase);
  await memory.close(); services.delete(memory);

  const reopened = await openMemory(dir, safeStorage);
  assert.equal(reopened.generation, 0, 'a process restart begins with a fresh in-memory generation');
  const reopenedJournal = createWatchJournal(reopened);
  const calls = { send: 0, report: 0 };
  const service = new WatchService({ journal: reopenedJournal, getScene: () => 'private', epoch: () => reopened.generation,
    ready: () => true, autoSchedule: false,
    sensor: { async forget() {}, async sample() { throw new Error('paused restore must not sample'); }, async close() {} },
    inspect: async () => { throw new Error('paused restore must not inspect'); },
    execute: async (_watch, request) => { if (request.operation === 'send') calls.send++; return { ok: true }; },
    propose: async () => ({ reply: 'never reached' }), report: async () => { calls.report++; } });
  const result = await service.restore();
  assert.equal(result.restored, 1);
  assert.equal(result.skipped.length, 1, 'only the malformed row is skipped');
  assert(result.skipped.includes(badRootId), 'malformed row is skipped without blocking a valid watch');
  assert.equal(service.items.get(watchId).privacyEpoch, 0);
  assert.equal(service.items.get(watchId).status, 'paused');
  assert.equal(service.items.get(watchId).pendingSend, eventId);
  assert.equal((await reopenedJournal.getEvent(eventId)).privacyEpoch, 0);
  assert.equal((await reopenedJournal.receipt(await reopenedJournal.getEvent(eventId), reportText)).inserted, false);
  assert.equal((await reopenedJournal.receipt(await reopenedJournal.getEvent(legacyEventId), legacyText)).inserted, false,
    'legacy receipt remains idempotent across app restart with a different process generation');
  await service.tick(watchId);
  assert.deepEqual(calls, { send: 0, report: 0 }, 'unknown send and existing receipt are not replayed or reported twice');
  await assert.rejects(reopenedJournal.saveEvent(watch, { identityString: 'stale caller', phase: 'observed' }), /隐私版本已变更/);
  await service.close();

  const restoredVault = await openMemory(path.join(temp, 'rebind-backup-target'), safeStorage);
  const restoreResult = await restoredVault.restore(backup, passphrase);
  assert(restoreResult.records > 0);
  assert.equal(restoredVault.generation, 1, 'backup restore installs a new in-process generation');
  const restoredJournal = createWatchJournal(restoredVault);
  const backupRoot = await restoredJournal.restoreWatch(watchId);
  assert.equal(backupRoot.privacyEpoch, 1);
  assert.equal(backupRoot.status, 'paused');
  assert.equal((await restoredJournal.getEvent(eventId)).privacyEpoch, 1,
    'event epoch can differ from restored root and is projected through verified root scope');
  assert.equal((await restoredJournal.receipt(await restoredJournal.getEvent(eventId), reportText)).inserted, false);
  assert.equal((await restoredJournal.receipt(await restoredJournal.getEvent(legacyEventId), legacyText)).inserted, false,
    'legacy receipt remains idempotent after backup import into a vault with a different key');
  await restoredVault.close(); services.delete(restoredVault);
  await reopened.close(); services.delete(reopened);
}

async function main() {
  execFileSync(path.join(__dirname, '../tools/build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-watch-journal-'));
  const safeStorage = stubSafeStorage();
  try {
    await testWatchAndEvents(temp, safeStorage);
    await testStaleAndMissingSources(temp, safeStorage);
    await testRestoreRebindsWatchAndOldEventAcrossRestartAndBackup(temp, safeStorage);
    console.log('Watch journal integration checks passed');
  } finally {
    await Promise.all([...services].map(service => service.close().catch(() => {})));
    fs.rmSync(temp, { recursive: true, force: true });
    safeStorageKey.fill(0);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
