'use strict';
const { EventEmitter } = require('events');
const fs = require('fs'), path = require('path'), os = require('os');
function taskStatus(dir = path.join(os.homedir(), '.workbuddy/projects')) {
  try {
    fs.accessSync(dir, fs.constants.R_OK);
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    return { status: 'ready', note: '任务目录可读取' };
  } catch (e) {
    return { status: e.code === 'ENOENT' ? 'awaiting_first_task' : 'unavailable',
      note: e.code === 'ENOENT' ? '等待 WorkBuddy 产生第一项任务' : '任务目录不可读取，请检查权限' };
  }
}
function ticketIdentity() {
  return require('crypto').createHash('sha256').update(require('./workbuddy').discovery().ticket).digest('hex');
}
class WorkBuddyConnection extends EventEmitter {
  constructor({ open = () => require('./workbuddy').openApplication(),
    catalog = () => require('./model-catalog').refresh('workbuddy'), getModel, saveModel,
    tasks = taskStatus, identity = ticketIdentity, timeoutMs = 25000, clock = Date.now } = {}) {
    super();
    Object.assign(this, { open, catalog, getModel, saveModel, identity, tasks, timeoutMs, clock });
    this.state = { status: 'checking', ready: false, generation: 0, note: '正在检查 WorkBuddy' };
    this.closed = false;
  }
  status() { return { ...this.state }; }
  publish(patch) {
    if (this.closed) return;
    Object.assign(this.state, patch); this.emit('change', this.status());
  }
  invalidate(note = 'WorkBuddy 暂时断开，正在自动重新连接', { identityChanged = false } = {}) {
    this.publish({ status: 'reconnecting', ready: false, generation: this.state.generation + (identityChanged ? 1 : 0), note });
    this.schedule(2000);
  }
  schedule(ms) {
    if (!this.started || this.closed) return;
    clearTimeout(this.timer);
    this.publish({ nextRetryAt: this.clock() + ms });
    this.timer = setTimeout(() => void this.connect(), ms); this.timer.unref?.();
  }
  async connect({ launch = false } = {}) {
    if (this.closed) return this.status();
    if (this.pending) { if (launch) await this.open().catch(() => {}); return this.pending; }
    let generation = this.state.generation;
    this.pending = (async () => {
      this.publish({ status: 'checking', note: '正在连接 WorkBuddy…' });
      try {
        if (launch) await this.open();
        const identity = this.identity();
        if (this.identityValue && identity !== this.identityValue) {
          this.invalidate('WorkBuddy 登录状态变化，正在重新连接', { identityChanged: true }); generation = this.state.generation;
        }
        this.identityValue = identity;
        let timer;
        const catalog = await Promise.race([this.catalog(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('WorkBuddy 连接检查超时，稍后自动重试')), this.timeoutMs);
        })]).finally(() => clearTimeout(timer));
        if (this.closed || this.state.generation !== generation) return this.status();
        if (!catalog.models?.length) throw new Error('当前账号没有可用的文本模型');
        if (!catalog.models.some(m => m.id === this.getModel?.())) {
          await this.saveModel?.(catalog.models.find(m => m.id === 'hy3')?.id || catalog.models[0].id);
        }
        const tasks = this.tasks();
        this.failures = 0;
        this.publish({ status: 'ready', ready: true, tasks, note: '账号模型已连接；' + tasks.note, checkedAt: this.clock(), nextRetryAt: null });
      } catch (e) {
        if (!this.closed && this.state.generation === generation) {
          this.failures = (this.failures || 0) + 1;
          const status = /未找到/.test(e.message) ? 'missing' : /不支持|版本|E_METHOD_NOT_FOUND|E_PIPE_NOT_FOUND/.test(e.message) ? 'incompatible' : /登录|身份验证/.test(e.message) ? 'sign_in_required' : 'reconnecting';
          this.publish({ status, ready: false, failures: this.failures,
            note: status === 'missing' ? '请先安装 WorkBuddy，再登录自己的账号' : status === 'reconnecting' ? 'WorkBuddy 连接暂不可用，任务已保留，正在自动重连' : e.message, checkedAt: this.clock() });
        }
      }
      return this.status();
    })().finally(() => { this.pending = null; this.schedule(this.state.ready ? 30000 : [2000, 5000, 10000, 30000, 60000][Math.min(4, Math.max(0, (this.failures || 1) - 1))]); });
    return this.pending;
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    void this.connect();
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}
module.exports = { WorkBuddyConnection, taskStatus };
