'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {beginFollowUpDraft}=require('../src/main/workbuddy-observation');
const {bindNotDispatchedProof,proveDraftNotDispatched,draftReviewCandidate,archiveUnsubmittedDraft}=require('../src/main/submission-draft');
function fixture({legacy=false}={}){
 const task={id:'physical',target:'workbuddy',status:'review',goal:'publish page',outboundText:'original task',steps:[{action:'workbuddySend',state:'input-sent',at:100}],
  followUpRound:0,submittedAt:100,submitAttemptedAt:99,handoffSent:true,sessionId:'bound',monitorSessionId:'bound',monitorTaskId:1,monitorMessageKey:'old',monitorStatus:'ok',monitorSummary:'real prior result',monitorLinks:[{url:'https://fixture.invalid/game'}],verification:{verdict:'revise',report:'old check'}};
 task.followUpPending=beginFollowUpDraft(task,300,{origin:'automatic'});task.steps.push({action:'workbuddyFill',state:'input-sent',at:300,submissionRound:1});task.outboundText='unsent supplemental draft';task.status='paused';task.errorCode='E_GUI_POINTER_BLOCKED';task.errorDiagnostic={operation:'click',method:'visual',expectedBundleId:'com.tencent.workbuddy.mac',expectedPid:1,expectedWindowId:2};
 if(legacy)task.followUpPending={state:'draft-unknown',round:1};
 return task;
}
function explicit(task){return bindNotDispatchedProof(task,Object.assign(Error('guard refused'),{code:'E_GUI_POINTER_BLOCKED',dispatched:false}),{at:301});}
function logFor(task){
 const checkpoint={phase:'submission-unknown',followUpState:'draft-unknown',submittedAt:100,submitAttemptedAt:99,steps:[{action:'workbuddyFill',state:'input-sent',at:300}]};
 return [{stage:'submission-checkpoint',checkpoint:{phase:'confirmed',handoffSent:true,submittedAt:100,submitAttemptedAt:99,steps:[{action:'workbuddySend',state:'input-sent',at:99}]}},
  {stage:'submission-checkpoint',checkpoint},
  {stage:'pointer-blocked',point:{x:10,y:20},diagnostic:task.errorDiagnostic},
  {stage:'submission-checkpoint',checkpoint,errorCode:'E_GUI_POINTER_BLOCKED',diagnostic:task.errorDiagnostic}]
  .map(value=>'[fixture] '+JSON.stringify({taskId:task.id,generation:2,...value})).join('\n');
}
test('a bound explicit refusal permits a pure prior-result projection and complete nonrecursive draft archive',()=>{
 const task=fixture();task.followUpPending.dispatchProof=explicit(task);task.submissionDraftArchives=[{id:'older-archive'}];task.sensitiveAttachment={path:'/private/fixture-supplement.txt',sha256:'fixture'};task.sensitiveAttachmentState='verified';const before=structuredClone(task);
 const candidate=draftReviewCandidate(task);assert.equal(candidate.ok,true);assert.equal(candidate.origin,'automatic');assert.equal(candidate.round,1);assert.equal(candidate.priorRound,0);assert(candidate.proof.id);
 assert.equal(candidate.priorTask.outboundText,'original task');assert.equal(candidate.priorTask.monitorMessageKey,'old');assert.equal(candidate.priorTask.monitorSummary,'real prior result');
 const next=archiveUnsubmittedDraft(task,{proof:candidate.proof,reason:'prior result already satisfies owner goal',at:400});
 assert.equal(next.status,'review');assert.equal(next.followUpPending,undefined);assert.equal(next.submissionDraftDisposition.disposition,'abandoned-before-dispatch');
 const archive=next.submissionDraftArchives.at(-1);assert.equal(archive.pending.state,'draft-unknown');assert.equal(archive.current.outboundText,task.outboundText);assert.deepEqual(archive.steps,task.steps);assert.deepEqual(archive.current.verification,task.verification);assert.equal(archive.current.submissionDraftArchives,undefined);assert.deepEqual(archive.current.sensitiveAttachment,task.sensitiveAttachment);assert.equal(next.sensitiveAttachment,undefined);
 assert.equal(next.steps.length,1);assert.deepEqual(next.monitorLinks,task.monitorLinks);assert.deepEqual(task,before);
});
test('error codes, absent send entries and stale or unknown dispatches cannot authorize abandonment',()=>{
 const task=fixture();assert.equal(proveDraftNotDispatched(task).ok,false);
 task.followUpPending.dispatchProof=explicit(task);const proof=structuredClone(task.followUpPending.dispatchProof);
 task.outboundText+=' changed';assert.equal(proveDraftNotDispatched(task).ok,false);assert.throws(()=>archiveUnsubmittedDraft(task,{proof,reason:'fixture'}),{code:'E_DRAFT_EVIDENCE'});
 for(const state of ['intent','unknown','input-sent']){const pending=fixture();pending.followUpPending.dispatchProof=explicit(pending);pending.steps.push({action:'workbuddySend',purpose:'submit',at:302,state});assert.equal(proveDraftNotDispatched(pending).ok,false);}
 const pending=fixture();pending.followUpPending.dispatchProof=explicit(pending);pending.followUpAwaitingMonitor=true;assert.equal(proveDraftNotDispatched(pending).ok,false);
 const earlier=fixture();earlier.steps.splice(1,0,{action:'workbuddySend',state:'unknown',at:250,submissionRound:1});assert.equal(explicit(earlier),null);assert.equal(proveDraftNotDispatched(earlier).ok,false);
});
test('legacy recovery requires the full exact positive-fill-guard-pause chain and never guesses origin',()=>{
 const task=fixture({legacy:true}),log=logFor(task),result=draftReviewCandidate(task,{publicLogText:log});
 assert.equal(result.ok,true);assert.equal(result.origin,'unknown');assert.equal(result.proof.method,'legacy-guard-checkpoint-chain');assert(result.proof.evidence.sha256);assert.equal(result.priorTask.outboundText,undefined);
 assert.equal(draftReviewCandidate(task,{publicLogText:log+'\n[unrelated] event'}).proof.id,result.proof.id);
 for(const lines of [log.split('\n').slice(1),log.split('\n').filter((_,i)=>i!==2),log.split('\n').slice(0,-1)])assert.equal(draftReviewCandidate(task,{publicLogText:lines.join('\n')}).ok,false);
 for(const bad of [log.replaceAll('\"generation\":2,',''),log.replaceAll('\"submission-checkpoint\"','\"other-stage\"')])assert.equal(draftReviewCandidate(task,{publicLogText:bad}).ok,false);
 const extra=JSON.stringify({taskId:task.id,generation:2,stage:'submission-checkpoint',checkpoint:{followUpState:'draft-unknown',steps:[{action:'workbuddySend',state:'intent',at:302}]}});
 assert.equal(draftReviewCandidate(task,{publicLogText:log+'\n'+extra}).ok,false);
});
test('missing prior positive result evidence blocks projection even when this dispatch was refused',()=>{
 const task=fixture();delete task.followUpPending.priorSnapshot;task.followUpPending.dispatchProof=explicit(task);task.monitorStatus='running';assert.equal(draftReviewCandidate(task).ok,false);
});
test('the actual follow-up guard journals a bound refusal before returning, with zero send operations',async()=>{
 const {DesktopService}=require('../src/main/desktop-service'),task=fixture().followUpPending.priorSnapshot.fields;
 Object.assign(task,{id:'guard-fixture',target:'workbuddy',scene:'life',domain:'work',visibilityFloor:1,workModel:'deepseek-v4.1-flash',associationMarker:'[workbunny:guard-fixture]',steps:[],status:'review'});
 let filled=false,sends=0;const journals=[],native={cancel(){},close(){},request:async(op)=>{
  if(op==='frontmost')return {application:{pid:1,bundleId:'com.tencent.workbuddy.mac'},windows:[{pid:1,windowId:2,layer:0,rect:{x:0,y:0,width:1000,height:800}}]};
  if(op==='workbuddyInspect')return {available:true,conversationReady:true,associationMarkerPresent:true,editorCount:1,selectedModel:'deepseek-v4.1-flash',draftEmpty:!filled,draftMatchesRequest:filled,sendEnabled:filled,sendButtonRect:{x:850,y:700,width:40,height:30}};
  if(op==='workbuddyFill'){filled=true;return {filled:true};}
  if(op==='workbuddySend'){sends++;throw Error('must not send');}
  if(op==='capture')return {pngBase64:Buffer.from('fixture').toString('base64'),desktopRect:{x:0,y:0,width:1000,height:800}};
  if(op==='recognize')return {texts:[]};throw Error('unexpected fixture operation '+op);
 }};
 const desktop=new DesktopService({native,pointerBlocked:()=>true,persist:async value=>journals.push(structuredClone(value)),observeWorkBuddy:async()=>({sessionId:'bound',taskId:1,messageKey:'old',status:'ok',startedAt:100,updatedAt:200})});desktop.task=task;
 try{const result=await desktop.followUp({text:'request a supplemental check'});assert.equal(result.ok,false);assert.equal(sends,0);assert(journals.some(t=>t.followUpPending?.dispatchProof?.dispatched===false));assert.equal(draftReviewCandidate(desktop.task).ok,true);assert.equal(desktop.task.followUpPending.origin,'automatic');}
 finally{await desktop.close();}
});
test('legacy stopped proof is historical evidence and only an exact fresh host request can authorize archive',()=>{
 const task=fixture({legacy:true});task.status='stopped';task.note='应用退出';task.sources=['logical'];
 const before=structuredClone(task),candidate=draftReviewCandidate(task,{publicLogText:logFor(task)});
 assert.equal(candidate.ok,true);assert.equal(candidate.requiresExplicit,true);assert.equal(candidate.recoveryMode,'explicit-only');assert.deepEqual(task,before);
 assert.throws(()=>archiveUnsubmittedDraft(task,{proof:candidate.proof,reason:'fixture',at:400}),{code:'E_DRAFT_EXPLICIT_REQUIRED'});
 const auth={kind:'review-prior-result',explicit:true,taskNonterminal:true,taskId:'logical',jobId:task.id,round:1,draftHash:candidate.proof.draftHash,requestId:'fresh-request',requestedAt:350};
 for(const patch of [{draftHash:'wrong'},{taskId:'other'},{jobId:'other'},{round:2},{requestId:''},{taskNonterminal:false},{requestedAt:401}])assert.throws(()=>archiveUnsubmittedDraft(task,{proof:candidate.proof,reason:'fixture',at:400,recoveryAuthorization:{...auth,...patch}}),{code:'E_DRAFT_EXPLICIT_REQUIRED'});
 assert.throws(()=>archiveUnsubmittedDraft(task,{proof:candidate.proof,reason:'fixture',at:400000,recoveryAuthorization:auth}),{code:'E_DRAFT_EXPLICIT_REQUIRED'});
 const projected=archiveUnsubmittedDraft(task,{proof:candidate.proof,reason:'explicitly reviewed',at:400,recoveryAuthorization:auth});assert.equal(projected.status,'review');assert.equal(projected.submissionDraftArchives.at(-1).recoveryAuthorization.requestId,'fresh-request');assert.deepEqual(task,before);
 task.note='用户停止';assert.equal(draftReviewCandidate(task,{publicLogText:logFor(task)}).requiresExplicit,true,'legacy prose does not grant or deny authorization');
});
test('typed terminal intent blocks even valid prior dispatch proofs and cannot be overridden by review authorization',()=>{
 for(const mutate of [t=>{t.controllerLifecycle={intent:'user-stop',terminal:true};},t=>{t.controllerLifecycle={intent:'business-stop',terminal:false};},t=>{t.stopRequest={phase:'confirmed'};},t=>{t.monitorStatus='stopped';},t=>{t.status='cancelled';}]){
  const task=fixture();task.followUpPending.dispatchProof=explicit(task);const proof=structuredClone(task.followUpPending.dispatchProof);mutate(task);
  assert.equal(proveDraftNotDispatched(task).ok,false);assert.equal(draftReviewCandidate(task).ok,false);assert.throws(()=>archiveUnsubmittedDraft(task,{proof,reason:'fixture'}),{code:'E_DRAFT_TERMINAL'});
 }
});
test('a round-aware host suspension checkpoint preserves a legacy proof without hiding later stop or unknown evidence',()=>{
 const {workSubmissionState}=require('../src/main/workbuddy-observation'),task=fixture({legacy:true});task.status='stopped';
 const lifecycle={schema:'bunny.controller-lifecycle/v1',state:'suspended',intent:'host-suspend',cause:'process-exit',terminal:false,at:400,generation:3};task.controllerLifecycle=lifecycle;
 const event={taskId:task.id,generation:3,stage:'submission-checkpoint',status:'stopped',controllerLifecycle:lifecycle,checkpoint:workSubmissionState(task)};
 const log=logFor(task)+'\n'+JSON.stringify(event);assert.equal(draftReviewCandidate(task,{publicLogText:log}).requiresExplicit,true);
 const stopped={...event,controllerLifecycle:{...lifecycle,state:'stopped',intent:'user-stop',terminal:true}};
 assert.equal(proveDraftNotDispatched(task,{publicLogText:log+'\n'+JSON.stringify(stopped)}).ok,false);
 const unknown={...event,checkpoint:{...event.checkpoint,steps:[{action:'workbuddySend',state:'intent',at:450}],followUpState:'unknown',submitAttempted:true}};
 assert.equal(proveDraftNotDispatched(task,{publicLogText:log+'\n'+JSON.stringify(unknown)}).ok,false);
});
