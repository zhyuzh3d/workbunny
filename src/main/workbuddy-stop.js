'use strict';
const bundleId='com.tencent.workbuddy.mac';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Cancellation uses the same GUI lease as all other software actions. The
// monitor identifies the round; the visible conversation authorizes the click.
class WorkBuddyStopper{
 constructor({native,lease,lookup,confirmed,wait=delay,timeoutMs=20000}){Object.assign(this,{native,lease,lookup,confirmed,wait,timeoutMs});this.pending=new Map();}
 stop(target,options={}){
  const key=target.sessionId+'#'+target.taskId;
  if(this.pending.has(key))return this.pending.get(key);
  const work=this.perform(target,options).finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;
 }
 async perform(target,{signal}={}){
  const read=()=>{const snap=this.lookup(target);if(!snap||!snap.task||target.taskId&&snap.task.id!==target.taskId||target.messageKey&&snap.task.messageKey!==target.messageKey||target.bunnyTaskId&&snap.task.bunnyTaskId!==target.bunnyTaskId)throw Error('原工作轮次已经变化，未停止其他任务');return snap;};
  let snap=read();if(snap.task.status!=='running')return {ok:true,verified:true,alreadyEnded:true};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs),owner='workbuddy-stop:'+target.sessionId;
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  let cancelNative;
  const expired=()=>{if(controller.signal.aborted)throw Error('外部清理超时；Bunny 已停止，错误已记录，不再尝试');};
  const request=async(...args)=>{expired();let abort;const cancelled=new Promise((_,reject)=>{abort=()=>{cancelNative=Promise.resolve(this.native.cancel?.()).catch(()=>{});reject(Error('外部清理超时；Bunny 已停止，错误已记录，不再尝试'));};controller.signal.addEventListener('abort',abort,{once:true});});try{const result=await Promise.race([this.native.request(...args),cancelled]);expired();return result;}finally{controller.signal.removeEventListener('abort',abort);}};
  const wait=async ms=>{expired();await this.wait(ms);expired();};
  let held=false;
  try{
   await this.lease.acquire(owner,controller.signal);held=true;snap=read();if(snap.task.status!=='running')return {ok:true,verified:true,alreadyEnded:true};
   expired();const front=await request('frontmost',{},5000),window=front.windows?.find(w=>w.bundleId===bundleId&&w.layer===0&&w.rect?.width>100);
   if(!window)throw Error('未找到 WorkBuddy 真实窗口');
   const scope={expected:{bundleId,pid:window.pid},windowId:window.windowId};
   const marker=snap.task.bunnyTaskId?'[workbunny:'+snap.task.bunnyTaskId+']':undefined;
   const evidence=String(snap.task.userText||'').trim().slice(0,200),payload={...scope,...(marker?{marker}:{evidence,conversationTitle:snap.sessionTitle||snap.task.title})};
   let view=await request('workbuddyStop',{...payload,inspect:true},8000);
   if(!view.matched){
    if(!snap.sessionTitle)throw Error('原会话尚无可识别标题，停止未确认');
    await request('activate',{bundleId,requireRunning:true},8000);await wait(500);
    await request('workbuddyNavigate',{...scope,operation:'selectConversation',name:snap.sessionTitle},8000);await wait(500);
    view=await request('workbuddyStop',{...payload,inspect:true},8000);
   }
   read();if(!view.matched)throw Error('未能核对原工作会话');
   if(view.stopCount!==1)throw Error('没有找到唯一的 WorkBuddy 停止按钮');
   await request('workbuddyStop',payload,8000);
   for(let i=0;i<12;i++){
    await wait(500);const current=read();if(current.task.status!=='running')return {ok:true,verified:true};
    const after=await request('workbuddyStop',{...payload,inspect:true},8000);
    if(after.matched&&after.stopCount===0){await this.confirmed(target);return {ok:true,verified:true,stoppedAt:Date.now()};}
   }
   throw Error('已点击停止，尚未观察到 WorkBuddy 停止，保留状态等待核对');
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);await cancelNative;if(held)this.lease.release(owner);}
 }
}
module.exports={WorkBuddyStopper};
