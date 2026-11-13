'use strict';
const crypto = require('node:crypto');
const { TASK_SCHEMA, STATES, TERMINAL, MAX_ACTIVE_TASKS, occupiesSlot, capacityNote, taskSpec, authority, clone } = require('./agent-contract');
const { canRead } = require('./memory-scope');
const { scriptPlan } = require('./agent-tools');
const {OperationLedger,hasUncertainEffect,hasBlockingEffect,replayProtected,reconcileNavigationOnCompletion}=require('./operation-ledger');
const {ActionProgress}=require('./action-progress');
const recoveryPolicy=require('./action-recovery');
const {createBoundedWait}=require('./bounded-wait');
const {assertAdmission,waitAdmission}=require('./task-admission');
function resolveFailure(task,{operationId,actionId,at,reason}){
  const failure=task.state.lastFailure;
  if(!failure||Number.isFinite(failure.resolvedAt))return;
  if(failure.operationId?failure.operationId!==operationId:!actionId||failure.actionId!==actionId)return;
  if(operationId&&failure.actionId&&task.operations[operationId]?.actionId!==failure.actionId)return;
  failure.resolvedAt=at;failure.resolution=reason;
}
class AgentRuntime {
  constructor({ journal, tools, skills, request,ready = () => true, epoch = () => 0, getScene = () => 'life', emit = () => {}, report = async () => {}, clock = Date.now, autoSchedule = true, prepare = async()=>{}, completed = async()=>{},settled=async()=>{},failed=async()=>{},authorize=async()=>{},stopTask=async()=>{},stopTimeoutMs=30000,stopAckTimeoutMs=1000,diagnoseRepair=null,reflectAction=null,reviewTask,mainReviewOptions={},observeWhileActive=null,remindIdle=null,onRecoveryDiagnostic=()=>{},recoveryPolicy:recoveryOptions={},recoveryTimeoutMs=12000,stepTimeoutMs=360000 }) {
    Object.assign(this, { journal, tools, skills, ready, epoch, getScene, emit, report, clock, autoSchedule, prepare, completed,settled,failed,authorize,stopTask,stopTimeoutMs,stopAckTimeoutMs,diagnoseRepair,observeWhileActive,onRecoveryDiagnostic,recoveryTimeoutMs,stepTimeoutMs });
    this.recoveryPolicy={...recoveryPolicy.DEFAULTS,...recoveryOptions};
    this.taskRequest=request;this.remediationSkills=new Map();
    this.tasks = new Map(); this.controllers = new Map(); this.actionGroups = new Map(); this.tokens = new Map(); this.controlRequests = new Map(); this.closed = false; this.admissionEpoch = 0;
    this.admissionTail=Promise.resolve();this.stops=new Map();this.pendingSaves=new Map();this.amending=new Set();
    this.operations=new OperationLedger({tools,clock,authorize:(...args)=>this.authorize(...args),save:task=>this.saveOperation(task)});
    this.keepalive=new(require('./task-keepalive').TaskKeepalive)({clock,remind:remindIdle?(args=>this.withModelTrace(this.tasks.get(args.task.id),args.run,{signal:args.signal},()=>remindIdle(args))):null});
    this.reflectAction=reflectAction?(args=>this.withModelTrace(this.tasks.get(args.task.id),args.run,{signal:args.signal},()=>reflectAction(args))):null;
    this.mainReviews=new(require('./main-review').MainReview)(this,{reviewTask:reviewTask?(args=>this.withModelTrace(this.tasks.get(args.task.id),args.run,{signal:args.signal,isCurrent:args.isCurrent},()=>reviewTask(args))):undefined,...mainReviewOptions});
  }
  modelTraceScope(task,run,{signal,isCurrent=()=>this.canControl(task)&&!signal?.aborted}={}) {
    return {recorder:this.modelTrace,taskId:task.id,actionId:run?.id||null,generation:task.privacyEpoch,scene:task.scene,visibilityFloor:task.visibilityFloor,parentGoal:task.workRequest?.goal||task.goal,signal,isCurrent,
      registerModelOperation:async({requestId,purpose,attempt,at,parentOperationId})=>{
        if(!isCurrent()||!this.owns(task))throw Object.assign(Error('模型调用已取消'),{code:'ABORT_ERR'});
        const operationId=crypto.createHash('sha256').update(task.id+'\0model\0'+requestId).digest('hex');
        task.operations[operationId]={id:operationId,key:'model:'+requestId,kind:'model',tool:'model.request',effect:'read',status:'intent',...(run?.id?{actionId:run.id}:{}),requestId,purpose,attempt,parentOperationId,at:at||this.clock()};
        const old=Object.values(task.operations).filter(op=>op.kind==='model'&&op.status!=='intent');
        for(const op of old.slice(0,Math.max(0,old.length-64)))delete task.operations[op.id];
        await this.save(task);return {operationId};
      },
      completeModelOperation:async({operationId,requestId,status,validation,error})=>{
        if(!isCurrent()||!this.owns(task))return;const op=task.operations[operationId];if(!op||op.requestId!==requestId)return;
        Object.assign(op,{status:status==='completed'||status==='validated'?'confirmed':'failed',validation,error,finishedAt:this.clock()});await this.save(task);
      }};
  }
  withModelTrace(task,run,options,invoke){return task?require('./task-model-trace').scope(this.modelTraceScope(task,run,options),invoke):invoke();}
  executionSkill(task){
    const skill=this.skills.get(task.skill),goals=require('./goal-actions');
    if(!goals.returnedCompletion(task))return skill;
    let entry=this.remediationSkills.get(skill.id);
    if(entry?.original!==skill){entry={original:skill,skill:goals.remediationSkill(skill,{request:this.taskRequest})};this.remediationSkills.set(skill.id,entry);}
    return entry.skill;
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
  list({scene=this.getScene(),includeArchived=false}={}) {
    return [...this.tasks.values()].filter(t => (includeArchived||!t.state.listArchive)&&!(t.skill==='task.resolve'&&TERMINAL.has(t.status))&&t.privacyEpoch===this.epoch() && canRead(scene, t)).map(t => ({ id:t.id, goal:t.goal, skill:t.skill,listArchived:!!t.state.listArchive,
      presentation:require('./task-presentation').taskPresentation(t,{handling:this.controllers.has(t.id)&&t.status==='needs_attention'}),workJobId:t.state.workOperationId||t.state.job?.jobId||null,lastCheckedAt:t.state.lastCheckedAt||null,subjects:clone(t.subjects), status:t.status, note:t.note, createdAt:t.createdAt, updatedAt:t.updatedAt,
      nextCheckAt:t.nextCheckAt, expiresAt:t.expiresAt, stopRequest:clone(t.state.stopRequest||null),resources:clone(Object.values(t.state.resources||{})),cleanupLog:clone(t.state.cleanupLog||[]),queuedEvents:t.inbox.length+(t.overflowEvent?1:0),
      observationReady:t.skill==='conversation.manage'?Object.values(t.state.conversations||{}).filter(c=>c.cursor?.ready).length===t.subjects.length:undefined,
      counters:clone(t.counters), schedule:clone(t.schedule), completion:t.completion,delivery:clone(t.state.delivery||t.delivery||null),result:t.state.result?{revision:t.state.result.revision,source:clone(t.state.result.source||null),summary:t.state.result.summary,links:require('./result-links').resultLinks(t.state.result),text:String(t.state.result.text||t.state.result.summary).slice(0,12000),artifacts:clone(t.state.result.artifacts||[])}:null })).sort((a,b)=>a.createdAt-b.createdAt);
  }
  publish() {
    if (this.restoring) return;
    try { this.emit(this.list()); }
    catch { /* Delivery of a view does not change the durable task state. */ }
  }
  async reportProgress(task,progress,actionId,text){
    if(!progress||progress.state.blockedReportedAt)return;
    progress.state.blockedReportedAt=this.clock();await this.save(task);
    if(!this.owns(task)||task.state.stopRequest)return;
    await this.report({taskId:task.id,eventId:'progress:'+actionId,text,sources:[task.id],scene:task.scene,domain:task.domain,visibilityFloor:task.visibilityFloor,epoch:task.privacyEpoch});
  }
  async diagnose(args){
    if(!this.diagnoseRepair)return null;
    const wait=createBoundedWait({signal:args.signal,timeoutMs:this.recoveryTimeoutMs,code:'E_RECOVERY_TIMEOUT',message:'恢复判断达到时限'});
    try{return await wait.run(signal=>this.diagnoseRepair({...args,signal}));}
    catch{return null;}
    finally{wait.close();}
  }
  async recoverAction(task,run,progress,{event,error,signal,isCurrent,kind='stall'}={}){
    const owner=run||task.state,repair=require('./self-repair');
    const operations=Object.values(task.operations).filter(op=>run?op.actionId===run.id:!op.actionId);
    const state=recoveryPolicy.begin(owner,{progress,now:this.clock(),code:error?.code||'E_NO_PROGRESS',policy:this.recoveryPolicy,operations});
    if(this.mainReviews.isEnabled())state.episodeId ||= crypto.randomUUID();
    const modelKind=kind!=='stall';
    if(modelKind)task.state.selfRepair={fingerprint:repair.incident(task,error,progress),kind,attempts:state.attempts,status:state.exhausted?'exhausted':'diagnosing',profile:task.state.selfRepair?.profile||{},at:this.clock()};
    await this.save(task);
    if(!isCurrent())return null;
    let advice;
    if(!state.exhausted){
      let schemaAudit;if(kind==='schema')try{schemaAudit=repair.auditSchemas(this.tools.catalog(undefined,task));}catch{schemaAudit={checked:0,issues:1};}
      const code=/^E_[A-Z0-9_]{1,64}$/u.test(String(error?.code||''))?error.code:'E_NO_PROGRESS';
      if(this.reflectAction&&this.mainReviews.isEnabled()){
        const wait=createBoundedWait({signal,timeoutMs:this.recoveryTimeoutMs,code:'E_RECOVERY_TIMEOUT'});
        try{advice=await wait.run(signal=>this.reflectAction({task:clone(task),run:run?clone(run):null,event:clone(event),error:{code,message:String(error?.message||'').slice(0,500),diagnostic:repair.diagnostic(error?.diagnostic)},signal,kind}));}catch{}finally{wait.close();}
      }
      if(!advice)advice=await this.diagnose({kind,skill:task.skill,code,attempt:state.attempts,phase:event?'pending_event':task.state.pendingDecision?'pending_decision':'task_step',errorType:['Error','TypeError','RangeError','SyntaxError'].includes(error?.name)?error.name:'Error',schemaAudit,diagnostic:repair.diagnostic(error?.diagnostic),progress:progress?.snapshot(),signal});
    }
    if(!isCurrent())return null;
    if(advice?.assessment){const assessment=require('./main-review').assessment(advice.assessment);if(assessment)state.assessment=assessment;}
    if(advice?.selfSuspension&&this.mainReviews.request(task,run,{reason:'self-suspended',selfSuspension:advice.selfSuspension,assessment:advice.assessment}))
      return {status:task.status,note:task.note,nextCheckAt:this.clock(),consumeEvent:false,selfSuspended:true};
    const requestAction=modelKind&&repair.OPTIONS[kind]?.includes(advice?.action)?advice.action:null;
    const decision=recoveryPolicy.decide(state,modelKind?{source:advice?.source}:advice,{now:this.clock(),policy:this.recoveryPolicy,requestAction});
    if(modelKind){
      const repairState=task.state.selfRepair;repairState.action=requestAction||'defer';repairState.source=advice?.source==='llm'?'llm':'local';
      if(requestAction)repairState.profile=repair.applyAction(repairState.profile,requestAction,{code:error?.code});
      repairState.status=decision.exhausted?'exhausted':requestAction&&requestAction!=='defer'?'retrying':'deferred';
    }
    const guidance={...decision,scope:run?.scope||null,eventKey:event?.key||null,...(progress?{progress:progress.snapshot()}:{})};
    if(run)run.recovery=guidance;task.state.recoveryGuidance=guidance;
    if(decision.exhausted&&this.mainReviews.request(task,run,{reason:'local-budget'}))return {status:task.status,note:task.note,nextCheckAt:this.clock(),consumeEvent:false,awaitingMain:true};
    const detail=error?.message?'；'+(require('./conversation-input').containsSecret(error.message)?'暂时无法继续':String(error.message).slice(0,180)):'';
    const note=decision.exhausted?'自动恢复预算已到，尚未取得足够的多角度验证，不能认定真实障碍或永久阻塞；已保留目标、现场和回执，等待新证据后重新评估，或由主人补充信息、协助后继续。':decision.delayed?'暂未确认恢复，已安排有界延时复试，继续响应新消息与任务':'正在核对卡点、反思先前步骤并'+(decision.action==='change_method'?'调整方法继续原任务':'重新观察原任务')+detail;
    this.keepalive.touch(task,run,{waitReason:decision.delayed?decision.waitFor:undefined,nextCheckAt:decision.nextCheckAt});
    return {status:decision.exhausted?'needs_attention':'waiting',note:(task.skill==='task.resolve'?'交办已保存，':'')+note,nextCheckAt:decision.nextCheckAt??this.clock(),consumeEvent:false};
  }
  async reviewActionProgress(task,run,progress,{event,signal,isCurrent,force=false}){
    if(!progress||!force&&!progress.reviewDue())return null;
    progress.reviewed();
    return this.recoverAction(task,run,progress,{event,signal,isCurrent,kind:'stall'});
  }
  async retireTimedOut(task,{event,actionId,error}){
    if(!this.owns(task)||task.state.stopRequest)return;
    this.cancelWorker(task);
    const replacement=clone(task),now=this.clock();
    for(const run of Object.values(replacement.actionRuns||{}))if(run.status==='running')run.status='waiting';
    const unknown=Object.values(replacement.operations).some(op=>hasUncertainEffect(op));
    for(const op of Object.values(replacement.operations))if(op.status==='intent'&&op.effect==='read'&&!replayProtected(op)){op.status='not_dispatched';op.lifecycle={...op.lifecycle,phase:'cancelled',reason:'retired-caller'};}
    replacement.status=unknown?'needs_attention':'waiting';
    replacement.state.lastFailure={code:error.code,message:error.message,at:now,unknown,...(actionId?{actionId}:{})};
    this.tasks.set(task.id,replacement);this.operations.retire(task);
    this.actionGroups.delete(task.id);this.controllers.delete(task.id);
    const run=replacement.actionRuns[actionId],progress=run?new ActionProgress(run.progress??={},this.clock):null;
    if(unknown){
      for(const op of Object.values(replacement.operations))if(hasUncertainEffect(op)&&replacement.actionRuns[op.actionId])replacement.actionRuns[op.actionId].status='needs_attention';
      replacement.note='本轮调用达到时限，已释放本地执行等待；外部副作用尚未确认，保留回执且禁止重放，等待只读核对。';
      replacement.nextCheckAt=now;await this.save(replacement);return;
    }
    const controller=new AbortController(),token=this.tokens.get(task.id);this.controllers.set(task.id,controller);
    try{
      const recovery=await this.recoverAction(replacement,run,progress,{event,error,signal:controller.signal,isCurrent:()=>this.current(replacement,token,true)&&!controller.signal.aborted,kind:'stall'});
      if(!recovery)return;
      Object.assign(replacement,{status:recovery.status,note:recovery.note,nextCheckAt:recovery.nextCheckAt});
      if(run)Object.assign(run,{status:recovery.status,note:recovery.note});
      await this.save(replacement);
      if(recovery.status==='needs_attention')await this.reportProgress(replacement,progress,actionId,recovery.note);
    }finally{if(this.controllers.get(task.id)===controller)this.controllers.delete(task.id);this.schedule();}
  }
  current(task, token, activeAction = false) { return !this.closed && !this.restoring && !this.amending.has(task.id) && this.ready() && this.tasks.get(task.id) === task && this.tokens.get(task.id) === token &&
    task.privacyEpoch === this.epoch() && (canRead(this.getScene(), task)||task.authority?.channel==='authenticated-channel') && !task.state.listArchive && !task.state.stopRequest && !TERMINAL.has(task.status) &&
    !['queued','stopping','paused',...(activeAction?[]:['needs_attention','waiting_permission'])].includes(task.status); }
  eventScope(event) { return typeof event?.subjectKey==='string'&&event.subjectKey ? 'subject:'+event.subjectKey : typeof event?.scope==='string'&&event.scope ? 'scope:'+event.scope : null; }
  selectEvent(task, group) {
    const active=[...(group?.workers.values()||[])],blocked=Object.values(task.actionRuns||{}).filter(a=>['needs_attention','waiting_permission','paused'].includes(a.status)||recoveryPolicy.held(a));
    return task.inbox.find(event=>{
      const scope=this.eventScope(event);
      const pending=Object.values(task.actionRuns||{}).find(run=>run.eventKey===event.key);
      if(recoveryPolicy.deferred(pending,this.clock()))return false;
      if(active.some(a=>a.eventKey===event.key)||blocked.some(a=>a.eventKey===event.key||!a.scope||!scope||a.scope===scope))return false;
      return !active.length||!!scope&&active.every(a=>a.scope&&a.scope!==scope);
    });
  }
  cancelWorker(task,{cancelReview=true}={}) {
    this.keepalive.cancel(task.id);
    if(cancelReview)this.mainReviews.cancel(task);
    this.tokens.set(task.id, (this.tokens.get(task.id) || 0) + 1);
    this.controllers.get(task.id)?.abort();
  }
  canControl(task) {
    return !!task && !this.closed && !this.restoring && this.ready() && this.tasks.get(task.id) === task &&
      task.privacyEpoch === this.epoch() && canRead(this.getScene(), task);
  }
  owns(task) { return this.tasks.get(task.id) === task && task.privacyEpoch === this.epoch(); }
  async notifyCompleted(task){
    if(!this.owns(task)||task.state.stopRequest||task.status!=='completed')return;
    const proposal=task.state.completionProposal;
    const tracked=['accepted','bypassed'].includes(proposal?.status);
    if(tracked){
      if(proposal.callbackState)return;
      proposal.callbackState='claimed';proposal.callbackAt=this.clock();await this.save(task);
      if(!this.owns(task)||task.state.stopRequest||task.status!=='completed'||task.state.completionProposal?.id!==proposal.id)return;
    }
    this.actionGroups.get(task.id)?.parent.abort();
    try{await this.completed(task);if(tracked){proposal.callbackState='completed';await this.save(task);}}
    catch(error){if(tracked&&this.owns(task)){proposal.callbackState='failed';proposal.callbackError=String(error.code||error.name||'E_COMPLETION_CALLBACK').slice(0,80);await this.save(task).catch(()=>{});}else throw error;}
  }
  async saveOperation(task){
    if(this.closed)return;
    if(this.owns(task))return this.save(task);
    const current=this.tasks.get(task.id);
    if(!current||current.privacyEpoch!==task.privacyEpoch||current.privacyEpoch!==this.epoch())return;
    const confirmed=Object.values(task.operations).filter(op=>op.effect==='write'&&op.status==='confirmed'&&op.result?.ok===true&&op.result?.verified===true&&
      current.operations[op.id]?.status==='intent'&&current.operations[op.id].tool===op.tool&&current.operations[op.id].argsHash===op.argsHash);
    if(!confirmed.length)return;
    // A retired caller may contribute only a verified receipt for the exact
    // existing intent. No old task state, pending plan, report or status wins.
    await this.persist(current,target=>{for(const op of confirmed){const entry=target.operations[op.id];if(entry?.status!=='intent'||entry.argsHash!==op.argsHash)continue;target.operations[op.id]=clone(op);target.counters.writes++;resolveFailure(target,{operationId:op.id,at:this.clock(),reason:'late-operation-confirmed'});}});
  }
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
  waitForStorage(task,run){
    if(!this.owns(task)||task.state.stopRequest||TERMINAL.has(task.status)||!(task.state.storageWait?.nextAt>this.clock()))return false;
    const unknown=Object.values(task.operations).some(hasUncertainEffect);
    if(run)run.status=unknown?'needs_attention':'waiting';
    task.status=unknown?'needs_attention':'waiting';
    task.state.lastFailure={code:task.state.storageWait.code,at:this.clock(),unknown,storage:true};
    task.note='本地任务记录暂未保存，已保留当前任务与实际回执；稍后核对存储后继续';
    return true;
  }
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
    const storageWait=task.state.storageWait;delete snapshot.state.storageWait;
    try{await this.journal.put(snapshot);}catch(error){
      if(!amend&&this.owns(task)&&!TERMINAL.has(task.status)&&!task.state.stopRequest){
        const attempts=(task.state.storageWait?.attempts||0)+1,nextAt=this.clock()+Math.min(30000,1000*2**Math.min(attempts-1,5));
        task.state.storageWait={attempts,nextAt,at:this.clock(),code:error.code||'E_TASK_JOURNAL_UNAVAILABLE',...require('./vault-db').vaultErrorDiagnostic(error)};
        task.nextCheckAt=Math.max(task.nextCheckAt||0,nextAt);
      }
      throw error;
    }
    if (!this.owns(task)) throw new Error('任务资料版本已经变化');
    if(task.state.storageWait===storageWait)delete task.state.storageWait;
    amend?.(task, now);
    task.updatedAt = now;
    this.publish();
  }
  async start(specification, authorization, { signal, ownerRequest,ownerContext,initialState={},requestKey,authorizeAdmission=()=>{},commitGate,isCurrent=()=>true } = {}) {
    const admission = this.admissionEpoch, epoch = this.epoch();
    const live = () => !this.closed && !this.restoring && this.ready() && !signal?.aborted &&
      admission === this.admissionEpoch && epoch === this.epoch() && isCurrent() && (!commitGate || commitGate.isCurrent?.());
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
      await waitAdmission(commitGate,{signal,live});
      return await this.admission(async()=>{
        if(!live())return {ok:false,error:'交办在启动前被取消'};
        assertAdmission(commitGate,live);
        authorizeAdmission();
        if(requestKey){const existing=[...this.tasks.values()].find(t=>t.state.requestKey===requestKey);if(existing){if(existing.state.ownerRequest!==task.state.ownerRequest)throw Error('同一交办标识的原文不一致，未创建重复任务');if(existing.state.admissionPending)return {ok:false,id:existing.id,saved:true,paused:true,error:existing.note,code:'E_VOICE_COMMIT_UNCONFIRMED'};return {ok:true,id:existing.id,duplicate:true};}}
        this.admit(task);if(commitGate)task.state.admissionPending=true;await this.journal.put(clone(task));
        try{
          authorizeAdmission();assertAdmission(commitGate,live);
        }catch(error){
          task.status=commitGate?'paused':'stopped';task.note=error.message;
          if(commitGate)task.state.admissionPending=true;
          await this.journal.put(clone(task));
          if(commitGate&&epoch===this.epoch()&&!this.closed){this.tasks.set(task.id,task);this.tokens.set(task.id,0);this.publish();}
          return {ok:false,id:task.id,saved:true,paused:!!commitGate,error:error.message,code:error.code};
        }
        if(!live()){task.status='stopped';task.note='交办在启动前被取消';await this.journal.put(clone(task));return {ok:false,error:task.note};}
        if(commitGate)delete task.state.admissionPending;
        this.tasks.set(task.id,task); this.tokens.set(task.id,0); this.publish(); this.schedule(25);
        // Admission linearizes above, with no await between the fresh seal and
        // publication. Clearing its crash-safe marker is subsequent bookkeeping;
        // a later acoustic event cannot pretend that admission never happened.
        if(commitGate)try{await this.save(task);}catch(error){try{this.onRecoveryDiagnostic('admission-confirmation-save',task,error);}catch{}}
        return { ok:true, id:task.id,queued:task.status==='queued',...(task.status==='queued'?{note:capacityNote}:{}) };
      });
    } catch (error) { return { ok:false, error:error.message,...(error.code?{code:error.code}:{}) }; }
  }
  async adopt(id,specification,authorization,{signal,live=()=>true,replaceId,commitGate}={}){
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
    await waitAdmission(commitGate,{signal,live});
    // Publish executable state only after all preparation and persistence pass.
    // A failed adoption must leave a saved intent, never a half-prepared skill.
    const adopted=await this.admission(async () => {
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
          assertAdmission(commitGate,live);
          this.admit(staged, replacing);
          staged.updatedAt = this.clock();
          const stopped = replacing && { ...clone(replacing), status: 'stopped',
            note: '补充要求已接续到同一工作会话', updatedAt: staged.updatedAt,state:{...clone(replacing.state),stopRequest:{at:staged.updatedAt,phase:'confirmed',externalDisposition:'transferred'}} };
          if(commitGate)staged.state.admissionPending=true;
          await put(stopped ? [clone(staged), stopped] : [clone(staged)]);
          try{
            assertAdmission(commitGate,()=>!signal?.aborted&&live());
          }catch(error){
            if(commitGate&&this.owns(task)&&!TERMINAL.has(task.status)&&!task.state.stopRequest){task.status='paused';task.note=error.message;task.state.admissionPending=true;}
            if(records.every(record=>this.owns(record)))await put(records.map(clone));
            throw error;
          }
          if (signal?.aborted || !live()) {
            if (records.every(record => this.owns(record))) await put(records.map(clone));
            throw Error('交办已取消');
          }
          if (replacing) {
            this.cancelWorker(replacing);
            this.tasks.set(replacing.id,clone(stopped));
          }
          if(commitGate)delete staged.state.admissionPending;
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
    if(commitGate)try{await this.save(adopted);}catch(error){try{this.onRecoveryDiagnostic('admission-confirmation-save',adopted,error);}catch{}}
    return adopted;
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
      let active = 0,skipped=0;
      for (const record of records) {
       try{
        if (!live()) return { restored: 0 };
        if (record.schema !== TASK_SCHEMA || !this.skills.skills.has(record.skill) || !await this.journal.authorized(record)) continue;
        const task = clone(record);
        task.privacyEpoch = epoch;
        if ((!TERMINAL.has(task.status) || task.state.stopRequest&&(task.state.stopRequest.version!==2||task.state.stopRequest.phase==='pending')) && this.restoreTask(task)) changed.push(task);
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
       }catch(error){skipped++;try{this.onRecoveryDiagnostic('restore-task-record',record,error);}catch{}}
      }
      if (!live()) return { restored: 0 };
      this.controllers.clear();
      this.actionGroups.clear();
      this.tasks = restored;
      this.tokens = new Map([...restored.keys()].map(id => [id, 0]));
      for (const task of changed) {
        try { await this.save(task); }
        catch(error) {
          skipped++;try{this.onRecoveryDiagnostic('restore-task-save',task,error);}catch{}
          restored.delete(task.id);
          this.tokens.delete(task.id);
        }
      }
      return { restored: restored.size,...(skipped?{skipped}:{}) };
    }).finally(() => {
      this.restoring = false;
      this.restoreWork = null;
      this.publish();
      this.schedule();
      // Resume only this new lifecycle's unclaimed completion notification;
      // historical terminal tasks have no proposal and are never reviewed.
      for(const task of this.tasks.values())if(task.status==='completed'&&['accepted','bypassed'].includes(task.state.completionProposal?.status)&&!task.state.completionProposal.callbackState&&canRead(this.getScene(),task))void this.notifyCompleted(task).catch(()=>{});
    });
    return this.restoreWork;
  }

  restoreTask(task) {
    let changed = this.mainReviews.restore(task);
    for(const op of Object.values(task.operations||{}))for(const review of op.effectReviews||[])if(review.continuation?.status==='issued'){review.continuation.status='cancelled';review.continuation.reason='runtime-restarted';changed=true;}
    for(const op of Object.values(task.operations||{}))if(op.effectReview?.continuation?.status==='issued'){op.effectReview.continuation.status='cancelled';op.effectReview.continuation.reason='runtime-restarted';changed=true;}
    if(task.state.admissionPending&&!TERMINAL.has(task.status)&&!task.state.stopRequest){task.status='paused';task.note='上次语音交办的提交确认未完成，原输入已保留；等待重新确认后继续。';changed=true;}
    if(task.state.listArchive&&!TERMINAL.has(task.status)){task.status='stopped';task.state.stopRequest??={at:this.clock(),phase:'failed',cause:'list-clear'};task.note='任务已移出列表并停止；恢复列表不会继续执行';changed=true;}
    if(task.state.stopRequest||task.status==='stopping'||/^停止尚未确认：|^上次停止尚未确认/.test(task.note||'')){
      const prior=task.state.stopRequest||{},interrupted=prior.phase==='pending'||task.status==='stopping',failed=prior.phase!=='confirmed';
      task.state.stopRequest={...prior,version:2,at:prior.at||this.clock(),phase:failed?'failed':'confirmed',finishedAt:prior.finishedAt||this.clock()};
      task.status=prior.cause==='expired'?'expired':'stopped';
      if(failed){task.state.legacyStopNote??=task.note;task.note=interrupted?'Bunny 已停止；上次外部清理未完成，原记录已保留，不会再次执行。':'Bunny 已停止；旧版外部清理有未完成项，日志已保留。';}
      for(const entry of Object.values(task.state.resources||{}))if(!['ended','stopped','preserved'].includes(entry.phase)){
        entry.phase='unknown';entry.verified=false;entry.cleanupAttemptedAt??=this.clock();entry.reason=interrupted?'应用退出前未能确认清理完成；不会再次清理':entry.reason||'旧版清理未确认，记录已保留';
        if(interrupted){task.state.cleanupLog??=[];task.state.cleanupLog.push({id:entry.id,kind:entry.kind,label:entry.label,phase:'unknown',verified:false,reason:entry.reason,at:this.clock()});}
      }
      changed=true;
    }
    for (const run of Object.values(task.actionRuns)) {
      if (run.status === 'running') {
        run.status = 'waiting';
        changed = true;
      }
    }
    if(task.state.stopRequest){for(const run of Object.values(task.actionRuns))if(!['completed','cancelled'].includes(run.status))run.status='cancelled';return true;}
    let unknown = false;
    for (const op of Object.values(task.operations)) {
      if (!hasUncertainEffect(op)) continue;
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
      const delayed=Object.values(task.actionRuns).filter(run=>recoveryPolicy.deferred(run,this.clock())).map(run=>run.recoveryState.nextAt);
      task.nextCheckAt = unknown||this.selectEvent(task)?this.clock():delayed.length?Math.min(...delayed):recoveryPolicy.deferred(task.state,this.clock())?task.state.recoveryState.nextAt:this.clock();
      changed = true;
    }
    return changed;
  }
  async enqueue(id, event, { advance, current,recoveryEvidence=false } = {}) {
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
            if(recoveryEvidence&&!['queued'].includes(target.status)){
              const scope=this.eventScope(stored);
              for(const run of Object.values(target.actionRuns||{})){
                if((run.recoveryState?.selfSuspension||run.recoveryState?.mainReview)&&(!run.scope||run.scope===scope)){
                  new ActionProgress(run.progress??={},this.clock).observe('external.event',{type:stored.type,key:stored.key});
                  if(this.mainReviews.isEnabled()&&!['owner','protection'].includes(target.state.pauseSource)){
                    const prior=run.recoveryState.mainReview;if(prior){prior.status='cancelled';prior.rejectionReason='new-evidence';}
                    this.mainReviews.request(target,run,{reason:'new-evidence',hold:run.status==='paused'});
                  }
                  continue;
                }
                if(target.status==='paused')continue;
                if(run.recoveryState?.status!=='exhausted'||run.status!=='needs_attention'||run.scope&&run.scope!==scope||
                  Object.values(target.operations).some(op=>op.actionId===run.id&&hasUncertainEffect(op)))continue;
                // This flag belongs to trusted observation adapters, never a
                // model decision. Fresh actual evidence reopens assessment,
                // while permissions, stop latches and unknown writes still win.
                new ActionProgress(run.progress??={},this.clock).observe('external.event',{type:stored.type,key:stored.key});
                run.recoveryState.status='rearmed';run.recoveryState.rearmedAt=now;run.recoveryState.evidenceEvent=stored.key;
                run.status='waiting';run.recovery={action:'reobserve',source:'new-evidence',at:now,eventKey:stored.key,obstacleConfirmed:false,nextStep:'新的实际证据已到达；重新交叉核对卡点及前序步骤，尚未确认障碍已解决。'};
                target.state.recoveryGuidance=run.recovery;
              }
              if(target.status==='needs_attention'&&!Object.values(target.actionRuns).some(run=>['needs_attention','waiting_permission'].includes(run.status))&&
                !Object.values(target.operations).some(op=>hasUncertainEffect(op))){target.status='waiting';target.note='已收到新的实际证据，重新评估原任务；尚未宣称卡点已解决';}
            }
            if (target === task) this.operations.supersede(target, stored);
          }
        };
        const snapshot = clone(task), now = this.clock();
        apply(snapshot, now);
        await this.commitSnapshot(task, snapshot, now, apply);
        if (!overflow && stored.type === 'conversation.messages' && require('./conversation-cursor').hasNewInput(stored)) {
          const scope = this.eventScope(stored);
          for (const worker of this.actionGroups.get(id)?.workers.values() || []) {
            if (!scope || worker.scope !== scope || worker.eventKey === stored.key) continue;
            // Cancel planning immediately. Once a write Operation exists, its
            // lifecycle already cancels preparation at the safe boundary. Let
            // that Operation settle its actual non-dispatch/receipt before
            // releasing this worker, so a successor cannot inherit a transient
            // unknown write while the old draft is still being stopped.
            const settlingWrite = Object.values(task.operations).some(op => op.actionId === worker.actionId && hasUncertainEffect(op));
            if (!settlingWrite) worker.controller.abort(Object.assign(new Error('同一会话有新消息，保留原输入并合并回应'), { code: 'E_ACTION_SUPERSEDED', dispatched: false }));
          }
        }
        this.schedule();
        return { ok: true, ...(overflow ? { overflow: true } : {}) };
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  async stop(task,{terminalState='stopped',reason='已停止',cause='owner'}={}) {
    const id = task.id;
    if (this.stops.has(id)) return this.stops.get(id);
    if (!this.canControl(task)) return { ok:false, error:'任务当前不可控制，请先解锁资料库' };
    const openResources=Object.values(task.state.resources||{}).some(entry=>entry.ownership==='owned'&&!['ended','stopped','preserved'].includes(entry.phase));
    if(task.state.stopRequest||task.status==='stopped')return {ok:true,verified:true,localStopped:true,alreadyStopped:true,cleanupVerified:task.state.stopRequest?.phase!=='failed',message:task.note||'任务已停止；不会再次清理或继续执行'};
    if (TERMINAL.has(task.status) && task.status !== 'stopped' && !openResources) return { ok:false, error:'任务已结束，无需停止' };
    // Detach the canonical record from closures already running against the old
    // object. They may settle, but cannot mutate or persist the stopped task.
    const previous=task;task = clone(task); this.tasks.set(id, task);this.operations.retire(previous);
    // Owner cancellation is a latch, not a recoverable execution failure. Set it
    // before awaiting admission/storage so old workers lose authority at once.
    task.state.stopRequest = { at: task.state.stopRequest?.at || this.clock(), version:2,phase:'pending',cause,deadlineAt:Date.now()+this.stopTimeoutMs };
    task.status = terminalState; task.note = reason+'；Bunny 已停止，正在核对后台执行';
    this.cancelWorker(task); this.publish(); this.schedule();
    const work = (async () => {
      let storageFailure,failure,initialSaved=false,finalSaved=false;
      const controller=new AbortController();let timer;
      const timeout=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();for(const entry of Object.values(task.state.resources||{}))if(!['ended','stopped','preserved'].includes(entry.phase)){entry.phase='unknown';entry.verified=false;entry.reason='外部清理超过总时限，停止未确认';task.state.cleanupLog??=[];task.state.cleanupLog.push({id:entry.id,kind:entry.kind,label:entry.label,phase:'unknown',verified:false,reason:entry.reason,at:Date.now()});}failure=Error('外部清理超过总时限，仍未确认的资源已记录；Bunny 任务已停止，可以开始新任务');resolve();},this.stopTimeoutMs);});
      const stopping=Promise.race([Promise.resolve().then(()=>this.stopTask(task,{signal:controller.signal})).catch(error=>{if(!controller.signal.aborted)failure=error;}),timeout]).finally(()=>clearTimeout(timer));
      const initialSave=this.save(task).then(()=>{initialSaved=true;}).catch(error=>{storageFailure=error;});
      // Local cancellation and its acknowledgement never wait behind admission
      // or an unbounded storage queue. Persistence gets a bounded final grace.
      await stopping;
      return (async () => {
        if (this.tasks.get(id) !== task || task.privacyEpoch !== this.epoch()) return { ok: false, error: '任务资料已变化' };
        task.state.stopRequest.phase = failure ? 'failed' : 'confirmed';task.state.stopRequest.finishedAt=this.clock();task.state.stopRequest.cleanupErrors=failure?[failure.message]:[];
        task.status = terminalState;
        task.note = failure ? 'Bunny 已停止；外部清理未完成（已记录，不再尝试）：' + failure.message : reason+(task.state.stopRequest.preserved?.length?'；'+task.state.stopRequest.preserved.join('；'):'');
        this.publish();this.schedule();
        const finalSave=this.save(task).then(()=>{finalSaved=true;storageFailure=null;}).catch(error=>{storageFailure=error;});let storageTimer;
        try{await Promise.race([Promise.all([initialSave,finalSave]),new Promise(resolve=>{storageTimer=setTimeout(resolve,Math.max(0,task.state.stopRequest.deadlineAt-Date.now())+this.stopAckTimeoutMs);})]);}finally{clearTimeout(storageTimer);}
        if(!finalSaved){storageFailure??=Error('停止状态保存尚未确认');task.state.stopRequest.phase='failed';task.state.stopRequest.persistence='unconfirmed';task.note+='；停止状态保存失败或未确认：'+storageFailure.message+'。本地已停止，重启后的持久化状态需核对';this.publish();}
        return {ok:true,verified:true,localStopped:true,cleanupVerified:!failure,persistenceVerified:initialSaved||finalSaved,cleanupLogPersisted:finalSaved,cleanupErrors:[...(failure?[failure.message]:[]),...(!finalSaved?[storageFailure.message]:[])],preserved:clone(task.state.stopRequest.preserved||[]),message:task.note};
      })();
    })();
    this.stops.set(id, work);
    try { return await work; }
    finally { if (this.stops.get(id) === work) this.stops.delete(id); }
  }

  controlRevision(id) { return this.controlRequests.get(id)||0; }
  async observeSubscription(task,call,{signal,scope}={}) {
    const live=()=>!signal?.aborted&&this.canControl(task)&&!task.state.stopRequest&&['waiting','running','needs_attention','waiting_permission'].includes(task.status);
    if(!live()||!require('./goal-actions').readOnly(this.tools.get(call.tool)))throw Object.assign(Error('只读订阅已暂停'),{code:'ABORT_ERR',dispatched:false});
    const id=crypto.createHash('sha256').update(task.id+'\0subscription\0'+scope).digest('hex');
    const run=task.actionRuns[id]??={id,eventType:'task.observation',subscription:true,scope,subjects:[{application:call.args.application,...(call.args.recipient?{recipient:call.args.recipient}:{})}],goal:'持续感知当前授权对象的变化，保留最新动态并通知原Task',criteria:'新的实际变化已核对并进入原Task事件队列',createdAt:this.clock(),attempts:0,sequence:0};
    run.status='running';run.attempts++;
    const wait=createBoundedWait({signal,timeoutMs:this.stepTimeoutMs,code:'E_OBSERVATION_TIMEOUT',message:'只读观察达到本轮时限'}),current=()=>live()&&!wait.signal.aborted;
    try{return await wait.run(()=>this.withModelTrace(task,run,{signal:wait.signal,isCurrent:current},()=>this.operations.execute({task,call:{...call,key:'subscription:'+id+':'+run.sequence},signal:wait.signal,actionId:id,isCurrent:current})));}
    catch(error){if(this.owns(task)){run.lastFailure={code:error.code||'E_OBSERVATION',at:this.clock()};try{this.onRecoveryDiagnostic('subscription',task,error);}catch{}}throw error;}
    finally{wait.close();if(this.owns(task)&&!signal?.aborted){run.sequence++;run.status='waiting';run.updatedAt=this.clock();await this.save(task);}}
  }
  async reconcileEffect(id,args,{signal,ownerReviewed=false,reviewedInputKinds,sourceRefs}={}) {
    const task=this.tasks.get(id);
    if(signal?.aborted||!this.canControl(task)||task.state.stopRequest)return {ok:false,error:'Task已停止或核对权限变化'};
    let result;
    if(args.continuation){
      const original=task.operations[args.operationId],tool=original&&this.tools.get(original.tool),next=args.continuation.next,checked=next&&this.tools.check(next.tool,next.args,task);
      if(!tool?.continuationPolicy||!checked?.tool.continuationPolicy||!checked.tool.continuationPolicy(task,checked.input)||next.key===original.key||original.args?.message&&checked.input.message!==original.args.message)throw Object.assign(Error('新策略超出可控工具或原正文范围'),{code:'E_EFFECT_REVIEW',dispatched:false});
      result={ok:true,...require('./effect-review').assess(task,original,args,{policy:()=>tool.continuationPolicy(task,original.args||{}),at:this.clock()})};
    }else if(task.operations[args.operationId]?.effect==='write'&&args.outcome==='applied'){
      const original=task.operations[args.operationId],tool=this.tools.get(original.tool);
      result={ok:true,...require('./effect-review').assess(task,original,args,{policy:()=>tool.continuationPolicy?.(task,original.args||{}),at:this.clock()})};
    }else result={ok:true,...require('./operation-ledger').reconcileEffect(task,{...args,at:this.clock()},{ownerReviewed,reviewedInputKinds,sourceRefs})};
    if(result.ok&&args.outcome!=='unresolved'){
      const original=task.operations[args.operationId],run=task.actionRuns[original?.actionId];
      if(run&&!Object.values(task.operations).some(op=>op.actionId===run.id&&hasBlockingEffect(task,op))){run.status='cancelled';run.reconciliationReason='fresh-observation';run.updatedAt=this.clock();}
      resolveFailure(task,{operationId:args.operationId,at:this.clock(),reason:'effect-reconciled'});
      if(this.skills.get(task.skill).goalDirected){task.state.goalPlan??={};task.state.goalPlan.needsPlanning=true;}
    }
    await this.save(task);return result;
  }
  async upgradeGoal(id,{signal}={}) {
    const task=this.tasks.get(id),epoch=this.epoch(),token=this.tokens.get(id),controlRevision=this.controlRevision(id);
    const live=()=>!signal?.aborted&&this.canControl(task)&&task.status==='paused'&&!this.controllers.has(id)&&!this.actionGroups.get(id)?.workers.size&&epoch===this.epoch()&&token===this.tokens.get(id)&&controlRevision===this.controlRevision(id);
    if(!live())return {ok:false,error:'请先暂停当前Task并等待在途调用释放'};
    const staged=clone(task),wait=createBoundedWait({signal,timeoutMs:this.stepTimeoutMs,code:'E_CONTEXT_REFRESH_TIMEOUT',message:'任务经验刷新达到本轮时限'});
    try{
      await wait.run(()=>this.prepare(staged));
      if(!live())return {ok:false,superseded:true,error:'Task或主人控制已变化，未采用迟到经验'};
      const fields=['operatingKnowledge','operatingKnowledgeAvailability','useInnateExperience','softwarePackages','sensitiveContext'],at=this.clock();let result;
      await this.persist(task,target=>{
        if(!live())throw Object.assign(Error('Task或主人控制已变化，未采用迟到经验'),{code:'E_TASK_STALE'});
        for(const key of fields)if(Object.hasOwn(staged.state,key))target.state[key]=clone(staged.state[key]);
        target.sources=[...new Set([...target.sources,...staged.sources])];
        target.visibilityFloor=Math.max(target.visibilityFloor,staged.visibilityFloor);
        result=require('./goal-actions').upgrade(target,at);
      });
      return {...result,contextRefreshed:true};
    }catch(error){return {ok:false,error:error.message,code:error.code};}finally{wait.close();}
  }
  async control(action, id, {expectedRevision,commitGate,isCurrent=()=>true,signal}={}) {
    let task = this.tasks.get(id);
    if (!this.canControl(task)) return { ok: false, error: '请明确要控制的任务' };
    if (action === 'status') return { ok: true, task: this.list().find(t => t.id === id) };
    if(!['pause','resume','stop'].includes(action))return {ok:false,error:'任务控制不合法'};
    if(expectedRevision!==undefined&&expectedRevision!==this.controlRevision(id))return {ok:false,superseded:true,error:'已采用更新的任务控制，本次请求不再执行'};
    const requestRevision=this.controlRevision(id)+1;this.controlRequests.set(id,requestRevision);
    task.state.controlRevision=(task.state.controlRevision||0)+1;
    this.mainReviews.cancel(task,'owner-'+action);
    if (action === 'stop') return this.stop(task);
    if(task.state.listArchive)return {ok:false,error:'这项任务已移出列表，请先恢复列表；恢复显示不会自动执行'};
    const resumeAdmission=this.admissionEpoch;
    const resumeLive=()=>!signal?.aborted&&isCurrent()&&resumeAdmission===this.admissionEpoch&&this.canControl(task)&&!TERMINAL.has(task.status)&&!task.state.stopRequest&&requestRevision===this.controlRevision(id);
    // Voice resume preparation cannot hold the global admission lane while
    // waiting for renewed acoustic evidence or an asynchronous skill hook.
    if(action==='resume'&&commitGate)try{
      if(TERMINAL.has(task.status)||task.state.stopRequest||task.status==='stopping'||!this.skills.get(task.skill).goalDirected&&Object.values(task.operations).some(hasUncertainEffect))return {ok:false,error:'任务已停止或原操作结果不确定，未开始恢复准备'};
      await waitAdmission(commitGate,{signal,live:resumeLive});
      await this.skills.get(task.skill).resume?.(task);
      await waitAdmission(commitGate,{signal,live:resumeLive});
    }catch(error){return {ok:false,error:error.message,code:error.code};}
    return this.admission(async () => {
      if(requestRevision!==this.controlRevision(id))return {ok:false,superseded:true,error:'已采用更新的任务控制，本次请求不再执行'};
      if (!this.canControl(task) || !['pause', 'resume'].includes(action) || TERMINAL.has(task.status)) return { ok: false, error: '任务已结束或操作不合法' };
      if (task.state.stopRequest) return {ok:false,error:'任务已停止，不能继续或重试；请交办独立新任务'};
      if (task.status === 'stopping') return { ok: false, error: '正在停止，请等待确认' };
      if (action === 'resume' && !this.skills.get(task.skill).goalDirected && Object.values(task.operations).some(hasUncertainEffect)) {
        return { ok: false, error: '上次写入结果不确定，不能自动恢复或重发' };
      }
      if (action === 'resume' && !occupiesSlot(task) && task.skill !== 'task.resolve' && this.capacity().active >= MAX_ACTIVE_TASKS) {
        return { ok: false, error: capacityNote };
      }

      const queued = task.status === 'queued', group = this.actionGroups.get(id);
      const active = !!group?.workers.size && !group.parent.signal.aborted;
      if (action === 'pause') {
        const old=task;task=clone(task);this.tasks.set(id,task);this.cancelWorker(task);this.operations.retire(old);
        for(const run of Object.values(task.actionRuns))if(run.status==='running')run.status='waiting';
        this.actionGroups.delete(id);this.controllers.delete(id);
      }else if(!active)this.cancelWorker(task);
      else this.keepalive.cancel(id);
      if (action === 'resume') {
        if(commitGate)try{assertAdmission(commitGate,resumeLive);}catch(error){return {ok:false,error:error.message,code:error.code};}
        const admission = this.admissionEpoch;
        if(!commitGate)await this.skills.get(task.skill).resume?.(task);
        if(requestRevision!==this.controlRevision(id))return {ok:false,superseded:true,error:'已采用更新的任务控制，本次请求不再执行'};
        if (admission !== this.admissionEpoch || !this.canControl(task) || TERMINAL.has(task.status)) return { ok: false, error: '任务状态已变化' };
        for (const run of Object.values(task.actionRuns)) {
          if (['needs_attention', 'waiting_permission','paused'].includes(run.status)) run.status = 'waiting';
          if(run.recoveryState?.episodeId){
            recoveryPolicy.ownerResumed(run.recoveryState,{key:'owner:'+requestRevision,now:this.clock(),attempts:this.recoveryPolicy.attempts});
            delete run.visualRecovery;delete run.recovery;continue;
          }
          delete run.visualRecovery;delete run.recoveryState;delete run.recovery;
        }
        delete task.state.visualRecovery;if(!task.state.recoveryState?.episodeId)delete task.state.recoveryState;else recoveryPolicy.ownerResumed(task.state.recoveryState,{key:'owner:'+requestRevision,now:this.clock(),attempts:this.recoveryPolicy.attempts});delete task.state.recoveryGuidance;
      }
      if(action==='resume')delete task.state.admissionPending;
      task.status = action === 'pause' ? 'paused' : active ? 'running' : 'waiting';
      if(action==='pause')task.state.pauseSource='owner';else delete task.state.pauseSource;
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
      if (!this.canControl(task) || task.state.stopRequest || op?.effect !== 'write' || op.status !== 'intent' ||
          this.operations.isRunning(task, op) || result?.verified !== true || result?.ok !== true) return { ok: false, error: '没有可核对的未确认操作' };
      const apply = (target, now) => {
        const entry = target.operations[operationId];
        entry.status = 'confirmed'; entry.result = clone(result); entry.finishedAt = now;
        resolveFailure(target,{operationId,at:now,reason:'operation-confirmed'});
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
  async controlAll(action,{excludeIds=[],commitGate,isCurrent,signal}={}){
    if(action==='status')return {ok:true,tasks:this.list().filter(t=>!excludeIds.includes(t.id))};
    if(!['pause','stop','resume'].includes(action))return {ok:false,error:'任务控制不合法'};
    if(action!=='resume')this.admissionEpoch++;
    const targets=[...this.tasks.values()].filter(t=>!excludeIds.includes(t.id)&&(!TERMINAL.has(t.status)||action==='stop'&&!t.state.stopRequest&&t.status!=='stopped'&&Object.values(t.state.resources||{}).some(entry=>entry.ownership==='owned'&&entry.phase==='running'))&&canRead(this.getScene(),t)&&(action!=='resume'||t.status==='paused')&&(action!=='pause'||t.status!=='queued'));
    const results=[];
    if(action==='stop')results.push(...await Promise.all(targets.map(task=>this.control(action,task.id))));
    else for(const task of targets)results.push(await this.control(action,task.id,action==='resume'?{commitGate,isCurrent,signal}:{}));
    const cleanupErrors=results.flatMap(result=>result.cleanupErrors||[]),preserved=results.flatMap(result=>result.preserved||[]);
    return {ok:results.every(r=>r.ok),...(cleanupErrors.length||preserved.length?{cleanupErrors,preserved,message:'Bunny 任务已停止；'+[...cleanupErrors,...preserved].join('；')}:{}) ,...(results.some(r=>!r.ok)?{error:'部分任务有不确定操作，需要先核对'}:{})};
  }
  archiveList(ids){
    const key=ids===undefined?'clearList':'archive:'+JSON.stringify(Array.isArray(ids)?[...ids].sort():ids);
    if(this.listChangeWork)return this.listChangeKey===key?this.listChangeWork:Promise.resolve({ok:false,error:'任务列表正在更新，请稍后再操作'});
    const scene=this.getScene(),epoch=this.epoch(),visible=new Set(this.list().map(task=>task.id));
    if(ids!==undefined&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!visible.has(id))))return Promise.resolve({ok:false,error:'找不到当前列表中的任务'});
    if(ids===undefined)this.admissionEpoch++;
    const chosen=ids?new Set(ids):null,targets=[...this.tasks.values()].filter(task=>task.privacyEpoch===epoch&&canRead(scene,task)&&!task.state.listArchive&&(!chosen||chosen.has(task.id)));
    const work=(async()=>{
      const stopped=await Promise.all(targets.filter(task=>!TERMINAL.has(task.status)||!task.state.stopRequest&&Object.values(task.state.resources||{}).some(entry=>entry.ownership==='owned'&&entry.phase==='running')).map(task=>this.stop(task,{cause:'list-clear',reason:'已停止并移出任务列表'})));
      if(stopped.some(result=>!result.ok))return {ok:false,error:'部分任务未能确认本地停止，仍保留在列表中'};
      const count=targets.filter(task=>visible.has(task.id)).length;
      const result=await this.changeListVisibility(targets.map(task=>task.id),{at:this.clock(),batchId:crypto.randomUUID()},scene,epoch);
      const unresolved=targets.map(task=>this.tasks.get(task.id)).filter(task=>task?.state.stopRequest?.phase==='failed').length;
      return {...result,count:result.ok?count:result.count||0,...(result.ok?{message:'已移出 '+count+' 项任务；记忆、产物及原记录已保留。'+(unresolved?'其中 '+unresolved+' 项有外部清理错误，日志已保留，可恢复列表查看；不会再次执行。':'')}: {})};
    })();this.listChangeKey=key;this.listChangeWork=work.finally(()=>{this.listChangeWork=null;this.listChangeKey=null;});return this.listChangeWork;
  }
  restoreList(){
    if(this.listChangeWork)return this.listChangeKey==='restoreList'?this.listChangeWork:Promise.resolve({ok:false,error:'任务列表正在更新，请稍后再操作'});
    const scene=this.getScene(),epoch=this.epoch(),ids=[...this.tasks.values()].filter(task=>task.state.listArchive&&task.privacyEpoch===epoch&&canRead(scene,task)).map(task=>task.id),visible=new Set(this.list({includeArchived:true}).map(task=>task.id));
    const work=this.changeListVisibility(ids,null,scene,epoch).then(result=>({...result,...(result.ok?{count:ids.filter(id=>visible.has(id)).length,message:'已恢复任务列表；任务保持结束状态，不会自动执行或发送。'}:{})}));
    this.listChangeKey='restoreList';this.listChangeWork=work.finally(()=>{this.listChangeWork=null;this.listChangeKey=null;});return this.listChangeWork;
  }
  async changeListVisibility(ids,archive,scene,epoch){
    let count=0;
    try{
      for(let i=0;i<ids.length;i+=24){
        const tasks=ids.slice(i,i+24).map(id=>this.tasks.get(id));
        if(epoch!==this.epoch()||scene!==this.getScene()||!this.ready()||tasks.some(task=>!this.canControl(task)||!TERMINAL.has(task.status)))throw Error('任务或资料范围已变化，未继续清理列表');
        await this.writeInOrder(tasks,async()=>{
          const now=this.clock(),apply=task=>{if(archive){task.state.listArchive=clone(archive);for(const entry of task.state.reportOutbox||[])if(!['delivered','cancelled'].includes(entry.status)){entry.status='cancelled';entry.cancelledAt=now;entry.cancelledBy='task-list-clear';}}else delete task.state.listArchive;task.updatedAt=now;};
          const snapshots=tasks.map(task=>{const snapshot=clone(task);apply(snapshot);return snapshot;});
          if(snapshots.length>1){if(typeof this.journal.putAll!=='function')throw Error('任务记录不支持安全的批量保存');await this.journal.putAll(snapshots);}else if(snapshots.length)await this.journal.put(snapshots[0]);
          if(epoch!==this.epoch()||tasks.some(task=>!this.owns(task)))throw Error('任务资料已变化，请重新读取列表');
          for(const task of tasks)apply(task);count+=tasks.length;this.publish();
        });
      }
      return {ok:true,count};
    }catch(error){return {ok:false,count,error:'任务列表保存未完成：'+error.message+'；原资料未删除，可刷新后重试。'};}
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
          // A proposed result belongs to the old goal. Keep it as history,
          // rather than letting the resumed task immediately reuse its cache.
          if(target.state.completionProposal&&target.state.result){
            target.state.previousCompletionResults=[...(target.state.previousCompletionResults||[]),{proposalId:target.state.completionProposal.id,result:clone(target.state.result)}].slice(-2);
            delete target.state.result;
          }
          for (const key of ['selfRepair', 'contextTuning', 'pendingDecision', 'recoveryGuidance', 'recoveryState']) delete target.state[key];
          for (const event of target.inbox) {
            delete event.decision;
            delete event.decisionAt;
          }
          const unknown = Object.values(target.operations).some(hasUncertainEffect);
          if (!['queued', 'paused'].includes(target.status)) target.status = unknown ? 'needs_attention' : 'waiting';
          target.note = target.status === 'queued' ? '目标已更新；' + capacityNote : unknown ? '目标已更新；上次操作结果仍需核对' : '已更新原任务，保留已有进展';
          target.nextCheckAt = now;
        };

        if (!cadenceOnly) this.amending.add(id);
        try {
          await this.persist(task, apply);
          // An in-flight Operation still owns its receipt. Cancelling its
          // worker prevents it from continuing under the old instructions.
          if (!cadenceOnly) {
            const active=this.controllers.has(id);this.cancelWorker(task);
            if(active){
              const replacement=clone(task);for(const run of Object.values(replacement.actionRuns))if(run.status==='running')run.status='waiting';
              this.tasks.set(id,replacement);this.operations.retire(task);this.actionGroups.delete(id);this.controllers.delete(id);
            }
          }
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
    if(task.state.storageWait?.nextAt>this.clock())return;
    if(recoveryPolicy.held(task.state))return;
    const group = this.actionGroups.get(task.id);
    if(!group&&this.controllers.has(task.id))return;
    if(group?.parent.signal.aborted)return;
    const event = this.selectEvent(task, group),skill=event?this.skills.get(task.skill):this.executionSkill(task);
    const planned=!event&&typeof skill.actionSelection==='function'?skill.actionSelection(task,this.clock()):null;
    const plannedRun=planned?.id?task.actionRuns[planned.id]:planned?.phase?task.actionRuns[crypto.createHash('sha256').update(task.id+'\0'+planned.phase+'\0goal').digest('hex')]:null;
    const readonly=!!planned&&(planned.phase?.startsWith('goal.plan:')||plannedRun&&require('./goal-actions').nextReadOnly(plannedRun,this.tools));
    if(planned&&planned.phase===null)return;
    if(!event&&!planned&&(task.inbox.length||group?.workers.size||['needs_attention','waiting_permission'].includes(task.status)))return;
    const parallelReadonly=plannedRun?.schedule?.intervalSeconds&&plannedRun.operations?.length&&plannedRun.operations.every(op=>require('./goal-actions').readOnly(this.tools.get(op.tool)));
    if(planned&&group?.workers.size&&!parallelReadonly)return;
    if(planned&&['needs_attention','waiting_permission'].includes(task.status)&&!readonly)return;
    const pendingRun=planned?plannedRun:Object.values(task.actionRuns).find(run=>run.status==='waiting'&&(event?run.eventKey===event.key:!run.eventKey));
    if((pendingRun||task.state).resourceWait?.nextAt>this.clock())return;
    if(recoveryPolicy.held(pendingRun))return;
    if(recoveryPolicy.deferred(pendingRun||task.state,this.clock()))return;
    if(this.keepalive.pending.has(this.keepalive.key(task,pendingRun)))return;
    return { group, event, planned };
  }
  async step(id) {
    const task=this.tasks.get(id),token=this.tokens.get(id);
    if (!task||!this.current(task,token,true))return;
    if (task.expiresAt && this.clock() >= task.expiresAt) return this.stop(task,{terminalState:'expired',cause:'expired',reason:'已达到主人指定时长'});
    const selected = this.selectWork(task);
    if (!selected) return;
    let { group, event, planned } = selected;
    if(!group){const parent=new AbortController();group={parent,workers:new Map()};this.actionGroups.set(id,group);this.controllers.set(id,parent);}
    const workerKey=event?.key||planned?.id||'__task__',controller=new AbortController();let scope=this.eventScope(event);
    const cancel=()=>controller.abort(group.parent.signal.reason);group.parent.signal.addEventListener('abort',cancel,{once:true});if(group.parent.signal.aborted)cancel();
    group.workers.set(workerKey,{eventKey:event?.key,scope,controller});let stopObservation,actionRun,progress,failureOperationId,failureOperationError,stepWait;
    let skill,actionKind=null,actionId=null;
    try {
      if(!await this.journal.authorized(task))throw Object.assign(new Error('任务来源已失效'),{code:'E_TASK_AUTH'});
      if(!this.current(task,token,true))return;
      skill=event?this.skills.get(task.skill):this.executionSkill(task);
      // Continuous skills may declare a finite active phase without treating
      // passive observation as endless unfinished work. Its key survives retries.
      if(event)actionKind='event';
      else if(planned)actionKind=planned.phase;
      else if(typeof skill.activeAction==='function'){
        const phase=skill.activeAction(task);
        if(phase!=null&&(typeof phase!=='string'||!phase.trim()||phase.length>200))throw Error('技能主动阶段标识不合法');
        actionKind=phase??null;
        for(const run of Object.values(task.actionRuns)){
          if(run.activePhase&&run.activePhase!==actionKind&&!['completed','cancelled'].includes(run.status)&&
            !Object.values(task.operations).some(op=>op.actionId===run.id&&hasUncertainEffect(op)))run.status='cancelled';
        }
      }else if(!['task.resolve','conversation.manage','screen.watch'].includes(task.skill))actionKind='goal';
      actionId=planned?.id||(actionKind?crypto.createHash('sha256').update(id+'\0'+actionKind+'\0'+(event?.key||'goal')).digest('hex'):null);
      if(planned?.scope){scope=planned.scope;group.workers.get(workerKey).scope=scope;}
      if(actionKind&&!planned&&!event&&typeof skill.activeScope==='function'){
        scope=skill.activeScope(task,actionKind);
        if(scope!=null&&(typeof scope!=='string'||!scope||scope.length>200))throw Error('技能主动阶段范围不合法');
        group.workers.get(workerKey).scope=scope||null;
      }
      group.workers.get(workerKey).actionId=actionId;
      task.startedAt??=this.clock();
      if(actionId){task.actionRuns??={};actionRun=task.actionRuns[actionId]??={id:actionId,eventKey:event?.key||null,scope,eventType:event?.type||'task.goal',goal:task.goal,criteria:task.criteria||task.goal,...(!event&&typeof skill.activeAction==='function'?{activePhase:actionKind}:{}),createdAt:this.clock(),attempts:0};actionRun.status='running';actionRun.attempts++;actionRun.startedAt??=this.clock();progress=new ActionProgress(actionRun.progress??={},this.clock).wait(null);}
      recoveryPolicy.checking(actionRun||task.state,this.clock());
      if(!['needs_attention','waiting_permission'].includes(task.status))task.status='running';task.counters.wakes++;
      // tick() schedules before this worker resumes from its authorization
      // await. Arm monitoring again now that its active Action actually exists;
      // otherwise the first pending tool/model call can have no future tick.
      this.schedule();await this.save(task);
      stopObservation=this.observeWhileActive?.(task,event,controller.signal);
      stepWait=createBoundedWait({signal:controller.signal,timeoutMs:this.stepTimeoutMs,code:'E_ACTION_TIMEOUT',message:'本轮执行调用达到时限，保留实际状态并重新分析'});
      const live=()=>this.current(task,token,true)&&!stepWait.signal.aborted;
      const operationFor=call=>Object.values(task.operations).filter(op=>op.key===call.key&&(actionId?op.actionId===actionId:!op.actionId)).at(-1);
      const call=async call=>{
        try{
          if(Object.values(task.operations).some(op=>hasBlockingEffect(task,op)&&!require('./effect-review').permits(task,op,call,this.clock()))&&!require('./goal-actions').readOnly(this.tools.get(call.tool)))throw Object.assign(Error('原效果待评估；先观察并用effect.reconcile明确可控影响后选择新Operation，禁止重放旧key'),{code:'E_SUBMISSION_UNCERTAIN',dispatched:false});
          const result=await this.operations.execute({task,call,signal:stepWait.signal,actionId,
            isCurrent:()=>live()&&(!task.expiresAt||this.clock()<task.expiresAt)});
          const operation=operationFor(call);
          if((actionRun||task.state).resourceWait){(actionRun||task.state).resourceWait.resolvedAt=this.clock();delete (actionRun||task.state).resourceWait.nextAt;}
          if(this.current(task,token,true)&&!controller.signal.aborted&&operation?.status==='confirmed')resolveFailure(task,{operationId:operation.id,at:this.clock(),reason:'operation-confirmed'});
          return result;
        }catch(error){const operation=operationFor(call);if(operation?.error===error.message){failureOperationId=operation.id;failureOperationError=error;}throw error;}
      };
      const script=async plan=>{const steps=scriptPlan(plan,this.tools,task,skill),results=[];for(const action of steps)results.push(await call(action));return results;};
      const traceContext=this.modelTraceScope(task,actionRun,{signal:stepWait.signal,isCurrent:live});
      const taskGuidance=task.state.recoveryGuidance;
      const currentGuidance=taskGuidance?.reviewedResult&&!(actionRun?.recovery?.at>taskGuidance.at)?taskGuidance:actionRun?.recovery||taskGuidance;
      const result=await stepWait.run(()=>require('./task-model-trace').scope(traceContext,()=>skill.run({ task,action:actionRun,progress,isLive:live, event:clone(event), recovery:currentGuidance,mainReviewEnabled:this.mainReviews.isEnabled(),signal:stepWait.signal, call, script, now:this.clock(),clock:()=>this.clock(),
        availableTools:this.tools.catalog(undefined,task).filter(tool=>!Object.values(task.operations).some(op=>hasBlockingEffect(task,op))||require('./goal-actions').readOnly(tool)||!!this.tools.get(tool.name).continuationPolicy),validateCall:(name,args)=>this.tools.check(name,args,task),
        completedCall:(key,tool)=>{const op=Object.values(task.operations).find(o=>o.key===key&&o.tool===tool&&o.effect==='write'&&o.status==='confirmed'&&(!actionId||o.actionId===actionId));return op?clone(op.result):null;},
        checkpoint:async()=>{if(!live())throw new Error('任务已停止');await this.save(task);},
        enqueue:(event, options)=>live()?this.enqueue(id,event,{...options,current:()=>live()&&(!options?.current||options.current())}):Promise.resolve({ok:false}), report:async(text,key,details={})=>{
          // Interpretation may have just adopted a valid queued Task. Reporting
          // that durable result is allowed even though queued work cannot run.
          if(this.closed||!this.owns(task)||this.tokens.get(id)!==token||task.state.stopRequest||task.state.listArchive||stepWait.signal.aborted)return;
          if(typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('任务汇报不合法');
          const reportId=crypto.createHash('sha256').update(id+'\0'+key).digest('hex');
          if(task.reports.includes(reportId))return;
          const reportDetails={};
          if(Array.isArray(details.links)){const requested=new Set(require('./result-links').normalizeResultLinks(details.links).map(link=>link.url));reportDetails.links=require('./result-links').resultLinks(task.state.result).filter(link=>requested.has(link.url));}
          if(typeof details.speechText==='string'&&details.speechText.length<=12000)reportDetails.speechText=details.speechText;
          await this.report({taskId:id,eventId:reportId,text,...reportDetails,sources:[id],scene:task.scene,domain:task.domain,visibilityFloor:task.visibilityFloor,epoch:task.privacyEpoch});
          if(!this.current(task,token,true))return;task.reports.push(reportId);await this.save(task);
        } })));
      if(!this.current(task,token,true))return;
      if(!result||!STATES.has(result.status)||['running','ready'].includes(result.status))throw new Error('技能没有返回可持续保存的任务状态');
      if(result.state&&result.state!==task.state)task.state=clone(result.state);
      if(result.status==='completed')reconcileNavigationOnCompletion(task,{at:this.clock(),basis:result.note||'任务脑依据当前观察判断导航目标已达到'});
      if(result.selfSuspension&&this.mainReviews.request(task,actionRun,{reason:'self-suspended',selfSuspension:result.selfSuspension,assessment:result.assessment})){
        await this.save(task);return;
      }
      if(this.mainReviews.isEnabled()&&['stopped','paused','needs_attention'].includes(result.status)&&!result.protection&&!result.clarification&&
        !Object.values(task.operations).some(op=>hasUncertainEffect(op))){
        this.mainReviews.request(task,actionRun,{reason:'task-disposition-proposal',assessment:{summary:result.note||'任务脑建议暂缓，等待整体评估'}});
        await this.save(task);return;
      }
      if(!['needs_attention','waiting_permission'].includes(result.status)&&!Object.values(task.operations).some(op=>hasUncertainEffect(op)&&(actionId?op.actionId===actionId:!op.actionId)))
        resolveFailure(task,{actionId,at:this.clock(),reason:'action-progressed'});
      if(task.state.selfRepair?.status==='retrying'){
        task.state.selfRepair.status='resumed';task.state.selfRepair.resumedAt=this.clock();
      }else if(task.state.selfRepair?.status==='resumed'&&this.clock()-task.state.selfRepair.resumedAt>=600000){
        delete task.state.selfRepair.profile;
      }
      if(task.skill==='conversation.manage')task.state.consecutiveReadFailures=0;
      const activePending=actionRun?.goalAction?!result.actionComplete:!event&&typeof skill.activeAction==='function'?skill.activeAction(task)===actionKind:!event;
      if(actionRun)actionRun.failedAttempts=0;
      delete (actionRun||task.state).visualRecovery;
      recoveryPolicy.resumed(actionRun||task.state,progress,this.clock());
      // Shared logical-action progress survives retries, wording changes and
      // nested desktop execution. Passive monitors have no action ledger.
      if(progress&&result.status==='waiting'&&(activePending||event&&result.consumeEvent===false)){
        if(result.waitReason)progress.wait(result.waitReason);
        const review=await this.reviewActionProgress(task,actionRun,progress,{event,signal:controller.signal,isCurrent:()=>this.current(task,token,true)&&!controller.signal.aborted});
        if(!this.current(task,token,true)||controller.signal.aborted)return;
        if(review){Object.assign(result,review);if(review.status==='needs_attention'){result.consumeEvent=false;await this.reportProgress(task,progress,actionId,result.note);}}
      }
      if(event&&result.consumeEvent!==false)task.inbox=task.inbox.filter(e=>e.key!==event.key);
      if(task.overflowEvent&&task.inbox.length<200&&Buffer.byteLength(JSON.stringify(task.inbox))+Buffer.byteLength(JSON.stringify(task.overflowEvent))<=300000){task.inbox.push(task.overflowEvent);task.eventKeys.push(task.overflowEvent.key);delete task.overflowEvent;}
      if(actionRun){actionRun.status=['needs_attention','waiting_permission','paused'].includes(result.status)?result.status:activePending&&result.status!=='completed'||result.consumeEvent===false?'waiting':'completed';actionRun.note=String(result.note||'').slice(0,500);actionRun.updatedAt=this.clock();}
      const blockedRuns=Object.values(task.actionRuns||{}).filter(a=>['needs_attention','waiting_permission'].includes(a.status)),blocked=blockedRuns.map(a=>a.status);
      const unresolvedWrite=Object.values(task.operations).some(op=>hasBlockingEffect(task,op));
      task.status=blocked.includes('needs_attention')||result.status==='completed'&&unresolvedWrite?'needs_attention':blocked.includes('waiting_permission')?'waiting_permission':result.status==='completed'?'completed':group.workers.size>1?'running':result.status;
      task.note=String(blockedRuns.find(a=>a.status===task.status)?.note||result.note||'').slice(0,500);
      task.nextCheckAt=Number.isFinite(result.nextCheckAt)?result.nextCheckAt:this.clock()+task.schedule.intervalSeconds*1000;
      if(task.status==='completed')this.mainReviews.requestCompletion(task,actionRun,{note:result.note});
      if(typeof skill.actionNextWake==='function')task.nextCheckAt=Math.min(task.nextCheckAt,skill.actionNextWake(task,this.clock()));
      if(recoveryPolicy.held(actionRun)&&actionRun.recoveryState.mainReview?.hold)this.mainReviews.hold(task,actionRun,actionRun.recoveryState.selfSuspension?'self-suspension':'main-review');
      this.keepalive.touch(task,actionRun,{waitReason:result.waitReason,nextCheckAt:task.nextCheckAt});
      if(task.inbox.some(e=>e.key!==event?.key&&!group.workers.has(e.key)))task.nextCheckAt=this.clock();
      const strategy=(actionRun||task.state).recoveryState?.strategy;
      if(strategy){strategy.outcomeRefs=Object.values(task.operations).filter(op=>op.actionId===actionId&&op.finishedAt>=((actionRun||task.state).recoveryState.mainReview?.appliedAt||0)).slice(-8).map(op=>op.id);strategy.outcome=result.status==='completed'?'progressed':strategy.outcomeRefs.length?'observed':'pending';}
      await this.save(task);
      if(!this.owns(task)||task.state.stopRequest)return;
      if(actionRun&&['completed','needs_attention'].includes(actionRun.status)&&event){try{await this.settled(task,actionRun);}catch{}}
      if(this.owns(task)&&!task.state.stopRequest&&task.status==='completed')await this.notifyCompleted(task);
    }catch(error){
      if(this.current(task,token,true)){
        if(this.waitForStorage(task,actionRun)){
          // Saving the recovery state would fail through the same journal.
          // Keep this local scheduling backoff and do not spend another model.
          return;
        }
        if(error.code==='E_ACTION_TIMEOUT'){await this.retireTimedOut(task,{event,actionId,error});return;}
        if(error.code==='E_ACTION_SUPERSEDED'&&error.dispatched===false){if(actionRun)actionRun.status='waiting';const blocked=Object.values(task.actionRuns||{}).map(a=>a.status);task.status=blocked.includes('needs_attention')?'needs_attention':blocked.includes('waiting_permission')?'waiting_permission':'waiting';task.note='同一对象有新动态，正在合并后继续';task.nextCheckAt=this.clock();await this.save(task);this.schedule(25);return;}
        const unknown=Object.values(task.operations).some(op=>hasUncertainEffect(op)&&(actionId?op.actionId===actionId:!op.actionId));
        // Resource contention is an ordinary wait, not a model/tool failure.
        // Preserve the event and cached decision. A durable nextAt bounds repeated
        // admission work, without treating a busy resource as business failure.
        if(['E_GUI_BUSY','E_CAPTURE_BUSY','E_OPERATION_BUSY','E_MODEL_BUSY'].includes(error.code)&&error.dispatched===false&&!unknown){
          const owner=actionRun||task.state,previous=owner.resourceWait,attempts=previous&&!previous.resolvedAt?(previous.attempts||0)+1:1;
          owner.resourceWait={code:error.code,firstAt:previous&&!previous.resolvedAt?previous.firstAt:this.clock(),lastAt:this.clock(),attempts,nextAt:this.clock()+Math.min(5000,1000*2**Math.min(attempts-1,3))};
          progress?.wait('resource');
          if(actionRun){actionRun.status='waiting';actionRun.note=error.message;}
          const blocked=Object.values(task.actionRuns||{}).map(a=>a.status);
          task.status=blocked.includes('needs_attention')?'needs_attention':blocked.includes('waiting_permission')?'waiting_permission':'waiting';
          task.note=error.message;task.nextCheckAt=owner.resourceWait.nextAt;this.keepalive.touch(task,actionRun,{waitReason:'resource',nextCheckAt:task.nextCheckAt});await this.save(task);return;
        }
        try{await this.failed(task,error);}catch{}
        if(!this.current(task,token,true)||controller.signal.aborted)return;
        if(error.code==='E_MODEL_TIMEOUT'&&!require('./boper-outcome').hasEffects(error.inputOutcome||error.diagnostic?.inputOutcome)){
          const repair=require('./self-repair'),profile=repair.afterModelTimeout(task.state.selfRepair?.profile,error),previous=error.diagnostic?.modelRequest?.timeoutMs||task.state.selfRepair?.profile?.requestTimeoutMs||25000;
          task.state.selfRepair={...task.state.selfRepair,profile};
          error.diagnostic={...error.diagnostic,modelRequest:{...error.diagnostic?.modelRequest,nextTimeoutMs:profile.requestTimeoutMs,budgetChanged:profile.requestTimeoutMs>previous,externalAction:false}};
        }
        task.state.lastFailure={message:error.message,code:error.code||'E_STEP',at:this.clock(),unknown,goalRevision:task.state.goalRevision||0,controlRevision:task.state.controlRevision||0,...(actionId?{actionId}:{}),...(failureOperationId&&failureOperationError===error?{operationId:failureOperationId}:{}),...(require('./self-repair').diagnostic(error.diagnostic)?{diagnostic:require('./self-repair').diagnostic(error.diagnostic)}:{})};
        const boundary=error.code==='E_PERMISSION_REQUIRED'?'waiting_permission':unknown||['E_TASK_AUTH','E_APP_CIRCUIT','E_SUBMISSION_UNCERTAIN','E_WORKBUDDY_DRAFT_CONFLICT','E_WORKBUDDY_ROUTE_CONFLICT','ABORT_ERR','E_ABORTED'].includes(error.code)||error.diagnostic?.visualState?.requiresOwner===true?'needs_attention':null;
        const failureStatus=boundary||'waiting';
        if(actionRun){actionRun.status=failureStatus;actionRun.note=error.message;actionRun.failureCode=error.code||'E_STEP';actionRun.updatedAt=this.clock();}
        const blocked=Object.values(task.actionRuns||{}).map(a=>a.status);
        task.status=blocked.includes('needs_attention')?'needs_attention':blocked.includes('waiting_permission')?'waiting_permission':failureStatus;task.note=require('./task-presentation').failureNote(task,error,{unknown});
        if(!boundary){
          const kind=require('./self-repair').category(error)||'stall';
          let recovery;try{recovery=await this.recoverAction(task,actionRun,progress,{event,error,signal:controller.signal,isCurrent:()=>this.current(task,token,true)&&!controller.signal.aborted,kind});}
          catch(failure){if(this.waitForStorage(task,actionRun))return;throw failure;}
          if(!recovery)return;
          if(actionRun){actionRun.status=recoveryPolicy.held(actionRun)&&actionRun.recoveryState.mainReview?.hold?'paused':recovery.status;actionRun.note=recovery.note;actionRun.updatedAt=this.clock();}
          const otherBlocked=Object.values(task.actionRuns||{}).find(run=>run!==actionRun&&['needs_attention','waiting_permission'].includes(run.status));
          task.status=otherBlocked?.status||recovery.status;task.note=otherBlocked?.note||recovery.note;task.nextCheckAt=recovery.nextCheckAt;
          await this.save(task);
          if(recovery.status==='needs_attention'){
            await this.reportProgress(task,progress,actionId,recovery.note);
            if(actionRun)try{await this.settled(task,actionRun);}catch{}
          }
          return;
        }
        if(error.code==='E_NO_PROGRESS')await this.reportProgress(task,progress,actionId,task.note);
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
      stepWait?.close();
      this.keepalive.touch(task,actionRun);
      try{stopObservation?.();}catch(error){try{this.onRecoveryDiagnostic('observation-cleanup',task,error);}catch{}}
      group.parent.signal.removeEventListener('abort',cancel);group.workers.delete(workerKey);
      if(actionRun?.status==='running'){actionRun.status=controller.signal.aborted?'cancelled':'waiting';actionRun.updatedAt=this.clock();if(this.tasks.get(id)===task)await this.save(task).catch(()=>{});}
      if(!group.workers.size&&this.actionGroups.get(id)===group){
        this.actionGroups.delete(id);if(this.controllers.get(id)===group.parent)this.controllers.delete(id);
        if(this.tasks.get(id)===task&&task.status==='running'){task.status='waiting';await this.save(task).catch(()=>{});}
      }
      if(this.owns(task)&&!task.state.stopRequest&&!(task.state.storageWait?.nextAt>this.clock())&&task.inbox.some(item=>item.key!==event?.key)&&this.selectEvent(task,this.actionGroups.get(id)))task.nextCheckAt=Math.min(task.nextCheckAt,this.clock());
      this.schedule();
    }
  }
  async tick(id) {
    if (this.closed || this.restoring || !this.ready()) return;
    const now = this.clock();
    const due = id ? [id] : [...this.tasks.values()]
      .filter(task => task.nextCheckAt <= now || recoveryPolicy.due(task,now) || task.expiresAt && task.expiresAt <= now)
      .map(task => task.id);
    const work = Promise.all(due.map(task => this.step(task)));
    this.mainReviews.inspect();
    this.keepalive.inspect(this);
    this.schedule();
    await work;
  }
  schedule() {
    if (this.closed || this.restoring || !this.autoSchedule) return;
    const now = this.clock();
    let next = this.mainReviews.nextWake();
    for (const task of this.tasks.values()) {
      if (!this.current(task, this.tokens.get(task.id), true)) continue;
      if (task.expiresAt) next = Math.min(next, task.expiresAt);
      if(task.state.storageWait?.nextAt>now){next=Math.min(next,task.state.storageWait.nextAt);continue;}
      if (this.selectWork(task)) next = Math.min(next,recoveryPolicy.due(task,now)?now:task.nextCheckAt);
      const skill=this.executionSkill(task);if(skill.actionNextWake)next=Math.min(next,skill.actionNextWake(task,now));
      for(const owner of [task.state,...Object.values(task.actionRuns||{})]){if(recoveryPolicy.deferred(owner,now))next=Math.min(next,owner.recoveryState.nextAt);if(owner.resourceWait?.nextAt>now)next=Math.min(next,owner.resourceWait.nextAt);}
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
      if (TERMINAL.has(task.status) || ['queued', 'stopping'].includes(task.status)) continue;
      this.mainReviews.cancel(task,'runtime-invalidated');
      if(task.status==='paused'){if(task.state.pauseSource!=='owner')task.state.pauseSource='protection';if(task.privacyEpoch===this.epoch())writes.push(this.save(task));continue;}
      this.cancelWorker(task);
      task.status = 'paused';
      task.state.pauseSource='protection';
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
    this.mainReviews.close();
    clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.pendingSaves.values());
  }
}
module.exports={ AgentRuntime };
