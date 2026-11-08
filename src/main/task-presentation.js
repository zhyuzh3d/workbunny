'use strict';
const names={workbuddy:'WorkBuddy',wechat:'微信',system:'系统',bunny:'Bunny',finder:'访达',chrome:'Chrome',codex:'Codex'};
const clean=value=>String(value||'').replace(/(?:\/[^\s，。；：、"'`]+)+/gu,p=>p.split('/').filter(Boolean).at(-1)||'文件').replace(/\s+/gu,' ').trim();
function currentTaskFailure(task){
 const failure=task.state?.lastFailure;if(!failure)return null;
 if(Number.isFinite(failure.resolvedAt)&&(!Number.isFinite(failure.at)||failure.resolvedAt>=failure.at))return null;
 const operation=failure.operationId&&task.operations?.[failure.operationId];
 if(operation?.status==='confirmed'&&(!failure.actionId||operation.actionId===failure.actionId)&&Number.isFinite(operation.finishedAt)&&Number.isFinite(failure.at)&&operation.finishedAt>=failure.at)return null;
 // Older records have no operation provenance. A later receipt for this exact
 // delegated job still proves its earlier submission failure is historical.
 const jobId=task.state?.job?.jobId;
 if(!failure.operationId&&task.skill==='work.delegate'&&jobId&&Number.isFinite(failure.at)&&
  Object.values(task.operations||{}).some(op=>op.tool==='work.submit'&&op.status==='confirmed'&&op.result?.jobId===jobId&&Number.isFinite(op.finishedAt)&&op.finishedAt>failure.at))return null;
 return failure;
}
function currentWorkAttention(task){
 const attention=task.state?.workAttention,checkpoint=task.state?.workCheckpoint,jobId=task.state?.job?.jobId||task.state?.workOperationId;
 if(task.skill!=='work.delegate'||attention?.kind!=='work-follow-up'||!jobId||attention.jobId!==jobId||!Number.isSafeInteger(attention.round)||attention.round<0||!Number.isFinite(attention.at))return null;
 if(Number.isSafeInteger(checkpoint?.submissionRound)&&attention.round!==checkpoint.submissionRound)return null;
 return attention;
}
function priorResultReviewAction(task){
 const state=task.state||{},checkpoint=state.workCheckpoint,capability=checkpoint?.capabilities?.reviewPriorResult,jobId=state.job?.jobId||state.workOperationId;
 if(task.skill!=='work.delegate'||!['paused','needs_attention'].includes(task.status)||state.stopRequest||task.stopRequest||capability?.available!==true||!jobId||capability.jobId!==jobId)return null;
 if(checkpoint.phase!=='draft-ready'||checkpoint.submitAttempted!==false||checkpoint.handoffSent!==false||checkpoint.priorSubmission?.handoffSent!==true)return null;
 if(!Number.isSafeInteger(capability.submissionRound)||capability.submissionRound<1||capability.submissionRound!==checkpoint.submissionRound||
  !Number.isSafeInteger(capability.priorSubmissionRound)||capability.priorSubmissionRound<0||capability.priorSubmissionRound>=capability.submissionRound)return null;
 return {operation:'reviewPriorResult',label:'保留补充草稿，重新核验原成果',detail:(capability.requiresExplicit?'旧记录的停止原因未确认，需要本次明确发起。':'')+'保留补充草稿，仅重新核验原成果；不会发送或清空编辑器，是否完成由核验结果决定。'};
}
function failureNote(task,error,{unknown=false}={}){
 const checkpoint=task.state?.workCheckpoint;
 if(unknown&&task.skill==='work.delegate'&&checkpoint?.phase==='draft-ready'&&!checkpoint.submitAttempted&&!checkpoint.handoffSent)
  return '原稿已填写，尚未提交；'+error.message;
 return unknown?'操作结果不确定，已停止重发；'+error.message:error.message;
}
function taskGuidance(task,{handling=false}={}){
 const missing=task.state?.missingPermissions||[],intent=Object.values(task.operations||{}).find(o=>o.effect==='write'&&o.status==='intent');
 if(task.state?.stopRequest)return task.state.stopRequest.phase==='pending'&&(task.state.workOperationId||task.state.job?.jobId||Object.values(task.state.resources||{}).some(entry=>entry.kind!=='controller'&&!['ended','stopped','preserved'].includes(entry.phase)))?{kind:'cleanup',title:'Bunny 已停止，外部清理中',detail:'本地任务已结束，启动名额已释放。仅进行一次、最多30秒的外部清理；结果和错误会保留，可以开始独立新任务。',working:true}:null;
 if(task.status==='waiting_permission')return {kind:'permission',title:'需要开启'+(missing.map(k=>require('./authorization-service').permissionTitles[k]||k).join('、')||'任务权限'),detail:'任务和已有进展已保留。打开授权指引，完成后 Bunny 会继续原任务。',primaryLabel:'打开授权指引'};
 if(task.status!=='needs_attention')return null;
 const failure=currentTaskFailure(task),attention=currentWorkAttention(task);
 if(failure?.code==='E_TASK_AUTH')return {kind:'source',title:'原交办已失效',detail:'原交办来源已不可用，Bunny 没有继续操作。请重新说明要做的事。',primaryLabel:'重新交办'};
 if(attention&&(!failure||!Number.isFinite(failure.at)||attention.at>=failure.at)){
  const checkpoint=task.state.workCheckpoint||{},prior=checkpoint.priorSubmission?.handoffSent===true,preserved=attention.resultPreserved===true?'原成果已保留。':'原会话进展已保留。';
  if(prior&&['draft-ready','input-unknown'].includes(checkpoint.phase))return {kind:'retry',title:checkpoint.phase==='draft-ready'?'补充草稿待继续':'补充草稿写入待核对',
   detail:preserved+(checkpoint.phase==='draft-ready'?'补充草稿已填写，尚未提交。':'补充草稿写入结果仍需核对。')+(attention.report||'保留现有草稿，核对后继续，不重新制作。'),primaryLabel:'核对补充草稿并继续'};
  return {kind:'retry',title:prior?'补充要求待核对':'工作跟进待核对',detail:(prior?preserved:'')+(attention.report||'保留原会话与操作记录，核对本轮实际进展后继续。'),primaryLabel:'核对当前进展并继续'};
 }
 if(failure?.code==='E_WORKBUDDY_DRAFT_CONFLICT')return {kind:'retry',title:'等待处理 WorkBuddy 草稿',detail:'WorkBuddy 通用任务页已有未发送内容，已保留。请先保存或处理草稿，再继续这项任务。',primaryLabel:'草稿已处理，继续交办'};
 if(failure?.code==='E_WORKBUDDY_ROUTE_CONFLICT')return {kind:'retry',title:'等待核对 WorkBuddy 工作空间',detail:'指定工作空间不存在或不唯一，已保留任务。请核对工作位置后继续。',primaryLabel:'位置已核对，继续交办'};
 if(failure?.code==='E_APP_CIRCUIT')return {kind:'wechat-unavailable',title:'微信需要恢复后继续',detail:'请在本机恢复原微信账号，确认已登录并显示后重新定位。Bunny 不会自动重启或登录；窗口变化后会重新建立来信基线，主人入口需重新绑定。',primaryLabel:'原账号已恢复，重新定位'};
 if(intent?.tool==='work.submit'){
  const check=task.state?.reconciliation?.[intent.id]||{},pending=handling||['queued','checking','waiting_idle'].includes(check.phase);
  const phase=task.state?.workCheckpoint?.phase;
  if(['draft-ready','input-unknown'].includes(phase))return {kind:'work-submit',title:handling||check.phase==='checking'?'正在核对原草稿':check.phase==='waiting_idle'?'等待空闲后核对原草稿':phase==='input-unknown'?'草稿写入待核对':'原草稿待继续',
   detail:check.checkpointPhase===phase&&check.lastError?check.lastError:phase==='input-unknown'?'输入结果仍需核对，保留原文和操作记录，不重新填写或直接发送。':'草稿已保留，尚无提交动作。核对完整原文和当前条件后，仅继续这一份草稿，不重新填写。',primaryLabel:pending?'正在核对…':'核对原草稿并继续',working:pending,nextCheckAt:check.nextAt};
  const detail=phase==='submission-unknown'?'原提交结果仍待核对，不重复发送。'+(check.lastError?'最近恢复检查：'+check.lastError:'原任务、草稿和提交记录已保留。'):check.lastError||'保留原任务和草稿，核对真实会话与原文后继续；结果不明时不重复交办。';
  return {kind:'work-submit',title:handling||check.phase==='checking'?'正在核对原交办':check.phase==='waiting_idle'?'等待空闲后核对':check.phase==='queued'?'已安排核对':check.phase==='needs_evidence'?'交办还需补证':'交办状态待核对',detail,primaryLabel:pending?'正在核对…':'核对并继续',working:pending,nextCheckAt:check.nextAt};
 }
 if(intent&&['conversation.send','result.deliver','result.attach'].includes(intent.tool)){
  const pending=handling||!!task.state?.recoveryRequestedAt;
  if(task.state?.conversationProgress?.phase==='draft')return {kind:'wechat-send',title:handling?'正在核对输入状态':pending?'等待空闲后核对':'输入状态待核对',detail:'输入操作已发出，Bunny 会核对联系人、编辑区和发送状态，再决定如何继续。',primaryLabel:pending?'正在核对…':'核对并继续',working:pending};
  return {kind:'wechat-send',title:handling?'正在核对发送结果':pending?'等待空闲后核对':'发送结果待确认',detail:pending?'Bunny 会核对刚才那一次发送，确认后继续原任务；不会重复发送已提交的消息。':'回复可能已发送，Bunny 已暂停以免重发。点击核对，确认结果后自动继续原任务。',primaryLabel:pending?'正在核对…':'核对并继续',working:pending};
 }
 if(intent)return {kind:'inspect',title:'这一步的结果待确认',detail:'这一步可能已经执行，Bunny 已暂停。请先查看原软件的实际结果；操作详情和已有进展保留在这里。',primaryLabel:'查看操作详情'};
 if(task.skill==='work.delegate'){
  if(task.state?.result)return {kind:'retry',title:'成果交付待核对',detail:'已回收成果和交付记录已保留。核对后继续交付，不重新制作。',primaryLabel:'检查交付并继续'};
  if(task.state?.job)return {kind:'retry',title:'WorkBuddy进度待核对',detail:'已绑定的工作会话和操作记录已保留。核对实际进展后继续跟进。',primaryLabel:'检查结果并继续'};
  return {kind:'retry',title:'交办尚未成功',detail:'原交办和操作记录已保留，尚未确认 WorkBuddy 接到本轮工作。环境恢复后继续这项任务，不重复创建。',primaryLabel:'继续原交办'};
 }
 return {kind:'retry',title:task.skill==='task.resolve'?'交办尚未安排成功':'任务暂时中断',detail:'交办和进展已保存。Bunny 可以从当前进度重新检查并继续。',primaryLabel:'重新尝试'};
}
function taskPresentation(task,options={}){
 const contacts=(task.subjects||[]).map(s=>s.recipient||names[s.application]||s.application).join('、'),behavior=task.parameters?.behavior;
 const continuous=['conversation.manage','screen.watch'].includes(task.skill),finished=['completed','stopped','expired'].includes(task.status);
 let title=clean(task.title||task.goal).replace(/^(?:请|麻烦|帮我|请你)\s*/u,'').split(/[。；\n]/u)[0].slice(0,32)||'处理交办';
 if(!task.title){if(task.skill==='conversation.manage')title=(behavior==='inquiry'?'联系':behavior==='owner'?'接收交办 · ':'监看 ')+contacts;else if(task.skill==='screen.watch')title='观察 '+contacts;else if(task.skill==='result.forward')title='转交已有成果';else if(task.skill==='task.resolve')title='安排 · '+title;}
 let statusLabel={queued:'待启动',stopping:'正在停止',ready:'准备执行',running:'正在处理',waiting:'等待下一步',waiting_permission:'等待授权',paused:'已暂停',needs_attention:'需要处理',completed:'已完成',stopped:'已停止',expired:'已结束'}[task.status]||'等待更新';
 if(!finished&&!['queued','stopping','paused','needs_attention','waiting_permission'].includes(task.status)){
  if(task.skill==='task.resolve')statusLabel=task.status==='waiting'&&currentTaskFailure(task)?'稍后继续理解':'理解交办中';
  else if(task.state?.result)statusLabel=task.state.delivery?.status==='delivered'?'已交付':'正在交付';
  else if(continuous)statusLabel=task.inbox?.length?'处理新动态':task.skill==='conversation.manage'&&!Object.values(task.state?.conversations||{}).some(c=>c.cursor?.ready)?'建立观察位置':'持续监看';
  else if(task.skill==='work.delegate')statusLabel=task.state?.workPhase==='submitting'?'核对交办结果':task.state?.workPhase==='verifying'?'回收成果':task.state?.job?'WorkBuddy执行中':'正在交办';
 }
 if(task.status==='paused'&&task.skill==='work.delegate'&&task.state?.job)statusLabel='已暂停跟进';
 const guidance=taskGuidance(task,options),secondaryAction=priorResultReviewAction(task);if(guidance)statusLabel=guidance.title;
 return {title,statusLabel,continuous,finished,...(guidance?{guidance}:{}),...(secondaryAction?{secondaryAction}:{})};
}
module.exports={taskPresentation,taskGuidance,failureNote,currentTaskFailure};
