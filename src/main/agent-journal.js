'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TASK_SCHEMA, clone } = require('./agent-contract');
const { canRead } = require('./memory-scope');
const { VAULT_PAGE_SIZE } = require('./vault-db');

const TASK_MARKER = 'bunny_agent_task';

function taskSources(task) {
  if (!Array.isArray(task.sources) || !task.sources.length) throw new Error('任务缺少交办来源');
  return [...new Set(task.sources)];
}

// Executable task state shares the encrypted vault and its source graph.
function createAgentJournal(memory) {
  function check(task) {
    if (task.privacyEpoch !== memory.generation) throw new Error('任务资料版本已经变化');
    if (task.schema !== TASK_SCHEMA) throw new Error('任务规范不匹配');
    if (Buffer.byteLength(JSON.stringify(task)) > 1_200_000) throw new Error('任务记录达到容量上限，需要整理会话');
  }

  function putAll(tasks) {
    return memory.serial(async () => {
      const records = tasks.map(task => {
        check(task);
        return {
          id: task.id, kind: 'task', ts: task.createdAt, updatedAt: task.updatedAt, domain: task.domain, visibilityFloor: task.visibilityFloor,
          value: { ...task, sources: taskSources(task), taskType: 'agent-task', content: [task.goal, task.note].join('\n') },
        };
      });
      // Task checkpoints have their own UI stream. A tool receipt does not
      // invalidate the dialogue history or trigger a memory-panel reload.
      await memory.write(records, memory.epoch, { notify: false, strictSources: true });
    });
  }

  return {
    put: task => putAll([task]),
    putAll,
    async list() {
      const result = [];
      let cursor = {};
      for (;;) {
        const rows = await memory.query('task', VAULT_PAGE_SIZE, { ...cursor, scene: null, requiredMarkers: [TASK_MARKER] });
        for (const row of rows) {
          if (row.value.schema === TASK_SCHEMA && row.value.taskType === 'agent-task') result.push({ ...row.value, id: row.id });
        }
        if (rows.length < VAULT_PAGE_SIZE) return result;
        const tail = rows.at(-1);
        cursor = { before: tail.ts, beforeId: tail.id };
      }
    },
    async authorized(task) {
      try {
        memory.check();
        const sources = taskSources(task), ids = [task.id, ...sources];
        const found = new Map();
        for (let i = 0; i < ids.length; i += VAULT_PAGE_SIZE) {
          const { rows } = await memory.db.request('get', { ids: ids.slice(i, i + VAULT_PAGE_SIZE) });
          for (const row of rows) found.set(row.id, memory.decode(row));
        }
        const root = found.get(task.id);
        return sources.every(id => found.get(id)?.state === 'active') && root?.state === 'active' &&
          root.value.schema === TASK_SCHEMA && root.value.authority?.verified === true && canRead(task.scene, root);
      } catch (cause) {
        // A failed read is not evidence that the owner/source was revoked.
        // No operation is authorized until a later successful fresh check.
        throw Object.assign(new Error('任务来源暂无法核对，已保留任务；取得有效依据前不会执行操作',{cause}),{code:'E_TASK_JOURNAL_UNAVAILABLE',dispatched:false});
      }
    },
  };
}

// Developer/live-test adapter using the same atomic journal contract.
class FileAgentJournal {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    this.tail = Promise.resolve();
  }
  async load() {
    try {
      for (const task of JSON.parse(await fs.readFile(this.file, 'utf8'))) this.records.set(task.id, task);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  put(task) { return this.putAll([task]); }
  putAll(tasks) {
    const snapshots = tasks.map(clone);
    const job = this.tail.then(async () => {
      const staged = new Map(this.records);
      for (const task of snapshots) staged.set(task.id, task);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify([...staged.values()]), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.file);
        this.records = staged;
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    });
    this.tail = job.catch(() => {});
    return job;
  }
  async list() { return [...this.records.values()].map(clone); }
  async authorized(task) { return task.authority?.verified === true && task.authority.role === 'owner' && this.records.has(task.id); }
}

module.exports = { createAgentJournal, FileAgentJournal, TASK_MARKER };
