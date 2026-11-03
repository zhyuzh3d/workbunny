'use strict';
// Voice conversion uses only the external display and guarded GUI input.
const {applicationScene,actionWindow,same}=require('./screen-geometry');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const BUNDLE='com.tencent.xinWeChat';
async function transcribeVoice({scene,lease,canOperate,subject,task,signal,requested=false,sequence}){
  const native=scene.native,owner='agent-voice:'+task.id;
  if(!await canOperate(task))return {pending:true,reason:'等待电脑空闲后识别语音'};
  await lease?.acquire(owner,signal);
  try{
    if(signal?.aborted)throw Error('任务已暂停');
    await scene.assertTaskIdentity(task);
    const original=await scene.assertHealthy(),before=await native.request('frontmost');
    if(before.application?.bundleId!==BUNDLE||before.application?.pid!==original.pid){
      const idle=await native.request('inputIdle',{},5000);
      if(!Number.isFinite(idle.hidIdleMs)||idle.hidIdleMs<500)return {pending:true,reason:'主人正在操作，稍后识别语音'};
      await native.request('activate',{bundleId:BUNDLE,requireRunning:true},8000);await pause(700);scene.invalidate();
    }
    const view=await scene.observe(subject,{force:true,repairProfile:task.state?.selfRepair?.profile});
    if(!view.headerMatched||view.unstable||view.latestPending)return {pending:true,reason:'等待核对指定会话的最新消息'};
    // Match the queued sequence to its position in the verified visual
    // baseline. This preserves order even for several identical voice bubbles.
    const state=task.state?.conversations?.[require('./conversation-skill').subjectKey(subject)];
    if(!state?.cursor?.ready)return {pending:true,reason:'等待会话基线'};
    const voice=require('./conversation-cursor').locateObserved(state.cursor,view.messages||[],sequence);
    if(!voice||voice.kind!=='voice'||voice.direction!=='incoming'||!voice.voiceVerified||!voice.voiceCenter)return {pending:true,reason:'正在重新定位对方语音'};
    if(voice.voiceText)return {text:voice.voiceText,verified:true};
    if(requested)return {pending:true,reason:'等待微信语音转文字完成'};
    const window=await scene.assertHealthy();
    let front=await native.request('frontmost');
    if(front.application?.bundleId!==BUNDLE||front.application?.pid!==window.pid)return {pending:true,reason:'等待微信窗口处于前台'};
    const idle=await native.request('inputIdle',{},5000);
    if(!Number.isFinite(idle.hidIdleMs)||idle.hidIdleMs<500)return {pending:true,reason:'主人正在操作，稍后识别语音'};
    const x=window.rect.x+voice.voiceCenter.x*window.rect.width,y=window.rect.y+voice.voiceCenter.y*window.rect.height;
    if(signal?.aborted)throw Error('任务已暂停');
    await native.request('click',{expected:{bundleId:BUNDLE,pid:window.pid},windowId:window.windowId,x,y,button:'right'},8000);
    await pause(500);
    front=await native.request('frontmost');
    const current=front.windows.find(w=>w.windowId===window.windowId&&w.pid===window.pid);
    if(front.application?.bundleId!==BUNDLE||!current||!same(current.rect,window.rect))return {pending:true,reason:'微信窗口已变化，重新定位语音'};
    const menu=applicationScene(current,front.windows),frame=await native.request('capture',{captureMode:'displayStream',region:menu.rect,relocate:true},12000);
    const rows=(await native.request('recognize',{pngBase64:frame.pngBase64},10000)).texts||[];
    const matches=rows.filter(r=>r.confidence>=.5&&/^(?:转文字|转换为文字|转换成文字|Convert to Text|Transcribe)$/iu.test(String(r.text).trim()));
    if(matches.length!==1)return {pending:true,reason:'未找到唯一的语音转文字菜单'};
    const row=matches[0],point={x:menu.rect.x+(row.x+row.width/2)*menu.rect.width,y:menu.rect.y+(row.y+row.height/2)*menu.rect.height};
    const anchor={windowId:window.windowId,pid:window.pid,bundleId:BUNDLE,rect:menu.rect,windowRect:window.rect,sceneWindows:menu.windows.map(w=>({windowId:w.windowId,rect:w.rect}))};
    const fresh=await native.request('frontmost');
    if(fresh.application?.bundleId!==BUNDLE||fresh.application?.pid!==window.pid) return {pending:true,reason:'微信已失焦，稍后重新识别'};
    const target=actionWindow(anchor,fresh.windows,point);
    if(signal?.aborted)throw Error('任务已暂停');
    await native.request('click',{expected:{bundleId:BUNDLE,pid:window.pid},windowId:target.windowId,...point},8000);
    await pause(500);scene.invalidate();
    return {requested:true,pending:true,reason:'已请求微信转文字，等待识别结果'};
  }finally{lease?.release(owner);}
}
module.exports={transcribeVoice};
