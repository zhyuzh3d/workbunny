'use strict';
// A local owner's exact-id forensic export. It never lists records, follows
// sources, schedules work, or returns task contents through the control tool.
const fs=require('node:fs/promises'),constants=require('node:fs').constants,path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const MAX_BYTES=2*1024*1024;
const NOTE='当前快照，非逐次历史或未保存的模型请求';
const failure=(code,message)=>Object.assign(Error(message),{code});
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/u.test(id);
const STATUSES=new Set(['queued','ready','running','waiting','waiting_permission','paused','needs_attention','stopping','completed','stopped','expired']);

async function privateDirectory(directory){
 // Reject symbolic ancestors too; a private final component must not hide a
 // redirected parent. The fixed dependency should use a canonical path.
 let current=path.parse(directory).root;
 for(const part of directory.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  let stat;try{stat=await fs.lstat(current);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(stat.isSymbolicLink()||!stat.isDirectory())throw failure('E_TASK_INSPECTION_PATH','任务导出目录不可信');
 }
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const stat=await fs.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||typeof process.getuid!=='function'||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o700)
  throw failure('E_TASK_INSPECTION_PATH','任务导出目录必须由本机用户拥有且权限为0700');
 return {dev:stat.dev,ino:stat.ino};
}

function createTaskInspection({memory,getScene,outputDirectory,clock=Date.now}={}){
 if(!memory||typeof getScene!=='function'||typeof outputDirectory!=='string'||!path.isAbsolute(outputDirectory)||path.normalize(outputDirectory)!==outputDirectory||
    outputDirectory===path.parse(outputDirectory).root||/[\u0000-\u001f\u007f]/u.test(outputDirectory)||typeof clock!=='function')throw TypeError('任务导出依赖不合法');
 return async function inspect(params,{signal}={}){
  if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(key=>key!=='id')||!validId(params.id))throw failure('E_TASK_INSPECTION_PARAMS','任务导出只接受一个明确id');
  const {id}=params,generation=memory.generation;
  const check=()=>{
   if(signal?.aborted)throw failure('E_TASK_INSPECTION_ABORTED','任务导出已取消');
   if(getScene()!=='life')throw failure('E_TASK_INSPECTION_SCENE','任务导出仅允许生活场景');
   if(!memory.ready||!Number.isSafeInteger(generation)||memory.generation!==generation)throw failure('E_TASK_INSPECTION_STALE','任务资料已锁定或代次改变');
  };
  let temporary,artifact,handle,published=false,complete=false;
  try{
   check();
   if(typeof memory.db?.request!=='function'||typeof memory.decode!=='function')throw failure('E_TASK_INSPECTION_UNAVAILABLE','任务资料服务暂不可用');
   let abort;
   const aborted=signal?new Promise((_,reject)=>{abort=()=>reject(failure('E_TASK_INSPECTION_ABORTED','任务导出已取消'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}):null;
   let result;
   try{const read=Promise.resolve().then(()=>{check();return memory.db.request('get',{ids:[id]});});result=await (aborted?Promise.race([read,aborted]):read);}
   finally{if(abort)signal.removeEventListener('abort',abort);}
   check();
   if(!Array.isArray(result?.rows)||result.rows.length!==1||result.rows[0]?.id!==id)throw failure('E_TASK_INSPECTION_NOT_FOUND','指定任务记录不可用');
   const row=result.rows[0];
   if(row.kind!=='task'||row.domain!=='life'||row.visibilityFloor!==1||row.state==='deleted')throw failure('E_TASK_INSPECTION_SCOPE','指定记录不属于本次允许的生活任务');
   // Metadata must pass before any content is decrypted.
   const decoded=memory.decode(row);check();
   const value=decoded?.value;
   if(!value||typeof value!=='object'||Array.isArray(value)||value.id!==id||value.scene!=='life')throw failure('E_TASK_INSPECTION_SCOPE','任务正文身份或场景与允许范围不符');
   let removed=0;
   const task=JSON.parse(JSON.stringify(value,(key,item)=>{
    if(typeof item==='string'&&(/^data:image\/[a-zA-Z0-9.+-]+;base64,/u.test(item)||key==='pngBase64'&&/^iVBORw0KGgo/u.test(item))){removed++;return '[pixel attachment omitted]';}
    return item;
   }));
   const exportedAt=clock();check();
   const record=Object.fromEntries(['id','kind','ts','updatedAt','state','domain','visibilityFloor','ingestionSeq'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
   const bytes=Buffer.from(JSON.stringify({schema:'bunny.task-inspection/v1',exportedAt,record,task,omissions:{pixelAttachmentsRemoved:removed,otherTaskFieldsRemoved:false},note:NOTE})+'\n');
   if(bytes.length>MAX_BYTES)throw failure('E_TASK_INSPECTION_LIMIT','任务快照超过2MiB，未截断正文或导出');
   const directory=await privateDirectory(outputDirectory);check();
   const suffix=randomUUID();temporary=path.join(outputDirectory,'.task-'+suffix+'.tmp');artifact=path.join(outputDirectory,'task-'+id+'-'+suffix+'.json');
   handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);check();
   await handle.writeFile(bytes);check();await handle.sync();check();await handle.close();handle=null;check();
   const actual=await fs.lstat(outputDirectory);
   if(actual.isSymbolicLink()||actual.dev!==directory.dev||actual.ino!==directory.ino||actual.uid!==process.getuid()||(actual.mode&0o777)!==0o700)throw failure('E_TASK_INSPECTION_PATH','任务导出目录在保存时改变');
   check();
   // link publishes a fully written file atomically and refuses an existing
   // destination. A filesystem without this guarantee fails closed.
   await fs.link(temporary,artifact);published=true;check();await fs.unlink(temporary);temporary=null;check();
   const stat=await fs.lstat(artifact);check();
   if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600)throw failure('E_TASK_INSPECTION_PATH','任务快照文件权限不可信');
   const operations=Object.values(value.operations||{}),metadata={kind:'task',domain:'life',visibilityFloor:1,
    ...(STATUSES.has(value.status)?{status:value.status}:{}),
    ...(Number.isSafeInteger(value.createdAt)?{createdAt:value.createdAt}:{}),...(Number.isSafeInteger(row.updatedAt)?{updatedAt:row.updatedAt}:{}),
    actionCount:Object.keys(value.actionRuns||{}).length,operationCount:operations.length,
    unknownWriteCount:operations.filter(op=>op?.effect==='write'&&['intent','uncertain','unknown'].includes(op.status)).length,uncertainEffectCount:operations.filter(op=>require('./operation-ledger').hasUncertainEffect(op)).length,pixelAttachmentsRemoved:removed};
   check();complete=true;
   return {ok:true,id,scene:'life',artifact:{path:artifact,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length},metadata,note:NOTE};
  }catch(error){
   if(/^E_TASK_INSPECTION_[A-Z_]+$/u.test(error?.code||''))throw error;
   throw failure('E_TASK_INSPECTION_UNAVAILABLE','任务快照未能安全导出');
  }finally{
   if(handle)await handle.close().catch(()=>{});
   if(temporary)await fs.unlink(temporary).catch(()=>{});
   if(published&&!complete)await fs.unlink(artifact).catch(()=>{});
  }
 };
}
module.exports={createTaskInspection,privateDirectory};
