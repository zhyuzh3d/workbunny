'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MemoryService } = require('../src/main/memory-service');
const { createTaskJournal } = require('../src/main/task-journal');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');

async function main() {
  execFileSync(path.join(__dirname, 'build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-task-privacy-test-'));
  let time = Date.UTC(2026, 9, 26, 12);
  const service = new MemoryService({
    dir: path.join(temp, 'vault'), bin,
    openKey: async () => crypto.randomBytes(32),
    getSettings: () => ({ enabled: true, extract: false }),
    clock: () => ++time,
  });
  try {
    await service.init();
    assert(service.db, `isolated memory vault failed to initialize: ${service.error}`);
    const persist = createTaskJournal(service, { clock: () => ++time });
    const task = (id, privacyEpoch, sources) => ({
      id, goal: 'Synthetic task: file a note', note: 'Synthetic result for privacy cascade test',
      status: 'review', startedAt: ++time, updatedAt: time, privacyEpoch, sources,
    });
    const get = ids => service.db.request('get', { ids });

    // User source -> persisted task -> assistant receipt. Forgetting the user
    // source must recursively remove both derived rows and their HMAC tokens.
    const origin = await service.addMessage('user', '合成来源：蓝色项目备忘录由我确认。');
    const firstEpoch = service.generation;
    const firstTask = task('task-origin-chain', firstEpoch, [origin.id]);
    await persist(firstTask);
    const savedTask = (await get([firstTask.id])).rows[0];
    assert(savedTask && savedTask.kind === 'task');
    const decodedTask = service.decode(savedTask);
    assert.equal(decodedTask.value.content, `${firstTask.goal}\n${firstTask.note}`);
    assert.deepEqual(decodedTask.value.sources, [origin.id], 'task journal must preserve provenance instead of defaulting sources to []');
    assert.equal(decodedTask.ts, firstTask.startedAt);
    assert.equal(decodedTask.value.privacyEpoch, firstEpoch);

    const receipt = await service.addMessage('assistant', '合成任务报告：备忘录已处理。', {
      delivery: 'task-receipt', sources: [firstTask.id],
    });
    assert(receipt.value.sources.includes(firstTask.id));
    assert.equal((await get([origin.id, firstTask.id, receipt.id])).rows.length, 3);
    const removed = await service.remove(origin.id);
    assert(removed.removed >= 3);
    assert.equal((await get([origin.id, firstTask.id, receipt.id])).rows.length, 0, 'forgetting the origin must cascade to the task and receipt');
    assert.equal((await service.search('合成任务报告 备忘录', ['task', 'message'], 20)).length, 0);

    // A late journal write carrying the old privacy generation must fail even
    // if the task object still holds the former source ID.
    await assert.rejects(persist(firstTask), /隐私|来源|失效|删除/);
    assert.equal((await get([firstTask.id])).rows.length, 0, 'stale task must not be recreated after forgetting its origin');
    await assert.rejects(service.addMessage('assistant', '迟到的合成任务报告。', {
      delivery: 'task-receipt', sources: [firstTask.id],
    }), /来源已删除或不存在/);

    // A matching generation does not permit a task with a missing source.
    const sameEpochMissing = task('task-missing-source', service.generation, ['missing-origin-id']);
    await assert.rejects(persist(sameEpochMissing), /来源|删除|不存在/);
    assert.equal((await get([sameEpochMissing.id])).rows.length, 0);

    // Clear invalidates a previously valid task and its pending report. A new
    // task in the new generation can still be journaled with normal format.
    const secondOrigin = await service.addMessage('user', '第二个合成来源：完成资料目录核对。');
    const clearEpoch = service.generation;
    const secondTask = task('task-before-clear', clearEpoch, [secondOrigin.id]);
    await persist(secondTask);
    const secondReceipt = await service.addMessage('assistant', '第二条合成任务回执。', { sources: [secondTask.id], delivery: 'task-receipt' });
    await service.clear();
    assert.equal((await get([secondOrigin.id, secondTask.id, secondReceipt.id])).rows.length, 0);
    await assert.rejects(persist(secondTask), /隐私|来源|失效|删除/);
    assert.equal((await get([secondTask.id])).rows.length, 0, 'clear must prevent old tasks from being written again');
    await assert.rejects(service.addMessage('assistant', '清空后的旧任务报告。', { sources: [secondTask.id] }), /来源已删除或不存在/);

    const freshOrigin = await service.addMessage('user', '新会话合成来源：我确认已完成索引核验。');
    const freshEpoch = service.generation;
    const freshTask = task('task-after-clear', freshEpoch, [freshOrigin.id]);
    await persist(freshTask);
    const freshRow = (await get([freshTask.id])).rows[0];
    assert(freshRow && freshRow.kind === 'task', 'a new task in the current generation must persist');
    const freshValue = service.decode(freshRow).value;
    assert.deepEqual(freshValue.sources, [freshOrigin.id]);
    assert.equal(freshValue.content, `${freshTask.goal}\n${freshTask.note}`);
    assert.equal(freshValue.privacyEpoch, freshEpoch);
    const freshReceipt = await service.addMessage('assistant', '新会话合成任务回执。', {
      sources: [freshTask.id], delivery: 'task-receipt',
    });
    assert((await get([freshOrigin.id, freshTask.id, freshReceipt.id])).rows.length === 3);

    console.log('Task journal privacy and cascade checks passed');
  } finally {
    await service.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
