'use strict';
const {fields,text}=require('./agent-contract');
const {actionWindow,contains}=require('./screen-geometry');
const {randomUUID}=require('node:crypto');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
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
function assertAnchorFront(front,anchor){
 const window=front.windows.find(w=>w.windowId===anchor.windowId&&w.pid===anchor.pid);
 if(front.application?.bundleId!==anchor.bundleId||front.application?.pid!==anchor.pid||!window||['x','y','width','height'].some(k=>Math.abs(window.rect[k]-(anchor.windowRect||anchor.rect)[k])>=1))throw Object.assign(Error('目标窗口改变，重新观察定位'),{dispatched:false});
}
function registerScreenActions(tools,{native,wechatScene,lease,canOperate=async()=>true,applications,observe,sensitivePolicy=require('./sensitive-policy').createSensitivePolicy()}){
 const scope=a=>({application:a.application,...(a.recipient?{recipient:a.recipient}:{})});
 tools.register({name:'screen.activate',description:'打开已授权的目标软件并切到前台；微信只激活已运行进程，不启动或登录。随后重新观察。',effect:'read',capabilities:['screen.input'],scope,
 validate:v=>{fields(v,['application'],'激活应用');if(!applications[v.application])throw Error('没有该软件适配');return v;},
 execute:async(a,c)=>{if(!await canOperate(c.task))throw Object.assign(Error('等待电脑空闲后切换'),{code:'E_GUI_BUSY',dispatched:false});if(a.application==='wechat')await wechatScene.assertHealthy();const owner=leaseOwner(c);await lease?.acquire(owner,c.signal);try{const result=await native.request('activate',{bundleId:applications[a.application],requireRunning:a.application==='wechat'},8000);await pause(700);return result;}finally{lease?.release(owner);}}
 });
 tools.register({name:'screen.action',description:'执行一个Operation。Bunny可选择observeAfter=true在同次调用带回新画面；无需中间检查时省略或false，由Bunny按Action需要决定。文字优先提供实际OCR标签label；OCR遗漏或错读时，可给实际可见label、targetType=text和预览图pixelX/pixelY进行视觉定位。无文字目标用targetType=icon/region及像素坐标，右键和滚动也用像素坐标。Task与Action完成须自主核查，Operation不必逐次检查；微信正文统一用conversation.send。',effect:'write',capabilities:['screen.input'],scope,
 validate:v=>{fields(v,['application','recipient','frameId','action','pixelX','pixelY','text','key','modifiers','deltaY','purpose','button','label','targetType','observeAfter'],'屏幕动作');if(v.observeAfter!==undefined&&typeof v.observeAfter!=='boolean')throw Error('observeAfter须为布尔值');if(!applications[v.application]||!['click','type','key','scroll'].includes(v.action)||v.button!==undefined&&!['left','right'].includes(v.button)||v.targetType!==undefined&&!['text','icon','region'].includes(v.targetType))throw Error('屏幕动作无效');text(v.frameId,'当前画面ID',160);
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
 execute:async(a,c)=>{
  if(a.action==='type'&&['wechat','workbuddy'].includes(a.application))await sensitivePolicy.check({target:a.application,recipient:a.recipient,text:a.text,ownership:'unknown'});
  const anchor=c.task.state.screenAnchors?.[a.application];if(!anchor||anchor.frameId!==a.frameId||Date.now()-anchor.at>30000)throw Object.assign(Error('画面定位失效，先重新观察'),{dispatched:false});
  if(!await canOperate(c.task))throw Object.assign(Error('等待电脑空闲后操作'),{code:'E_GUI_BUSY',dispatched:false});
  if(a.application==='wechat')await wechatScene.assertTaskIdentity(c.task);
  const owner=leaseOwner(c);await lease?.acquire(owner,c.signal);
  let inputStarted=false;
  try{
   if(c.signal?.aborted)throw Object.assign(Error('任务已暂停'),{dispatched:false});const front=await native.request('frontmost');assertAnchorFront(front,anchor);
   const payload={expected:{bundleId:anchor.bundleId,pid:anchor.pid},windowId:anchor.windowId};
   let frameRows;
   if(a.application==='wechat'){
    const frame=await native.request('capture',{captureMode:'displayStream',region:anchor.rect},12000);frameRows=(await native.request('recognize',{pngBase64:frame.pngBase64},10000)).texts||[];const error=require('./wechat-auth-state').wechatAuthError(frameRows);
    if(error){await wechatScene.trip?.(error.message);throw error;}
   }
   if(a.application==='wechat'&&a.purpose==='file-dialog'){
    const destinations=c.task.state.fileDestinations||[];if(!destinations.length)throw Object.assign(Error('先用 files.destination 创建本任务的接收位置'),{dispatched:false});
    const kind=fileDialogKind(frameRows);
    if(!kind)throw Object.assign(Error('画面不是可确认的文件保存或前往文件夹对话框，先重新观察'),{dispatched:false});
    if(a.action==='type'&&(kind!=='folder'||!destinations.some(d=>d.directory===a.text)))throw Object.assign(Error('只在前往文件夹对话框输入本任务准备的接收目录'),{dispatched:false});
    for(const d of destinations){const entries=await require('node:fs/promises').readdir(d.directory);if(entries.some(name=>name!=='.DS_Store'))throw Object.assign(Error('接收目录已有文件，先读取核对，不覆盖'),{dispatched:false});}
   }
   if(['click','scroll'].includes(a.action)){
    let location={x:a.pixelX/anchor.previewWidth,y:a.pixelY/anchor.previewHeight},rows=[];if(!a.label&&(!Number.isFinite(location.x)||!Number.isFinite(location.y)||location.x<0||location.x>=1||location.y<0||location.y>=1))throw Object.assign(Error('像素坐标超出当前预览图，重新观察'),{dispatched:false});
    if(a.action==='click'&&a.button!=='right'){
     if(frameRows)rows=frameRows;else{const frame=await native.request('capture',{captureMode:'displayStream',region:anchor.rect},12000);rows=(await native.request('recognize',{pngBase64:frame.pngBase64},10000)).texts||[];}
     if(a.label){
      try{location=labelTarget(a.label,rows);}
      catch(error){
       // The planner has the actual current screenshot. A missing OCR token
       // is not a prohibition on acting on a clearly visible text control.
       if(a.targetType!=='text'||rows.some(r=>labelKey(r.text)===labelKey(a.label))||![location.x,location.y].every(n=>Number.isFinite(n)&&n>=0&&n<1))throw error;
      }
     }
     if(rows.some(r=>r.confidence>=.25&&/^(?:是否|确认)?(?:删除|清空|替换|覆盖).*[?？]$/u.test(String(r.text).trim()))&&labelKey(a.label)!=='取消'&&labelKey(a.label)!=='cancel')throw Object.assign(Error('当前是破坏性确认窗口，只允许取消并重新观察'),{dispatched:false});
     if(rows.some(r=>r.confidence>=.25&&destructiveLabel(r.text)&&Math.abs(location.x-(r.x+r.width/2))*anchor.rect.width<55&&Math.abs(location.y-(r.y+r.height/2))*anchor.rect.height<20))throw Object.assign(Error('该位置是破坏性或资金控件，未点击；请重新定位目标'),{dispatched:false});
    }
    const point={x:anchor.rect.x+location.x*anchor.rect.width,y:anchor.rect.y+location.y*anchor.rect.height},target=actionWindow(anchor,front.windows,point);payload.x=point.x;payload.y=point.y;payload.windowId=target.windowId;
    const root=anchor.windowRect||anchor.rect;if(a.application==='wechat'&&a.action==='click'&&a.button!=='right'&&a.purpose!=='file-dialog'&&target.windowId===anchor.windowId&&contains(root,point)&&(point.x-root.x)/root.width>.5&&(point.y-root.y)/root.height>.8)throw Object.assign(Error('微信发送区改用对应会话工具'),{dispatched:false});
    if(a.application==='wechat'&&a.action==='click'&&a.button!=='right'&&target.windowId===anchor.windowId&&(point.x-root.x)/root.width<.09&&(point.y-root.y)/root.height<.04)throw Object.assign(Error('保留微信主窗口，不点击关闭区域'),{dispatched:false});
   }
   for(const key of ['text','key','modifiers','deltaY','button'])if(a[key]!==undefined)payload[key]=a[key];
   const current=await native.request('frontmost');assertAnchorFront(current,anchor);
   if(['click','scroll'].includes(a.action))actionWindow(anchor,current.windows,{x:payload.x,y:payload.y});
   if(c.signal?.aborted)throw Object.assign(Error('任务已暂停'),{dispatched:false});
   inputStarted=true;const result=await native.request(a.action,payload,8000);delete c.task.state.screenAnchors[a.application];
   const response={ok:result.performed===true,verified:result.performed===true,receipt:{inputPerformed:true,application:a.application,frameId:a.frameId,...(a.label?{targetLabel:a.label}:{}),point:result.point,at:Date.now(),businessResult:'输入已发出，业务结果待自主判断'}};
   // Return the actual resulting scene in the same tool lifecycle. The next
   // semantic decision can advance immediately instead of spending a model
   // turn merely requesting another observation.
   if(a.observeAfter===true&&observe&&result.performed===true&&!c.signal?.aborted){
    try{await pause(160);response.observation=await observe({application:a.application,force:true},c);}
    catch(error){response.observationError={code:error.code||'E_OBSERVATION',message:error.message};}
   }
   return response;
  }catch(error){if(!inputStarted)error.dispatched=false;throw error;}finally{lease?.release(owner);}
 }
 });
}
module.exports={registerScreenActions,fileDialogKind,labelTarget,destructiveLabel};
