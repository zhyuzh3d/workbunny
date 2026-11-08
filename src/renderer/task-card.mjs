import { appendResultLinks } from './result-links.mjs';
const ended=new Set(['completed','stopped','expired','failed','accepted','ok']);
const time=value=>new Date(value).toLocaleTimeString('zh-CN',{hour12:false});
export function refreshTaskClock(card,task){const stamp=card.querySelector('[data-last-check]');if(stamp&&task.lastCheckedAt)stamp.textContent=' · 最近检查 '+time(task.lastCheckedAt);const countdown=card.querySelector('[data-cleanup-countdown]');if(countdown){const seconds=Math.max(0,Math.ceil((task.stopRequest.deadlineAt-Date.now())/1000));countdown.textContent=seconds?'外部停止中 · 最多剩余 '+seconds+' 秒':'外部清理时限已到，正在记录未确认项；Bunny 已停止，可开始新任务。';}}
export function taskCard(task,{onAction=()=>{},onArtifact=()=>{},onResultLink=()=>{},pending=false,message='',external=false,document:doc=globalThis.document}={}){
 const el=(tag,cls,text)=>{const n=doc.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;return n;};
 const card=el('article','task-card');card.dataset.taskId=task.id||'';
 const p=task.presentation||{},guide=p.guidance,reviewPriorResult=!external&&!task.stopRequest&&!task.state?.stopRequest&&['paused','needs_attention'].includes(task.status)&&p.secondaryAction?.operation==='reviewPriorResult'?p.secondaryAction:null;
 const status=task.status==='stopped'?'已停止':task.status==='expired'?'已结束':guide?guide.kind==='permission'?'待授权':guide.working?'处理中':'待确认':p.statusLabel||task.status;
 const head=el('div','task-card-heading');head.append(el('h3','',p.title||task.title||task.name||task.goal||'工作任务'),el('span','task-card-status',status));card.append(head);
 if(task.subjects?.length)card.append(el('div','task-card-meta',task.subjects.map(s=>s.recipient||({workbuddy:'WorkBuddy',wechat:'微信'}[s.application]||s.application)).join(' · ')));
 if(task.goal&&task.goal!==p.title)card.append(el('p','task-card-goal',task.goal));
 if(guide){const box=el('div','task-card-guidance');box.append(el('strong','',guide.title),el('p','',guide.detail));card.append(box);}
 else if(task.note)card.append(el('p','task-card-note',task.note));
 if(task.stopRequest?.phase==='pending'&&task.stopRequest.deadlineAt&&(task.resources?.some(r=>r.kind!=='controller'&&!['ended','stopped','preserved'].includes(r.phase))||task.workJobId)){const countdown=el('p','task-card-message');countdown.dataset.cleanupCountdown='';countdown.setAttribute('role','status');card.append(countdown);refreshTaskClock(card,task);}
 if(task.queuedEvents)card.append(el('p','task-card-meta',`有 ${task.queuedEvents} 条动态待处理，已保留。`));
 if(task.schedule?.intervalSeconds&&!ended.has(task.status)){const cadence=el('p','task-card-meta',p.guidance?.nextCheckAt?`下次恢复核对 ${time(p.guidance.nextCheckAt)}`:['work-submit','wechat-send'].includes(p.guidance?.kind)?p.guidance.working?'正在恢复核对':'等待恢复核对':`每 ${task.schedule.intervalSeconds} 秒${p.continuous?'检查画面':'跟进进度'}`),stamp=el('span','');stamp.dataset.lastCheck='';cadence.append(stamp);card.append(cadence);refreshTaskClock(card,task);}
 const controls=el('div','task-card-actions');
 const add=(label,operation,primary=false)=>{const button=el('button',primary?'task-primary':'task-secondary',label);button.type='button';button.dataset.operation=operation;button.disabled=pending&&!['pause','stop'].includes(operation)||guide?.working===true&&(['resolve','reviewPriorResult'].includes(operation)||guide.kind==='stop'&&operation==='stop');button.onclick=()=>onAction(operation,task);controls.append(button);};
 if(guide?.primaryLabel)add(guide.primaryLabel,guide.kind==='stop'?'stop':guide.kind==='source'?'reissue':guide.kind==='inspect'?'details':'resolve',true);
 else if(task.status==='queued')add('启动这项任务','resume',true);
 else if(task.status==='paused')add('继续任务','resume',true);
 else if(!external&&['ready','running','waiting'].includes(task.status)){add('暂停','pause');add('现在检查','check');}
 if(reviewPriorResult)add(reviewPriorResult.label,'reviewPriorResult');
 if(!external&&!task.stopRequest&&guide?.kind!=='stop'&&['needs_attention','waiting_permission'].includes(task.status))add('暂停','pause');
 if((!ended.has(task.status)||task.resources?.some(entry=>entry.ownership==='owned'&&!['ended','stopped','preserved'].includes(entry.phase)))&&!task.stopRequest&&task.status!=='stopping'&&guide?.kind!=='stop')add(task.status==='queued'?'取消任务':'停止任务','stop');
 if(!external&&['completed','stopped','expired'].includes(task.status))add('移出列表','archive');
 if(controls.childElementCount)card.append(controls);
 if(reviewPriorResult?.detail)card.append(el('p','task-card-meta',reviewPriorResult.detail));
 if(message)card.append(el('p','task-card-message',message));
 if(task.cleanupLog?.length){const details=el('details','task-card-technical');details.dataset.detailsKey='cleanup';details.append(el('summary','','查看外部清理日志'));for(const row of task.cleanupLog)details.append(el('p','',(row.label||row.kind)+' · '+(row.verified?'已确认停止':'已保留或未确认')+' · '+row.reason));card.append(details);}
 if(guide&&task.note){const details=el('details','task-card-technical');details.dataset.detailsKey='reason';details.append(el('summary','','查看具体原因'),el('p','',task.note));card.append(details);}
 if(task.result?.links?.length){const links=el('div','task-card-links');appendResultLinks(links,task.result.links,index=>onResultLink(task.id,index));card.append(links);}
 if(task.result){const details=el('details','task-card-result');details.dataset.detailsKey='result';details.append(el('summary','','查看成果'),el('p','',task.result.text||task.result.summary));for(const [index,file] of(task.result.artifacts||[]).entries()){const b=el('button','task-secondary',String(file.path||'成果文件').split('/').at(-1));b.onclick=()=>onArtifact(task.id,index);details.append(b);}card.append(details);}
 if(task.delivery?.status==='delivered')card.append(el('p','task-card-meta','已交付'+(task.delivery.channel==='wechat'?' · 微信 '+task.delivery.recipient:'')));
 return card;
}
