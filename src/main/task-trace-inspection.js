'use strict';
const fs=require('node:fs/promises'),constants=require('node:fs').constants,path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {privateDirectory}=require('./task-inspection');
const fail=(code,message)=>Object.assign(Error(message),{code});
function createTaskTraceInspection({getRuntime,getMemory,getScene,outputDirectory}={}){
 if(typeof outputDirectory!=='string'||!path.isAbsolute(outputDirectory)||path.normalize(outputDirectory)!==outputDirectory)throw TypeError('需要固定的任务调度取证目录');
 return async({id,traceIds,limit=20},{signal}={})=>{
  if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/u.test(id)||!Number.isInteger(limit)||limit<1||limit>64||traceIds!==undefined&&(!Array.isArray(traceIds)||!traceIds.length||traceIds.length>64||traceIds.some(t=>typeof t!=='string'||!/^[a-zA-Z0-9_.:-]{1,200}$/u.test(t))))throw fail('E_TASK_TRACE_PARAMS','调度取证参数无效');
  const runtime=getRuntime(),memory=getMemory(),task=runtime?.tasks.get(id),generation=memory?.generation;
  const current=()=>!signal?.aborted&&getScene()==='life'&&memory?.ready&&memory.generation===generation&&getMemory()===memory&&getRuntime()===runtime&&runtime?.tasks.get(id)===task&&task?.id===id&&task.scene==='life'&&task.domain==='life'&&task.visibilityFloor===1;
  const check=()=>{if(!current())throw fail('E_TASK_TRACE_SCOPE','仅允许本次有效生活任务的调度记录');};
  let temporary,artifact,handle,published=false,complete=false;
  try{
   check();const recorder=runtime.modelTrace;if(!recorder?.read)throw fail('E_TASK_TRACE_UNAVAILABLE','原始模型调度记录尚未就绪');
   await recorder.flush?.({timeoutMs:1000});check();
   const result=await recorder.read({taskId:id,...(traceIds?{traceIds}:{}),limit},{authorize:()=>current(),isCurrent:current,scene:'life'});check();
   const bytes=Buffer.from(JSON.stringify({schema:'bunny.task-trace-inspection/v1',taskId:id,exportedAt:Date.now(),...result})+'\n');
   if(bytes.length>16*1024*1024)throw fail('E_TASK_TRACE_LIMIT','调度记录超过16MiB，请减少limit或指定更少traceIds');
   const directory=await privateDirectory(outputDirectory);check();const suffix=randomUUID();temporary=path.join(outputDirectory,'.trace-'+suffix+'.tmp');artifact=path.join(outputDirectory,'trace-'+id+'-'+suffix+'.json');
   handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);check();await handle.writeFile(bytes);check();await handle.sync();check();await handle.close();handle=null;
   const actual=await fs.lstat(outputDirectory);if(actual.isSymbolicLink()||actual.dev!==directory.dev||actual.ino!==directory.ino||actual.uid!==process.getuid()||(actual.mode&0o777)!==0o700)throw fail('E_TASK_TRACE_PATH','调度取证目录已变化');check();
   await fs.link(temporary,artifact);published=true;check();await fs.unlink(temporary);temporary=null;check();complete=true;
   return {ok:true,id,artifact:{path:artifact,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length},traceCount:result.traces?.length||0,gapCount:result.gaps?.length||0,pending:result.pending,omitted:result.omitted};
  }finally{if(handle)await handle.close().catch(()=>{});if(temporary)await fs.unlink(temporary).catch(()=>{});if(published&&!complete)await fs.unlink(artifact).catch(()=>{});}
 };
}
module.exports={createTaskTraceInspection};
