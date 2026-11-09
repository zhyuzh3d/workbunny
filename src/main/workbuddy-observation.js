'use strict';

// Correlate only our explicit GUI handoff. Never use the monitor's "latest task"
// as evidence for a different delegated request.
function submissionRound(task={}){
  const committed=Number.isSafeInteger(task.followUpRound)?task.followUpRound:0,pending=task.followUpPending;
  return Math.max(committed,Number.isSafeInteger(pending?.round)?pending.round:pending?.state==='draft-unknown'?committed+1:committed);
}
function matchesSubmissionRound(record,task={}){
  if(!record)return false;
  const pending=task.followUpPending,committed=Number.isSafeInteger(task.followUpRound)?task.followUpRound:0;
  if(Number.isSafeInteger(record.submissionRound)&&record.submissionRound!==submissionRound(task))return false;
  // Filling a new draft is not a submission. Inherited positive receipts cannot
  // confirm it, even if another recovery path still sees the old message key.
  if(pending?.state==='draft-unknown'||submissionRound(task)>committed)return false;
  const session=task.monitorSessionId||task.sessionId;
  if(session&&record.sessionId!==session)return false;
  const unresolved=pending&&pending.state!=='observed';
  const baselineKey=pending?.baselineMessageKey||task.previousMonitorMessageKey||(unresolved?task.monitorMessageKey:null),baselineTask=pending?.baselineTaskId||task.previousMonitorTaskId||(unresolved?task.monitorTaskId:null);
  if(pending||task.followUpAwaitingMonitor){
    if(baselineKey&&(!record.messageKey||record.messageKey===baselineKey))return false;
    if(!baselineKey&&baselineTask&&record.taskId===baselineTask)return false;
    const at=pending?.submittedAt||task.submittedAt;
    if(Number.isFinite(at)&&at>0){const observed=record.startedAt??record.updatedAt;if((pending?.state!=='observed'||Number.isFinite(observed))&&(!Number.isFinite(observed)||observed<at-2000))return false;}
  }
  return true;
}
function beginFollowUpDraft(task,at=Date.now(),{origin='unknown',priorSnapshot}={}){
  return {state:'draft-unknown',round:(task.followUpRound||0)+1,draftStartedAt:at,
    origin,priorSnapshot:priorSnapshot||require('./submission-draft').capturePriorSnapshot(task),
    baselineMessageKey:task.monitorMessageKey||null,baselineTaskId:task.monitorTaskId||null,
    priorReceipt:{submissionRound:task.followUpRound||0,handoffSent:task.handoffSent===true,submittedAt:task.submittedAt||null,messageKey:task.monitorMessageKey||null}};
}
function workSubmissionConfirmed(task){
  if(!task?.handoffSent||!(task.monitorSessionId||task.sessionId)||task.followUpAwaitingMonitor===true)return false;
  if(task.continuationOf&&(task.followUpRound||0)<=(task.continuationOf.round||0))return false;
  if(task.followUpPending){
    if(task.followUpPending.state!=='observed')return false;
    if(!matchesSubmissionRound({sessionId:task.monitorSessionId||task.sessionId,taskId:task.monitorTaskId,messageKey:task.monitorMessageKey,startedAt:task.monitorStartedAt,updatedAt:task.monitorUpdatedAt},task))return false;
    if(task.previousMonitorMessageKey&&task.monitorMessageKey===task.previousMonitorMessageKey)return false;
  }
  return true;
}
function workSubmissionState(task={}){
 task=task&&typeof task==='object'?task:{};
 const allHistory=Array.isArray(task.steps)?task.steps:[],active=s=>!['not-dispatched','not_dispatched'].includes(s?.state),round=submissionRound(task),pending=task.followUpPending;
 const input=s=>s?.action==='workbuddyFill'||s?.action==='type'&&s.purpose!=='navigation';
 const drafting=pending?.state==='draft-unknown',lastInputIndex=allHistory.findLastIndex(s=>input(s)&&active(s));
 const anchor=pending?.draftStartedAt||pending?.submittedAt||((drafting&&lastInputIndex>=0)?allHistory[lastInputIndex].at:null);
 const history=allHistory.filter((s,i)=>Number.isSafeInteger(s.submissionRound)?s.submissionRound===round:anchor?Number.isFinite(s.at)&&s.at>=anchor:drafting?i>=lastInputIndex:round>0&&task.submittedAt?Number.isFinite(s.at)&&s.at>=task.submittedAt:!drafting);
 const inputs=history.filter(s=>input(s)&&active(s)),lastInput=inputs.at(-1);
 const sends=history.filter(s=>(s?.action==='workbuddySend'||s?.purpose==='submit')&&active(s));
 const time=value=>Number.isFinite(value)&&value>0?value:null;
 const followUpState=['draft-unknown','unknown','sent','observed'].includes(task.followUpPending?.state)?task.followUpPending.state:null;
 const followUpPending=!!task.followUpPending&&task.followUpPending.state!=='observed';
 const draftInserted=!!lastInput||!!pending?.draftInserted||(!pending&&!!task.draftInserted),submitAttempted=!drafting&&!!(sends.length||time(pending?.submittedAt)||task.followUpAwaitingMonitor||(!pending&&time(task.submitAttemptedAt))||(!pending&&time(task.submittedAt))||workSubmissionConfirmed(task));
 const handoffSent=task.handoffSent===true&&!drafting&&submissionRound(task)<=(task.followUpRound||0),hasMonitorSession=typeof task.monitorSessionId==='string'&&!!task.monitorSessionId,hasSession=hasMonitorSession||typeof task.sessionId==='string'&&!!task.sessionId;
 const phase=workSubmissionConfirmed(task)?'confirmed':submitAttempted?'submission-unknown':draftInserted?(lastInput&&['input-sent','confirmed'].includes(lastInput.state)?'draft-ready':'input-unknown'):'not-started';
 const actions=new Set(['type','workbuddyFill','workbuddySend','key','click','scroll','wait','done']),purposes=new Set(['task','navigation','focus','submit']),states=new Set(['intent','input-sent','not-dispatched','not_dispatched','unknown','confirmed']);
 const steps=history.slice(-3).map(s=>({...actions.has(s?.action)?{action:s.action}:{},...purposes.has(s?.purpose)?{purpose:s.purpose}:{},...states.has(s?.state)?{state:s.state}:{},...(time(s?.at)?{at:s.at}:{})}));
 return {phase,inputUnconfirmed:!!lastInput&&!['input-sent','confirmed'].includes(lastInput.state),submissionRound:round,draftInserted,submitAttempted,handoffSent,hasSession,hasMonitorSession,followUpPending,submitAttemptedAt:drafting?null:time(pending?.submittedAt||task.submitAttemptedAt),submittedAt:drafting?null:time(task.submittedAt),draftInsertedAt:time(lastInput?.at||pending?.draftStartedAt||(!pending&&task.draftInsertedAt)),followUpState,steps,
   ...(pending?{priorSubmission:pending.priorReceipt||{submissionRound:Math.max(0,round-1),handoffSent:task.handoffSent===true,messageKey:pending.baselineMessageKey||task.previousMonitorMessageKey||task.monitorMessageKey||null}}:{})};
}
function observeWorkBuddy(monitor, task) {
  if (!monitor?.sessions || !task?.id || !Number.isFinite(task.submittedAt) || task.submittedAt <= 0) return null;
  // Legacy repeated attempts must not move the correlation window past an
  // earlier successful first submission carrying the same exact task marker.
  // Follow-up rounds retain their separate time/message-key boundary.
  const initial=!task.continuationOf&&!task.followUpPending&&!(task.followUpRound>0);
  const attempts=initial&&(Array.isArray(task.steps))?task.steps.filter(s=>(s?.purpose==='submit'||s?.action==='workbuddySend')&&['intent','input-sent','confirmed'].includes(s.state)&&Number.isFinite(s.at)&&s.at>0).map(s=>s.at):[];
  const submittedAt=Math.min(task.submittedAt,...attempts);
  const found = [];
  for (const entry of monitor.sessions.values()) {
    const snap = entry.snap;
    if (!snap?.sessionId || (task.monitorSessionId && snap.sessionId !== task.monitorSessionId)) continue;
    const rows = [snap.task, ...(snap.history || [])].filter(Boolean);
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const previous = task.previousMonitorMessageKey ? row.messageKey === task.previousMonitorMessageKey : row.id === task.previousMonitorTaskId;
      if (row.bunnyTaskId !== task.id || previous ||
          !Number.isFinite(row.startedAt) || row.startedAt < submittedAt - 2000) continue;
      if (task.monitorMessageKey ? row.messageKey !== task.monitorMessageKey : task.monitorTaskId && row.id !== task.monitorTaskId) continue;
      const status = row.endReason === 'superseded' ? 'abandoned' : row.status;
      if (!['running', 'ok', 'failed', 'abandoned', 'stopped'].includes(status)) continue;
      const candidate={sessionId:snap.sessionId,taskId:row.id,messageKey:row.messageKey,startedAt:row.startedAt,updatedAt:row.endedAt||snap.lastEventAt};
      if(!matchesSubmissionRound(candidate,task))continue;
      const links = require('./result-links').extractResultLinks(String(row.summary || ''));
      found.push({ sessionId: snap.sessionId, taskId: row.id, status, ...(links.length ? { links } : {}),
        ...(row.messageKey ? { messageKey: row.messageKey } : {}),
        ...(snap.sessionTitle||row.title?{sessionTitle:snap.sessionTitle||row.title}:{}),summary: String(row.summary || '').slice(0, 6000), startedAt: row.startedAt,
        updatedAt: row.endedAt || snap.lastEventAt, model: row.model || null });
    }
  }
  // Ambiguous duplicate markers must never authorize a reply to either session.
  return found.length === 1 ? found[0] : null;
}

// Absence is useful evidence only after the exact bound log was read through
// its current file boundary. A missing, rotating or partially read log is unknown.
async function inspectWorkBuddySubmission(monitor,task){
 const record=observeWorkBuddy(monitor,task),sessionId=task.monitorSessionId||task.sessionId;
 const entries=[...(monitor?.sessions?.values()||[])].filter(e=>e.snap?.sessionId===sessionId);
 if(entries.length!==1)return {complete:false,record,reason:'绑定会话记录缺失或不唯一'};
 const entry=entries[0];
 try{
  const stat=await require('node:fs/promises').lstat(entry.file);
  const rows=[entry.snap.task,...(entry.snap.history||[])].filter(Boolean);
  const legacyDraft=task.followUpPending?.state==='draft-unknown';
  const baselineKey=task.followUpPending?.baselineMessageKey||task.previousMonitorMessageKey||(legacyDraft?task.monitorMessageKey:null),baselineTask=task.followUpPending?.baselineTaskId||task.previousMonitorTaskId||(legacyDraft?task.monitorTaskId:null);
  const baseline=rows.some(row=>baselineKey?row.messageKey===baselineKey:task.continuationOf?.id?row.bunnyTaskId===task.continuationOf.id:baselineTask&&row.id===baselineTask);
  const complete=stat.isFile()&&!entry.priming&&entry.integrityUnknown!==true&&baseline&&entry.ino===stat.ino&&entry.offset===stat.size&&entry.reader?.atBoundary===true;
  return {complete,record,sessionId,cursor:{bytes:entry.offset,size:stat.size,ino:stat.ino},needsEvidence:entry.integrityUnknown===true||!baseline,reason:complete?'原会话基线存在，记录无丢弃且已读到当前完整边界':entry.integrityUnknown?'会话记录有截断、轮换或丢弃事件，不能据此认定未提交':!baseline?'尚未在记录中定位原会话消息基线':'会话记录仍在读取或有未完成行'};
 }catch{return {complete:false,record,reason:'暂不能读取绑定会话记录'};}
}

function boundWorkObservationQuery(task,{priorResult=false}={}){
 if(!task||task.target!=='workbuddy')return null;
 let base=task,priorRound=task.followUpRound||0;
 if(priorResult){
  const identity=require('./submission-draft').identifyDraft(task),pending=task.followUpPending;
  if(!identity||task.followUpAwaitingMonitor||pending.submittedAt)return null;
  const priorAt=pending.priorReceipt?.submittedAt||task.submittedAt;
  if(task.steps.some((s,i)=>(s.submissionRound===identity.round||i>=identity.fillIndex||Number.isFinite(priorAt)&&s.at>priorAt)&&
    (s.action==='workbuddySend'||s.purpose==='submit')&&!['not-dispatched','not_dispatched'].includes(s.state)))return null;
  base=pending.priorSnapshot?.fields||task;priorRound=base.followUpRound||0;
  if(priorRound>=identity.round||pending.priorReceipt?.handoffSent===false||pending.baselineMessageKey&&pending.baselineMessageKey!==base.monitorMessageKey||pending.priorReceipt?.messageKey&&pending.priorReceipt.messageKey!==base.monitorMessageKey)return null;
 }else if(!workSubmissionConfirmed(task))return null;
 const session=base.monitorSessionId||base.sessionId,key=base.monitorMessageKey;
 if(base.handoffSent!==true||typeof session!=='string'||!session||typeof key!=='string'||!key.trim()||key.length>256||!Number.isFinite(base.submittedAt)||base.submittedAt<=0)return null;
 if((task.monitorSessionId||task.sessionId)!==session||task.monitorMessageKey!==key)return null;
 const query=structuredClone(task);
 Object.assign(query,{sessionId:session,monitorSessionId:session,monitorMessageKey:key,monitorTaskId:base.monitorTaskId,submittedAt:base.submittedAt,followUpRound:priorRound,followUpAwaitingMonitor:false});
 delete query.followUpPending;delete query.previousMonitorMessageKey;delete query.previousMonitorTaskId;
 if(priorResult&&task.continuationOf&&(task.followUpRound||0)<=(task.continuationOf.round||0)){
  if(!task.continuationOf.id)return null;query.id=task.continuationOf.id;delete query.continuationOf;
 }
 return query;
}
function syncBoundWorkObservation(task,record,options={}){
 const query=boundWorkObservationQuery(task,options),time=value=>Number.isSafeInteger(value)&&value>0&&value<=8_640_000_000_000_000;
 if(!query)return {ok:false,reason:'缺少可精确核对的原轮正向绑定，未更新成果事实'};
 // A stable message key survives WorkBuddy's per-process task counter reorder.
 // Neither a nearby task ID nor a new message may replace this exact reply.
 if(!record||record.status!=='ok'||record.sessionId!==query.monitorSessionId||record.messageKey!==query.monitorMessageKey||
   !(typeof record.taskId==='string'&&record.taskId.trim()||Number.isSafeInteger(record.taskId)&&record.taskId>0)||
   !time(record.startedAt)||!time(record.updatedAt)||record.updatedAt<record.startedAt||record.startedAt<query.submittedAt-2000||options.priorResult&&record.startedAt>=require('./submission-draft').identifyDraft(task).fillAt||typeof record.summary!=='string'||!record.summary.trim())
  return {ok:false,reason:'完成回执与原会话消息或时间不匹配，未更新成果事实'};
 const facts={monitorSessionId:record.sessionId,monitorTaskId:record.taskId,monitorMessageKey:record.messageKey,monitorStatus:'ok',monitorSummary:record.summary,
  monitorLinks:require('./result-links').resultLinkCandidates(record.links,record.summary),monitorStartedAt:record.startedAt,monitorUpdatedAt:record.updatedAt,monitorModel:record.model||null,
  ...(typeof record.sessionTitle==='string'?{sessionTitle:record.sessionTitle}:{}),...(typeof record.evidence==='string'?{monitorEvidence:record.evidence}:{})};
 const projection=structuredClone(task);Object.assign(projection,facts);
 if(options.priorResult&&projection.followUpPending.priorSnapshot){
  const snapshot=projection.followUpPending.priorSnapshot;Object.assign(snapshot.fields,facts);snapshot.absent=(snapshot.absent||[]).filter(key=>!Object.hasOwn(facts,key));
 }
 return {ok:true,task:projection};
}

module.exports = { observeWorkBuddy, workSubmissionConfirmed,workSubmissionState,inspectWorkBuddySubmission,submissionRound,matchesSubmissionRound,beginFollowUpDraft,boundWorkObservationQuery,syncBoundWorkObservation };
