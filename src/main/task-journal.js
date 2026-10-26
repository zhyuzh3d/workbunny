'use strict';
const { SCENES, normalizeScene, rank } = require('./memory-scope');

// Receipts share the memory vault's provenance and erasure boundary. An old
// operation must not recreate text after its user source has been forgotten.
function createTaskJournal(memory, { clock = Date.now } = {}) {
  return task => memory.serial(async () => {
    if (task.privacyEpoch !== undefined && task.privacyEpoch !== memory.generation) throw new Error('任务的记忆来源已变更，停止写入旧内容');
    const sources = Array.isArray(task.sources) ? [...new Set(task.sources)] : [];
    if (sources.length > 200 || sources.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('任务来源不合法');
    if (sources.length && (await memory.db.request('get', { ids: sources })).rows.length !== sources.length) throw new Error('任务的来源已经删除，未重新保存旧内容');
    if (task.scene !== undefined && !SCENES.includes(task.scene)) throw new Error('任务scene不合法');
    const scene = task.scene === undefined ? 'private' : normalizeScene(task.scene, 'private');
    const floor = Number.isInteger(task.visibilityFloor) && task.visibilityFloor >= 0 && task.visibilityFloor <= 2
      ? task.visibilityFloor : 2;
    const domain = typeof task.domain === 'string' && task.domain ? task.domain : (task.target === 'workbuddy' ? 'work' : scene);
    if (task.target === 'workbuddy' && domain !== 'work') throw new Error('WorkBuddy任务必须归类到work domain');
    const minimumFloor = Math.max(rank(scene), rank(domain));
    if (floor < minimumFloor) throw new Error('任务visibilityFloor不得低于创建场景或domain');
    return memory.write([{ id: task.id, kind: 'task', ts: task.startedAt, updatedAt: clock(), domain, visibilityFloor: floor,
      value: { ...task, scene, domain, visibilityFloor: floor, content: task.goal + '\n' + task.note, sources } }]);
  });
}

module.exports = { createTaskJournal };
