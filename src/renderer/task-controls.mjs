const progress={archive:'正在移出任务列表…',clearList:'正在停止并清理任务列表…',restoreList:'正在恢复任务列表…',stop:'正在提交停止请求并核对后台执行…',pause:'正在暂停任务…',resume:'正在继续任务…',check:'正在检查任务…',resolve:'正在处理任务…',reviewPriorResult:'正在请求重新核验原成果，补充草稿保留…',reissue:'正在打开交办…'};
const success={archive:'任务已移出列表，原记录已保留。',clearList:'任务列表已清理，原记录已保留。',restoreList:'任务列表已恢复，任务不会自动执行。',stop:'Bunny 任务已停止，后台停止已核实。',pause:'任务已暂停。',resume:'已继续任务。',check:'本次检查已结束，请查看任务当前状态。',resolve:'本次处理请求已结束，请查看任务当前状态。',reviewPriorResult:'本次原成果核验请求已结束，请查看任务当前状态。',reissue:'已打开交办。'};
// Both task surfaces keep feedback through status refreshes and share the same
// duplicate-click contract. A slow response is never presented as success.
export function createTaskControls({changed=()=>{},waitMs=8000}={}){
 const pending=new Set(),messages=new Map(),requests=new Map(),latest=new Map();
 const priority=operation=>operation==='stop'?2:operation==='pause'?1:0;
 function run(key,operation,request){
  const current=latest.get(key);
  if(current&&priority(operation)<=priority(current.operation))return current.work;
  const operations=requests.get(key)||new Map();
  if(operations.has(operation))return operations.get(operation).work;
  if(current)clearTimeout(current.timer);
  const entry={operation,work:null,timer:null};
  latest.set(key,entry);requests.set(key,operations);operations.set(operation,entry);
  pending.add(key);messages.set(key,progress[operation]||'正在处理…');
  const work=Promise.resolve().then(request).then(result=>{
   if(!result?.ok)throw Error(result?.error||'操作尚未确认，请查看任务状态后重试。');
   if(latest.get(key)===entry)messages.set(key,result.message||success[operation]||'操作已完成。');return result;
  }).catch(error=>{const result={ok:false,error:error?.message||'任务服务未响应，请查看任务状态后重试。'};if(latest.get(key)===entry)messages.set(key,result.error);return result;})
   .finally(()=>{clearTimeout(entry.timer);operations.delete(operation);if(!operations.size)requests.delete(key);if(latest.get(key)===entry){pending.delete(key);latest.delete(key);changed();}});
  entry.work=work;
  entry.timer=setTimeout(()=>{if(latest.get(key)!==entry)return;messages.set(key,operation==='stop'?'仍在等待后台停止核对；结果尚未确认，请查看任务状态。':'仍在等待任务服务回应，结果尚未确认。');changed();},waitMs);
  changed();return work;
 }
 return {pending,messages,run};
}
