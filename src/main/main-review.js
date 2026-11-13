'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { clone, TERMINAL, MAX_ACTIVE_TASKS, occupiesSlot } = require('./agent-contract');
const { canRead } = require('./memory-scope');
const { createBoundedWait } = require('./bounded-wait');
const recovery = require('./action-recovery');
const { taskMonitorFact } = require('./task-supervision');
const { replayProtected, hasBlockingEffect } = require('./operation-ledger');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const owners = task => [task.state, ...Object.values(task.actionRuns || {})];
const stateFor = owner => owner.recoveryState;
const pending = record => ['requested', 'running', 'decided'].includes(record?.status);
const MAX_RESPONSE_PROFILES = 5;
const responseProfile = value => Number.isSafeInteger(value?.maxTokens) && value.maxTokens >= 512 && value.maxTokens <= 8192 && value.thinking === 'low' && value.reasoningEffort === 'low'
  ? { maxTokens: value.maxTokens, thinking: 'low', reasoningEffort: 'low' } : null;
const profileKey = value => JSON.stringify(responseProfile(value));
const text = (value, max = 1200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function assessment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['summary','assessmentSummary','remainingUncertainty','requestedHelp','strategySummary','nextInquiry']) if (text(value[key])) result[key] = text(value[key]);
  for (const key of ['basisRefs','attemptedPaths','questionGroups','alternativeExplanations','consequences']) {
    if (Array.isArray(value[key])) result[key] = value[key].slice(0, 8).map(item => typeof item === 'string' ? item.slice(0, 600) : JSON.stringify(item).slice(0, 600));
  }
  return Object.keys(result).length ? result : null;
}
function decision(value) {
  if (!value || !['accept','continue','replan','wait','needs_owner','fail'].includes(value.type) || !text(value.rationaleSummary)) throw Object.assign(Error('主脑指导格式不完整'), { code: 'E_MAIN_REVIEW_SCHEMA' });
  const guidance = value.guidance && typeof value.guidance === 'object' && !Array.isArray(value.guidance) ? clone(value.guidance) : {};
  if (Buffer.byteLength(JSON.stringify(guidance)) > 16000) throw Object.assign(Error('主脑指导达到记录上限'), { code: 'E_MAIN_REVIEW_SCHEMA' });
  // Only cognitive guidance is accepted. No executable patch, tool call,
  // authority, task goal, receipt or completion state can enter via this path.
  const allowed = ['objective','hypotheses','historicalCorrections','verificationIdeas','alternativeStrategies','repairNeeds','restartFromCheckpoint','waitCondition','requiredEvidenceRefs','strategySummary','expectedChange','disconfirmEvidence'];
  for (const key of Object.keys(guidance)) if (!allowed.includes(key)) delete guidance[key];
  return { type: value.type, rationaleSummary: text(value.rationaleSummary), guidance,
    obstacleConfirmed: value.obstacleConfirmed === true, sourceRefs: Array.isArray(value.sourceRefs) ? value.sourceRefs.filter(v => typeof v === 'string').slice(0, 24).map(v => v.slice(0, 256)) : [],
    ...(Number.isFinite(value.nextCheckAt) ? { nextCheckAt: value.nextCheckAt } : {}),
    ...(value.context ? { context: clone(value.context) } : {}) };
}

// A scheduling component of AgentRuntime, not an executor or second queue.
// Pending work lives exclusively in the canonical Task/Action. This object
// owns only the current read-only invocation and observes the existing timer.
class MainReview {
  constructor(runtime, { reviewTask, enabled = () => !!reviewTask, proactive = true, timeoutMs = 55000, retryMs = 15000,
    monitorMs = 1000, stageTimeoutMs = 90000, maxReviews = 3, maxEpisodeAttempts = 12, onFact = () => {} } = {}) {
    Object.assign(this, { runtime, reviewTask, enabled, proactive, timeoutMs, retryMs, monitorMs, stageTimeoutMs, maxReviews, maxEpisodeAttempts, onFact });
    this.active = null; this.nextMonitorAt = 0; this.observations = new Map();this.independentAdmissions=new Set();
  }
  isEnabled() { return typeof this.enabled === 'function' ? this.enabled() && !!this.reviewTask : !!this.enabled && !!this.reviewTask; }
  visible(task) {
    const r = this.runtime;
    return !r.closed && !r.restoring && r.ready() && r.tasks.get(task.id) === task && task.privacyEpoch === r.epoch() &&
      (canRead(r.getScene(), task) || task.authority?.channel === 'authenticated-channel') && !task.state.listArchive && !task.state.stopRequest && !TERMINAL.has(task.status) && !['queued','stopping','waiting_permission'].includes(task.status);
  }
  eligible(task, owner) {
    if (!this.visible(task)) return false;
    if (task.status === 'paused' && !['self-suspension','main-review'].includes(task.state.pauseSource)) return false;
    return !owner.id || !['completed','cancelled','waiting_permission'].includes(owner.status);
  }
  basis(task, owner) {
    const operations = Object.values(task.operations || {}).filter(op => !owner.id || op.actionId === owner.id);
    return { taskId: task.id, actionId: owner.id || null, scope: owner.scope || null, episodeId: stateFor(owner)?.episodeId,
      goalRevision: task.state.goalRevision || 0, controlRevision: task.state.controlRevision || 0, requestRevision: this.runtime.controlRevision(task.id), privacyEpoch: task.privacyEpoch,
      authorityRevision: digest([task.authority, task.capabilities, task.subjects, task.scene, task.visibilityFloor]),
      goal: digest([task.goal, task.criteria, task.policy, task.context, task.parameters, task.workRequest, task.delivery]),
      completionProposalId:!owner.id&&task.state.completionProposal?.status==='pending'?task.state.completionProposal.id:null,
      // Hash bounded effect facts/reconciliation, never raw screenshots,
      // response bodies or the read-only polling history.
      evidenceRevision: digest([task.state.sceneIdentity || null, task.state.originChannelAuthorization || null,
        operations.filter(replayProtected).map(op => [op.id, op.effect, op.status, op.finishedAt, op.argsHash,
          require('./boper-outcome').sanitize(op.inputOutcome) || null, op.effectReconciliation || null,op.effectReviews||null])]) };
  }
  matches(task, owner, record) { return this.eligible(task, owner) && JSON.stringify(this.basis(task, owner)) === JSON.stringify(record.basis); }
  request(task, run, { reason = 'local-budget', selfSuspension, assessment: appraisal, hold = true, completionProposalId } = {}) {
    if (!this.isEnabled()) return false;
    const owner = run || task.state, now = this.runtime.clock();
    let state = stateFor(owner);
    if (!state) owner.recoveryState = state = { version: 1, attempts: 0, totalAttempts: 0, startedAt: now, evidence: [], history: [] };
    state.episodeId ||= randomUUID();
    const current = state.mainReview;
    if (pending(current)) return true;
    if (!completionProposalId&&(state.reviewCalls || state.mainReviewCount || 0) >= this.maxReviews) { state.reviewBudgetReached = true; return false; }
    if (current) state.reviewHistory = [...(state.reviewHistory || []), { reviewId: current.reviewId, status: current.status, decision: current.decision?.type, at: current.appliedAt || current.requestedAt }].slice(-6);
    const checked = assessment(appraisal); if (checked) state.assessment = checked;
    if (selfSuspension) {
      const suspension = assessment(selfSuspension);
      // Counters and a failed tool never manufacture this semantic judgment.
      if (!suspension?.assessmentSummary || !suspension.requestedHelp) return false;
      state.selfSuspension = { ...suspension, assessedAt: now }; state.obstacleConfirmed = selfSuspension.obstacleConfirmed === true;
    }
    state.mainReview = { reviewId: randomUUID(), status: 'requested', requestedAt: now, nextCheckAt: now, reason: text(reason, 100), hold,
      basis: this.basis(task, owner), observationBasis:clone(owner.progress?.evidence||[]),attempts: 0,...(completionProposalId?{completionProposalId}:{}) };
    if (hold) this.hold(task, owner, state.selfSuspension ? 'self-suspension' : 'main-review');
    return true;
  }
  requestCompletion(task,run,{note=''}={}){
    if(!this.isEnabled()||this.runtime.skills.get(task.skill).internal)return false;
    const key=digest([task.state.goalRevision||0,task.state.controlRevision||0,this.runtime.controlRevision(task.id),run?.id||null,run?.attempts||0,task.state.result?.revision||0,task.state.result?.collectedAt||0]);
    const previous=task.state.completionProposal;
    if(previous?.key===key&&previous.status==='accepted')return false;
    if(previous?.key===key&&previous.status==='pending'){this.hold(task,task.state);return true;}
    this.cancel(task,'completion-proposed');
    if(previous)task.state.completionHistory=[...(task.state.completionHistory||[]),clone(previous)].slice(-4);
    task.state.completionProposal={id:randomUUID(),key,status:'pending',goalRevision:task.state.goalRevision||0,actionId:run?.id||null,attempt:run?.attempts||0,resultRevision:task.state.result?.revision||0,summary:String(note||task.state.result?.summary||'任务脑已自判完成').slice(0,1200),proposedAt:this.runtime.clock()};
    if(task.state.recoveryState)delete task.state.recoveryState.selfSuspension;
    this.request(task,null,{reason:'completion-proposal',completionProposalId:task.state.completionProposal.id,hold:true});
    task.note='任务脑已自判完成，等待一次主脑终审；原成果与回执已保留';return true;
  }
  hold(task, owner, source = 'main-review') {
    if (owner.id) owner.status = 'paused';
    const remaining = task.inbox.some(event => {
      const scope = this.runtime.eventScope(event);
      return !Object.values(task.actionRuns || {}).some(run => run.status === 'paused' && (run.eventKey === event.key || !run.scope || !scope || scope === run.scope));
    });
    if (!owner.id || !remaining) { task.status = 'paused'; task.state.pauseSource = source; }
    else task.status = 'waiting';
    task.note = source === 'self-suspension' ? '任务已自我挂起，待主脑督导评估；原目标与回执已保留' : '本轮资源已让出，待主脑督导；尚未确认业务障碍';
  }
  cancel(task, reason = 'control-change') {
    delete task.state.reviewAdmission;
    if (this.active?.taskId === task.id) this.active.controller.abort();
    for (const owner of owners(task)) {
      const record = stateFor(owner)?.mainReview;
      if (pending(record)) { record.status = 'cancelled'; record.rejectionReason = reason; record.cancelledAt = this.runtime.clock(); }
    }
    if(task.state.completionProposal?.status==='pending'){task.state.completionProposal.status='cancelled';task.state.completionProposal.cancelledAt=this.runtime.clock();task.state.completionProposal.reason=reason;}
  }
  restore(task) {
    let changed = false;
    if(task.state.reviewAdmission){delete task.state.reviewAdmission;changed=true;}
    for (const owner of owners(task)) {
      const record = stateFor(owner)?.mainReview;
      if(record?.applying){delete record.applying;changed=true;}
      if (record?.status === 'running') { record.status = 'requested'; record.nextCheckAt = this.runtime.clock(); delete record.deadlineAt; changed = true; }
      // Process-local request revisions are not replayed across boots.
      if (record?.basis) record.basis.requestRevision = this.runtime.controlRevision(task.id);
      if(record?.completionProposalId&&task.state.completionProposal?.id===record.completionProposalId&&task.state.completionProposal.status==='pending')record.basis=this.basis(task,owner);
    }
    return changed;
  }
  nextWake() {
    let next = Infinity;
    if(!this.isEnabled())for(const task of this.runtime.tasks.values())if(this.eligible(task,task.state)&&task.state.completionProposal?.status==='pending'&&!stateFor(task.state)?.mainReview?.applying&&!Object.values(task.operations).some(op=>hasBlockingEffect(task,op))&&!this.runtime.actionGroups.get(task.id)?.workers.size)next=Math.min(next,this.runtime.clock());
    for(const task of this.runtime.tasks.values())if(this.independentWork(task))next=Math.min(next,this.runtime.clock()+1000);
    for (const task of this.runtime.tasks.values()) for (const owner of owners(task)) {
      if (!this.eligible(task, owner)) continue;
      const record = this.isEnabled()?stateFor(owner)?.mainReview:null;
      if (record?.status === 'decided'&&!record.applying) next = Math.min(next, record.nextCheckAt ?? this.runtime.clock());
      if (!this.active && record?.status === 'requested' && !record.unavailable) next = Math.min(next, record.nextCheckAt || 0);
      if (record?.status === 'applied' && record.decision?.type === 'wait' && Number.isFinite(record.nextCheckAt)) next = Math.min(next, record.nextCheckAt);
      if (this.proactive && owner.id && owner.status === 'running') next = Math.min(next, this.nextMonitorAt);
    }
    return next;
  }
  inspect() {
    const r = this.runtime, now = r.clock();
    if (r.closed || r.restoring || !r.ready()) return;
    if(this.active){const task=r.tasks.get(this.active.taskId),owner=this.active.actionId?task?.actionRuns[this.active.actionId]:task?.state;
      if(!task||!owner||stateFor(owner)?.mainReview?.reviewId!==this.active.reviewId||!this.eligible(task,owner))this.active.controller.abort();}
    for(const task of r.tasks.values())if(this.independentWork(task)&&!this.independentAdmissions.has(task.id)){
      this.independentAdmissions.add(task.id);
      void r.admission(async()=>{
        if(!this.independentWork(task)||r.capacity().active>=MAX_ACTIVE_TASKS&&task.skill!=='task.resolve')return;
        await r.persist(task,target=>{if(this.independentWork(task)){target.status='waiting';delete target.state.pauseSource;target.nextCheckAt=r.clock();target.note='其它对象有独立待办，原挂起 scope 继续等待主脑评估';}});
      }).catch(()=>{}).finally(()=>{this.independentAdmissions.delete(task.id);r.schedule();});
    }
    // Observe-only facts are also useful when model intervention is disabled.
    if (now >= this.nextMonitorAt) {
      this.nextMonitorAt = now + this.monitorMs;
      for (const task of r.tasks.values()) {
        if (!this.visible(task)) continue;
        for (const owner of owners(task)) {
          const fact = this.monitorFact(task, owner, now);
          if (!fact) continue;
          const key = task.id + ':' + (owner.id || 'task'), signature = digest([fact.reason, fact.at, stateFor(owner)?.episodeId]);
          if (this.observations.get(key) === signature) continue;
          this.observations.set(key, signature); while (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value);
          try { this.onFact({ taskId: task.id, actionId: owner.id || null, ...fact }); } catch {}
          if (this.isEnabled() && this.proactive && this.eligible(task, owner) && !pending(stateFor(owner)?.mainReview)) {
            // Repeated timer ticks of the same stage do not create new reviews.
            if (this.request(task, owner.id ? owner : null, { reason: fact.reason, hold: false })) void r.save(task).then(() => this.inspect()).catch(() => {});
          }
        }
      }
    }
    if (!this.isEnabled()) {
      if (this.active) this.active.controller.abort();
      for(const task of r.tasks.values())if(this.eligible(task,task.state)&&task.state.completionProposal?.status==='pending')void this.bypassCompletion(task).catch(()=>{});
      return;
    }
    const candidates = [];
    for (const task of r.tasks.values()) for (const owner of owners(task)) {
      if (!this.eligible(task, owner)) continue;
      const record = stateFor(owner)?.mainReview;
      if (record?.status === 'applied' && record.decision?.type === 'wait' && record.nextCheckAt <= now) {
        delete record.nextCheckAt;
        if (this.request(task, owner.id ? owner : null, { reason: 'wait-condition-due' })) void r.save(task).catch(() => {});
      }
      if (record?.status === 'decided' && (record.nextCheckAt || 0) <= now) { void this.apply(task.id, owner.id || null, record.reviewId).catch(() => {}); continue; }
      if (record?.status === 'requested' && !record.unavailable && (record.nextCheckAt || 0) <= now) candidates.push({ task, owner, record });
    }
    if (this.active || !candidates.length) return;
    candidates.sort((a, b) => a.record.requestedAt - b.record.requestedAt);
    this.start(candidates[0]);
  }
  independentWork(task){return this.visible(task)&&task.status==='paused'&&['self-suspension','main-review'].includes(task.state.pauseSource)&&!recovery.held(task.state)&&!!this.runtime.selectEvent(task);}
  async bypassCompletion(task){
    const r=this.runtime,proposal=task.state.completionProposal,record=stateFor(task.state)?.mainReview;
    if(!record||record.applying||record.completionProposalId!==proposal.id||r.actionGroups.get(task.id)?.workers.size)return;
    const baseline=this.basis(task,task.state),valid=()=>!this.isEnabled()&&this.eligible(task,task.state)&&task.state.completionProposal?.id===proposal.id&&task.state.completionProposal.status==='pending'&&JSON.stringify(this.basis(task,task.state))===JSON.stringify(baseline)&&!Object.values(task.operations).some(op=>hasBlockingEffect(task,op));
    if(!valid())return;record.applying=true;
    try{
      await r.writeInOrder([task],async()=>{
        if(!valid())return;const snapshot=clone(task),now=r.clock();
        snapshot.state.completionProposal.status='bypassed';snapshot.state.completionProposal.reviewedAt=now;
        snapshot.state.recoveryState.mainReview.status='cancelled';snapshot.state.recoveryState.mainReview.rejectionReason='review-disabled';delete snapshot.state.recoveryState.mainReview.applying;
        snapshot.status='completed';delete snapshot.state.pauseSource;snapshot.note=proposal.summary;snapshot.updatedAt=now;
        await r.journal.put(snapshot);
        if(!valid()){if(r.owns(task))await r.journal.put(clone(task));return;}
        Object.assign(task,snapshot);r.publish();
      });
      if(task.state.completionProposal?.status==='bypassed')await r.notifyCompleted(task);
    }finally{delete stateFor(task.state)?.mainReview?.applying;r.schedule();}
  }
  monitorFact(task,owner,now){
    const progress=owner.id?owner.progress:null,start=progress?.stageStartedAt??owner.startedAt??now;
    // Fresh progress moves only the default idle deadline. An explicit estimate
    // can still be overdue, and repeated unchanged evidence keeps its own rule.
    const allowance=this.stageTimeoutMs+(!Number.isFinite(progress?.expectedAt)&&Number.isFinite(progress?.lastProgressAt)?Math.max(0,Math.min(now,progress.lastProgressAt)-start):0);
    const fact=taskMonitorFact(task,owner.id?owner:null,{now,active:owner.status==='running',stageTimeoutMs:allowance});
    return fact&&(owner.subscription===true||progress?.waitReason==='timer')&&['stage-overdue','wait-overdue','repeated-no-progress'].includes(fact.reason)?null:fact;
  }
  start({ task, owner, record }) {
    const r = this.runtime, controller = new AbortController(), entry = { taskId: task.id, actionId: owner.id || null, reviewId: record.reviewId, controller };
    this.active = entry;
    entry.work = (async () => {
      const valid = () => this.isEnabled() && !controller.signal.aborted && this.matches(task, owner, record) && stateFor(owner)?.mainReview?.reviewId === record.reviewId && stateFor(owner).mainReview.status === 'running';
      record.status = 'running'; record.attempts++; stateFor(owner).reviewCalls=(stateFor(owner).reviewCalls||0)+1;record.deadlineAt = r.clock() + this.timeoutMs;
      const rememberProfile = value => {
        const profile = responseProfile(value);if(!profile||!valid())return;
        record.responseProfilesTried ??= [];
        if(!record.responseProfilesTried.some(item=>profileKey(item)===profileKey(profile)))record.responseProfilesTried.push(profile);
        record.responseProfilesTried=record.responseProfilesTried.slice(-MAX_RESPONSE_PROFILES);
      };
      rememberProfile(record.responseProfile);
      const wait = createBoundedWait({ signal: controller.signal, timeoutMs: this.timeoutMs, code: 'E_MAIN_REVIEW_TIMEOUT', message: '主脑督导达到本轮时限' });
      try {
        await wait.run(()=>r.save(task));
        if(!valid())return;
        const authorized = await wait.run(() => r.journal.authorized(task));
        if (!authorized || !valid()) throw Object.assign(Error('审阅来源已变化'), { code: 'E_TASK_AUTH' });
        const relatedTasks = r.list({ scene: task.scene }).filter(item => item.id !== task.id).slice(0, 6);
        const result = decision(await wait.run(signal => this.reviewTask({ task: clone(task), run: owner.id ? clone(owner) : null,
          event: owner.eventKey ? clone(task.inbox.find(event => event.key === owner.eventKey)) : null,
          relatedTasks, signal, reviewId: record.reviewId, basis: clone(record.basis), responseProfile: clone(record.responseProfile),onResponseProfile:async profile=>{if(valid()){rememberProfile(profile);await r.save(task);}},...(record.completionProposalId?{completionProposal:clone(task.state.completionProposal)}:{}),deadlineAt: record.deadlineAt, isCurrent: valid, scene: task.scene })));
        if(result.type==='accept'&&!record.completionProposalId)throw Object.assign(Error('只有本次完成提案可确认结束'),{code:'E_MAIN_REVIEW_SCHEMA'});
        // Missing information belongs to the original task brain's next step,
        // rather than repeatedly reviewing an unchanged success proposal.
        if(record.completionProposalId&&result.type==='wait')result.type='continue';
        if (!valid()) return;
        if (!await wait.run(() => r.journal.authorized(task)) || !valid()) return;
        await wait.run(()=>r.persist(task, target => {
          if (!valid()) return;
          const targetOwner = owner.id ? target.actionRuns[owner.id] : target.state;
          Object.assign(targetOwner.recoveryState.mainReview, { status: 'decided', decision: result, decidedAt: r.clock() });
        }));
        if (valid() || stateFor(owner)?.mainReview?.status === 'decided') void this.apply(task.id, owner.id || null, record.reviewId).catch(()=>{});
      } finally { wait.close(); }
    })().catch(async error => {
      const current = r.tasks.get(task.id), currentOwner = current && (entry.actionId ? current.actionRuns[entry.actionId] : current.state), currentRecord = stateFor(currentOwner || {})?.mainReview;
      if (!currentRecord || currentRecord.reviewId !== record.reviewId || currentRecord.status !== 'running' || controller.signal.aborted || !this.visible(current)) return;
      currentRecord.status = 'requested'; currentRecord.lastError = /^E_[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'E_MAIN_REVIEW_UNAVAILABLE';
      const profile = responseProfile(error.reviewResponseProfile),responseFailure=['E_PAYLOAD_TOO_LARGE','E_OUTPUT_LIMIT'].includes(error.code),tried=currentRecord.responseProfilesTried||[];
      const repeatedProfile=profile&&tried.some(item=>profileKey(item)===profileKey(profile));
      const freshResponse=this.matches(current,currentOwner,currentRecord)&&responseFailure&&profile&&!repeatedProfile&&currentRecord.attempts<MAX_RESPONSE_PROFILES&&tried.length<MAX_RESPONSE_PROFILES;
      if(freshResponse)currentRecord.responseProfile=profile;
      try{r.onRecoveryDiagnostic('main-review',current,error);}catch{}
      if(error.code==='E_MODEL_BUSY'){
        currentRecord.attempts=Math.max(0,currentRecord.attempts-1);stateFor(currentOwner).reviewCalls=Math.max(0,(stateFor(currentOwner).reviewCalls||0)-1);
        currentRecord.nextCheckAt=r.clock()+this.retryMs;void r.save(current).catch(()=>{});return;
      }
      currentRecord.nextCheckAt = r.clock() + this.retryMs * currentRecord.attempts;
      if (responseFailure&&profile&&!freshResponse || (currentRecord.attempts >= this.maxReviews || !currentRecord.completionProposalId&&stateFor(currentOwner).reviewCalls>=this.maxReviews)&&!freshResponse) { currentRecord.unavailable = true;delete currentRecord.nextCheckAt;if(responseFailure)currentRecord.responseExhaustion=repeatedProfile?'profile-already-tried':'profile-budget'; }
      void r.save(current).catch(() => {});
    }).finally(() => {
      if(this.active===entry)this.active=null;
      const current=r.tasks.get(entry.taskId),currentOwner=entry.actionId?current?.actionRuns[entry.actionId]:current?.state,currentRecord=stateFor(currentOwner||{})?.mainReview;
      if(currentRecord?.reviewId===entry.reviewId&&currentRecord.status==='running'&&!this.matches(current,currentOwner,currentRecord)){
        currentRecord.status='cancelled';currentRecord.rejectionReason='basis-changed';
        if(this.eligible(current,currentOwner)&&(currentRecord.hold||this.monitorFact(current,currentOwner,r.clock())))this.request(current,currentOwner.id?currentOwner:null,{reason:'updated-basis',hold:currentRecord.hold,completionProposalId:currentRecord.completionProposalId});
        void r.save(current).catch(()=>{});
      }
      r.schedule();
    });
  }
  async apply(taskId, actionId, reviewId) {
    const r = this.runtime;
    let task = r.tasks.get(taskId), owner = actionId ? task?.actionRuns[actionId] : task?.state, record = stateFor(owner || {})?.mainReview;
    if (!record || record.reviewId !== reviewId || record.status !== 'decided' || record.applying) return;
    record.applying = true;let commitPending=false;
    const applicationWait=createBoundedWait({timeoutMs:this.timeoutMs,code:'E_MAIN_APPLICATION_TIMEOUT',message:'主脑指导保存暂未完成，原串行保存仍被跟踪'});
    try {
      if (!this.isEnabled() || !this.matches(task, owner, record)) {
        record.status = 'cancelled'; record.rejectionReason = 'basis-changed';
        if(record.completionProposalId&&task.state.completionProposal?.id===record.completionProposalId&&task.state.completionProposal.status==='pending'&&this.eligible(task,owner))this.request(task,null,{reason:'updated-basis',completionProposalId:record.completionProposalId});
        await r.save(task); return;
      }
      const result = decision(record.decision), resumes = ['continue','replan'].includes(result.type);
      if(result.type==='accept'&&(!record.completionProposalId||task.state.completionProposal?.id!==record.completionProposalId||task.state.completionProposal.status!=='pending'))throw Object.assign(Error('完成提案已失效'),{code:'E_MAIN_REVIEW_SCHEMA'});
      if(result.type==='accept'&&Object.values(task.operations).some(op=>hasBlockingEffect(task,op))){record.awaitingEffects=true;record.nextCheckAt=r.clock()+this.retryMs;return;}
      if (resumes && task.status === 'paused' && !occupiesSlot(task) && r.capacity().active >= MAX_ACTIVE_TASKS && task.skill !== 'task.resolve') {
        record.nextCheckAt = r.clock() + 1000; return;
      }
      // A proactive strategy can retire a hung caller. Clone first so a model
      // or Skill ignoring abort cannot mutate the new canonical execution.
      const workers=[...(r.actionGroups.get(taskId)?.workers.values()||[])];
      if(workers.length){
        const mayRetire=result.type==='replan'&&result.guidance.restartFromCheckpoint&&workers.length===1&&workers[0].actionId===actionId&&['stage-overdue','wait-overdue','repeated-no-progress'].includes(record.reason);
        if(!mayRetire){record.nextCheckAt=r.clock()+1000;record.awaitingSafeBoundary=true;return;}
        const old = task; task = clone(old);
        r.cancelWorker(old, { cancelReview: false }); r.tasks.set(taskId, task); r.operations.retire(old);
        for (const run of Object.values(task.actionRuns)) if (run.status === 'running') run.status = 'waiting';
        r.actionGroups.delete(taskId); r.controllers.delete(taskId);
        owner = actionId ? task.actionRuns[actionId] : task.state; record = stateFor(owner).mainReview;
      }
      const basis = clone(record.basis), now = r.clock();
      // Reserve synchronously before the first await. A different Task may
      // finish reviewing while this one's journal commit is still pending.
      if(resumes&&task.status==='paused'&&!occupiesSlot(task)&&task.skill!=='task.resolve')task.state.reviewAdmission={reviewId};
      const valid = () => !applicationWait.signal.aborted && this.isEnabled() && this.matches(task, owner, { basis }) && stateFor(owner)?.mainReview?.reviewId === reviewId && stateFor(owner).mainReview.status === 'decided';
      commitPending=true;
      const physicalCommit=r.writeInOrder([task], async () => {
        if (!valid()) return;
        const snapshot = clone(task), targetOwner = actionId ? snapshot.actionRuns[actionId] : snapshot.state, state = stateFor(targetOwner), review = state.mainReview;
        delete snapshot.state.reviewAdmission;
        delete review.applying;
        review.status = 'applied'; review.appliedAt = now; review.applicationId = reviewId;
        state.mainReviewCount = (state.mainReviewCount || 0) + 1;
        const type = result.type;
        snapshot.state.disposition = { type, decidedBy: 'self', reviewId, basis, rationaleSummary: result.rationaleSummary, sourceRefs: result.sourceRefs, at: now,
          obstacleConfirmed: result.obstacleConfirmed, ...(result.guidance.waitCondition ? { continueWhen: clone(result.guidance.waitCondition) } : {}) };
        if(type==='accept'){
          snapshot.state.completionProposal.status='accepted';snapshot.state.completionProposal.reviewId=reviewId;snapshot.state.completionProposal.reviewedAt=now;
          snapshot.status='completed';delete snapshot.state.pauseSource;snapshot.note=result.rationaleSummary;
        }else if (resumes) {
          if (!recovery.grantWindow(state, reviewId, { now, attempts: r.recoveryPolicy.attempts, totalLimit: this.maxEpisodeAttempts })) {
            // Resource exhaustion is not a new business conclusion. Preserve
            // the unconsumed decision without granting an infinite window.
            review.resourceDeferred = true; delete review.nextCheckAt;
            this.hold(snapshot, targetOwner); snapshot.note = '主脑已给出指导；本 episode 资源额度已到，保留认识不确定和再次激活条件';
          } else {
            delete state.selfSuspension;
            const guidance = { action: 'change_method', source: 'main-review', guidanceId: reviewId, at: now,
              nextStep: result.rationaleSummary, ...clone(result.guidance), obstacleConfirmed: result.obstacleConfirmed, basisRefs: result.sourceRefs,
              observationDelta:{changed:JSON.stringify(owner.progress?.evidence||[])!==JSON.stringify(record.observationBasis||[]),latestEvidenceRefs:clone(owner.progress?.evidence||[])},
              planRevision: (state.planRevision || 0) + (type === 'replan' ? 1 : 0) };
            if(review.completionProposalId){
              const proposal=snapshot.state.completionProposal;
              proposal.status='returned';proposal.reviewId=reviewId;proposal.reviewedAt=now;
              guidance.reviewedResult={proposalId:proposal.id,summary:proposal.summary,resultRevision:proposal.resultRevision};
              if(snapshot.state.result){snapshot.state.previousCompletionResults=[...(snapshot.state.previousCompletionResults||[]),{proposalId:proposal.id,result:clone(snapshot.state.result)}].slice(-2);guidance.reviewedResult={proposalId:proposal.id,summary:snapshot.state.result.summary,resultRevision:snapshot.state.result.revision};delete snapshot.state.result;}
              if(snapshot.state.goalPlan)snapshot.state.goalPlan.needsPlanning=true;
            }
            state.planRevision = guidance.planRevision; state.strategy = { guidanceId: reviewId, strategySummary: result.guidance.strategySummary || result.rationaleSummary, basisRefs: result.sourceRefs, outcomeRefs: [] };
            if (actionId) { targetOwner.status = 'waiting'; targetOwner.recovery = guidance; }
            else snapshot.state.recoveryGuidance = guidance;
            // Invalidate only planning caches; operations and effect IDs stay.
            if (snapshot.state.pendingDecision) { snapshot.state.previousGuidedDecision = { tool: snapshot.state.pendingDecision.tool, reason: 'main-review', reviewId }; delete snapshot.state.pendingDecision; }
            if (targetOwner.eventKey) { const event = snapshot.inbox.find(e => e.key === targetOwner.eventKey); if (event) { delete event.decision; delete event.decisionAt; } }
            if (['self-suspension','main-review'].includes(snapshot.state.pauseSource)) { delete snapshot.state.pauseSource; snapshot.status = 'waiting'; }
            if(snapshot.status==='running')snapshot.status='waiting';
            snapshot.nextCheckAt = now; snapshot.note = '主脑已提出新的判断与指导，正在原任务中核实和推进';
          }
        } else if (type === 'wait') {
          this.hold(snapshot, targetOwner); review.nextCheckAt = Math.max(now + 1000, Math.min(now + 3600000, result.nextCheckAt || now + 60000));
          state.waitCondition = clone(result.guidance.waitCondition || { reason: result.rationaleSummary }); snapshot.note = result.rationaleSummary;
        } else {
          if(review.completionProposalId){snapshot.state.completionProposal.status=type==='fail'?'rejected':'needs_owner';snapshot.state.completionProposal.reviewId=reviewId;snapshot.state.completionProposal.reviewedAt=now;}
          if (actionId) { targetOwner.status = 'needs_attention'; targetOwner.note = result.rationaleSummary; }
          // A scope disposition does not terminate unrelated scopes.
          const another = !!actionId&&!!targetOwner.scope&&(snapshot.subjects.length>1||snapshot.inbox.some(event => event.key !== targetOwner.eventKey && this.runtime.eventScope(event) && this.runtime.eventScope(event) !== targetOwner.scope));
          snapshot.status = type === 'fail' && !another ? 'stopped' : another ? 'waiting' : 'needs_attention';
          delete snapshot.state.pauseSource; snapshot.note = result.rationaleSummary;
        }
        // Owner controls can arrive while storage awaits. Do not apply the
        // saved proposal in memory or publish a wakeup after that point.
        snapshot.updatedAt = now; await r.journal.put(snapshot);
        if (!valid()) { const current=r.tasks.get(taskId);if(current&&r.owns(current))await r.journal.put(clone(current));return; }
        Object.assign(task, snapshot); r.publish();
      });
      physicalCommit.finally(()=>{commitPending=false;const current=r.tasks.get(taskId),currentOwner=actionId?current?.actionRuns[actionId]:current?.state;if(stateFor(currentOwner||{})?.mainReview?.reviewId===reviewId)delete stateFor(currentOwner).mainReview.applying;if(current?.state.reviewAdmission?.reviewId===reviewId)delete current.state.reviewAdmission;r.schedule();}).catch(()=>{});
      try{await applicationWait.run(()=>physicalCommit);}catch(error){if(record.status==='decided'){record.lastError=error.code||'E_MAIN_APPLICATION_UNAVAILABLE';record.nextCheckAt=r.clock()+this.retryMs;}throw error;}
      if(task.state.completionProposal?.status==='accepted'&&task.state.completionProposal.reviewId===reviewId)await r.notifyCompleted(task);
      if (stateFor(actionId ? task.actionRuns[actionId] : task.state)?.mainReview?.status === 'applied' && ['needs_owner','fail'].includes(result.type) && this.visibleForReport(task)) {
        await r.report({ taskId, eventId: 'main-review:' + reviewId, text: result.rationaleSummary, sources: [taskId], scene: task.scene, domain: task.domain, visibilityFloor: task.visibilityFloor, epoch: task.privacyEpoch });
      }
    } finally {
      applicationWait.close();
      const current = r.tasks.get(taskId), currentOwner = actionId ? current?.actionRuns[actionId] : current?.state;
      if (!commitPending&&stateFor(currentOwner || {})?.mainReview?.reviewId === reviewId) delete stateFor(currentOwner).mainReview.applying;
      if(!commitPending&&current?.state.reviewAdmission?.reviewId===reviewId)delete current.state.reviewAdmission;
      r.schedule();
    }
  }
  visibleForReport(task) { return this.runtime.owns(task) && !task.state.stopRequest && !task.state.listArchive; }
  close() { this.active?.controller.abort(); }
}
module.exports = { MainReview, assessment, decision, owners };
