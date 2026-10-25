'use strict';

// Receipts share the memory vault's provenance and erasure boundary. An old
// operation must not recreate text after its user source has been forgotten.
function createTaskJournal(memory, { clock = Date.now } = {}) {
  return task => memory.serial(async () => {
    if (task.privacyEpoch !== undefined && task.privacyEpoch !== memory.generation) throw new Error('任务的记忆来源已变更，停止写入旧内容');
    const sources = Array.isArray(task.sources) ? [...new Set(task.sources)] : [];
    if (sources.length > 200 || sources.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('任务来源不合法');
    if (sources.length && (await memory.db.request('get', { ids: sources })).rows.length !== sources.length) throw new Error('任务的来源已经删除，未重新保存旧内容');
    return memory.write([{ id: task.id, kind: 'task', ts: task.startedAt, updatedAt: clock(),
      value: { ...task, content: task.goal + '\n' + task.note, sources } }]);
  });
}

module.exports = { createTaskJournal };
