'use strict';
const {fields,text}=require('./agent-contract');
const {randomUUID}=require('node:crypto');
const leaseOwner=c=>'agent-primitive:'+c.task.id+':'+(c.operationId||randomUUID());
const labelKey=value=>String(value||'').normalize('NFKC').replace(/\s/gu,'').replace(/^[•·●○◦▪▸►]+/u,'').replace(/[.⋯…]+$/gu,'').toLowerCase();
const destructiveLabel=value=>/^(?:删除|删除该消息|清空|全部删除|替换|覆盖|退出微信|退出登录|支付|付款|转账|确认付款|delete|deleteall|replace|overwrite|erase|pay|transfer|logout|quitwechat)$/iu.test(labelKey(value));
function labelTarget(label,rows){
 const matches=rows.filter(r=>r.confidence>=.25&&labelKey(r.text)===labelKey(label)),unique=matches.filter((r,i)=>matches.findIndex(o=>Math.abs(o.x-r.x)<.015&&Math.abs(o.y-r.y)<.015)===i);
 if(unique.length!==1)throw Object.assign(Error('没有唯一可见的“'+label+'”，先重新观察'),{dispatched:false});const r=unique[0];return {x:r.x+r.width/2,y:r.y+r.height/2};
}
function fileDialogKind(rows){
 const labels=rows.filter(r=>r.confidence>=.6).map(r=>String(r.text).normalize('NFKC').replace(/\s/gu,''));
 const cancel=labels.some(s=>/^(?:取消|Cancel)$/iu.test(s));
 if(cancel&&labels.some(s=>/^(?:前往文件夹[:：]?|Gotofolder[:：]?)$/iu.test(s)))return 'folder';
 if(cancel&&labels.some(s=>/^(?:保存|存储|Save)$/iu.test(s))&&labels.some(s=>/^(?:存储为[:：]?|另存为[:：]?|SaveAs[:：]?|文件名[:：]?)$/iu.test(s)))return 'save';
 return null;
}
function registerScreenActions(tools,{native,wechatScene,lease,canOperate=async()=>true,applications,resolveApplication=(application)=>applications[application],observe,visualFor,assertWeChatInput=()=>{},sensitivePolicy=require('./sensitive-policy').createSensitivePolicy()}){
 const scope=a=>({application:a.application,...(a.recipient?{recipient:a.recipient}:{})});
 tools.register({name:'screen.activate',description:'只按当前截图与视觉模型识别的唯一安全区域点击激活目标，再以新截图核对；不查询或启动应用，不查询前台或窗口。目标不可见或安全区域不明则停止。先前激活后未能核实结果时默认只观察；自主重新选择激活可显式retry=true，仍须本次新鲜同身份画面确认未激活及安全区域，每个新Operation只重选一次，不能越过需要主人处理的安全/登录提示。',effect:'write',capabilities:['screen.input'],scope,continuationPolicy:(task,input)=>require('./effect-review').boundedPolicy(task,input),available:task=>task.subjects.some(s=>!['system','bunny'].includes(s.application)),validate:v=>{fields(v,['application','retry'],'视觉软件目标');if(typeof v.application!=='string'||!v.application||v.retry!==undefined&&typeof v.retry!=='boolean')throw Error('缺少目标软件或retry无效');return v;},execute:async(a,c)=>{
  if(!await canOperate(c.task))throw Object.assign(Error('等待电脑空闲后操作'),{code:'E_GUI_BUSY',dispatched:false});
  const owner=leaseOwner(c);await lease?.acquire(owner,c.signal);try{const {frame,...response}=await visualFor(a.application).activate({signal:c.signal,retry:a.retry===true,retryKey:c.operationId});return response;
  }finally{lease?.release(owner);}
 }});
 tools.register({name:'screen.action',description:'执行一个Operation。Bunny可选择observeAfter=true在同次调用带回新画面；无需中间检查时省略或false，由Bunny按Action需要决定。文字提供实际视觉标签label；无文字目标用targetType=icon/region及预览图像素坐标，右键和滚动也用像素坐标。Task与Action完成须自主核查，Operation不必逐次检查；受控会话正文使用对应收发工具。',effect:'write',capabilities:['screen.input'],scope,continuationPolicy:(task,input)=>require('./effect-review').boundedPolicy(task,input),
 validate:v=>{fields(v,['application','recipient','frameId','action','pixelX','pixelY','text','key','modifiers','deltaY','purpose','button','label','targetType','observeAfter'],'屏幕动作');if(v.observeAfter!==undefined&&typeof v.observeAfter!=='boolean')throw Error('observeAfter须为布尔值');if(typeof v.application!=='string'||!v.application||!['click','type','key','scroll'].includes(v.action)||v.button!==undefined&&!['left','right'].includes(v.button)||v.targetType!==undefined&&!['text','icon','region'].includes(v.targetType))throw Error('屏幕动作无效');text(v.frameId,'当前画面ID',160);
  if(v.label!==undefined){text(v.label,'可见文字标签',160);if(destructiveLabel(v.label))throw Error('此动作工具仅用于非破坏性操作，不能点击该控件');}
  if(v.action==='click'&&v.button!=='right'&&!v.label&&!['icon','region'].includes(v.targetType))throw Error('文字按钮或菜单必须提供label；仅无文字图标或空白区域使用targetType及坐标');
  if((v.action==='scroll'||v.action==='click'&&(v.button==='right'||!v.label))&&(![v.pixelX,v.pixelY].every(n=>Number.isInteger(n)&&n>=0&&n<32768)))throw Error('需要预览图中的整数pixelX/pixelY像素坐标，不进行归一化');
  if(v.targetType==='text'&&(!v.label||![v.pixelX,v.pixelY].every(n=>Number.isInteger(n)&&n>=0&&n<32768)))throw Error('文字的视觉定位需要实际可见label与预览图像素坐标');
  if(v.action==='type')text(v.text,'输入文字',3500);if(v.action==='key'){text(v.key,'按键',30);if(!Array.isArray(v.modifiers)||v.modifiers.some(m=>!['cmd','shift','alt','ctrl'].includes(m)))throw Error('修饰键无效');}
  if(v.action==='scroll'&&(!Number.isFinite(v.deltaY)||Math.abs(v.deltaY)>2000))throw Error('滚动范围无效');
  if(v.application==='wechat'){
   if(v.action==='click'&&v.label&&/^(?:发送|send)$/iu.test(labelKey(v.label)))throw Error('微信发送统一使用conversation.send');
   const dialog=v.purpose==='file-dialog';
   if(v.action==='type'&&!dialog&&(!v.recipient||v.text!==v.recipient||v.purpose!=='navigation'))throw Error('微信正文请用conversation.send，本动作只搜索指定联系人');
   if(v.action==='key'&&((v.modifiers.includes('cmd')&&['q','w'].includes(v.key.toLowerCase()))||!dialog&&['enter','return'].includes(v.key.toLowerCase())))throw Error('微信此处禁止关闭或直接发送，改用对应会话工具');

  }return v;},
 available:task=>task.skill!=='conversation.manage'&&task.subjects.some(s=>!['system','bunny'].includes(s.application)&&resolveApplication(s.application,task)),
 execute:async(a,c)=>{
  if(c.task.skill==='conversation.manage')throw Object.assign(Error('会话请使用对应收发操作'),{dispatched:false});
  const anchor=c.task.state.screenAnchors?.[a.application];if(!anchor||anchor.mode!=='visual'||anchor.frameId!==a.frameId||Date.now()-anchor.at>30000)throw Object.assign(Error('视觉帧失效，先重新观察'),{dispatched:false});
  if(!await canOperate(c.task))throw Object.assign(Error('等待电脑空闲后操作'),{code:'E_GUI_BUSY',dispatched:false});
  const visual=visualFor(a.application);if(visual.identity().sessionId!==anchor.sessionId)throw Object.assign(Error('视觉身份已变化'),{dispatched:false});
  const owner=leaseOwner(c);await lease?.acquire(owner,c.signal);let inputStarted=false;
  try{
   if(c.signal?.aborted)throw Object.assign(Error('任务已暂停'),{dispatched:false});
   const review=require('./effect-review'),executionContext=review.visualContext(c.task,a,{policy:tools.get('screen.action').continuationPolicy,signal:c.signal}),perceptionFeedback={};
   let location={x:a.pixelX/anchor.previewWidth,y:a.pixelY/anchor.previewHeight};
   if(a.label)try{location=labelTarget(a.label,anchor.ocr||[]);}catch(error){
    if(a.targetType!=='text'||(anchor.ocr||[]).some(r=>labelKey(r.text)===labelKey(a.label))||![location.x,location.y].every(n=>Number.isFinite(n)&&n>=0&&n<1))throw error;
    if(review.checkVisualContext(executionContext))perceptionFeedback.labelUnconfirmed=true;
    else{const proof=await visual.judge(anchor.visualFrameId,{question:'给定截图位置是否为实际可见且唯一的指定文字控件？不能把期望文字当成截图内容；错误、遮挡或不唯一时不匹配。',evidence:{label:a.label,point:location}},{signal:c.signal});if(!proof.matched)throw Object.assign(Error('文字目标尚未视觉确认：'+proof.evidence),{code:'E_VISUAL_TARGET',dispatched:false});}
   }
   const payload={action:a.action};for(const k of ['text','key','modifiers','deltaY','button'])if(a[k]!==undefined)payload[k]=a[k];
   if(['click','scroll'].includes(a.action)){
    if(![location.x,location.y].every(n=>Number.isFinite(n)&&n>=0&&n<1))throw Object.assign(Error('坐标不在视觉预览内'),{dispatched:false});
    payload.x=anchor.rect.x+location.x*anchor.rect.width;payload.y=anchor.rect.y+location.y*anchor.rect.height;
    if((anchor.ocr||[]).some(r=>r.confidence>=.25&&destructiveLabel(r.text)&&Math.abs(location.x-(r.x+r.width/2))*anchor.rect.width<55&&Math.abs(location.y-(r.y+r.height/2))*anchor.rect.height<20))throw Object.assign(Error('此处是破坏性或资金控件，未点击'),{dispatched:false});
   }
   if(a.action==='click'&&a.button!=='right'&&(anchor.ocr||[]).some(r=>r.confidence>=.25&&/^(?:是否|确认)?(?:删除|清空|替换|覆盖).*[?？]$/u.test(String(r.text).trim()))&&!['取消','cancel'].includes(labelKey(a.label)))throw Object.assign(Error('破坏性确认界面只允许取消并重新观察'),{dispatched:false});
   if(a.application==='wechat'){
    const error=require('./wechat-auth-state').wechatAuthError(anchor.ocr||[]);if(error){await wechatScene.trip(error.message);throw error;}
    if(a.action==='key'&&a.modifiers.includes('cmd')&&['v','c','x'].includes(a.key.toLowerCase()))throw Object.assign(Error('禁止剪贴板方式操作该软件'),{dispatched:false});
    if(a.purpose==='file-dialog'){
     const destinations=c.task.state.fileDestinations||[],kind=fileDialogKind(anchor.ocr||[]);
     if(!kind||!destinations.length||a.action==='type'&&(kind!=='folder'||!destinations.some(d=>d.directory===a.text)))throw Object.assign(Error('保存界面或本任务目标目录尚未视觉核实'),{dispatched:false});
     for(const d of destinations){const entries=await require('node:fs/promises').readdir(d.directory);if(entries.some(name=>name!=='.DS_Store'))throw Object.assign(Error('接收目录已有文件，先读取核对，不覆盖'),{dispatched:false});}
    }
    if(a.action==='click'&&a.button!=='right'){
     const r=anchor.mainRegion||{x:0,y:0,width:1,height:1},x=(location.x-r.x)/r.width,y=(location.y-r.y)/r.height;
     if(x>=0&&x<1&&y>=0&&y<1){if(a.purpose!=='file-dialog'&&x>.5&&y>.8)throw Object.assign(Error('微信发送区改用对应会话工具'),{dispatched:false});if(x<.09&&y<.04)throw Object.assign(Error('保留微信主界面，不点击关闭区域'),{dispatched:false});}
    }
    assertWeChatInput(c.task,anchor);
   }
   if(a.action==='type'&&['wechat','workbuddy'].includes(a.application))await sensitivePolicy.check({target:a.application,recipient:a.recipient,text:a.text,ownership:'unknown'});
   if(c.signal?.aborted)throw Object.assign(Error('任务已暂停'),{dispatched:false});
   inputStarted=true;const result=await visual.input(anchor.visualFrameId,payload,{signal:c.signal,executionContext});
   // A successful input does not consume all usable visual evidence. Known
   // operations may continue with the same frame; VisualSession still checks
   // current identity, geometry, target and focus before each native input.
   // A changed target fails that guard and requires a new observation.
   if(result.performed!==true)delete c.task.state.screenAnchors[a.application];
   require('./software-tools').remember(c.task,{application:a.application,channel:'visual',operation:a.action,operationId:c.operationId,outcome:result.performed===true?'input-dispatched':'unconfirmed'});
   const response={ok:result.performed===true,verified:result.performed===true,receipt:{inputPerformed:result.performed===true,application:a.application,frameId:a.frameId,method:'display-pixels',at:Date.now(),businessResult:'输入已发出，业务结果待自主判断'},visualFeedback:{...result.visualFeedback,...perceptionFeedback}};
   if(a.observeAfter===true&&observe&&!c.signal?.aborted){try{await require('./action-progress').pauseFor(160,c.signal);response.observation=await observe({application:a.application,force:true},c);}catch(error){response.observationError={code:error.code||'E_OBSERVATION',message:error.message};}}
   return response;
  }catch(error){if(inputStarted)delete c.task.state.screenAnchors[a.application];else error.dispatched=false;throw error;}finally{lease?.release(owner);}
 }
 });
}
module.exports={registerScreenActions,fileDialogKind,labelTarget,destructiveLabel};
