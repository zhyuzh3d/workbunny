'use strict';
const crypto = require('node:crypto');
const { TASK_SCHEMA, STATES, TERMINAL, MAX_ACTIVE_TASKS, occupiesSlot, capacityNote, taskSpec, authority, clone } = require('./agent-contract');
const { canRead } = require('./memory-scope');
const { scriptPlan } = require('./agent-tools');
const {ActionLifecycle}=require('./action-lifecycle');
class AgentRuntime {
  constructor({ journal, tools, skills, ready = () => true, epoch = () => 0, getScene = () => 'life', emit = () => {}, report = async () => {}, clock = Date.now, autoSchedule = true, prepare = async()=>{}, completed = async()=>{},failed=async()=>{},authorize=async()=>{},stopTask=async()=>{},diagnoseRepair=null,observeWhileActive=null }) {
    Object.assign(this, { journal, tools, skills, ready, epoch, getScene, emit, report, clock, autoSchedule, prepare, completed,failed,authorize,stopTask,diagnoseRepair,observeWhileActive });
    this.tasks = new Map(); this.controllers = new Map(); this.tokens = new Map(); this.closed = false; this.ticking = false; this.admissionEpoch = 0;
    this.admissionTail=Promise.resolve();this.stops=new Map();this.actions=new ActionLifecycle();
  }
  admission(action){const work=this.admissionTail.then(action);this.admissionTail=work.catch(()=>{});return work;}
  capacity(){return {limit:MAX_ACTIVE_TASKS,active:[...this.tasks.values()].filter(occupiesSlot).length,queued:[...this.tasks.values()].filter(t=>t.status==='queued').length};}
  admit(task){
    if(task.skill!=='task.resolve'&&this.capacity().active>=MAX_ACTIVE_TASKS){task.status='queued';task.note=capacityNote;delete task.expiresAt;return false;}
    task.status='ready';task.nextCheckAt=this.clock();if(task.schedule.durationMinutes&&!task.expiresAt)task.expiresAt=this.clock()+task.schedule.durationMinutes*60000;return true;
  }
  list() {
    return [...this.tasks.values()].filter(t => !(t.skill==='task.resolve'&&TERMINAL.has(t.status))&&t.privacyEpoch===this.epoch() && canRead(this.getScene(), t)).map(t => ({ id:t.id, goal:t.goal, skill:t.skill,
      presentation:require('./task-presentation').taskPresentation(t,{handling:this.controllers.has(t.id)&&t.status==='needs_attention'}),workJobId:t.state.workOperationId||t.state.job?.jobId||null,lastCheckedAt:t.state.lastCheckedAt||null,subjects:clone(t.subjects), status:t.status, note:t.note, createdAt:t.createdAt, updatedAt:t.updatedAt,
      nextCheckAt:t.nextCheckAt, expiresAt:t.expiresAt, queuedEvents:t.inbox.length+(t.overflowEvent?1:0),
      observationReady:t.skill==='conversation.manage'?Object.values(t.state.conversations||{}).filter(c=>c.cursor?.ready).length===t.subjects.length:undefined,
      counters:clone(t.counters), schedule:clone(t.schedule), completion:t.completion,delivery:clone(t.state.delivery||t.delivery||null),result:t.state.result?{revision:t.state.result.revision,source:clone(t.state.result.source||null),summary:t.state.result.summary,text:String(t.state.result.text||t.state.result.summary).slice(0,12000),artifacts:clone(t.state.result.artifacts||[])}:null })).sort((a,b)=>a.createdAt-b.createdAt);
  }
  publish() { this.emit(this.list()); }
  current(task, token) { return !this.closed && this.ready() && this.tasks.get(task.id) === task && this.tokens.get(task.id) === token &&
    task.privacyEpoch === this.epoch() && canRead(this.getScene(), task) && !TERMINAL.has(task.status) && !['queued','stopping','paused','needs_attention','waiting_permission'].includes(task.status); }
  async save(task) { task.updatedAt = this.clock(); await this.journal.put(clone(task)); this.publish(); }
  async start(specification, authorization, { signal, ownerRequest,ownerContext } = {}) {
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
        state:{...(ownerContext?{ownerContext:require('./agent-contract').text(ownerContext,'主人历史交办',12000)}:{}),...(typeof ownerRequest==='string'?{ownerRequest:require('./agent-contract').text(ownerRequest,'主人原始交办',12000)}:{})}, inbox:[], eventKeys:[], operations:{}, reports:[], counters:{ wakes:0, reads:0, writes:0, events:0 } };
      await this.prepare(task);
      return await this.admission(async()=>{
        if(signal?.aborted||admission!==this.admissionEpoch)return {ok:false,error:'交办在启动前被取消'};
        this.admit(task);await this.journal.put(clone(task));
        if(signal?.aborted||admission!==this.admissionEpoch){task.status='stopped';task.note='交办在启动前被取消';await this.journal.put(clone(task));return {ok:false,error:task.note};}
        this.tasks.set(task.id,task); this.tokens.set(task.id,0); this.publish(); this.schedule(25);
        return { ok:true, id:task.id,queued:task.status==='queued',...(task.status==='queued'?{note:capacityNote}:{}) };
      });
    } catch (error) { return { ok:false, error:error.message }; }
  }
  async adopt(id,specification,authorization,{signal,live=()=>true,replaceId}={}){
    const task=this.tasks.get(id);if(!task||signal?.aborted||!live())throw Error('交办已取消');
    const spec=taskSpec(specification),actor=authority(authorization,authorization.scene),skill=this.skills.get(spec.skill);try{await skill.validate?.(spec,actor);}catch(error){error.code||='E_TASK_SPEC';throw error;}
    const capabilities=skill.capabilitiesFor?skill.capabilitiesFor(spec):skill.capabilities;
    if(actor.capabilities&&capabilities.some(c=>!actor.capabilities.includes(c)))throw Object.assign(Error('主人入口没有此任务所需权限'),{code:'E_TASK_AUTH'});
    if(signal?.aborted||!live())throw Error('交办已取消');
    const staged=clone(task);
    if(staged.skill==='task.resolve')for(const key of ['context','delivery','workContext','workRequest'])delete staged[key];
    Object.assign(staged,spec);staged.authority=actor;staged.sources=[...new Set([...staged.sources,...actor.sources])];staged.capabilities=[...capabilities];staged.skillVersion=skill.version;staged.visibilityFloor=Math.max(staged.visibilityFloor,actor.visibilityFloor);
    staged.state.resolution={kind:'task',at:this.clock()};delete staged.state.selfRepair;await this.prepare(staged);if(signal?.aborted||!live())throw Error('交办已取消');
    // Publish executable state only after all preparation and persistence pass.
    // A failed adoption must leave a saved intent, never a half-prepared skill.
    return this.admission(async()=>{
      if(signal?.aborted||!live())throw Error('交办已取消');
      const prior=this.tasks.get(replaceId);
      // A continuation takes over the same slot and external conversation.
      if(prior&&!TERMINAL.has(prior.status)){this.tokens.set(prior.id,(this.tokens.get(prior.id)||0)+1);this.controllers.get(prior.id)?.abort();prior.status='stopped';prior.note='补充要求已接续到同一工作会话';await this.save(prior);}
      this.admit(staged);staged.updatedAt=this.clock();await this.journal.put(clone(staged));
      if(signal?.aborted||!live()){await this.journal.put(clone(task));throw Error('交办已取消');}
      for(const key of Object.keys(task))if(!(key in staged))delete task[key];Object.assign(task,staged);this.publish();return task;
    });
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
        if(task.status==='stopping'){task.status='needs_attention';task.note='上次停止尚未确认，请再次停止以核对外部任务';}
        // Only the guarded automatic-reply protocol proves that preparing
        // precedes any draft or submit. Older and other write intents remain unknown.
        for(const op of Object.values(task.operations||{}))if(op.effect==='write'&&op.status==='intent'&&op.tool==='conversation.send'&&op.lifecycle?.policy==='newer-event'&&op.lifecycle.phase==='preparing'){
          op.status='not_dispatched';op.lifecycle={...op.lifecycle,phase:'cancelled',reason:'restart-before-effect'};
        }
        if (!TERMINAL.has(task.status) && !['queued','paused','needs_attention','waiting_permission'].includes(task.status)) {
          const pending = Object.values(task.operations).some(op => op.effect === 'write' && op.status === 'intent');
          task.status = pending ? 'needs_attention' : 'waiting';
          task.note = pending ? '上次操作结果不确定；停止重发，等待核对' : '已恢复任务与待处理事件，等待重新观察';
          task.nextCheckAt = this.clock();
        }
        if(occupiesSlot(task)&&this.capacity().active>=MAX_ACTIVE_TASKS){task.status='queued';task.note=capacityNote;delete task.expiresAt;}
        this.tasks.set(task.id,task); this.tokens.set(task.id,0); await this.save(task);
      } catch { /* A removed skill/source never becomes an authorized task. */ }
    }
    this.schedule(); return { restored:this.tasks.size };
  }
  async enqueue(id, event) {
    const task = this.tasks.get(id);
    if (!task || TERMINAL.has(task.status) || typeof event?.key !== 'string' || !event.key || event.key.length > 256 || Buffer.byteLength(JSON.stringify(event)) > 64000) return { ok:false };
    if (task.eventKeys.includes(event.key)||task.overflowEvent?.key===event.key) return { ok:true, duplicate:true };
    if (task.inbox.length >= 200 || Buffer.byteLength(JSON.stringify(task.inbox))+Buffer.byteLength(JSON.stringify(event))>300000) { if(task.overflowEvent)return {ok:false,error:'待处理事件已满，请先恢复处理积压'}; task.overflowEvent={...clone(event),at:event.at??this.clock()}; task.counters.events++; if(task.status!=='queued')task.status='needs_attention'; task.note='待处理事件已满；本次新事件也已保存，暂停观察等待处理积压'; await this.save(task); return { ok:true,overflow:true }; }
    task.inbox.push({ ...clone(event), at:event.at ?? this.clock() }); task.eventKeys.push(event.key);
    task.counters.events++; task.nextCheckAt=this.clock(); await this.save(task);
    if(event.type==='conversation.messages'&&typeof event.subjectKey==='string'&&(event.messages||[]).some(m=>m.direction==='incoming'&&m.incomingVerified))
      this.actions.supersede({taskId:task.id,scope:task.id+':'+task.scene+':'+event.subjectKey,eventKey:event.key});
    this.schedule(25); return { ok:true };
  }
  async control(action, id) {
    const task = this.tasks.get(id);
    if (!task || !canRead(this.getScene(),task)) return { ok:false,error:'请明确要控制的任务' };
    if (action === 'status') return { ok:true, task:this.list().find(t=>t.id===id) };
    if (!['pause','resume','stop'].includes(action) || TERMINAL.has(task.status)) return { ok:false,error:'任务已结束或操作不合法' };
    if (action === 'resume' && Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='intent')) return { ok:false,error:'上次写入结果不确定，不能自动恢复或重发' };
    if(action==='stop'){
      if(this.stops.has(id))return this.stops.get(id);
      const work=(async()=>{
        this.tokens.set(id,(this.tokens.get(id)||0)+1);this.controllers.get(id)?.abort();task.status='stopping';task.note='正在停止任务';await this.save(task);
        try{await this.stopTask(task);task.status='stopped';task.note='已停止';await this.save(task);return {ok:true};}
        catch(error){task.status='needs_attention';task.note='停止尚未确认：'+error.message;await this.save(task);return {ok:false,error:task.note};}
      })();this.stops.set(id,work);try{return await work;}finally{this.stops.delete(id);}
    }
    return this.admission(async()=>{
      if(task.status==='stopping')return {ok:false,error:'正在停止，请等待确认'};
      if(action==='resume'&&!occupiesSlot(task)&&task.skill!=='task.resolve'&&this.capacity().active>=MAX_ACTIVE_TASKS)return {ok:false,error:capacityNote};
      const queued=task.status==='queued';this.tokens.set(id,(this.tokens.get(id)||0)+1);this.controllers.get(id)?.abort();
      if(action==='resume')await this.skills.get(task.skill).resume?.(task);
      task.status=action==='pause'?'paused':'waiting';task.note=action==='pause'?'已暂停，保留待处理事项':'继续原任务与待处理事项';task.nextCheckAt=this.clock();
      if(action==='resume'&&queued&&task.schedule.durationMinutes)task.expiresAt=this.clock()+task.schedule.durationMinutes*60000;
      await this.save(task);if(action==='resume')this.schedule(25);return {ok:true};
    });
  }
  async confirmReconciled(id,operationId,result){
    const task=this.tasks.get(id),op=task?.operations[operationId];
    if(!task||!canRead(this.getScene(),task)||op?.effect!=='write'||op.status!=='intent'||result?.verified!==true||result?.ok!==true)return {ok:false,error:'没有可核对的未确认操作'};
    op.status='confirmed';op.result=clone(result);op.finishedAt=this.clock();delete op.args;delete op.error;task.counters.writes++;
    if(!TERMINAL.has(task.status)){task.status='paused';task.note='只读核对已确认本次操作，保留进展；可继续原任务';}
    await this.save(task);return {ok:true};
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
  async update(id,patch,authorization){
    const task=this.tasks.get(id);if(!task||TERMINAL.has(task.status)||task.status==='stopping'||!canRead(this.getScene(),task))return {ok:false,error:'找不到可修改的当前任务，或任务正在停止'};
    try{
      const actor=authority(authorization,authorization?.scene||this.getScene());
      const allowed=['goal','criteria','policy','parameters','schedule','completion','context','delivery','workContext','workRequest'];
      if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!allowed.includes(k)))throw new Error('修改仅可调整当前任务目标、规则与周期');
      const spec=taskSpec({skill:task.skill,goal:task.goal,criteria:task.criteria,subjects:task.subjects,policy:task.policy,parameters:task.parameters,completion:task.completion,context:task.context,delivery:task.delivery,workContext:task.workContext,workRequest:task.workRequest,...patch,schedule:{...task.schedule,...patch.schedule}});
      const skill=this.skills.get(spec.skill);await skill.validate?.(spec,actor);
      const requested=skill.capabilitiesFor?skill.capabilitiesFor(spec):skill.capabilities;
      if(actor.capabilities&&requested.some(c=>!actor.capabilities.includes(c)))throw new Error('此主人入口未授权修改后的任务能力');
      return await this.admission(async()=>{
        // A cadence change is not a request to cancel an unrelated in-flight action.
        if(Object.keys(patch).length===1&&Object.hasOwn(patch,'schedule')){
          const amendmentSources=(actor.originSourceId?[actor.originSourceId]:actor.sources).filter(source=>source!==id);
          task.schedule=clone(spec.schedule);task.sources=[...new Set([...task.sources,...amendmentSources])];task.visibilityFloor=Math.max(task.visibilityFloor,actor.visibilityFloor);
          if(Object.hasOwn(patch.schedule,'durationMinutes')){if(spec.schedule.durationMinutes&&task.status!=='queued')task.expiresAt=this.clock()+spec.schedule.durationMinutes*60000;else delete task.expiresAt;}
          await this.save(task);return {ok:true,id,queued:task.status==='queued'};
        }
        const staged=clone(task),priorStatus=task.status;
        Object.assign(staged,spec);staged.capabilities=[...requested];
        // Contextual assistant reports may already descend from this task.
        // Amendments depend on the new owner turn, not its contextual descendants.
        const amendmentSources=(actor.originSourceId?[actor.originSourceId]:actor.sources).filter(source=>source!==id);
        staged.sources=[...new Set([...staged.sources,...amendmentSources])];
        staged.visibilityFloor=Math.max(staged.visibilityFloor,actor.visibilityFloor);staged.state.goalRevision=(staged.state.goalRevision||0)+1;delete staged.state.selfRepair;
        for(const event of staged.inbox)delete event.decision;
        const unknown=Object.values(staged.operations).some(op=>op.effect==='write'&&op.status==='intent');
        staged.status=['queued','paused'].includes(priorStatus)?priorStatus:unknown?'needs_attention':'waiting';
        staged.note=priorStatus==='queued'?'目标已更新；'+capacityNote:unknown?'目标已更新；上次操作结果仍需核对':'已更新原任务，保留已有进展';
        staged.nextCheckAt=this.clock();if(patch.schedule&&Object.hasOwn(patch.schedule,'durationMinutes')){if(spec.schedule.durationMinutes&&priorStatus!=='queued')staged.expiresAt=this.clock()+spec.schedule.durationMinutes*60000;else delete staged.expiresAt;}
        staged.updatedAt=this.clock();await this.journal.put(clone(staged));
        this.tokens.set(id,(this.tokens.get(id)||0)+1);this.controllers.get(id)?.abort();for(const key of Object.keys(task))if(!(key in staged))delete task[key];Object.assign(task,staged);this.publish();this.schedule(25);return {ok:true,id,queued:task.status==='queued'};
      });
    }catch(error){return {ok:false,error:error.message};}
  }
  async call(task, skill, call, token, signal) {
    if (!this.current(task,token) || signal.aborted) throw new Error('任务已停止或权限已变化');
    let checked;try{checked=this.tools.check(call.tool,call.args,task,skill);}catch(error){error.dispatched=false;throw error;}const {tool,input}=checked;
    if (typeof call.key !== 'string' || !call.key || call.key.length>200) throw new Error('工具调用缺少稳定操作标识');
    const id = crypto.createHash('sha256').update(task.id+'\0'+call.key).digest('hex');
    const argsHash=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior=task.operations[id];
    if (prior && (prior.tool !== tool.name || (prior.argsHash||crypto.createHash('sha256').update(JSON.stringify(prior.args)).digest('hex')) !== argsHash)) throw new Error('同一操作标识不能对应不同工具或参数');
    if (prior?.status==='confirmed' && tool.effect==='write') return clone(prior.result);
    if (prior?.status==='intent'&&prior.effect==='write') throw new Error('此写入结果不确定，禁止重试');
    await this.authorize(tool,input,task);
    const operation={ id,key:call.key,tool:tool.name,effect:tool.effect,args:input,argsHash,status:'intent',at:this.clock() };
    task.operations[id]=operation;
    const reads=Object.values(task.operations).filter(op=>op.effect==='read');
    for(const old of reads.slice(0,Math.max(0,reads.length-32)))delete task.operations[old.id];
    await this.save(task);
    if (!this.current(task,token)||signal.aborted) { operation.status='not_dispatched';await this.save(task);throw new Error('任务已暂停，未继续调用工具'); }
    const policy=tool.lifecycle?.(input,{task,call})||{policy:'independent'};
    const action=this.actions.start({id,taskId:task.id,scope:policy.scope,eventKey:policy.eventKey,policy:policy.policy,parentSignal:signal,
      onPhase:async phase=>{operation.lifecycle={...(operation.lifecycle||{}),phase};await this.save(task);}});
    if(policy.policy==='newer-event'){
      const index=task.inbox.findIndex(e=>e.key===policy.eventKey),later=index<0?[]:task.inbox.slice(index+1);
      const fresh=later.find(e=>e.type==='conversation.messages'&&task.id+':'+task.scene+':'+e.subjectKey===policy.scope&&(e.messages||[]).some(m=>m.direction==='incoming'&&m.incomingVerified));
      if(fresh)this.actions.supersede({taskId:task.id,scope:policy.scope,eventKey:fresh.key});
    }
    try {
      operation.lifecycle={phase:'preparing',policy:policy.policy};await this.save(task);
      if(action.signal.aborted||!this.current(task,token))throw Object.assign(Error('动作在执行前已停止'),{dispatched:false,...(action.superseded?{code:'E_ACTION_SUPERSEDED'}:{})});
      let result;const maxAttempts=Math.max(1,Math.min(2,Number(policy.maxAttempts)||1));
      for(let attempt=1;;attempt++){
        try{
          result=await tool.execute(input,{ task, signal:action.signal, action, operationId:id,attempt });
          if(tool.effect==='write'&&(result?.ok!==true||result?.verified!==true))throw Object.assign(new Error(result?.error||'写入结果尚未核实'),result?.dispatched===false?{dispatched:false,...(result.code?{code:result.code}:{})}:{});
          break;
        }catch(error){
          if(attempt>=maxAttempts||error.dispatched!==false||action.phase!=='preparing'||action.signal.aborted||!policy.shouldRetry?.(error))throw error;
          operation.status='not_dispatched';operation.lifecycle={...operation.lifecycle,phase:'recovering',attempt};await this.save(task);
          await policy.recover?.({error,task,input,signal:action.signal,attempt});
          if(action.signal.aborted||!this.current(task,token))throw Object.assign(Error('动作恢复前已停止'),{dispatched:false,...(action.superseded?{code:'E_ACTION_SUPERSEDED'}:{})});
          await this.authorize(tool,input,task);operation.status='intent';operation.lifecycle={...operation.lifecycle,phase:'preparing',attempt:attempt+1};await this.save(task);
        }
      }
      operation.status='confirmed';operation.lifecycle={...(operation.lifecycle||{}),phase:'completed'};operation.result=tool.effect==='write'?clone(result ?? {}):{ok:true};operation.finishedAt=this.clock();delete operation.args;
      task.counters[tool.effect==='write'?'writes':'reads']++; await this.save(task);
      if(!this.current(task,token)||signal.aborted)throw new Error('实际结果已核实并保存；任务已暂停，没有继续后续操作');
      return clone(result ?? {});
    } catch(error) {
      if(tool.effect==='read')error.dispatched=false;
      if (error.dispatched===false) operation.status='not_dispatched';
      if(action.superseded&&action.phase==='preparing'&&error.dispatched===false)error.code='E_ACTION_SUPERSEDED';
      operation.lifecycle={...(operation.lifecycle||{}),phase:operation.status==='not_dispatched'?'cancelled':operation.status==='confirmed'?'completed':'uncertain',...(action.superseded?{reason:'newer-event'}:{})};
      operation.error=error.message;await this.save(task);throw error;
    } finally {action.finish();}
  }
  async step(id) {
    const task=this.tasks.get(id),token=this.tokens.get(id);
    if (!task||!this.current(task,token)||this.controllers.has(id))return;
    const controller=new AbortController();this.controllers.set(id,controller);let stopObservation;
    try {
      if(!await this.journal.authorized(task))throw Object.assign(new Error('任务来源已失效'),{code:'E_TASK_AUTH'});
      if(!this.current(task,token))return;
      if(task.expiresAt&&this.clock()>=task.expiresAt){task.status='expired';task.note='已达到主人指定时长';await this.save(task);return;}
      const skill=this.skills.get(task.skill),event=task.inbox[0];task.status='running';task.counters.wakes++;await this.save(task);
      if(event?.type==='conversation.messages')stopObservation=this.observeWhileActive?.(task,event,controller.signal);
      const call=action=>this.call(task,skill,action,token,controller.signal);
      const script=async plan=>{const steps=scriptPlan(plan,this.tools,task,skill),results=[];for(const action of steps)results.push(await call(action));return results;};
      const result=await skill.run({ task,isLive:()=>this.current(task,token), event:clone(event), signal:controller.signal, call, script, now:this.clock(),clock:()=>this.clock(),
        availableTools:this.tools.catalog(skill.tools,task),validateCall:(name,args)=>this.tools.check(name,args,task,skill),checkpoint:async()=>{if(!this.current(task,token))throw new Error('任务已停止');await this.save(task);},
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
      if(task.state.selfRepair?.status==='retrying'){
        task.state.selfRepair.status='resumed';task.state.selfRepair.resumedAt=this.clock();
      }else if(task.state.selfRepair?.status==='resumed'&&this.clock()-task.state.selfRepair.resumedAt>=600000){
        delete task.state.selfRepair.profile;
      }
      if(task.skill==='conversation.manage')task.state.consecutiveReadFailures=0;
      if(event&&result.consumeEvent!==false)task.inbox=task.inbox.filter(e=>e.key!==event.key);
      if(task.overflowEvent&&task.inbox.length<200&&Buffer.byteLength(JSON.stringify(task.inbox))+Buffer.byteLength(JSON.stringify(task.overflowEvent))<=300000){task.inbox.push(task.overflowEvent);task.eventKeys.push(task.overflowEvent.key);delete task.overflowEvent;}
      task.status=result.status;task.note=String(result.note||'').slice(0,500);
      task.nextCheckAt=result.nextCheckAt??this.clock()+task.schedule.intervalSeconds*1000;
      await this.save(task);
      if(task.status==='completed')await this.completed(task);
    }catch(error){
      if(this.current(task,token)){
        if(error.code==='E_ACTION_SUPERSEDED'&&error.dispatched===false){task.status='waiting';task.note='同一对象有新动态，正在合并后继续';task.nextCheckAt=this.clock();await this.save(task);this.schedule(25);return;}
        try{await this.failed(task,error);}catch{}
        const unknown=Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='intent');
        task.state.lastFailure={message:error.message,code:error.code||'E_STEP',at:this.clock(),unknown};
        task.status=error.code==='E_PERMISSION_REQUIRED'?'waiting_permission':unknown||['E_TASK_AUTH','E_APP_CIRCUIT'].includes(error.code)?'needs_attention':'waiting';task.note=unknown?'操作结果不确定，已停止重发；'+error.message:error.message;
        const repair=require('./self-repair'),kind=!unknown&&this.diagnoseRepair?repair.category(error):null;
        if(kind&&this.current(task,token)&&!controller.signal.aborted){
          const fingerprint=repair.incident(task,error),previous=task.state.selfRepair||{};
          const attempts=previous.fingerprint===fingerprint?(previous.attempts||0):0;
          const recent=(task.state.selfRepairAttempts||[]).filter(at=>Number.isFinite(at)&&this.clock()-at<3600000);
          if(attempts<2&&recent.length<4){
            task.state.selfRepairAttempts=[...recent,this.clock()];
            task.state.selfRepair={fingerprint,kind,attempts:attempts+1,status:'diagnosing',profile:previous.profile||{},at:this.clock()};
            task.note='遇到异常，正在分析并尝试恢复原任务';await this.save(task);
            let schemaAudit;if(kind==='schema')try{schemaAudit=repair.auditSchemas(this.tools.catalog(this.skills.get(task.skill).tools,task));}catch{schemaAudit={checked:0,issues:1};}
            const code=/^E_[A-Z0-9_]{1,60}$/u.test(String(error.code||''))?error.code:'E_STEP';
            const errorType=['Error','TypeError','RangeError','SyntaxError'].includes(error.name)?error.name:'Error';
            const phase=task.state.pendingDecision?'pending_decision':task.inbox.length?'pending_event':'task_step';
            let advice;try{advice=await this.diagnoseRepair({kind,skill:task.skill,code,attempt:attempts+1,phase,errorType,schemaAudit,signal:controller.signal});}catch{}
            if(!this.current(task,token)||controller.signal.aborted)return;
            const state=task.state.selfRepair;
            const allowed={context:['compact_context','retry','defer'],schema:['repair_schema','retry','defer'],output:['increase_output','retry','defer'],unexpected:['retry','defer']}[kind];
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
      }
    }finally{stopObservation?.();if(this.controllers.get(id)===controller)this.controllers.delete(id);}
  }
  async tick(id) {
    if(this.closed||!this.ready())return;
    const due=[...this.tasks.values()].filter(task=>(!id||task.id===id)&&(id||task.nextCheckAt<=this.clock()));
    await Promise.all(due.map(task=>this.step(task.id)));
  }
  schedule(delay=1000){if(this.closed||!this.autoSchedule)return;clearTimeout(this.timer);this.timer=setTimeout(()=>{this.schedule();void this.tick().catch(()=>{});},delay);this.timer.unref?.();}
  async invalidate(reason='资料或运行状态发生变化'){
    for(const task of this.tasks.values())if(!TERMINAL.has(task.status)&&task.status!=='queued'){
      this.tokens.set(task.id,(this.tokens.get(task.id)||0)+1);this.controllers.get(task.id)?.abort();task.status='paused';task.note=reason;
    }this.publish();
  }
  async close(){this.closed=true;clearTimeout(this.timer);for(const c of this.controllers.values())c.abort();}
}
module.exports={ AgentRuntime };
