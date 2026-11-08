'use strict';
const {readRecords,snapshotsOf,verifySnapshots}=require('./memory-evidence');
async function enqueue(learning,task,run){
 if(task.scene==='private'||task.visibilityFloor>1||['skill.learn','task.resolve'].includes(task.skill)||task.state.sensitiveContext)return;
 const operations=Object.values(task.operations||{}).filter(op=>!run||op.actionId===run.id).slice(-12);
 const attempts=operations.length?operations.map(op=>({tool:op.tool,...(op.error?{error:String(op.error).slice(0,300)}:{}),
  ...(!op.tool.startsWith('conversation.')&&!['result.deliver','result.attach'].includes(op.tool)?{method:Object.fromEntries(['application','command','args','action','role','label','purpose'].filter(k=>op.args?.[k]!==undefined).map(k=>[k,Array.isArray(op.args[k])?op.args[k].slice(0,12).map(v=>String(v).slice(0,240)):typeof op.args[k]==='string'?op.args[k].slice(0,600):op.args[k]]))}:{}),
  ...(op.status==='confirmed'?{result:{verified:op.result?.verified===true&&op.result?.receipt?.inputPerformed!==true,...(op.result?.exitCode!==undefined?{exitCode:op.result.exitCode}:{}),...(typeof op.result?.stdout==='string'?{stdout:op.result.stdout.slice(-1000)}:{}),...(typeof op.result?.stderr==='string'?{stderr:op.result.stderr.slice(-600)}:{})}}:{})})):run?[]:task.state.attempts||[];
 if(!attempts.some(a=>a.error&&!/授权|空闲|网络|超时|timeout/iu.test(a.error))){
  if(!run&&task.status==='completed'&&attempts.some(a=>a.result?.verified===true)){}
  else {if(!run?.recovery&&!(run?.progress?.reviews>0))return;attempts.unshift({tool:'action.progress',error:'E_NO_PROGRESS: repeated evidence required recovery'});}
 }
 const memory=learning.memory,id='task-experience-queue:'+task.id+(run?':'+run.id:'');
 if((await readRecords(memory,[id])).length)return;
 const input={id,sourceTaskId:task.id,skill:task.skill,status:run?.status==='needs_attention'?'needs_attention':'completed',scene:task.scene,visibilityFloor:task.visibilityFloor,
  goal:String(task.goal||'').slice(0,700),criteria:String(task.criteria||'').slice(0,400),subjects:(task.subjects||[]).map(s=>({application:s.application})),state:{attempts,softwarePackages:task.state.softwarePackages||[],softwareMethods:task.state.softwareMethods||[],experienceReviews:task.state.experienceReviews||[]}};
 if(require('./sensitive-policy').hasProtectedContent(JSON.stringify(input),await memory.sensitiveValues()))return;
 await memory.write([{id,kind:'state',ts:Date.now(),domain:task.scene,visibilityFloor:task.visibilityFloor,
  value:{origin:'task-experience-queue-v1',status:'pending',taskId:task.id,input,sources:[task.id]}}]);return true;
}
async function maintain(learning,mode,{signal,reserveModelCall}={}){
 const memory=learning.memory,generation=memory.generation;
 if(signal?.aborted)return 'paused';
 const queue=(await memory.query('state',1,{scene:null,requiredMarkers:['bunny_task_experience_pending']}))[0];
 if(queue){
  const source=queue.value.input?queue:(await readRecords(memory,[queue.value.taskId]))[0],task=queue.value.input||source?.value;
  if(['completed','needs_attention'].includes(task?.status)&&!task.state?.sensitiveContext&&source?.state==='active'&&
     queue.visibilityFloor<=1&&source.visibilityFloor<=1&&require('./memory-scope').canRead(task.scene,source)){
   const input=JSON.stringify((task.state?.attempts||[]).map(a=>({tool:a.tool,error:a.error||''})));
   const protectedInput=require('./sensitive-policy').hasProtectedContent(input,await memory.sensitiveValues());
   if(!protectedInput){
    if(reserveModelCall&&!(await reserveModelCall(signal)).ok)return 'budget';
    const snapshots=snapshotsOf([source]);
    await learning.extractRecovery(task,{signal,canCommit:async()=>!signal?.aborted&&generation===memory.generation&&(await verifySnapshots(memory,snapshots)).ok});
   }
  }
  if(signal?.aborted||generation!==memory.generation)return 'paused';
  await memory.write([{...queue,value:{...queue.value,status:'processed'},updatedAt:Date.now()}]);return 'continue';
 }
 return 'done';
}
module.exports={enqueue,maintain};
