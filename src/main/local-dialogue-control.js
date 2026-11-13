'use strict';
const {randomUUID}=require('node:crypto');
const fail=(code,message)=>Object.assign(Error(message),{code});
// Receipts cover only messages submitted through this interface in this
// process/scope. This is not a reader for stored conversation history.
function createLocalDialogueControl({getScene,getScope,isReady,submit,clock=Date.now}={}){
 const receipts=new Map();
 const scope=signal=>{
  if(signal?.aborted)throw fail('E_LOCAL_CANCELLED','文字消息提交已取消');
  if(getScene()!=='life')throw fail('E_LOCAL_SCENE','文字消息开发接口仅允许生活场景');
  if(!isReady())throw fail('E_LOCAL_UNAVAILABLE','对话资料尚未就绪');
  return getScope();
 };
 const prune=()=>{const now=clock();for(const [id,r]of receipts)if(r.scope!==getScope()||now-r.createdAt>3600000)receipts.delete(id);};
 const view=r=>({ok:true,id:r.id,status:r.status,createdAt:r.createdAt,...(r.completedAt?{completedAt:r.completedAt}:{}),...(r.reply?{reply:r.reply}:{}),...(r.taskId?{taskId:r.taskId}:{}),...(r.performance?{performance:r.performance}:{}),...(r.avatar?{avatar:r.avatar}:{}),...(r.error?{error:r.error}:{})});
 return {
  async send({text,requestId},{signal}={}){
   const currentScope=scope(signal);prune();
   if(typeof text!=='string'||!text.trim()||text.length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))throw fail('E_LOCAL_PARAMS','需要1至12000字的明确文字');
   if(requestId!==undefined&&(typeof requestId!=='string'||!/^[a-zA-Z0-9_.:-]{1,80}$/u.test(requestId)))throw fail('E_LOCAL_PARAMS','requestId格式无效');
   const id=requestId||randomUUID(),previous=receipts.get(id);
   if(previous){if(previous.text!==text.trim())throw fail('E_LOCAL_PARAMS','同一requestId不能提交不同文字');return view(previous);}
   // Do not evict pending receipts: a timed-out caller can still check whether
   // its accepted message ran, rather than replaying it blindly.
   if(receipts.size>=64){const done=[...receipts.values()].find(r=>r.status!=='pending');if(done)receipts.delete(done.id);else throw fail('E_LOCAL_BUSY','待处理文字消息已满，请先查看已有回执');}
   const record={id,text:text.trim(),scope:currentScope,status:'pending',createdAt:clock()};receipts.set(id,record);
   try{
    const accepted=await submit(record.text,{onComplete:completion=>{
     Promise.resolve(completion).then(result=>{
      if(getScope()!==currentScope||getScene()!=='life'||!isReady()){receipts.delete(id);return;}
      record.status=result?'completed':'interrupted';record.completedAt=clock();
      if(typeof result?.text==='string')record.reply=result.text;
      if(typeof result?.actionReceipt?.taskId==='string')record.taskId=result.actionReceipt.taskId;
      if(result?.performanceReceipt)record.performance=structuredClone(result.performanceReceipt);
      if(result?.actionReceipt?.avatar)record.avatar=structuredClone(result.actionReceipt.avatar);
     },()=>{record.status='failed';record.completedAt=clock();record.error='本轮对话处理失败，请检查状态，不自动重发。';});
    }});
    if(accepted?.ok!==true){record.status='rejected';record.completedAt=clock();record.error=String(accepted?.error||'文字消息未接纳');}
    if(scope()!==currentScope){receipts.delete(id);throw fail('E_LOCAL_STALE','场景或资料已变化，请核对提交状态，不自动重发');}
    return view(record);
   }catch(error){record.status='failed';record.completedAt=clock();throw error;}
  },
  status({id},{signal}={}){scope(signal);prune();const record=receipts.get(id);if(!record)throw fail('E_LOCAL_RECEIPT','本次运行与当前场景中没有这条文字消息回执');return view(record);},
 };
}
module.exports={createLocalDialogueControl};
