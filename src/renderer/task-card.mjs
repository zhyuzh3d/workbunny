const ended=new Set(['completed','stopped','expired','failed','accepted','ok']);
const time=value=>new Date(value).toLocaleTimeString('zh-CN',{hour12:false});
export function refreshTaskClock(card,task){const stamp=card.querySelector('[data-last-check]');if(stamp&&task.lastCheckedAt)stamp.textContent=' · 最近检查 '+time(task.lastCheckedAt);}
export function taskCard(task,{onAction=()=>{},onArtifact=()=>{},pending=false,message='',external=false,document:doc=globalThis.document}={}){
 const el=(tag,cls,text)=>{const n=doc.createElement(tag);n.className=cls||'';if(text!=null)n.textContent=text;return n;};
 const card=el('article','task-card');card.dataset.taskId=task.id||'';
 const p=task.presentation||{},guide=p.guidance;
 const status=guide?guide.kind==='permission'?'待授权':guide.working?'处理中':'待确认':p.statusLabel||task.status;
 const head=el('div','task-card-heading');head.append(el('h3','',p.title||task.title||task.name||task.goal||'工作任务'),el('span','task-card-status',status));card.append(head);
 if(task.subjects?.length)card.append(el('div','task-card-meta',task.subjects.map(s=>s.recipient||({workbuddy:'WorkBuddy',wechat:'微信'}[s.application]||s.application)).join(' · ')));
 if(task.goal&&task.goal!==p.title)card.append(el('p','task-card-goal',task.goal));
 if(guide){const box=el('div','task-card-guidance');box.append(el('strong','',guide.title),el('p','',guide.detail));card.append(box);}
 else if(task.note)card.append(el('p','task-card-note',task.note));
 if(task.queuedEvents)card.append(el('p','task-card-meta',`有 ${task.queuedEvents} 条动态待处理，已保留。`));
 if(task.schedule?.intervalSeconds&&!ended.has(task.status)){const cadence=el('p','task-card-meta',`每 ${task.schedule.intervalSeconds} 秒${p.continuous?'检查画面':'跟进进度'}`),stamp=el('span','');stamp.dataset.lastCheck='';cadence.append(stamp);card.append(cadence);refreshTaskClock(card,task);}
 const controls=el('div','task-card-actions');
 const add=(label,operation,primary=false)=>{const button=el('button',primary?'task-primary':'task-secondary',label);button.type='button';button.dataset.operation=operation;button.disabled=pending||guide?.working===true&&operation==='resolve';button.onclick=()=>onAction(operation,task);controls.append(button);};
 if(guide)add(guide.primaryLabel,guide.kind==='source'?'reissue':guide.kind==='inspect'?'details':'resolve',true);
 else if(task.status==='queued')add('启动这项任务','resume',true);
 else if(task.status==='paused')add('继续任务','resume',true);
 else if(!external&&['ready','running','waiting'].includes(task.status)){add('暂停','pause');add('现在检查','check');}
 if(!ended.has(task.status)&&task.status!=='stopping')add(task.status==='queued'?'取消任务':'停止任务','stop');
 if(controls.childElementCount)card.append(controls);
 if(message)card.append(el('p','task-card-message',message));
 if(guide&&task.note){const details=el('details','task-card-technical');details.dataset.detailsKey='reason';details.append(el('summary','','查看具体原因'),el('p','',task.note));card.append(details);}
 if(task.result){const details=el('details','task-card-result');details.dataset.detailsKey='result';details.append(el('summary','','查看成果'),el('p','',task.result.text||task.result.summary));for(const [index,file] of(task.result.artifacts||[]).entries()){const b=el('button','task-secondary',String(file.path||'成果文件').split('/').at(-1));b.onclick=()=>onArtifact(task.id,index);details.append(b);}card.append(details);}
 if(task.delivery?.status==='delivered')card.append(el('p','task-card-meta','已交付'+(task.delivery.channel==='wechat'?' · 微信 '+task.delivery.recipient:'')));
 return card;
}
