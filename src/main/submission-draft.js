'use strict';
const {createHash}=require('node:crypto');
const hash=value=>createHash('sha256').update(value).digest('hex');
const proofId=proof=>({...proof,id:'draft-proof:'+hash(JSON.stringify([proof.taskId,proof.round,proof.draftHash,proof.fillAt,proof.method,proof.at||proof.evidence?.guardDigest]))});
const snapshotFields=['status','note','goal','criteria','outboundText','evidence','report','verification','artifactManifest','acceptedAt','automaticAccepted','userAccepted','acceptanceEvidence',
 'sessionId','monitorSessionId','monitorTaskId','monitorMessageKey','monitorStatus','monitorSummary','monitorEvidence','monitorLinks','monitorStartedAt','monitorUpdatedAt','monitorModel',
 'handoffSent','submittedAt','submitAttemptedAt','draftInserted','draftInsertedAt','followUpRound','followUpPending','followUpAwaitingMonitor','previousMonitorTaskId','previousMonitorMessageKey',
 'automaticFollowUps','followUpHistory','attachment','privateAttachment','sensitiveAttachment','sensitiveAttachmentState','controllerLifecycle','errorCode','errorDiagnostic','pauseCause'];
function capturePriorSnapshot(task){
 const fields={},absent=[];
 for(const key of snapshotFields)if(Object.hasOwn(task,key))fields[key]=structuredClone(task[key]);else absent.push(key);
 if(fields.followUpPending)delete fields.followUpPending.priorSnapshot;
 return {fields,absent,stepCount:Array.isArray(task.steps)?task.steps.length:0};
}
function identifyDraft(task){
 const pending=task?.followUpPending,steps=Array.isArray(task?.steps)?task.steps:[];
 if(pending?.state!=='draft-unknown'||typeof task.outboundText!=='string'||!task.outboundText)return null;
 const index=steps.findLastIndex(s=>s.action==='workbuddyFill'||s.action==='type'&&s.purpose==='task'),fill=steps[index];
 if(!fill||!['input-sent','confirmed'].includes(fill.state)||!Number.isFinite(fill.at)||fill.at<=0)return null;
 const round=require('./workbuddy-observation').submissionRound(task);
 if(round<=(task.followUpRound||0)||pending.draftStartedAt&&fill.at<pending.draftStartedAt)return null;
 return {taskId:task.id,round,draftHash:hash(task.outboundText),fillAt:fill.at,fillIndex:index};
}
function currentHasUncertainSend(task,identity){
 if(task.followUpAwaitingMonitor===true||task.followUpPending?.submittedAt)return true;
 const priorAt=task.followUpPending?.priorReceipt?.submittedAt||task.submittedAt;
 return task.steps.some((s,i)=>(s.submissionRound===identity.round||i>=identity.fillIndex||Number.isFinite(priorAt)&&s.at>priorAt)&&
  (s.action==='workbuddySend'||s.purpose==='submit')&&!['not-dispatched','not_dispatched'].includes(s.state));
}
function bindNotDispatchedProof(task,error,{stage='before-submit-dispatch',method='pointer-guard',at=Date.now()}={}){
 const identity=identifyDraft(task);
 if(!identity||currentHasUncertainSend(task,identity)||error?.dispatched!==false||stage!=='before-submit-dispatch')return null;
 return proofId({schema:'bunny.draft-dispatch-proof/v1',...identity,stage,method,dispatched:false,code:error.code||'E_DISPATCH_REFUSED',at});
}
function sameIdentity(a,b){return !!a&&!!b&&['taskId','round','draftHash','fillAt','fillIndex'].every(key=>a[key]===b[key]);}
function draftRecoveryPolicy(task){
 const lifecycle=task?.controllerLifecycle;
 if(task?.stopRequest||['cancelled','skipped'].includes(task?.status)||task?.monitorStatus==='stopped'||lifecycle?.terminal===true||['user-stop','business-stop'].includes(lifecycle?.intent))
  return {blocked:true,requiresExplicit:false,recoveryMode:'blocked',reason:'任务已有明确停止记录，不恢复同一任务'};
 const requiresExplicit=task?.status==='stopped';
 return {blocked:false,requiresExplicit,recoveryMode:requiresExplicit?'explicit-only':'automatic-eligible',reason:requiresExplicit?'旧停止记录的控制意图不明确，仅可在新的明确重验请求后只读核验':'宿主控制器状态不撤销已核实的未派发事实'};
}
function publicLogEvents(text,taskId){
 const events=[];
 for(const [index,line]of String(text||'').split('\n').entries()){
  const start=line.indexOf('{');if(start<0)continue;
  try{const value=JSON.parse(line.slice(start));if(value.taskId===taskId)events.push({...value,line:index+1});}catch{}
 }
 return events;
}
function legacyGuardProof(task,identity,text,checks={}){
 checks.legacyErrorMatches=task.errorCode==='E_GUI_POINTER_BLOCKED'&&task.errorDiagnostic?.operation==='click';if(!checks.legacyErrorMatches)return null;
 const events=publicLogEvents(text,task.id),sameDraft=e=>{
  const cp=e.checkpoint;if(cp?.followUpState!=='draft-unknown'||cp.steps?.at(-1)?.at!==identity.fillAt||cp.steps.at(-1).state!=='input-sent')return false;
  const legacy=cp.submittedAt===task.submittedAt&&cp.submitAttemptedAt===task.submitAttemptedAt;
  const current=cp.submissionRound===identity.round&&cp.submitAttempted===false&&cp.submittedAt===null&&cp.submitAttemptedAt===null&&cp.priorSubmission?.handoffSent===true&&
   cp.priorSubmission.submissionRound===(task.followUpRound||0)&&cp.priorSubmission.messageKey===(task.followUpPending.baselineMessageKey||task.monitorMessageKey);
  return legacy||current;
 };
 const afterFill=events.filter(e=>e.checkpoint?.steps?.some(s=>s.at>=identity.fillAt));
 checks.legacyNoNewSubmit=!afterFill.some(e=>e.checkpoint.steps.some(s=>s.at>=identity.fillAt&&(s.action==='workbuddySend'||s.purpose==='submit')&&!['not-dispatched','not_dispatched'].includes(s.state)));if(!checks.legacyNoNewSubmit)return null;
 const prior=events.findLast(e=>e.stage==='submission-checkpoint'&&e.checkpoint?.phase==='confirmed'&&e.checkpoint.handoffSent===true&&e.checkpoint.submittedAt===task.submittedAt&&e.checkpoint.submitAttemptedAt===task.submitAttemptedAt&&e.checkpoint.steps?.every(s=>s.at<identity.fillAt));
 checks.legacyPriorReceiptFound=!!prior;if(!prior)return null;
 for(const guard of events.filter(e=>e.stage==='pointer-blocked').reverse()){
  if(!Number.isSafeInteger(guard.generation)||guard.generation<0||guard.diagnostic?.operation!=='click'||guard.diagnostic.expectedBundleId!=='com.tencent.workbuddy.mac'||!Number.isFinite(guard.point?.x)||!Number.isFinite(guard.point?.y))continue;
  checks.legacyGuardFound=true;
  const before=events.findLast(e=>e.stage==='submission-checkpoint'&&e.line<guard.line&&e.line>prior.line&&e.generation===guard.generation&&sameDraft(e));
  const after=events.find(e=>e.stage==='submission-checkpoint'&&e.line>guard.line&&e.generation===guard.generation&&sameDraft(e)&&e.errorCode==='E_GUI_POINTER_BLOCKED'&&JSON.stringify(e.diagnostic)===JSON.stringify(guard.diagnostic));
  checks.legacyFillFound=!!before;checks.legacyPauseFound=!!after;checks.legacyDiagnosticMatches=JSON.stringify(task.errorDiagnostic)===JSON.stringify(guard.diagnostic);
  if(!before||!after||!checks.legacyDiagnosticMatches)continue;
  checks.legacyNoLaterStop=!events.some(e=>e.line>after.line&&(e.controllerLifecycle?.terminal===true||['user-stop','business-stop'].includes(e.controllerLifecycle?.intent)));if(!checks.legacyNoLaterStop)return null;
  checks.legacyNoLaterDraftChange=!events.some(e=>e.line>after.line&&e.stage==='submission-checkpoint'&&!sameDraft(e));if(!checks.legacyNoLaterDraftChange)return null;
  return proofId({schema:'bunny.draft-dispatch-proof/v1',...identity,stage:'before-submit-dispatch',method:'legacy-guard-checkpoint-chain',dispatched:false,code:'E_GUI_POINTER_BLOCKED',
   evidence:{kind:'host-public-log',sha256:hash(text),generation:guard.generation,guardDigest:hash(JSON.stringify([guard.generation,guard.point,guard.diagnostic])),priorLine:prior.line,fillLine:before.line,guardLine:guard.line,pausedLine:after.line}});
 }
 return null;
}
function proveDraftNotDispatched(task,{publicLogText}={}){
 const policy=draftRecoveryPolicy(task),identity=identifyDraft(task),checks={lifecycleAllowed:!policy.blocked,pendingDraft:task?.followUpPending?.state==='draft-unknown',outboundPresent:typeof task?.outboundText==='string'&&!!task.outboundText,draftIdentity:!!identity};
 if(policy.blocked)return {ok:false,...policy,reasonCode:'lifecycle-terminal',checks};
 if(!identity)return {ok:false,needsEvidence:true,reasonCode:'draft-identity-missing',reason:'本补充轮的草稿身份或输入回执不完整',checks};
 checks.noUncertainSubmit=!currentHasUncertainSend(task,identity);
 if(!checks.noUncertainSubmit)return {ok:false,needsEvidence:true,reasonCode:'current-submit-unknown',reason:'本补充轮存在未确认的提交证据，保留原屏障',checks};
 const stored=task.followUpPending.dispatchProof;checks.storedProofBound=stored?.schema==='bunny.draft-dispatch-proof/v1'&&stored.dispatched===false&&stored.stage==='before-submit-dispatch'&&sameIdentity(stored,identity);checks.legacyLogSupplied=typeof publicLogText==='string';
 const proof=checks.storedProofBound?structuredClone(stored):checks.legacyLogSupplied?legacyGuardProof(task,identity,publicLogText,checks):null;
 return proof?{ok:true,proof,requiresExplicit:policy.requiresExplicit,recoveryMode:policy.recoveryMode,policy,checks}:{ok:false,needsEvidence:true,reasonCode:checks.legacyLogSupplied?'legacy-proof-chain-mismatch':'dispatch-proof-missing',reason:'缺少绑定本轮草稿的明确派发拒绝证据；不能凭错误码或缺少发送记录认定未发',checks};
}
function priorReviewTask(task,proof){
 if(draftRecoveryPolicy(task).blocked)throw Object.assign(Error('任务已有明确停止记录，未恢复前轮'),{code:'E_DRAFT_TERMINAL'});
 const identity=identifyDraft(task);
 if(!sameIdentity(identity,proof)||proof?.schema!=='bunny.draft-dispatch-proof/v1'||proof.stage!=='before-submit-dispatch'||proof.dispatched!==false||currentHasUncertainSend(task,identity))throw Object.assign(Error('补充草稿或派发证据已变化，未恢复前轮'),{code:'E_DRAFT_EVIDENCE'});
 const prior=task.followUpPending.priorSnapshot,projection=structuredClone(task);
 if(prior){
  for(const key of prior.absent||[])delete projection[key];
  Object.assign(projection,structuredClone(prior.fields));projection.steps=projection.steps.slice(0,prior.stepCount);
 }else{
  // Legacy builds retained the prior positive receipt and actual result body,
  // but overwrote outboundText. Never invent the missing old outbound draft.
  if(!task.handoffSent||!task.monitorSessionId||!task.monitorMessageKey||task.monitorStatus!=='ok'||!task.monitorSummary||!(task.submittedAt<identity.fillAt))throw Object.assign(Error('前轮正向回执或成果基线不完整'),{code:'E_PRIOR_RESULT_EVIDENCE'});
  delete projection.followUpPending;delete projection.outboundText;delete projection.errorCode;delete projection.errorDiagnostic;
  projection.followUpAwaitingMonitor=false;projection.steps=projection.steps.slice(0,identity.fillIndex);
 }
 if(!require('./workbuddy-observation').workSubmissionConfirmed(projection)||projection.monitorStatus!=='ok'||!projection.monitorSummary||!projection.monitorMessageKey||!projection.monitorSessionId)throw Object.assign(Error('前轮回执与实际成果不匹配'),{code:'E_PRIOR_RESULT_EVIDENCE'});
 projection.status='review';projection.note='已保留前轮成果，等待重新核对';return projection;
}
function archiveUnsubmittedDraft(task,{proof,reason,at=Date.now(),recoveryAuthorization}={}){
 const projection=priorReviewTask(task,proof);
 if(draftRecoveryPolicy(task).requiresExplicit){
  const auth=recoveryAuthorization;
  if(auth?.kind!=='review-prior-result'||auth.explicit!==true||auth.taskNonterminal!==true||typeof auth.taskId!=='string'||!task.sources?.includes(auth.taskId)||auth.jobId!==task.id||
   auth.round!==proof.round||auth.draftHash!==proof.draftHash||typeof auth.requestId!=='string'||!auth.requestId.trim()||auth.requestId.length>256||
   !Number.isSafeInteger(auth.requestedAt)||auth.requestedAt<=0||auth.requestedAt>at||at-auth.requestedAt>300000)
   throw Object.assign(Error('旧停止记录需要新的、绑定本轮草稿的明确只读重验授权'),{code:'E_DRAFT_EXPLICIT_REQUIRED'});
 }
 if(typeof reason!=='string'||!reason.trim())throw Object.assign(Error('放弃补充草稿需要明确理由'),{code:'E_DRAFT_REASON'});
 const current={};for(const key of snapshotFields)if(Object.hasOwn(task,key))current[key]=structuredClone(task[key]);
 const archive={schema:'bunny.submission-draft-archive/v1',id:'draft-archive:'+hash(JSON.stringify([task.id,proof.round,proof.draftHash,proof.fillAt])),taskId:task.id,round:proof.round,draftHash:proof.draftHash,at,reason,disposition:'abandoned-before-dispatch',
  proof:structuredClone(proof),pending:structuredClone(task.followUpPending),current,steps:structuredClone(task.steps)};
 if(recoveryAuthorization)archive.recoveryAuthorization=Object.fromEntries(['kind','taskId','jobId','round','draftHash','requestId','requestedAt'].map(key=>[key,recoveryAuthorization[key]]));
 projection.submissionDraftArchives=[...(task.submissionDraftArchives||[]),archive];
 projection.submissionDraftDisposition={round:proof.round,disposition:'abandoned-before-dispatch',proofId:proof.id,archiveId:archive.id,at};return projection;
}
function draftReviewCandidate(task,options){
 const result=proveDraftNotDispatched(task,options);if(!result.ok)return result;
 try{const priorTask=priorReviewTask(task,result.proof);return {ok:true,proof:result.proof,priorTask,round:result.proof.round,priorRound:priorTask.followUpRound||0,draftText:task.outboundText,origin:task.followUpPending.origin||'unknown',requiresExplicit:result.requiresExplicit,recoveryMode:result.recoveryMode,policy:result.policy,checks:result.checks};}
 catch(error){return {ok:false,needsEvidence:true,reason:error.message};}
}
module.exports={capturePriorSnapshot,identifyDraft,bindNotDispatchedProof,proveDraftNotDispatched,priorReviewTask,archiveUnsubmittedDraft,draftReviewCandidate,draftRecoveryPolicy};
