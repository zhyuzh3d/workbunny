'use strict';
const crypto = require('node:crypto');
const { TASK_SCHEMA, STATES, TERMINAL, taskSpec, authority, clone } = require('./agent-contract');
const { canRead } = require('./memory-scope');
const { scriptPlan } = require('./agent-tools');
class AgentRuntime {
  constructor({ journal, tools, skills, ready = () => true, epoch = () => 0, getScene = () => 'life', emit = () => {}, report = async () => {}, clock = Date.now, autoSchedule = true, prepare = async()=>{}, completed = async()=>{} }) {
    Object.assign(this, { journal, tools, skills, ready, epoch, getScene, emit, report, clock, autoSchedule, prepare, completed });
    this.tasks = new Map(); this.controllers = new Map(); this.tokens = new Map(); this.closed = false; this.ticking = false; this.admissionEpoch = 0;
  }
  list() {
    return [...this.tasks.values()].filter(t => t.privacyEpoch===this.epoch() && canRead(this.getScene(), t)).map(t => ({ id:t.id, goal:t.goal, skill:t.skill,
      subjects:clone(t.subjects), status:t.status, note:t.note, createdAt:t.createdAt, updatedAt:t.updatedAt,
      nextCheckAt:t.nextCheckAt, expiresAt:t.expiresAt, queuedEvents:t.inbox.length+(t.overflowEvent?1:0),
      observationReady:t.skill==='conversation.manage'?Object.values(t.state.conversations||{}).filter(c=>c.cursor?.ready).length===t.subjects.length:undefined,
      counters:clone(t.counters), schedule:clone(t.schedule), completion:t.completion }));
  }
  publish() { this.emit(this.list()); }
  current(task, token) { return !this.closed && this.ready() && this.tasks.get(task.id) === task && this.tokens.get(task.id) === token &&
    task.privacyEpoch === this.epoch() && canRead(this.getScene(), task) && !TERMINAL.has(task.status) && !['paused','needs_attention'].includes(task.status); }
  async save(task) { task.updatedAt = this.clock(); await this.journal.put(clone(task)); this.publish(); }
  async start(specification, authorization, { signal, ownerRequest } = {}) {
    const admission = this.admissionEpoch;
    if (this.closed || !this.ready()) return { ok:false, error:'请先解锁本地资料，再开始任务' };
    try {
      const spec = taskSpec(specification), actor = authority(authorization, authorization?.scene ?? this.getScene()), skill = this.skills.get(spec.skill);
      await skill.validate?.(spec, actor);
      if(signal?.aborted||admission!==this.admissionEpoch)return {ok:false,error:'交办已取消，没有开始任务'};
      const requested = skill.capabilitiesFor ? skill.capabilitiesFor(spec) : skill.capabilities;
      const capabilities = requested.filter(c => !actor.capabilities || actor.capabilities.includes(c));
      if (requested.some(c => !capabilities.includes(c))) throw new Error('主人入口未授权此任务需要的能力');
      if (skill.requiredCapabilities?.some(c => !capabilities.includes(c))) throw new Error('主人入口没有此任务所需权限');
      const now = this.clock(), task = { schema:TASK_SCHEMA, id:'agent-'+crypto.randomUUID(), ...spec,
        authority:actor, sources:actor.sources, scene:actor.scene, domain:actor.scene, visibilityFloor:actor.visibilityFloor,
        capabilities, skillVersion:skill.version, privacyEpoch:this.epoch(), createdAt:now, updatedAt:now,
        status:'ready', note:'已接到交办，等待执行', nextCheckAt:now,
        ...(spec.schedule.durationMinutes ? { expiresAt:now+spec.schedule.durationMinutes*60000 } : {}),
        state:{...(typeof ownerRequest==='string'?{ownerRequest:require('./agent-contract').text(ownerRequest,'主人原始交办',12000)}:{})}, inbox:[], eventKeys:[], operations:{}, reports:[], counters:{ wakes:0, reads:0, writes:0, events:0 } };
      await this.prepare(task);
      await this.journal.put(clone(task));
      if(signal?.aborted||admission!==this.admissionEpoch){task.status='stopped';task.note='交办在启动前被取消';await this.journal.put(clone(task));return {ok:false,error:task.note};}
      this.tasks.set(task.id,task); this.tokens.set(task.id,0); this.publish(); this.schedule(25);
      return { ok:true, id:task.id };
    } catch (error) { return { ok:false, error:error.message }; }
  }
  async restore() {
    for(const controller of this.controllers.values())controller.abort();
    this.controllers.clear();this.tasks.clear();this.tokens.clear();
    const records = await this.journal.list();
    for (const record of records) {
      if (record.schema !== TASK_SCHEMA) continue;
      try {
        this.skills.get(record.skill); const task = clone(record);
        if (!await this.journal.authorized(task)) continue;
        task.privacyEpoch = this.epoch();
        if (!TERMINAL.has(task.status) && !['paused','needs_attention'].includes(task.status)) {
          const pending = Object.values(task.operations).some(op => op.effect === 'write' && op.status === 'intent');
          task.status = pending ? 'needs_attention' : 'waiting';
          task.note = pending ? '上次操作结果不确定；停止重发，等待核对' : '已恢复任务与待处理事件，等待重新观察';
          task.nextCheckAt = this.clock();
        }
        this.tasks.set(task.id,task); this.tokens.set(task.id,0); await this.save(task);
      } catch { /* A removed skill/source never becomes an authorized task. */ }
    }
    this.schedule(); return { restored:this.tasks.size };
  }
  async enqueue(id, event) {
    const task = this.tasks.get(id);
    if (!task || TERMINAL.has(task.status) || typeof event?.key !== 'string' || !event.key || event.key.length > 256 || Buffer.byteLength(JSON.stringify(event)) > 64000) return { ok:false };
    if (task.eventKeys.includes(event.key)||task.overflowEvent?.key===event.key) return { ok:true, duplicate:true };
    if (task.inbox.length >= 200 || Buffer.byteLength(JSON.stringify(task.inbox))+Buffer.byteLength(JSON.stringify(event))>300000) { if(task.overflowEvent)return {ok:false,error:'待处理事件已满，请先恢复处理积压'}; task.overflowEvent={...clone(event),at:event.at??this.clock()}; task.counters.events++; task.status='needs_attention'; task.note='待处理事件已满；本次新事件也已保存，暂停观察等待处理积压'; await this.save(task); return { ok:true,overflow:true }; }
    task.inbox.push({ ...clone(event), at:event.at ?? this.clock() }); task.eventKeys.push(event.key);
    task.counters.events++; task.nextCheckAt=this.clock(); await this.save(task); this.schedule(25); return { ok:true };
  }
  async control(action, id) {
    const task = this.tasks.get(id);
    if (!task || !canRead(this.getScene(),task)) return { ok:false,error:'请明确要控制的任务' };
    if (action === 'status') return { ok:true, task:this.list().find(t=>t.id===id) };
    if (!['pause','resume','stop'].includes(action) || TERMINAL.has(task.status)) return { ok:false,error:'任务已结束或操作不合法' };
    if (action === 'resume' && Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='intent')) return { ok:false,error:'上次写入结果不确定，不能自动恢复或重发' };
    this.tokens.set(id,(this.tokens.get(id)||0)+1); this.controllers.get(id)?.abort();
    task.status = action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'waiting';
    task.note = action === 'pause' ? '已暂停，保留待处理事项' : action === 'stop' ? '已停止' : '继续原任务与待处理事项';
    task.nextCheckAt=this.clock(); await this.save(task); if(action==='resume')this.schedule(25); return { ok:true };
  }
  async confirmReconciled(id,operationId,result){
    const task=this.tasks.get(id),op=task?.operations[operationId];
    if(!task||!canRead(this.getScene(),task)||op?.effect!=='write'||op.status!=='intent'||result?.verified!==true||result?.ok!==true)return {ok:false,error:'没有可核对的未确认操作'};
    op.status='confirmed';op.result=clone(result);op.finishedAt=this.clock();delete op.args;delete op.error;task.counters.writes++;
    if(!TERMINAL.has(task.status)){task.status='paused';task.note='只读核对已确认本次操作，保留进展；可继续原任务';}
    await this.save(task);return {ok:true};
  }
  async controlAll(action){
    if(action==='status')return {ok:true,tasks:this.list()};
    if(!['pause','stop','resume'].includes(action))return {ok:false,error:'任务控制不合法'};
    if(action!=='resume')this.admissionEpoch++;
    const targets=[...this.tasks.values()].filter(t=>!TERMINAL.has(t.status)&&(action!=='resume'||canRead(this.getScene(),t)));
    if(action!=='resume')for(const task of targets){this.tokens.set(task.id,(this.tokens.get(task.id)||0)+1);this.controllers.get(task.id)?.abort();task.status=action==='pause'?'paused':'stopped';task.note=action==='pause'?'主人已暂停全部任务':'主人已停止全部任务';}
    const results=[];
    for(const task of targets){if(action==='resume')results.push(await this.control(action,task.id));else await this.save(task);}
    return {ok:results.every(r=>r.ok),...(results.some(r=>!r.ok)?{error:'部分任务有不确定操作，需要先核对'}:{})};
  }
  async update(id,patch,authorization){
    const task=this.tasks.get(id);if(!task||TERMINAL.has(task.status)||!canRead(this.getScene(),task))return {ok:false,error:'找不到可修改的当前任务'};
    try{
      const actor=authority(authorization,authorization?.scene||this.getScene());
      const allowed=['goal','criteria','policy','parameters','schedule','completion'];
      if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!allowed.includes(k)))throw new Error('修改仅可调整当前任务目标、规则与周期');
      const spec=taskSpec({skill:task.skill,goal:task.goal,criteria:task.criteria,subjects:task.subjects,policy:task.policy,parameters:task.parameters,schedule:task.schedule,completion:task.completion,...patch});
      const skill=this.skills.get(spec.skill);await skill.validate?.(spec,actor);
      const requested=skill.capabilitiesFor?skill.capabilitiesFor(spec):skill.capabilities;
      if(actor.capabilities&&requested.some(c=>!actor.capabilities.includes(c)))throw new Error('此主人入口未授权修改后的任务能力');
      this.tokens.set(id,(this.tokens.get(id)||0)+1);this.controllers.get(id)?.abort();
      Object.assign(task,spec);task.capabilities=[...requested];task.sources=[...new Set([...task.sources,...actor.sources])];
      task.visibilityFloor=Math.max(task.visibilityFloor,actor.visibilityFloor);task.state.goalRevision=(task.state.goalRevision||0)+1;
      for(const event of task.inbox)delete event.decision;
      const unknown=Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='intent');
      task.status=unknown?'needs_attention':'waiting';task.note=unknown?'目标已更新；上次操作结果仍需核对':'已更新原任务，保留已有进展';
      task.nextCheckAt=this.clock();if(patch.schedule?.durationMinutes)task.expiresAt=this.clock()+patch.schedule.durationMinutes*60000;
      await this.save(task);this.schedule(25);return {ok:true,id};
    }catch(error){return {ok:false,error:error.message};}
  }
  async call(task, skill, call, token, signal) {
    if (!this.current(task,token) || signal.aborted) throw new Error('任务已停止或权限已变化');
    const { tool, input } = this.tools.check(call.tool,call.args,task,skill);
    if (typeof call.key !== 'string' || !call.key || call.key.length>200) throw new Error('工具调用缺少稳定操作标识');
    const id = crypto.createHash('sha256').update(task.id+'\0'+call.key).digest('hex');
    const argsHash=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior=task.operations[id];
    if (prior && (prior.tool !== tool.name || (prior.argsHash||crypto.createHash('sha256').update(JSON.stringify(prior.args)).digest('hex')) !== argsHash)) throw new Error('同一操作标识不能对应不同工具或参数');
    if (prior?.status==='confirmed' && tool.effect==='write') return clone(prior.result);
    if (prior?.status==='intent'&&prior.effect==='write') throw new Error('此写入结果不确定，禁止重试');
    const operation={ id,key:call.key,tool:tool.name,effect:tool.effect,args:input,argsHash,status:'intent',at:this.clock() };
    task.operations[id]=operation;
    const reads=Object.values(task.operations).filter(op=>op.effect==='read');
    for(const old of reads.slice(0,Math.max(0,reads.length-32)))delete task.operations[old.id];
    await this.save(task);
    if (!this.current(task,token)||signal.aborted) { operation.status='not_dispatched';await this.save(task);throw new Error('任务已暂停，未继续调用工具'); }
    try {
      const result=await tool.execute(input,{ task, signal, operationId:id });
      if (tool.effect==='write' && (result?.ok!==true || result?.verified!==true)) {
        if (result?.dispatched===false) { operation.status='not_dispatched'; await this.save(task); }
        throw new Error(result?.error || '写入结果尚未核实');
      }
      operation.status='confirmed';operation.result=tool.effect==='write'?clone(result ?? {}):{ok:true};operation.finishedAt=this.clock();delete operation.args;
      task.counters[tool.effect==='write'?'writes':'reads']++; await this.save(task);
      if(!this.current(task,token)||signal.aborted)throw new Error('实际结果已核实并保存；任务已暂停，没有继续后续操作');
      return clone(result ?? {});
    } catch(error) {
      if (error.dispatched===false) operation.status='not_dispatched';
      operation.error=error.message;await this.save(task);throw error;
    }
  }
  async step(id) {
    const task=this.tasks.get(id),token=this.tokens.get(id);
    if (!task||!this.current(task,token)||this.controllers.has(id))return;
    const controller=new AbortController();this.controllers.set(id,controller);
    try {
      if(!await this.journal.authorized(task))throw Object.assign(new Error('任务来源已失效'),{code:'E_TASK_AUTH'});
      if(!this.current(task,token))return;
      if(task.expiresAt&&this.clock()>=task.expiresAt){task.status='expired';task.note='已达到主人指定时长';await this.save(task);return;}
      const skill=this.skills.get(task.skill),event=task.inbox[0];task.status='running';task.counters.wakes++;await this.save(task);
      const call=action=>this.call(task,skill,action,token,controller.signal);
      const script=async plan=>{const steps=scriptPlan(plan,this.tools,task,skill),results=[];for(const action of steps)results.push(await call(action));return results;};
      const result=await skill.run({ task, event:clone(event), signal:controller.signal, call, script, now:this.clock(),
        checkpoint:async()=>{if(!this.current(task,token))throw new Error('任务已停止');await this.save(task);},
        enqueue:e=>this.enqueue(id,e), report:async(text,key)=>{
          if(typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('任务汇报不合法');
          const reportId=crypto.createHash('sha256').update(id+'\0'+key).digest('hex');
          if(task.reports.includes(reportId))return;
          await this.report({taskId:id,eventId:reportId,text,sources:[id],scene:task.scene,domain:task.domain,visibilityFloor:task.visibilityFloor,epoch:task.privacyEpoch});
          if(!this.current(task,token))return;task.reports.push(reportId);await this.save(task);
        } });
      if(!this.current(task,token))return;
      if(!result||!STATES.has(result.status)||['running','ready'].includes(result.status))throw new Error('技能没有返回可持续保存的任务状态');
      if(result.state)task.state=clone(result.state);
      if(event&&result.consumeEvent!==false)task.inbox=task.inbox.filter(e=>e.key!==event.key);
      if(task.overflowEvent&&task.inbox.length<200&&Buffer.byteLength(JSON.stringify(task.inbox))+Buffer.byteLength(JSON.stringify(task.overflowEvent))<=300000){task.inbox.push(task.overflowEvent);task.eventKeys.push(task.overflowEvent.key);delete task.overflowEvent;}
      task.status=result.status;task.note=String(result.note||'').slice(0,500);
      task.nextCheckAt=result.nextCheckAt??this.clock()+task.schedule.intervalSeconds*1000;
      await this.save(task);
      if(task.status==='completed')await this.completed(task);
    }catch(error){
      if(this.current(task,token)){
        const unknown=Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='intent');
        task.status=unknown||['E_TASK_AUTH','E_APP_CIRCUIT'].includes(error.code)?'needs_attention':'waiting';task.note=unknown?'操作结果不确定，已停止重发；'+error.message:error.message;
        task.nextCheckAt=this.clock()+Math.max(30,task.schedule.intervalSeconds)*1000;await this.save(task);
      }
    }finally{if(this.controllers.get(id)===controller)this.controllers.delete(id);}
  }
  async tick(id) {
    if(this.closed||!this.ready())return;
    const due=[...this.tasks.values()].filter(task=>(!id||task.id===id)&&(id||task.nextCheckAt<=this.clock()));
    await Promise.all(due.map(task=>this.step(task.id)));
  }
  schedule(delay=1000){if(this.closed||!this.autoSchedule)return;clearTimeout(this.timer);this.timer=setTimeout(()=>{this.schedule();void this.tick().catch(()=>{});},delay);this.timer.unref?.();}
  async invalidate(reason='资料或运行状态发生变化'){
    for(const task of this.tasks.values())if(!TERMINAL.has(task.status)){
      this.tokens.set(task.id,(this.tokens.get(task.id)||0)+1);this.controllers.get(task.id)?.abort();task.status='paused';task.note=reason;
    }this.publish();
  }
  async close(){this.closed=true;clearTimeout(this.timer);for(const c of this.controllers.values())c.abort();}
}
module.exports={ AgentRuntime };
