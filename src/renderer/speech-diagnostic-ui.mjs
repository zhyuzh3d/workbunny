export function mountSpeechDiagnostic(api,document){
 const get=id=>document.getElementById('speechDiagnostic'+id),start=get('Start'),stop=get('Stop'),open=get('Open'),clear=get('Clear'),resume=get('Resume'),pcm=get('Pcm'),note=get('Status');
 if(!start||typeof api.speechDiagnostic!=='function')return;
 let timer,disposed=false,working=false;
 const paint=status=>{
  start.disabled=working||status.active;stop.disabled=!status.active;pcm.disabled=status.active;
  open.disabled=clear.disabled=working||status.active||!status.id;
  resume.disabled=status.active||!status.blocked;
  note.textContent=status.active?(status.phase==='preparing'?'正在准备，暂勿播放测试音频。':status.phase==='finalizing'?'采集已结束，正在保存本机文件。':`正在隔离采集，剩余 ${(status.remainingMs/1000).toFixed(1)} 秒。`):status.id?(status.incomplete?'诊断已停止，文件可能不完整。请打开文件夹核对；常驻监听保持关闭。':'本次诊断已结束。可打开文件夹核对，随后清理；常驻监听保持关闭。'):status.blocked?'诊断已结束。需要时手动重新开启常驻监听。':'默认关闭，不会自动采集。';
  clearTimeout(timer);if(status.active&&!disposed)timer=setTimeout(refresh,250);
 };
 async function refresh(){try{const status=await api.speechDiagnostic({action:'status'});if(!disposed)paint(status);}catch{if(!disposed)note.textContent='暂时无法读取诊断状态。';}}
 const errorText=error=>String(error?.message||'').includes('E_DIAGNOSTIC_UNAVAILABLE')?'请先解锁记忆并允许麦克风，等待对话和朗读结束。此诊断需要 macOS 26 的连续识别。':String(error?.message||'').includes('E_DIAGNOSTIC_STORAGE_LIMIT')?'诊断文件夹已达上限，请先核对并清理旧诊断。':'诊断未能完成。采集已停止；请检查本机私有文件和可用磁盘。';
 const run=async action=>{if(working&&action!=='stop')return;working=true;start.disabled=true;open.disabled=clear.disabled=true;if(action==='start'){stop.disabled=false;note.textContent='正在准备，暂勿播放测试音频。';}try{const result=await api.speechDiagnostic({action,...(action==='start'?{pcm:pcm.checked}:{})});working=false;paint(result);}catch(error){working=false;await refresh();note.textContent=errorText(error);}};
 start.addEventListener('click',()=>{void run('start');});stop.addEventListener('click',()=>{void run('stop');});open.addEventListener('click',()=>{void run('open');});clear.addEventListener('click',()=>{void run('clear');});
 resume.addEventListener('click',()=>{api.listen(true);void refresh();});
 globalThis.addEventListener?.('beforeunload',()=>{disposed=true;clearTimeout(timer);},{once:true});void refresh();
}
