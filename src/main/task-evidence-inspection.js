'use strict';
// Exact-task, retained-evidence crop export. No capture, task execution, source
// traversal, key lookup or target-application interface is available here.
const fs=require('node:fs/promises'),constants=require('node:fs').constants,path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {privateDirectory}=require('./task-inspection');
const diagnostics=require('./operation-diagnostics');
const failure=(code,message)=>Object.assign(Error(message),{code});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,REF=/^[a-f0-9]{32}$/u;
function validateEvidenceParams(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['id','session','incidentId','captureId','region'].includes(k))||typeof p.id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/u.test(p.id)||!UUID.test(p.session||'')||!REF.test(p.incidentId||'')||!REF.test(p.captureId||''))throw failure('E_TASK_EVIDENCE_PARAMS','需要明确Task、session、incidentId、captureId及局部像素region');
 const r=p.region;if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==4||Object.keys(r).some(k=>!['x','y','width','height'].includes(k))||!['x','y','width','height'].every(k=>Number.isSafeInteger(r[k]))||r.x<0||r.y<0||r.width<1||r.height<1||r.width>8192||r.height>8192||!((r.width<=512&&r.height<=512)||(Math.min(r.width,r.height)<=128&&r.width*r.height<=200000)))throw failure('E_TASK_EVIDENCE_REGION','必须明确小区域：至多512×512，或宽度/高度不超过128且总面积不超过200000的窄条');
 return p;
}
function pngSize(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.subarray(12,16).toString()!=='IHDR')throw failure('E_TASK_EVIDENCE_IMAGE','留存像素不是有效PNG');
 return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}
function createTaskEvidenceInspection({memory,getScene,outputDirectory,operationDiagnostics,imageCrop,readTimeline=diagnostics.readTimeline,clock=Date.now}={}){
 if(!memory||typeof getScene!=='function'||typeof imageCrop!=='function'||typeof readTimeline!=='function'||typeof operationDiagnostics?.readEvidence!=='function'||typeof operationDiagnostics.root!=='string'||typeof outputDirectory!=='string'||!path.isAbsolute(outputDirectory)||path.normalize(outputDirectory)!==outputDirectory||outputDirectory===path.parse(outputDirectory).root||/[\u0000-\u001f\u007f]/u.test(outputDirectory))throw TypeError('局部证据导出依赖无效');
 return async function inspect(params,{signal}={}){
  validateEvidenceParams(params);const {id,session,incidentId,captureId,region}=params,generation=memory.generation;
  const check=()=>{if(signal?.aborted)throw failure('E_TASK_EVIDENCE_ABORTED','局部证据导出已取消');if(getScene()!=='life')throw failure('E_TASK_EVIDENCE_SCENE','局部证据仅允许生活场景');if(!memory.ready||!Number.isSafeInteger(generation)||memory.generation!==generation)throw failure('E_TASK_EVIDENCE_STALE','资料已锁定或代次改变');};
  const guarded=async invoke=>{check();let abort;const cancelled=signal?new Promise((_,reject)=>{abort=()=>reject(failure('E_TASK_EVIDENCE_ABORTED','局部证据导出已取消'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}):null;try{const work=Promise.resolve().then(()=>{check();return invoke();});const result=await(cancelled?Promise.race([work,cancelled]):work);check();return result;}finally{if(abort)signal.removeEventListener('abort',abort);}};
  let temporary,artifact,handle,published=false,complete=false,pixels,cropped;
  try{
   check();if(typeof memory.db?.request!=='function'||typeof memory.decode!=='function')throw failure('E_TASK_EVIDENCE_UNAVAILABLE','任务资料服务暂不可用');
   const rows=(await guarded(()=>memory.db.request('get',{ids:[id]})))?.rows;
   if(!Array.isArray(rows)||rows.length!==1||rows[0]?.id!==id)throw failure('E_TASK_EVIDENCE_SCOPE','指定任务不可用');
   const row=rows[0];if(row.kind!=='task'||row.domain!=='life'||row.visibilityFloor!==1||row.state==='deleted')throw failure('E_TASK_EVIDENCE_SCOPE','指定记录不属于允许的生活任务');
   const task=memory.decode(row)?.value;check();
   if(!task||task.id!==id||task.scene!=='life'||task.visibilityFloor!==1||task.privacyEpoch!==generation||!Number.isFinite(task.createdAt))throw failure('E_TASK_EVIDENCE_SCOPE','Task身份、场景或代次不匹配');
   const operationRefs=new Set(Object.entries(task.operations||{}).map(([key,op])=>diagnostics.ref(op?.id||key)));
   // Native controller scopes may use a child execution's Task ID. Only IDs
   // explicitly retained by this canonical Task can supplement its own ref.
   const taskRefs=new Set([id,...Object.values(task.operations||{}).map(op=>op?.physicalId),...(Array.isArray(task.state?.outboundMessages)?task.state.outboundMessages.map(message=>message?.id):[]),task.state?.conversationOperationId].filter(value=>typeof value==='string'&&value.length>0&&value.length<=200).map(diagnostics.ref));
   const from=task.createdAt,to=clock();if(!Number.isFinite(to)||to<from)throw failure('E_TASK_EVIDENCE_SCOPE','任务证据时间窗无效');
   const timeline=await guarded(()=>readTimeline(operationDiagnostics.root,{from,to,limit:512,session,incidentId,captureId}));
   const retained=timeline?.events?.find(e=>e.stage==='evidence-retained'&&e.session===session&&e.incidentId===incidentId&&e.captureId===captureId&&taskRefs.has(e.taskId)&&operationRefs.has(e.operationId)&&Number.isFinite(e.at)&&e.at>=from&&e.at<=to);
   if(!retained)throw failure('E_TASK_EVIDENCE_OWNERSHIP','未找到与指定Task Operation一致的留存证据事件');
   const result=await guarded(()=>operationDiagnostics.readEvidence({session,incidentId,captureId},{authorize:()=>{check();return ()=>{check();return true;};}}));
   if(!result?.available||typeof result.pngBase64!=='string')throw failure('E_TASK_EVIDENCE_UNAVAILABLE','指定留存像素不可用');
   const frame=result.frame;if(frame?.session!==session||frame.incidentId!==incidentId||frame.captureId!==captureId||frame.imageKind==='display')throw failure('E_TASK_EVIDENCE_SCOPE','只允许已归属Task的局部视觉帧');
   pixels=Buffer.from(result.pngBase64,'base64');const size=pngSize(pixels);
   if(size.width!==frame.width||size.height!==frame.height||region.x+region.width>size.width||region.y+region.height>size.height||(region.x===0&&region.y===0&&region.width===size.width&&region.height===size.height))throw failure('E_TASK_EVIDENCE_REGION','region须位于实际留存帧内且不能导出整帧');
   cropped=await guarded(()=>imageCrop(pixels,{...region}));const outputSize=pngSize(cropped);
   if(outputSize.width!==region.width||outputSize.height!==region.height||cropped.length>2*1024*1024)throw failure('E_TASK_EVIDENCE_IMAGE','局部PNG尺寸或容量无效');
   const directory=await guarded(()=>privateDirectory(outputDirectory)),suffix=randomUUID();temporary=path.join(outputDirectory,'.evidence-'+suffix+'.tmp');artifact=path.join(outputDirectory,'evidence-'+id+'-'+suffix+'.png');
   handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);check();await handle.writeFile(cropped);check();await handle.sync();check();await handle.close();handle=null;
   const actual=await fs.lstat(outputDirectory);check();if(actual.isSymbolicLink()||actual.dev!==directory.dev||actual.ino!==directory.ino||actual.uid!==process.getuid()||(actual.mode&0o777)!==0o700)throw failure('E_TASK_EVIDENCE_PATH','导出目录在保存时改变');
   await fs.link(temporary,artifact);published=true;check();await fs.unlink(temporary);temporary=null;check();const stat=await fs.lstat(artifact);check();
   if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600)throw failure('E_TASK_EVIDENCE_PATH','证据文件权限无效');
   complete=true;return {ok:true,id,scene:'life',artifact:{path:artifact,sha256:createHash('sha256').update(cropped).digest('hex'),size:cropped.length,mimeType:'image/png'},metadata:{session,incidentId,captureId,operationRef:retained.operationId,eventSeq:retained.seq,region:{...region},width:outputSize.width,height:outputSize.height},note:'仅指定Task已留存局部像素；未采集新画面，未返回整帧或消息正文。'};
  }catch(error){if(/^E_TASK_EVIDENCE_[A-Z_]+$/u.test(error?.code||''))throw error;throw failure('E_TASK_EVIDENCE_UNAVAILABLE','局部证据未能安全导出');}
  finally{pixels?.fill(0);cropped?.fill(0);if(handle)await handle.close().catch(()=>{});if(temporary)await fs.unlink(temporary).catch(()=>{});if(published&&!complete)await fs.unlink(artifact).catch(()=>{});}
 };
}
module.exports={createTaskEvidenceInspection,validateEvidenceParams};
