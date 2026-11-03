const terminal=new Set(['completed','stopped','expired']);
const activeDesktop=new Set(['starting','running','awaiting','monitoring','verifying','review']);
const short=value=>String(value||'').replace(/\s+/gu,' ').slice(0,34);
export function taskActivity({agent={},desktop={},work={},now=Date.now(),seen=new Set(),recentUntil=0,selectedKey=null}={}){
 const logical=(agent.tasks||[]).filter(task=>task.status!=='queued'&&(!terminal.has(task.status)||(task.status==='completed'&&now-task.updatedAt<7000)||selectedKey==='agent#'+task.id)),rows=[],linked=new Set(logical.map(task=>task.workJobId).filter(Boolean));
 for(const task of logical){
  const key='agent#'+task.id;
  if(terminal.has(task.status)&&seen.has(key)&&selectedKey!==key)continue;
  const p=task.presentation||{title:task.goal,statusLabel:task.status==='waiting'?'持续跟进':'正在处理'};
  let label=p.statusLabel;const physical=desktop.task;
  if(task.status==='paused'&&((physical?.id===task.workJobId&&activeDesktop.has(physical.status))||(work.tasks||[]).some(w=>w.bunnyTaskId===task.workJobId&&w.status==='running')))label='暂停跟进 · WorkBuddy仍在执行';
  rows.push({key,text:label+' · '+short(p.title),source:'bunny',record:task,terminal:terminal.has(task.status),action:task.status==='completed'?'dismiss':terminal.has(task.status)||task.status==='stopping'?null:'stop',ref:{source:'agent',id:task.id},taskId:task.id,attention:['waiting_permission','needs_attention'].includes(task.status),at:task.createdAt||0,...(task.status==='completed'&&selectedKey!==key?{expiresAt:task.updatedAt+7000}:{})});
 }
 const physical=desktop.task;let shownPhysicalId;
 if(physical){
  const owned=logical.some(t=>t.workJobId===physical.id||physical.sources?.includes(t.id));
  const active=desktop.running||activeDesktop.has(physical.status),recent=!active&&(now<recentUntil||selectedKey==='desktop#'+physical.id);
  if(!owned&&(active||recent)){
   const key='desktop#'+physical.id;if(!seen.has(key)||active){shownPhysicalId=physical.id;rows.push({key,text:(physical.target==='workbuddy'?'WorkBuddy · ':'')+(active?'正在操作 · ':'操作结束 · ')+short(physical.recipient||physical.goal||'软件任务'),source:'bunny',record:{...physical,presentation:{title:short(physical.recipient||physical.goal||'软件任务'),statusLabel:active?'正在操作':physical.status==='accepted'?'已完成':'已停止'}},terminal:!active,action:active?'stop':physical.status==='accepted'?'dismiss':null,ref:{source:'desktop',id:physical.id},attention:physical.status==='failed',at:physical.startedAt||0,...(!active&&selectedKey!==key?{expiresAt:recentUntil}:{})});}
  }
 }
 for(const task of work.tasks||[]){
  if(task.bunnyTaskId&&(linked.has(task.bunnyTaskId)||task.bunnyTaskId===shownPhysicalId))continue;
  const running=task.status==='running',recent=!running&&task.endedAt&&now-task.endedAt<7000;if(!running&&!recent&&selectedKey!==(task.sessionId||'')+'#'+(task.taskId||0))continue;
  const key=(task.sessionId||'')+'#'+(task.taskId||0);if(!running&&seen.has(key))continue;
  rows.push({key,text:(running?'WorkBuddy执行中 · ':task.status==='failed'?'WorkBuddy未完成 · ':task.status==='stopped'?'WorkBuddy已停止 · ':'WorkBuddy有结果 · ')+short(task.name||task.title||'工作任务'),source:'workbuddy',record:{...task,id:key,goal:task.userText||task.name||task.title,note:task.summary|| (running?'WorkBuddy正在执行这项工作。':'工作已经结束。'),presentation:{title:task.name||task.title||'WorkBuddy任务',statusLabel:running?'WorkBuddy执行中':task.status==='ok'?'已完成':task.status==='stopped'?'已停止':'未完成'}},terminal:!running,action:running?'stop':task.status==='ok'?'dismiss':null,ref:{source:'workbuddy',sessionId:task.sessionId,taskId:task.taskId},attention:task.status==='failed',at:task.startedAt||0,...(!running&&selectedKey!==key?{expiresAt:task.endedAt+7000}:{})});
 }
 return rows.sort((a,b)=>Number(b.attention)-Number(a.attention)||a.at-b.at);
}
