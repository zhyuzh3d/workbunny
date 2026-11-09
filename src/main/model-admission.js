'use strict';
const { createBoundedWait } = require('./bounded-wait');
const busy = () => Object.assign(Error('模型后台容量暂满，已保留当前工作'), { code: 'E_MODEL_BUSY', dispatched: false });
class ModelAdmission {
  constructor({ capacity = 4, backgroundLimit = 3 } = {}) { this.capacity = capacity; this.backgroundLimit = backgroundLimit; this.active = new Set(); }
  async run(invoke, options = {}) {
    if (options._modelAdmission) return invoke(options);
    if (options.signal?.aborted) throw Object.assign(Error('模型调用已取消'), { code: 'ABORT_ERR' });
    const foreground = options.priority === 'foreground';
    if (this.active.size >= (foreground ? this.capacity : this.backgroundLimit)) throw busy();
    const wait = createBoundedWait({ signal: options.signal, timeoutMs: Number(options.timeoutMs) || 55000, code: 'E_MODEL_TIMEOUT', message: '模型调用达到本轮时限' });
    const entry = { foreground }; this.active.add(entry);
    // A logical timeout never releases an unacknowledged physical request.
    const physical = Promise.resolve().then(() => {
      if (wait.signal.aborted) throw Object.assign(Error('模型调用已取消'), { code: 'ABORT_ERR' });
      return invoke({ ...options, signal: wait.signal, _modelAdmission: true });
    });
    const settled = physical.finally(() => { this.active.delete(entry); wait.close(); });
    settled.catch(() => {});
    try { return await wait.run(() => settled); }
    finally { if (!this.active.has(entry)) wait.close(); }
  }
}
const shared = new ModelAdmission();
module.exports = { ModelAdmission, run: (invoke, options) => shared.run(invoke, options) };
