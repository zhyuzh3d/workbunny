'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MemoryService } = require('../src/main/memory-service');
const { createWatchJournal } = require('../src/main/watch-journal');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const services = new Set();
const safeStorageKey = crypto.randomBytes(32);

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
    note: '等待新消息', startedAt: memory.clock(),
  };
  const journal = createWatchJournal(memory);
  const savedWatch = await journal.saveWatch(watch);
  assert.equal(savedWatch.taskType, 'watch', 'journal owns the root task type');
  assert.deepEqual(savedWatch.sources, [source.id]);
  assert.deepEqual((await journal.listWatches()).map(row => row.id), [watchId], 'only watch roots are listed');

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
  assert.equal((await journal.listWatches()).length, 1, 'event records are excluded from watch roots');

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
  assert.equal(watches.length, 1);
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
  const watch = { id: crypto.randomUUID(), privacyEpoch: memory.generation, sources: [source.id], status: 'monitoring', startedAt: memory.clock() };
  await assert.rejects(journal.saveWatch({ ...watch, sources: ['missing-source'] }), /已删除或不存在/);
  await assert.rejects(journal.saveWatch({ ...watch, privacyEpoch: memory.generation + 1 }), /隐私版本已变更/);
  const saved = await journal.saveWatch(watch);
  memory.generation++;
  await assert.rejects(journal.saveEvent(saved, { identityString: 'new-event', phase: 'detected' }), /隐私版本已变更/);
  await memory.close(); services.delete(memory);
}

async function main() {
  execFileSync(path.join(__dirname, 'build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-watch-journal-'));
  const safeStorage = stubSafeStorage();
  try {
    await testWatchAndEvents(temp, safeStorage);
    await testStaleAndMissingSources(temp, safeStorage);
    console.log('Watch journal integration checks passed');
  } finally {
    await Promise.all([...services].map(service => service.close().catch(() => {})));
    fs.rmSync(temp, { recursive: true, force: true });
    safeStorageKey.fill(0);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
