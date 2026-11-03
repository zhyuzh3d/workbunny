'use strict';
const names={workbuddy:'WorkBuddy',wechat:'微信',system:'系统',bunny:'Bunny',finder:'访达',chrome:'Chrome',codex:'Codex'};
const clean=value=>String(value||'').replace(/(?:\/[^\s，。；：、"'`]+)+/gu,p=>p.split('/').filter(Boolean).at(-1)||'文件').replace(/\s+/gu,' ').trim();
function taskGuidance(task,{handling=false}={}){
 const missing=task.state?.missingPermissions||[],intent=Object.values(task.operations||{}).find(o=>o.effect==='write'&&o.status==='intent');
 if(task.status==='waiting_permission')return {kind:'permission',title:'需要开启'+(missing.map(k=>require('./authorization-service').permissionTitles[k]||k).join('、')||'任务权限'),detail:'任务和已有进展已保留。打开授权指引，完成后 Bunny 会继续原任务。',primaryLabel:'打开授权指引'};
 if(task.status!=='needs_attention')return null;
 if(task.state?.lastFailure?.code==='E_TASK_AUTH')return {kind:'source',title:'原交办已失效',detail:'原交办来源已不可用，Bunny 没有继续操作。请重新说明要做的事。',primaryLabel:'重新交办'};
 if(task.state?.lastFailure?.code==='E_APP_CIRCUIT')return {kind:'wechat-unavailable',title:'微信需要恢复后继续',detail:'请在本机恢复原微信账号，确认已登录并显示后重新定位。Bunny 不会自动重启或登录；窗口变化后会重新建立来信基线，主人入口需重新绑定。',primaryLabel:'原账号已恢复，重新定位'};
 if(intent&&['conversation.send','result.deliver','result.attach'].includes(intent.tool)){
  const pending=handling||!!task.state?.recoveryRequestedAt;
  if(task.state?.conversationProgress?.phase==='draft')return {kind:'wechat-send',title:handling?'正在继续原草稿':pending?'等待空闲后继续草稿':'回复停在草稿中',detail:pending?'Bunny 会先核对原来的联系人和完整草稿，再继续发送这一次回复。':'回复已填入输入框，尚未提交。Bunny 可以核对原草稿后继续发送，不会重新输入一份。',primaryLabel:pending?'正在继续…':'核对草稿并发送',working:pending};
  return {kind:'wechat-send',title:handling?'正在核对发送结果':pending?'等待空闲后核对':'发送结果待确认',detail:pending?'Bunny 会核对刚才那一次发送，确认后继续原任务；不会重复发送已提交的消息。':'回复可能已发送，Bunny 已暂停以免重发。点击核对，确认结果后自动继续原任务。',primaryLabel:pending?'正在核对…':'核对并继续',working:pending};
 }
 if(intent)return {kind:'inspect',title:'这一步的结果待确认',detail:'这一步可能已经执行，Bunny 已暂停。请先查看原软件的实际结果；操作详情和已有进展保留在这里。',primaryLabel:'查看操作详情'};
 if(task.skill==='work.delegate')return {kind:'retry',title:'WorkBuddy进度待核对',detail:'原工作会话和已有成果已保留。重新检查执行结果后继续跟进。',primaryLabel:'检查结果并继续'};
 return {kind:'retry',title:task.skill==='task.resolve'?'交办尚未安排成功':'任务暂时中断',detail:'交办和进展已保存。Bunny 可以从当前进度重新检查并继续。',primaryLabel:'重新尝试'};
}
function taskPresentation(task,options={}){
 const contacts=(task.subjects||[]).map(s=>s.recipient||names[s.application]||s.application).join('、'),behavior=task.parameters?.behavior;
 const continuous=['conversation.manage','screen.watch'].includes(task.skill),finished=['completed','stopped','expired'].includes(task.status);
 let title=clean(task.title||task.goal).replace(/^(?:请|麻烦|帮我|请你)\s*/u,'').split(/[。；\n]/u)[0].slice(0,32)||'处理交办';
 if(!task.title){if(task.skill==='conversation.manage')title=(behavior==='inquiry'?'联系':behavior==='owner'?'接收交办 · ':'监看 ')+contacts;else if(task.skill==='screen.watch')title='观察 '+contacts;else if(task.skill==='result.forward')title='转交已有成果';else if(task.skill==='task.resolve')title='安排 · '+title;}
 let statusLabel={queued:'待启动',stopping:'正在停止',ready:'准备执行',running:'正在处理',waiting:'等待下一步',waiting_permission:'等待授权',paused:'已暂停',needs_attention:'需要处理',completed:'已完成',stopped:'已停止',expired:'已结束'}[task.status]||'等待更新';
 if(!finished&&!['queued','stopping','paused','needs_attention','waiting_permission'].includes(task.status)){
  if(task.skill==='task.resolve')statusLabel=task.status==='waiting'&&task.state?.lastFailure?'稍后继续理解':'理解交办中';
  else if(task.state?.result)statusLabel=task.state.delivery?.status==='delivered'?'已交付':'正在交付';
  else if(continuous)statusLabel=task.inbox?.length?'处理新动态':task.skill==='conversation.manage'&&!Object.values(task.state?.conversations||{}).some(c=>c.cursor?.ready)?'建立观察位置':'持续监看';
  else if(task.skill==='work.delegate')statusLabel=task.state?.workPhase==='verifying'?'回收成果':task.state?.job?'WorkBuddy执行中':'正在交办';
 }
 if(task.status==='paused'&&task.skill==='work.delegate'&&task.state?.job)statusLabel='已暂停跟进';
 const guidance=taskGuidance(task,options);if(guidance)statusLabel=guidance.title;
 return {title,statusLabel,continuous,finished,...(guidance?{guidance}:{})};
}
module.exports={taskPresentation,taskGuidance};
