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
    tasks = taskStatus, identity = ticketIdentity } = {}) {
    super();
    Object.assign(this, { open, catalog, getModel, saveModel, identity, tasks });
    this.state = { status: 'checking', ready: false, generation: 0, note: '正在检查 WorkBuddy' };
    this.closed = false;
  }
  status() { return { ...this.state }; }
  publish(patch) {
    if (this.closed) return;
    Object.assign(this.state, patch); this.emit('change', this.status());
  }
  invalidate(note = 'WorkBuddy 连接已断开，请重新连接') {
    this.publish({ status: 'unavailable', ready: false, generation: this.state.generation + 1, note });
  }
  async connect({ launch = false } = {}) {
    if (this.pending) { if (launch) await this.open().catch(() => {}); return this.pending; }
    let generation = this.state.generation;
    this.pending = (async () => {
      this.publish({ status: 'checking', note: '正在连接 WorkBuddy…' });
      try {
        if (launch) await this.open();
        const identity = this.identity();
        if (this.identityValue && identity !== this.identityValue) {
          this.invalidate('WorkBuddy 登录状态变化，正在重新连接'); generation = this.state.generation;
        }
        this.identityValue = identity;
        const catalog = await this.catalog();
        if (this.closed || this.state.generation !== generation) return this.status();
        if (!catalog.models?.length) throw new Error('当前账号没有可用的文本模型');
        if (!catalog.models.some(m => m.id === this.getModel?.())) {
          await this.saveModel?.(catalog.models.find(m => m.id === 'hy3')?.id || catalog.models[0].id);
        }
        const tasks = this.tasks();
        this.publish({ status: 'ready', ready: true, tasks, note: '账号模型已连接；' + tasks.note, checkedAt: Date.now() });
      } catch (e) {
        if (!this.closed && this.state.generation === generation) {
          this.publish({ status: /未找到/.test(e.message) ? 'missing' : /不支持|版本|E_METHOD_NOT_FOUND|E_PIPE_NOT_FOUND/.test(e.message) ? 'incompatible' : 'sign_in_required', ready: false,
            note: /未找到/.test(e.message) ? '请先安装 WorkBuddy，再登录自己的账号' : e.message, checkedAt: Date.now() });
        }
      }
      return this.status();
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  start() {
    void this.connect();
    this.timer = setInterval(() => void this.connect(), 30000); this.timer.unref?.();
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
module.exports = { WorkBuddyConnection, taskStatus };
