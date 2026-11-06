'use strict';
const crypto = require('node:crypto');
const { TASK_SCHEMA, STATES, TERMINAL, MAX_ACTIVE_TASKS, occupiesSlot, capacityNote, taskSpec, authority, clone } = require('./agent-contract');
const { canRead } = require('./memory-scope');
const { scriptPlan } = require('./agent-tools');
const {OperationLedger}=require('./operation-ledger');
const {ActionProgress}=require('./action-progress');
class AgentRuntime {
  constructor({ journal, tools, skills, ready = () => true, epoch = () => 0, getScene = () => 'life', emit = () => {}, report = async () => {}, clock = Date.now, autoSchedule = true, prepare = async()=>{}, completed = async()=>{},settled=async()=>{},failed=async()=>{},authorize=async()=>{},stopTask=async()=>{},diagnoseRepair=null,observeWhileActive=null,remindIdle=null }) {
    Object.assign(this, { journal, tools, skills, ready, epoch, getScene, emit, report, clock, autoSchedule, prepare, completed,settled,failed,authorize,stopTask,diagnoseRepair,observeWhileActive });
    this.tasks = new Map(); this.controllers = new Map(); this.actionGroups = new Map(); this.tokens = new Map(); this.closed = false; this.admissionEpoch = 0;
    this.admissionTail=Promise.resolve();this.stops=new Map();this.pendingSaves=new Map();this.amending=new Set();
    this.operations=new OperationLedger({tools,clock,authorize:(...args)=>this.authorize(...args),save:task=>this.save(task)});
    this.keepalive=new(require('./task-keepalive').TaskKeepalive)({clock,remind:remindIdle});
  }
  admission(action){const work=this.admissionTail.then(action);this.admissionTail=work.catch(()=>{});return work;}
  capacity(){return {limit:MAX_ACTIVE_TASKS,active:[...this.tasks.values()].filter(occupiesSlot).length,queued:[...this.tasks.values()].filter(t=>t.status==='queued').length};}
  capabilitiesFor(skill, spec, actor) {
    const required = skill.capabilitiesFor ? skill.capabilitiesFor(spec) : skill.capabilities;
    const allowed = capability => !actor.capabilities || actor.capabilities.includes(capability);
    if (required.some(capability => !allowed(capability)) || skill.requiredCapabilities?.some(capability => !allowed(capability))) {
      throw new Error('主人入口没有此任务所需权限');
    }
    return [...new Set([...required, ...(skill.optionalCapabilities || []).filter(allowed)])];
  }
  admit(task, replacing){
    const active = this.capacity().active - (replacing && occupiesSlot(replacing) ? 1 : 0);
    if(task.skill!=='task.resolve'&&active>=MAX_ACTIVE_TASKS){task.status='queued';task.note=capacityNote;delete task.expiresAt;return false;}
    task.status='ready';task.nextCheckAt=this.clock();if(task.schedule.durationMinutes&&!task.expiresAt)task.expiresAt=this.clock()+task.schedule.durationMinutes*60000;return true;
  }
  list({scene=this.getScene()}={}) {
    return [...this.tasks.values()].filter(t => !(t.skill==='task.resolve'&&TERMINAL.has(t.status))&&t.privacyEpoch===this.epoch() && canRead(scene, t)).map(t => ({ id:t.id, goal:t.goal, skill:t.skill,
      presentation:require('./task-presentation').taskPresentation(t,{handling:this.controllers.has(t.id)&&t.status==='needs_attention'}),workJobId:t.state.workOperationId||t.state.job?.jobId||null,lastCheckedAt:t.state.lastCheckedAt||null,subjects:clone(t.subjects), status:t.status, note:t.note, createdAt:t.createdAt, updatedAt:t.updatedAt,
      nextCheckAt:t.nextCheckAt, expiresAt:t.expiresAt, queuedEvents:t.inbox.length+(t.overflowEvent?1:0),
      observationReady:t.skill==='conversation.manage'?Object.values(t.state.conversations||{}).filter(c=>c.cursor?.ready).length===t.subjects.length:undefined,
      counters:clone(t.counters), schedule:clone(t.schedule), completion:t.completion,delivery:clone(t.state.delivery||t.delivery||null),result:t.state.result?{revision:t.state.result.revision,source:clone(t.state.result.source||null),summary:t.state.result.summary,text:String(t.state.result.text||t.state.result.summary).slice(0,12000),artifacts:clone(t.state.result.artifacts||[])}:null })).sort((a,b)=>a.createdAt-b.createdAt);
  }
  publish() {
    if (this.restoring) return;
    try { this.emit(this.list()); }
    catch { /* Delivery of a view does not change the durable task state. */ }
  }
  async reportProgress(task,progress,actionId,text){
    if(!progress||progress.state.blockedReportedAt)return;
    progress.state.blockedReportedAt=this.clock();await this.save(task);
    await this.report({taskId:task.id,eventId:'progress:'+actionId,text,sources:[task.id],scene:task.scene,domain:task.domain,visibilityFloor:task.visibilityFloor,epoch:task.privacyEpoch});
  }
  current(task, token, activeAction = false) { return !this.closed && !this.restoring && !this.amending.has(task.id) && this.ready() && this.tasks.get(task.id) === task && this.tokens.get(task.id) === token &&
    task.privacyEpoch === this.epoch() && (canRead(this.getScene(), task)||task.authority?.channel==='authenticated-channel') && !TERMINAL.has(task.status) &&
    !['queued','stopping','paused',...(activeAction?[]:['needs_attention','waiting_permission'])].includes(task.status); }
  eventScope(event) { return typeof event?.subjectKey==='string'&&event.subjectKey ? 'subject:'+event.subjectKey : typeof event?.scope==='string'&&event.scope ? 'scope:'+event.scope : null; }
  selectEvent(task, group) {
    const active=[...(group?.workers.values()||[])],blocked=Object.values(task.actionRuns||{}).filter(a=>['needs_attention','waiting_permission'].includes(a.status));
    return task.inbox.find(event=>{
      const scope=this.eventScope(event);
      if(active.some(a=>a.eventKey===event.key)||blocked.some(a=>a.eventKey===event.key||!a.scope||!scope||a.scope===scope))return false;
      return !active.length||!!scope&&active.every(a=>a.scope&&a.scope!==scope);
    });
  }
  cancelWorker(task) {
    this.keepalive.cancel(task.id);
    this.tokens.set(task.id, (this.tokens.get(task.id) || 0) + 1);
    this.controllers.get(task.id)?.abort();
  }
  canControl(task) {
    return !!task && !this.closed && !this.restoring && this.ready() && this.tasks.get(task.id) === task &&
      task.privacyEpoch === this.epoch() && canRead(this.getScene(), task);
  }
  owns(task) { return this.tasks.get(task.id) === task && task.privacyEpoch === this.epoch(); }
  async writeInOrder(tasks, commit) {
    const ids = tasks.map(task => task.id);
    const pending = ids.map(id => this.pendingSaves.get(id)).filter(Boolean);
    const write = Promise.allSettled(pending).then(async () => {
      if (!tasks.every(task => this.owns(task))) throw new Error('任务资料版本已经变化');
      return commit();
    });
    for (const id of ids) this.pendingSaves.set(id, write);
    try { return await write; }
    finally {
      for (const id of ids) if (this.pendingSaves.get(id) === write) this.pendingSaves.delete(id);
    }
  }
  save(task) { return this.persist(task); }
  persist(task, amend) {
    return this.writeInOrder([task], async () => {
      // Take the snapshot in write order. A checkpoint queued during a task
      // amendment must include that amendment if it has committed.
      const snapshot = clone(task);
      const now = this.clock();
      amend?.(snapshot, now);
      await this.commitSnapshot(task, snapshot, now, amend);
    });
  }
  async commitSnapshot(task, snapshot, now, amend) {
    snapshot.updatedAt = now;
    await this.journal.put(snapshot);
    if (!this.owns(task)) throw new Error('任务资料版本已经变化');
    amend?.(task, now);
    task.updatedAt = now;
    this.publish();
  }
  async start(specification, authorization, { signal, ownerRequest,ownerContext,initialState={},requestKey,authorizeAdmission=()=>{} } = {}) {
    const admission = this.admissionEpoch, epoch = this.epoch();
    const live = () => !this.closed && !this.restoring && this.ready() && !signal?.aborted &&
      admission === this.admissionEpoch && epoch === this.epoch();
    if (!live()) return { ok:false, error:'请先解锁本地资料，再开始任务' };
    try {
      const spec = taskSpec(specification), actor = authority(authorization, authorization?.scene ?? this.getScene()), skill = this.skills.get(spec.skill);
      await skill.validate?.(spec, actor);
      if(!live())return {ok:false,error:'交办已取消，没有开始任务'};
      const capabilities = this.capabilitiesFor(skill, spec, actor);
      const now = this.clock(), task = { schema:TASK_SCHEMA, id:'agent-'+crypto.randomUUID(), ...spec,
        authority:actor, sources:actor.sources, scene:actor.scene, domain:actor.scene, visibilityFloor:actor.visibilityFloor,
        capabilities, skillVersion:skill.version, privacyEpoch:this.epoch(), createdAt:now, updatedAt:now,
        status:'ready', note:'已接到交办，等待执行', nextCheckAt:now,
        ...(spec.schedule.durationMinutes ? { expiresAt:now+spec.schedule.durationMinutes*60000 } : {}),
        state:{...clone(initialState),...(requestKey?{requestKey}:{}),...(ownerContext?{ownerContext:require('./agent-contract').text(ownerContext,'主人历史交办',12000)}:{}),...(typeof ownerRequest==='string'?{ownerRequest:require('./agent-contract').text(ownerRequest,'主人原始交办',12000)}:{})}, inbox:[], eventKeys:[], operations:{}, actionRuns:{}, reports:[], counters:{ wakes:0, reads:0, writes:0, events:0 } };
      await this.prepare(task);
      return await this.admission(async()=>{
        if(!live())return {ok:false,error:'交办在启动前被取消'};
        authorizeAdmission();
        if(requestKey){const existing=[...this.tasks.values()].find(t=>t.state.requestKey===requestKey);if(existing){if(existing.state.ownerRequest!==task.state.ownerRequest)throw Error('同一交办标识的原文不一致，未创建重复任务');return {ok:true,id:existing.id,duplicate:true};}}
        this.admit(task);await this.journal.put(clone(task));
        try{authorizeAdmission();}catch(error){task.status='stopped';task.note=error.message;await this.journal.put(clone(task));throw error;}
        if(!live()){task.status='stopped';task.note='交办在启动前被取消';await this.journal.put(clone(task));return {ok:false,error:task.note};}
        this.tasks.set(task.id,task); this.tokens.set(task.id,0); this.publish(); this.schedule(25);
        return { ok:true, id:task.id,queued:task.status==='queued',...(task.status==='queued'?{note:capacityNote}:{}) };
      });
    } catch (error) { return { ok:false, error:error.message }; }
  }
  async adopt(id,specification,authorization,{signal,live=()=>true,replaceId}={}){
    const task=this.tasks.get(id);if(!task||signal?.aborted||!live())throw Error('交办已取消');
    const spec=taskSpec(specification),actor=authority(authorization,authorization.scene),skill=this.skills.get(spec.skill);try{await skill.validate?.(spec,actor);}catch(error){error.code||='E_TASK_SPEC';throw error;}
    let capabilities;
    try { capabilities = this.capabilitiesFor(skill, spec, actor); }
    catch (error) { error.code = 'E_TASK_AUTH'; throw error; }
    if(signal?.aborted||!live())throw Error('交办已取消');
    const staged=clone(task);
    if(staged.skill==='task.resolve')for(const key of ['context','delivery','workContext','workRequest'])delete staged[key];
    Object.assign(staged,spec);staged.authority=actor;staged.sources=[...new Set([...staged.sources,...actor.sources])];staged.capabilities=[...capabilities];staged.skillVersion=skill.version;staged.visibilityFloor=Math.max(staged.visibilityFloor,actor.visibilityFloor);
    staged.state.resolution={kind:'task',at:this.clock()};delete staged.state.selfRepair;await this.prepare(staged);if(signal?.aborted||!live())throw Error('交办已取消');
    // Publish executable state only after all preparation and persistence pass.
    // A failed adoption must leave a saved intent, never a half-prepared skill.
    return this.admission(async () => {
      if (signal?.aborted || !live()) throw Error('交办已取消');
      const prior = this.tasks.get(replaceId);
      const replacing = prior && prior !== task && !TERMINAL.has(prior.status) ? prior : null;
      if (replacing?.status === 'stopping') throw Error('上一任务正在停止，请先核对外部会话');
      const records = replacing ? [task, replacing] : [task];
      const put = snapshots => replacing ? this.journal.putAll(snapshots) : this.journal.put(snapshots[0]);
      if (replacing) this.amending.add(replacing.id);
      try {
        return await this.writeInOrder(records, async () => {
          if (signal?.aborted || !live()) throw Error('交办已取消');
          this.admit(staged, replacing);
          staged.updatedAt = this.clock();
          const stopped = replacing && { ...clone(replacing), status: 'stopped',
            note: '补充要求已接续到同一工作会话', updatedAt: staged.updatedAt };
          await put(stopped ? [clone(staged), stopped] : [clone(staged)]);
          if (signal?.aborted || !live()) {
            if (records.every(record => this.owns(record))) await put(records.map(clone));
            throw Error('交办已取消');
          }
          if (replacing) {
            this.cancelWorker(replacing);
            Object.assign(replacing, { status: stopped.status, note: stopped.note, updatedAt: stopped.updatedAt });
          }
          for (const key of Object.keys(task)) if (!(key in staged)) delete task[key];
          Object.assign(task, staged);
          this.publish();
          return task;
        });
      } finally {
        if (replacing) this.amending.delete(replacing.id);
        this.schedule();
      }
    });
  }
  restore() {
    if (this.restoreWork) return this.restoreWork;
    this.restoring = true;
    this.admissionEpoch++;
    clearTimeout(this.timer);
    this.timer = null;
    for (const task of this.tasks.values()) this.cancelWorker(task);
    this.restoreWork = this.admission(async () => {
      await Promise.allSettled(this.pendingSaves.values());
      const epoch = this.epoch();
      const live = () => !this.closed && this.ready() && this.epoch() === epoch;
      const records = await this.journal.list();
      const restored = new Map(), changed = [];
      let active = 0;
      for (const record of records) {
        if (!live()) return { restored: 0 };
        if (record.schema !== TASK_SCHEMA || !this.skills.skills.has(record.skill) || !await this.journal.authorized(record)) continue;
        const task = clone(record);
        task.privacyEpoch = epoch;
        if (!TERMINAL.has(task.status) && this.restoreTask(task)) changed.push(task);
        if (occupiesSlot(task)) {
          if (active < MAX_ACTIVE_TASKS) active++;
          else {
            task.status = 'queued';
            task.note = capacityNote;
            delete task.expiresAt;
            if (changed.at(-1) !== task) changed.push(task);
          }
        }
        restored.set(task.id, task);
      }
      if (!live()) return { restored: 0 };
      this.controllers.clear();
      this.actionGroups.clear();
      this.tasks = restored;
      this.tokens = new Map([...restored.keys()].map(id => [id, 0]));
      for (const task of changed) {
        try { await this.save(task); }
        catch {
          restored.delete(task.id);
          this.tokens.delete(task.id);
        }
      }
      return { restored: restored.size };
    }).finally(() => {
      this.restoring = false;
      this.restoreWork = null;
      this.publish();
      this.schedule();
    });
    return this.restoreWork;
  }

  restoreTask(task) {
    let changed = false;
    if (task.status === 'stopping') {
      task.status = 'needs_attention';
      task.note = '上次停止尚未确认，请再次停止以核对外部任务';
      changed = true;
    }
    for (const run of Object.values(task.actionRuns)) {
      if (run.status === 'running') {
        run.status = 'waiting';
        changed = true;
      }
    }
    let unknown = false;
    for (const op of Object.values(task.operations)) {
      if (op.effect !== 'write' || op.status !== 'intent') continue;
      if (op.tool === 'conversation.send' && op.lifecycle?.policy === 'newer-event' && op.lifecycle.phase === 'preparing') {
        op.status = 'not_dispatched';
        op.lifecycle = { ...op.lifecycle, phase: 'cancelled', reason: 'restart-before-effect' };
        changed = true;
        continue;
      }
      unknown = true;
      const run = task.actionRuns[op.actionId];
      if (run && run.status !== 'needs_attention') {
        run.status = 'needs_attention';
        changed = true;
      }
    }
    if (!['queued', 'paused', 'needs_attention', 'waiting_permission'].includes(task.status)) {
      task.status = unknown ? 'needs_attention' : 'waiting';
      task.note = unknown ? '上次操作结果不确定；停止重发，等待核对' : '已恢复任务与待处理事件，等待重新观察';
      task.nextCheckAt = this.clock();
      changed = true;
    }
    return changed;
  }
  async enqueue(id, event, { advance, current } = {}) {
    const task = this.tasks.get(id);
    if (!task || typeof event?.key !== 'string' || !event.key || event.key.length > 256) return { ok: false };
    try {
      const stored = { ...clone(event), at: event.at ?? this.clock() };
      const bytes = Buffer.byteLength(JSON.stringify(stored));
      if (bytes > 64000) return { ok: false };
      return await this.writeInOrder([task], async () => {
        if (this.closed || this.restoring || TERMINAL.has(task.status) || task.status === 'stopping') return { ok: false };
        if (task.eventKeys.includes(stored.key) || task.overflowEvent?.key === stored.key) return { ok: true, duplicate: true };
        if (current && !current()) return { ok: false, error: '观察位置已变化，等待重新核对' };
        const overflow = task.inbox.length >= 200 || Buffer.byteLength(JSON.stringify(task.inbox)) + bytes > 300000;
        if (overflow && task.overflowEvent) return { ok: false, error: '待处理事件已满，请先恢复处理积压' };
        const apply = (target, now) => {
          advance?.(target);
          target.counters.events++;
          if (overflow) {
            target.overflowEvent = clone(stored);
            if (!TERMINAL.has(target.status) && !['queued', 'paused', 'stopping'].includes(target.status)) {
              target.status = 'needs_attention';
              target.note = '待处理事件已满；本次新事件也已保存，暂停观察等待处理积压';
            }
          } else {
            target.inbox.push(clone(stored));
            target.eventKeys.push(stored.key);
            target.nextCheckAt = now;
            if (target === task) this.operations.supersede(target, stored);
          }
        };
        const snapshot = clone(task), now = this.clock();
        apply(snapshot, now);
        await this.commitSnapshot(task, snapshot, now, apply);
        this.schedule();
        return { ok: true, ...(overflow ? { overflow: true } : {}) };
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  async stop(task) {
    const id = task.id;
    if (this.stops.has(id)) return this.stops.get(id);
    const work = (async () => {
      const started = await this.admission(async () => {
        if (!this.canControl(task) || TERMINAL.has(task.status)) return false;
        this.cancelWorker(task);
        task.status = 'stopping';
        task.note = '正在停止任务';
        await this.save(task);
        this.schedule();
        return true;
      });
      if (!started) return { ok: false, error: '任务已结束或不可用' };

      let failure;
      try { await this.stopTask(task); }
      catch (error) { failure = error; }
      return this.admission(async () => {
        if (this.tasks.get(id) !== task || task.privacyEpoch !== this.epoch()) return { ok: false, error: '任务资料已变化' };
        task.status = failure ? 'needs_attention' : 'stopped';
        task.note = failure ? '停止尚未确认：' + failure.message : '已停止';
        await this.save(task);
        this.schedule();
        return failure ? { ok: false, error: task.note } : { ok: true };
      });
    })();
    this.stops.set(id, work);
    try { return await work; }
    finally { if (this.stops.get(id) === work) this.stops.delete(id); }
  }

  async control(action, id) {
    const task = this.tasks.get(id);
    if (!this.canControl(task)) return { ok: false, error: '请明确要控制的任务' };
    if (action === 'status') return { ok: true, task: this.list().find(t => t.id === id) };
    if (action === 'stop') return this.stop(task);
    return this.admission(async () => {
      if (!this.canControl(task) || !['pause', 'resume'].includes(action) || TERMINAL.has(task.status)) return { ok: false, error: '任务已结束或操作不合法' };
      if (task.status === 'stopping') return { ok: false, error: '正在停止，请等待确认' };
      if (action === 'resume' && Object.values(task.operations).some(op => op.effect === 'write' && op.status === 'intent')) {
        return { ok: false, error: '上次写入结果不确定，不能自动恢复或重发' };
      }
      if (action === 'resume' && !occupiesSlot(task) && task.skill !== 'task.resolve' && this.capacity().active >= MAX_ACTIVE_TASKS) {
        return { ok: false, error: capacityNote };
      }

      const queued = task.status === 'queued', group = this.actionGroups.get(id);
      const active = !!group?.workers.size && !group.parent.signal.aborted;
      if (action === 'pause' || !active) this.cancelWorker(task);
      else this.keepalive.cancel(id);
      if (action === 'resume') {
        const admission = this.admissionEpoch;
        await this.skills.get(task.skill).resume?.(task);
        if (admission !== this.admissionEpoch || !this.canControl(task) || TERMINAL.has(task.status)) return { ok: false, error: '任务状态已变化' };
        for (const run of Object.values(task.actionRuns)) {
          if (['needs_attention', 'waiting_permission'].includes(run.status)) run.status = 'waiting';
        }
      }
      task.status = action === 'pause' ? 'paused' : active ? 'running' : 'waiting';
      task.note = action === 'pause' ? '已暂停，保留待处理事项' : '继续原任务与待处理事项';
      task.nextCheckAt = this.clock();
      if (action === 'resume' && queued && task.schedule.durationMinutes) task.expiresAt = this.clock() + task.schedule.durationMinutes * 60000;
      await this.save(task);
      this.schedule();
      return { ok: true };
    });
  }
  async confirmReconciled(id,operationId,result){
    return this.admission(async () => {
      const task = this.tasks.get(id), op = task?.operations[operationId];
      if (!this.canControl(task) || op?.effect !== 'write' || op.status !== 'intent' ||
          this.operations.isRunning(task, op) || result?.verified !== true || result?.ok !== true) return { ok: false, error: '没有可核对的未确认操作' };
      const apply = (target, now) => {
        const entry = target.operations[operationId];
        entry.status = 'confirmed'; entry.result = clone(result); entry.finishedAt = now;
        delete entry.args; delete entry.error;
        target.counters.writes++;
        if (entry.actionId && target.actionRuns[entry.actionId]) target.actionRuns[entry.actionId].status = 'waiting';
        if (!TERMINAL.has(target.status) && target.status !== 'stopping') {
          target.status = 'paused'; target.note = '只读核对已确认本次操作，保留进展；可继续原任务';
        }
      };
      await this.persist(task, apply);
      this.schedule();
      return { ok: true };
    });
  }
  async controlAll(action,{excludeIds=[]}={}){
    if(action==='status')return {ok:true,tasks:this.list().filter(t=>!excludeIds.includes(t.id))};
    if(!['pause','stop','resume'].includes(action))return {ok:false,error:'任务控制不合法'};
    if(action!=='resume')this.admissionEpoch++;
    const targets=[...this.tasks.values()].filter(t=>!excludeIds.includes(t.id)&&!TERMINAL.has(t.status)&&canRead(this.getScene(),t)&&(action!=='resume'||t.status==='paused')&&(action!=='pause'||t.status!=='queued'));
    const results=[];
    for(const task of targets)results.push(await this.control(action,task.id));
    return {ok:results.every(r=>r.ok),...(results.some(r=>!r.ok)?{error:'部分任务有不确定操作，需要先核对'}:{})};
  }
  async update(id, patch, authorization) {
    try {
      return await this.admission(async () => {
        const task = this.tasks.get(id);
        const amendable = () => this.canControl(task) && !TERMINAL.has(task.status) && task.status !== 'stopping';
        if (!amendable()) throw new Error('找不到可修改的当前任务，或任务正在停止');
        const actor = authority(authorization, authorization?.scene || this.getScene());
        const allowed = ['goal', 'criteria', 'policy', 'parameters', 'schedule', 'completion', 'context', 'delivery', 'workContext', 'workRequest'];
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
            Object.keys(patch).some(key => !allowed.includes(key))) throw new Error('修改仅可调整当前任务目标、规则与周期');

        const { skill: name, goal, criteria, subjects, policy, parameters, completion, context, delivery, workContext, workRequest } = task;
        const spec = taskSpec({ skill: name, goal, criteria, subjects, policy, parameters, completion, context, delivery, workContext, workRequest,
          ...patch, schedule: { ...task.schedule, ...patch.schedule } });
        const skill = this.skills.get(spec.skill);
        await skill.validate?.(spec, actor);
        if (!amendable()) throw new Error('任务状态已变化，请重新查看后修改');
        const capabilities = this.capabilitiesFor(skill, spec, actor);
        const cadenceOnly = Object.keys(patch).length === 1 && Object.hasOwn(patch, 'schedule');
        const durationChanged = patch.schedule && Object.hasOwn(patch.schedule, 'durationMinutes');
        // Contextual reports may descend from this task, so use the new owner turn.
        const sources = (actor.originSourceId ? [actor.originSourceId] : actor.sources).filter(source => source !== id);
        const apply = (target, now) => {
          for (const key of Object.keys(patch)) {
            if (Object.hasOwn(spec, key)) target[key] = clone(spec[key]);
            else delete target[key];
          }
          target.sources = [...new Set([...target.sources, ...sources])];
          target.visibilityFloor = Math.max(target.visibilityFloor, actor.visibilityFloor);
          if (durationChanged) {
            if (spec.schedule.durationMinutes && target.status !== 'queued') target.expiresAt = now + spec.schedule.durationMinutes * 60000;
            else delete target.expiresAt;
          }
          if (cadenceOnly) return;
          target.capabilities = [...capabilities];
          target.state.goalRevision = (target.state.goalRevision || 0) + 1;
          for (const key of ['selfRepair', 'contextTuning', 'pendingDecision', 'recoveryGuidance']) delete target.state[key];
          for (const event of target.inbox) {
            delete event.decision;
            delete event.decisionAt;
          }
          const unknown = Object.values(target.operations).some(op => op.effect === 'write' && op.status === 'intent');
          if (!['queued', 'paused'].includes(target.status)) target.status = unknown ? 'needs_attention' : 'waiting';
          target.note = target.status === 'queued' ? '目标已更新；' + capacityNote : unknown ? '目标已更新；上次操作结果仍需核对' : '已更新原任务，保留已有进展';
          target.nextCheckAt = now;
        };

        if (!cadenceOnly) this.amending.add(id);
        try {
          await this.persist(task, apply);
          // An in-flight Operation still owns its receipt. Cancelling its
          // worker prevents it from continuing under the old instructions.
          if (!cadenceOnly) this.cancelWorker(task);
        } finally {
          this.amending.delete(id);
          this.schedule(25);
        }
        return { ok: true, id, queued: task.status === 'queued' };
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  selectWork(task) {
    const group = this.actionGroups.get(task.id);
    if(!group&&this.controllers.has(task.id))return;
    if(group?.parent.signal.aborted)return;
    const event = this.selectEvent(task, group);
    if(!event&&(task.inbox.length||group?.workers.size||['needs_attention','waiting_permission'].includes(task.status)))return;
    const pendingRun=Object.values(task.actionRuns).find(run=>run.status==='waiting'&&(event?run.eventKey===event.key:!run.eventKey));
    if(this.keepalive.pending.has(this.keepalive.key(task,pendingRun)))return;
    return { group, event };
  }
  async step(id) {
    const task=this.tasks.get(id),token=this.tokens.get(id);
    if (!task||!this.current(task,token,true))return;
    if (task.expiresAt && this.clock() >= task.expiresAt) {
      this.cancelWorker(task);
      task.status = 'expired';
      task.note = '已达到主人指定时长';
      await this.save(task);
      return;
    }
    const selected = this.selectWork(task);
    if (!selected) return;
    let { group, event } = selected;
    if(!group){const parent=new AbortController();group={parent,workers:new Map()};this.actionGroups.set(id,group);this.controllers.set(id,parent);}
    const workerKey=event?.key||'__task__',scope=this.eventScope(event),controller=new AbortController();
    const cancel=()=>controller.abort(group.parent.signal.reason);group.parent.signal.addEventListener('abort',cancel,{once:true});if(group.parent.signal.aborted)cancel();
    group.workers.set(workerKey,{eventKey:event?.key,scope,controller});let stopObservation,actionRun,progress;
    const actionKind=event?'event':!['task.resolve','conversation.manage','screen.watch'].includes(task.skill)?'goal':null;
    const actionId=actionKind?crypto.createHash('sha256').update(id+'\0'+actionKind+'\0'+(event?.key||'goal')).digest('hex'):null;
    try {
      if(!await this.journal.authorized(task))throw Object.assign(new Error('任务来源已失效'),{code:'E_TASK_AUTH'});
      if(!this.current(task,token,true))return;
      const skill=this.skills.get(task.skill);
      if(actionId){task.actionRuns??={};actionRun=task.actionRuns[actionId]??={id:actionId,eventKey:event?.key||null,scope,eventType:event?.type||'task.goal',createdAt:this.clock(),attempts:0};actionRun.status='running';actionRun.attempts++;actionRun.startedAt??=this.clock();progress=new ActionProgress(actionRun.progress??={},this.clock).wait(null);}
      if(!['needs_attention','waiting_permission'].includes(task.status))task.status='running';task.counters.wakes++;await this.save(task);
      if(event?.type==='conversation.messages')stopObservation=this.observeWhileActive?.(task,event,controller.signal);
      const call=call=>this.operations.execute({task,call,signal:controller.signal,actionId,
        isCurrent:()=>this.current(task,token,true)&&!controller.signal.aborted&&(!task.expiresAt||this.clock()<task.expiresAt)});
      const script=async plan=>{const steps=scriptPlan(plan,this.tools,task,skill),results=[];for(const action of steps)results.push(await call(action));return results;};
      const result=await skill.run({ task,progress,isLive:()=>this.current(task,token,true), event:clone(event), recovery:actionRun?.recovery,signal:controller.signal, call, script, now:this.clock(),clock:()=>this.clock(),
        availableTools:this.tools.catalog(undefined,task),validateCall:(name,args)=>this.tools.check(name,args,task),
        completedCall:(key,tool)=>{const op=Object.values(task.operations).find(o=>o.key===key&&o.tool===tool&&o.effect==='write'&&o.status==='confirmed'&&(!actionId||o.actionId===actionId));return op?clone(op.result):null;},
        checkpoint:async()=>{if(!this.current(task,token,true))throw new Error('任务已停止');await this.save(task);},
        enqueue:(event, options)=>this.enqueue(id,event,options), report:async(text,key)=>{
          if(typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('任务汇报不合法');
          const reportId=crypto.createHash('sha256').update(id+'\0'+key).digest('hex');
          if(task.reports.includes(reportId))return;
          await this.report({taskId:id,eventId:reportId,text,sources:[id],scene:task.scene,domain:task.domain,visibilityFloor:task.visibilityFloor,epoch:task.privacyEpoch});
          if(!this.current(task,token,true))return;task.reports.push(reportId);await this.save(task);
        } });
      if(!this.current(task,token,true))return;
      if(!result||!STATES.has(result.status)||['running','ready'].includes(result.status))throw new Error('技能没有返回可持续保存的任务状态');
      if(result.state&&result.state!==task.state)task.state=clone(result.state);
      if(task.state.selfRepair?.status==='retrying'){
        task.state.selfRepair.status='resumed';task.state.selfRepair.resumedAt=this.clock();
      }else if(task.state.selfRepair?.status==='resumed'&&this.clock()-task.state.selfRepair.resumedAt>=600000){
        delete task.state.selfRepair.profile;
      }
      if(task.skill==='conversation.manage')task.state.consecutiveReadFailures=0;
      // Shared logical-action progress survives retries, wording changes and
      // nested desktop execution. Passive monitors have no action ledger.
      if(progress&&result.status==='waiting'&&(!event||result.consumeEvent===false)){
        if(result.waitReason)progress.wait(result.waitReason);
        if(progress.reviewDue()){
          const timing=progress.reviewed();await this.save(task);
          let advice;try{advice=await this.diagnoseRepair?.({kind:'stall',skill:task.skill,code:'E_NO_PROGRESS',attempt:timing.reviews,phase:event?'pending_event':'task_step',errorType:'Error',progress:timing,signal:controller.signal});}catch{}
          if(!this.current(task,token,true)||controller.signal.aborted)return;
          const action=advice?.action||'change_method';
          actionRun.recovery={action,at:this.clock(),source:advice?.source==='llm'?'llm':'local'};
          task.state.recoveryGuidance={action,scope,eventKey:event?.key||null,at:this.clock(),progress:timing,nextStep:advice?.nextStep};
          if(action==='ask_owner'||timing.reviews>2&&advice?.source!=='llm'){
            result.status='needs_attention';result.consumeEvent=false;
            result.note=action==='ask_owner'?advice.nextStep||'Bunny 判断需要主人提供新的信息':`动作已耗时${Math.ceil(timing.elapsedMs/1000)}秒；恢复判断服务未能返回有效决策，保留原任务与回执`;
            await this.reportProgress(task,progress,actionId,result.note);
          }else if(action==='wait'&&advice.waitFor){
            result.nextCheckAt=this.clock()+Math.max(1000,Math.min(72000,advice.waitMs||3000));
            progress.wait('external:'+advice.waitFor);
          }
        }
      }
      if(event&&result.consumeEvent!==false)task.inbox=task.inbox.filter(e=>e.key!==event.key);
      if(task.overflowEvent&&task.inbox.length<200&&Buffer.byteLength(JSON.stringify(task.inbox))+Buffer.byteLength(JSON.stringify(task.overflowEvent))<=300000){task.inbox.push(task.overflowEvent);task.eventKeys.push(task.overflowEvent.key);delete task.overflowEvent;}
      if(actionRun){actionRun.status=['needs_attention','waiting_permission'].includes(result.status)?result.status:!event&&result.status!=='completed'||result.consumeEvent===false?'waiting':'completed';actionRun.note=String(result.note||'').slice(0,500);actionRun.updatedAt=this.clock();}
      const blockedRuns=Object.values(task.actionRuns||{}).filter(a=>['needs_attention','waiting_permission'].includes(a.status)),blocked=blockedRuns.map(a=>a.status);
      task.status=result.status==='completed'?'completed':blocked.includes('needs_attention')?'needs_attention':blocked.includes('waiting_permission')?'waiting_permission':group.workers.size>1?'running':result.status;
      task.note=String(blockedRuns.find(a=>a.status===task.status)?.note||result.note||'').slice(0,500);
      task.nextCheckAt=result.nextCheckAt??this.clock()+task.schedule.intervalSeconds*1000;
      this.keepalive.touch(task,actionRun,{waitReason:result.waitReason,nextCheckAt:task.nextCheckAt});
      if(task.inbox.some(e=>e.key!==event?.key&&!group.workers.has(e.key)))task.nextCheckAt=this.clock();
      await this.save(task);
      if(actionRun&&['completed','needs_attention'].includes(actionRun.status)&&event){try{await this.settled(task,actionRun);}catch{}}
      if(task.status==='completed'){group.parent.abort();await this.completed(task);}
    }catch(error){
      if(this.current(task,token,true)){
        if(error.code==='E_ACTION_SUPERSEDED'&&error.dispatched===false){if(actionRun)actionRun.status='waiting';const blocked=Object.values(task.actionRuns||{}).map(a=>a.status);task.status=blocked.includes('needs_attention')?'needs_attention':blocked.includes('waiting_permission')?'waiting_permission':'waiting';task.note='同一对象有新动态，正在合并后继续';task.nextCheckAt=this.clock();await this.save(task);this.schedule(25);return;}
        const unknown=Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='intent'&&(actionId?op.actionId===actionId:!op.actionId));
        // Resource contention is an ordinary wait, not a model/tool failure.
        // Preserve the event and cached decision without repair or backoff.
        if(['E_GUI_BUSY','E_CAPTURE_BUSY','E_OPERATION_BUSY'].includes(error.code)&&error.dispatched===false&&!unknown){
          if(actionRun){actionRun.status='waiting';actionRun.note=error.message;}
          const blocked=Object.values(task.actionRuns||{}).map(a=>a.status);
          task.status=blocked.includes('needs_attention')?'needs_attention':blocked.includes('waiting_permission')?'waiting_permission':'waiting';
          task.note=error.message;task.nextCheckAt=this.clock()+1000;await this.save(task);return;
        }
        try{await this.failed(task,error);}catch{}
        task.state.lastFailure={message:error.message,code:error.code||'E_STEP',at:this.clock(),unknown};
        const failureStatus=error.code==='E_PERMISSION_REQUIRED'?'waiting_permission':unknown||['E_TASK_AUTH','E_APP_CIRCUIT','E_NO_PROGRESS'].includes(error.code)?'needs_attention':'waiting';
        if(actionRun){actionRun.status=failureStatus;actionRun.note=error.message;actionRun.updatedAt=this.clock();}
        const blocked=Object.values(task.actionRuns||{}).map(a=>a.status);
        task.status=blocked.includes('needs_attention')?'needs_attention':blocked.includes('waiting_permission')?'waiting_permission':failureStatus;task.note=unknown?'操作结果不确定，已停止重发；'+error.message:error.message;
        if(error.code==='E_NO_PROGRESS')await this.reportProgress(task,progress,actionId,task.note);
        const repair=require('./self-repair'),kind=!unknown&&this.diagnoseRepair?repair.category(error):null;
        if(kind&&this.current(task,token,true)&&!controller.signal.aborted){
          const fingerprint=repair.incident(task,error),previous=task.state.selfRepair||{};
          const attempts=previous.fingerprint===fingerprint?(previous.attempts||0):0;
          const recent=(task.state.selfRepairAttempts||[]).filter(at=>Number.isFinite(at)&&this.clock()-at<3600000);
          if(attempts<2&&recent.length<4){
            task.state.selfRepairAttempts=[...recent,this.clock()];
            task.state.selfRepair={fingerprint,kind,attempts:attempts+1,status:'diagnosing',profile:previous.profile||{},at:this.clock()};
            task.note='遇到异常，正在分析并尝试恢复原任务';await this.save(task);
            let schemaAudit;if(kind==='schema')try{schemaAudit=repair.auditSchemas(this.tools.catalog(undefined,task));}catch{schemaAudit={checked:0,issues:1};}
            const code=/^E_[A-Z0-9_]{1,60}$/u.test(String(error.code||''))?error.code:'E_STEP';
            const errorType=['Error','TypeError','RangeError','SyntaxError'].includes(error.name)?error.name:'Error';
            const phase=task.state.pendingDecision?'pending_decision':task.inbox.length?'pending_event':'task_step';
            let advice;try{advice=await this.diagnoseRepair({kind,skill:task.skill,code,attempt:attempts+1,phase,errorType,schemaAudit,progress:progress?.snapshot(),signal:controller.signal});}catch{}
            if(!this.current(task,token,true)||controller.signal.aborted)return;
            const state=task.state.selfRepair;
            const allowed=repair.OPTIONS[kind];
            const action=allowed.includes(advice?.action)?advice.action:'defer';
            state.action=action;state.source=advice?.source==='llm'?'llm':'local';state.profile=repair.applyAction(state.profile,action,{code:error.code});
            state.status=action==='defer'?'deferred':'retrying';
            if(action==='defer')task.note='暂未找到可安全应用的修复，已保留任务并继续重试';
            if(action!=='defer'){
              task.note=action==='retry'?'诊断完成，正在重试原任务':'已调整本次请求，继续原任务';task.nextCheckAt=this.clock()+1000;await this.save(task);this.schedule(25);return;
            }
          }
        }
        if(error.code==='E_PERMISSION_REQUIRED'){task.state.missingPermissions=error.missing;task.state.permissionRequest=error.permissionRequest;}
        let retrySeconds=Math.max(30,task.schedule.intervalSeconds);
        if(task.skill==='conversation.manage'&&!unknown&&!['E_TASK_AUTH','E_APP_CIRCUIT','E_PERMISSION_REQUIRED'].includes(error.code)){
          task.state.consecutiveReadFailures=(task.state.consecutiveReadFailures||0)+1;
          retrySeconds=Math.min(30,3*2**Math.min(task.state.consecutiveReadFailures-1,4));
        }
        if(error.code==='E_GUI_BUSY'&&error.dispatched===false)retrySeconds=3;
        if(task.skill==='task.resolve'&&task.status==='waiting'){if(error.code==='E_TASK_SPEC')retrySeconds=1;else{task.state.admissionFailures=(task.state.admissionFailures||0)+1;retrySeconds=Math.min(900,30*2**Math.min(task.state.admissionFailures,5));}task.note='交办已保存，'+(require('./conversation-input').containsSecret(error.message)?'暂时无法继续':error.message.slice(0,180))+'；稍后自动继续。';}
        task.nextCheckAt=this.clock()+retrySeconds*1000;await this.save(task);
        if(actionRun?.status==='needs_attention'){try{await this.settled(task,actionRun);}catch{}}
      }
    }finally{
      this.keepalive.touch(task,actionRun);
      stopObservation?.();group.parent.signal.removeEventListener('abort',cancel);group.workers.delete(workerKey);
      if(actionRun?.status==='running'){actionRun.status=controller.signal.aborted?'cancelled':'waiting';actionRun.updatedAt=this.clock();if(this.tasks.get(id)===task)await this.save(task).catch(()=>{});}
      if(!group.workers.size&&this.actionGroups.get(id)===group){
        this.actionGroups.delete(id);if(this.controllers.get(id)===group.parent)this.controllers.delete(id);
        if(this.tasks.get(id)===task&&task.status==='running'){task.status='waiting';await this.save(task).catch(()=>{});}
      }
      this.schedule();
    }
  }
  async tick(id) {
    if (this.closed || this.restoring || !this.ready()) return;
    const now = this.clock();
    const due = id ? [id] : [...this.tasks.values()]
      .filter(task => task.nextCheckAt <= now || task.expiresAt && task.expiresAt <= now)
      .map(task => task.id);
    const work = Promise.all(due.map(task => this.step(task)));
    this.keepalive.inspect(this);
    this.schedule();
    await work;
  }
  schedule() {
    if (this.closed || this.restoring || !this.autoSchedule) return;
    const now = this.clock();
    let next = Infinity;
    for (const task of this.tasks.values()) {
      if (!this.current(task, this.tokens.get(task.id), true)) continue;
      if (task.expiresAt) next = Math.min(next, task.expiresAt);
      if (this.selectWork(task)) next = Math.min(next, task.nextCheckAt);
      next = Math.min(next, this.keepalive.nextWake(this, task, now));
    }
    const wakeAt = Math.max(now + 25, next);
    if (this.timer && this.wakeAt === wakeAt) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (!Number.isFinite(wakeAt)) return;
    this.wakeAt = wakeAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => this.schedule());
    }, Math.min(2_147_483_647, wakeAt - now));
    this.timer.unref?.();
  }
  async invalidate(reason = '资料或运行状态发生变化') {
    this.admissionEpoch++;
    const writes = [];
    for (const task of this.tasks.values()) {
      if (TERMINAL.has(task.status) || ['queued', 'stopping', 'paused'].includes(task.status)) continue;
      this.cancelWorker(task);
      task.status = 'paused';
      task.note = reason;
      if (task.privacyEpoch === this.epoch()) writes.push(this.save(task));
    }
    this.publish();
    this.schedule();
    await Promise.allSettled(writes);
  }
  async close() {
    this.closed = true;
    this.admissionEpoch++;
    this.keepalive.close();
    clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.pendingSaves.values());
  }
}
module.exports={ AgentRuntime };
