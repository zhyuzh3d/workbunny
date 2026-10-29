'use strict';
// Small idle extension. Grants, call/contact budgets and claims live in the
// same encrypted Vault. Execution and receipts stay with Secretary.
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readRecords, snapshotsOf, verifySnapshots } = require('./memory-evidence');
const { rank, canRead } = require('./memory-scope');
const refs = require('./memory-references');
const { containsSecret } = require('./conversation-input');
const STATE = 'autonomy:budget:v1';
class CompanionAutonomy {
  constructor({ memory, secretary, propose, canRun, report, getScene, clock = Date.now }) {
    Object.assign(this, { memory, secretary, propose, canRun, report, getScene, clock });
    this.controller = null; this.running = null; this.note = '尚未授权主动活动';
  }
  async grants() {
    return (await readRecords(this.memory, ['autonomy:grant:greet', 'autonomy:grant:create'])).filter(r => r.value.schema === 'autonomy-grant/v1');
  }
  async status() {
    const grants = (await this.grants()).map(r => ({ ...r.value, id: r.id }));
    const note = this.note === '尚未授权主动活动' && grants.some(g => g.enabled && g.expiresAt > this.clock()) ? '授权仍有效，空闲时自主决定' : this.note;
    const growth = await this.memory.growth?.view({ scene: this.getScene() });
    return { grants, note, running: !!this.running, growth: growth?.entries || [] };
  }
  async save(input) {
    if (!input || !['greet', 'create'].includes(input.kind)) throw new Error('主动活动类型无效');
    if (!['private', 'life', 'work'].includes(input.scene)) throw new Error('请选择可用资料范围');
    const subject = String(input.subject || '').trim();
    if (subject.length > 400 || containsSecret(subject)) throw new Error('兴趣范围过长或含秘密');
    const days = [1, 7, 30].includes(input.days) ? input.days : 7;
    let directory = '';
    if (input.kind === 'create' && input.enabled) {
      directory = String(input.directory || '');
      if (!directory || fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error('请先选择专用创作目录');
    }
    this.pause();
    const value = { schema: 'autonomy-grant/v1', kind: input.kind, enabled: input.enabled === true, scene: input.scene,
      subject, directory, expiresAt: this.clock() + days * 86400000, maxCallsPerDay: 2, maxContactsPerDay: 2,
      minGapMs: 6 * 3600000, quietHours: { from: 22, until: 9 }, recipient: 'owner', account: 'local', channels: ['desktop'],
      tools: input.kind === 'create' ? ['workbuddy-free', 'create-local-file'] : ['workbuddy-free', 'desktop-greeting'],
      maxCost: 0, executeCode: false, sources: [] };
    await this.memory.serial(() => this.memory.write([{ id: 'autonomy:grant:' + input.kind, kind: 'task', ts: 0,
      domain: input.scene, visibilityFloor: rank(input.scene), value }]));
    this.note = value.enabled ? '已授权；空闲时按范围自主决定' : '授权已撤销'; return this.status();
  }
  pause() { this.controller?.abort(); }
  async ownerInput() {
    this.pause();
    await this.memory.serial(async () => {
      const r = (await readRecords(this.memory, [STATE]))[0];
      if (r?.value.awaitingReply) await this.memory.write([{ ...r, value: { ...r.value, awaitingReply: false } }], this.memory.epoch, { notify: false });
    });
  }
  async claim({ contact = false, quietCreation = false } = {}) {
    return this.memory.serial(async () => {
      const previous = (await readRecords(this.memory, [STATE]))[0];
      const day = refs.localDay(this.clock()), old = previous?.value || {};
      const s = old.day === day ? old : { day, calls: 0, contacts: 0, lastAttempt: old.lastAttempt || 0, lastContact: old.lastContact || 0, awaitingReply: !!old.awaitingReply,
        pendingTaskIds: old.pendingTaskIds || (old.pendingTaskId ? [old.pendingTaskId] : []) };
      if (s.awaitingReply && (contact || !quietCreation) || (contact ? s.contacts >= 2 || this.clock() - s.lastContact < 6 * 3600000 : s.calls >= 2 || this.clock() - s.lastAttempt < 6 * 3600000)) return false;
      const next = contact ? { ...s, contacts: s.contacts + 1, lastContact: this.clock(), awaitingReply: true }
        : { ...s, calls: s.calls + 1, lastAttempt: this.clock() };
      // Persist before any effect. Uncertain delivery is never retried.
      await this.memory.write([{ id: STATE, kind: 'state', ts: 0, domain: 'private', visibilityFloor: 2, value: { ...next, sources: [] } }], this.memory.epoch, { notify: false });
      return true;
    });
  }
  async pendingTask(id, remove) {
    await this.memory.serial(async () => {
      const prior = (await readRecords(this.memory, [STATE]))[0];
      const old = prior?.value || {}, ids = old.pendingTaskIds || (old.pendingTaskId ? [old.pendingTaskId] : []);
      const next = id ? [...new Set([...ids, id])] : ids.filter(value => value !== remove);
      if (next.length > 4) throw new Error('待分享作品已满，暂停新创作');
      await this.memory.write([{ id: STATE, kind: 'state', ts: 0, domain: 'private', visibilityFloor: 2,
        value: { ...old, pendingTaskId: null, pendingTaskIds: next, sources: [] } }], this.memory.epoch, { notify: false });
    });
  }
  async sharePending(grants, { signal, generation }) {
    const state = (await readRecords(this.memory, [STATE]))[0];
    const pending = state?.value.pendingTaskIds || (state?.value.pendingTaskId ? [state.value.pendingTaskId] : []);
    if (!pending.length || state.value.awaitingReply) return false;
    const tasks = await readRecords(this.memory, pending);
    const missing = pending.find(id => !tasks.some(r => r.id === id));
    if (missing) { await this.pendingTask(null, missing); return false; }
    const task = tasks.find(r => canRead(this.getScene(), r));
    if (!task) return false;
    const taskId = task.id;
    const grant = grants.find(g => g.id === task?.value.authorization?.grantId);
    if (!task || !grant || snapshotsOf([grant])[0].fingerprint !== task.value.authorization.fingerprint) { await this.pendingTask(null, taskId); return false; }
    if (!canRead(this.getScene(), task)) return true;
    const file = task.value.artifactManifest?.files?.[0];
    if (!file || !fs.existsSync(file.path) || !file.path.startsWith(grant.value.directory + path.sep) || fs.realpathSync(file.path) !== file.path || fs.lstatSync(file.path).isSymbolicLink() ||
        fs.statSync(file.path).size > 60000 || require('node:crypto').createHash('sha256').update(fs.readFileSync(file.path)).digest('hex') !== file.sha256) {
      await this.pendingTask(null, taskId); this.note = '作品文件已变化，保留任务记录等主人查看'; return true;
    }
    if (signal?.aborted || generation !== this.memory.generation || !await this.canRun()) return true;
    if (!await this.claim({ contact: true })) return false;
    // Clear the claim before publishing. A crash never re-announces a result
    // whose delivery is uncertain; the real task remains inspectable.
    await this.pendingTask(null, taskId);
    const text = `我试着做了「${task.value.goal}」，作品已经保存到 ${file.path}。${['js', 'py', 'html'].includes(path.extname(file.path).slice(1)) ? '代码还没有运行。' : ''}`;
    const id = 'autonomy-outreach:' + randomUUID();
    await this.memory.addMessageOnce(id, 'assistant', text, { scene: task.domain, taskId: task.id, delivery: 'task-receipt', sources: [task.id], privacyEpoch: generation });
    if (signal?.aborted || generation !== this.memory.generation || !await this.canRun()) return true;
    this.note = '已分享一次，等待主人回应';
    await this.report({ eventId: id, taskId: task.id, text, status: 'accepted', persisted: true,
      epoch: generation, scene: task.domain, domain: task.domain, visibilityFloor: task.visibilityFloor, sources: [id] });
    return true;
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.run().catch(e => { if (!this.controller?.signal.aborted) this.note = '主动活动暂缓，本次未继续联系'; })
      .finally(() => { this.running = null; this.controller = null; });
    return this.running;
  }
  async run() {
    if (!this.memory.ready || !await this.canRun()) return;
    const hour = new Date(this.clock()).getHours(); if (hour < 9 || hour >= 22) return;
    const controller = this.controller = new AbortController(), generation = this.memory.generation;
    const scene = this.getScene();
    const grants = (await this.grants()).filter(r => r.value.enabled && r.value.expiresAt > this.clock() && canRead(scene, { domain: r.value.scene, visibilityFloor: rank(r.value.scene) }));
    if (await this.sharePending(grants, { signal: controller.signal, generation })) return;
    if (!grants.length) return;
    // Creative work takes priority over an empty check-in when both are allowed.
    const grant = grants.find(r => r.value.kind === 'create') || grants[0];
    const state = (await readRecords(this.memory, [STATE]))[0];
    if ((state?.value.pendingTaskIds?.length || 0) >= 4) { this.note = '已有作品等分享，这次安静待着'; return; }
    if (!await this.claim({ quietCreation: grant.value.kind === 'create' })) return;
    const snapshots = snapshotsOf([grant]);
    const current = async () => !controller.signal.aborted && generation === this.memory.generation && this.memory.ready &&
      grant.value.expiresAt > this.clock() && this.getScene() === scene && new Date(this.clock()).getHours() >= 9 && new Date(this.clock()).getHours() < 22 && await this.canRun() && (await verifySnapshots(this.memory, snapshots)).ok;
    const self = await this.memory.cognition.loadRoleView();
    const growth = await this.memory.growth?.view({ scene: grant.value.scene, budget: 2400, query: grant.value.subject });
    const active = (growth?.entries || []).filter(e => e.type === 'pursuit' && e.status === 'active').slice(0, 3);
    const query = [grant.value.subject, ...active.map(e => `${e.content} ${e.nextStep}`)].join(' ') || '近期兴趣、未完话题与值得探索的想法';
    const context = await this.memory.context(query, { scene: grant.value.scene, budget: 5000 });
    const inputs = await readRecords(this.memory, [...new Set([...context.sourceIds, ...(growth?.sourceIds || []), ...(growth?.heads || []).map(r => r.id)])], { scene: grant.value.scene });
    const inputSnapshots = snapshotsOf(inputs), baseCurrent = current;
    const evidenceCurrent = async () => await baseCurrent() && (await verifySnapshots(this.memory, inputSnapshots, { scene: grant.value.scene })).ok &&
      (await this.memory.cognition.loadRoleView({ repair: false }))?.revision === self?.revision;
    if (!await current()) return;
    this.note = grant.value.kind === 'create' ? '正在尝试一个小作品' : '正在考虑是否适合问候';
    const result = await this.propose({ grant: grant.value, self: self?.text, context: context.text, recent: context.messages, growth: growth?.text || '',
      actualState: '已获授权，当前空闲；尚未开始任何外部活动' }, { signal: controller.signal });
    if (!result || result.kind === 'none' || !await evidenceCurrent()) { this.note = '这次选择安静待着'; return; }
    if (result.kind !== grant.value.kind || typeof result.content !== 'string' || !result.content.trim() || containsSecret(result.content)) throw new Error('主动提案不符合授权');
    if (result.pursuitId && !active.some(e => e.id === result.pursuitId && growth.sourceIds.includes(e.id))) throw new Error('自主目标已变化');
    const sources = [...new Set([grant.id, ...context.sourceIds, ...(growth?.sourceIds || [])])].slice(0, 190);
    let text, taskId;
    if (result.kind === 'create') {
      const artifact = await this.secretary.createArtifact({ directory: grant.value.directory, title: result.title, extension: result.extension,
        content: result.content, sources, scene: grant.value.scene, signal: controller.signal, authorize: evidenceCurrent, authorization: { grantId: grant.id, fingerprint: snapshots[0].fingerprint } });
      taskId = artifact.taskId;
      if (generation !== this.memory.generation) return;
      await this.pendingTask(taskId);
      await this.memory.addMessageOnce('autonomy-experience:' + taskId, 'assistant', `我实际生成了本地作品「${artifact.title}」，文件内容已核验，源码未经运行。${result.pursuitId ? '这次是在尝试目标：' + active.find(e => e.id === result.pursuitId).content : ''}`,
        { scene: grant.value.scene, taskId, delivery: 'task-receipt', sources: [taskId] });
      await this.memory.observeTaskReport?.({ status: 'accepted', taskId });
      this.memory.maintenance?.requestReflection('autonomous-experience');
      await this.sharePending(grants, { signal: controller.signal, generation });
      return;
    } else {
      if (result.content.length > 160) throw new Error('问候过长');
      text = result.content;
    }
    if (!await evidenceCurrent() || !await this.claim({ contact: true })) { this.note = '结果已保留，等合适时再分享'; return; }
    const id = 'autonomy-outreach:' + randomUUID();
    await this.memory.addMessageOnce(id, 'assistant', text, { scene: grant.value.scene, delivery: 'task-receipt',
      sources: taskId ? [taskId] : sources, privacyEpoch: generation });
    if (!await current()) return;
    this.note = '已分享一次，等待主人回应';
    await this.report({ eventId: id, taskId: taskId || id, text, status: 'accepted', persisted: true,
      epoch: generation, scene: grant.value.scene, domain: grant.value.scene, visibilityFloor: rank(grant.value.scene), sources: [id] });
  }
  async close() { this.pause(); await this.running; }
}
module.exports = { CompanionAutonomy };
