'use strict';
const {INPUT_BACKEND_CHANGE_CAUSE}=require('./desktop-service');
const changing=new WeakSet();
// Same path used by the settings IPC and integration tests. A failed pause must
// not continue into installation or switch input backends under active work.
async function changeInputMode({action,boper,controllers,ensureDriver}){
 if(!['enable','disable'].includes(action))throw Error('BOPER 模式操作不合法');
 if(changing.has(boper))throw Object.assign(Error('BOPER 安装或模式变更尚未完成，请先查询状态'),{code:'E_BOPER_BUSY'});
 changing.add(boper);
 try{
 const results=await Promise.allSettled([
  ...controllers.filter(Boolean).map(controller=>controller.suspend({cause:INPUT_BACKEND_CHANGE_CAUSE,reason:'正在变更键鼠模式，已暂停输入'})),
  boper.stop(INPUT_BACKEND_CHANGE_CAUSE),
 ]);
 const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
 if(action==='disable')return boper.disable();
 boper.setEnabledIntent(true);
 await ensureDriver();
 const status=await boper.enable();
 if(status.state==='requires-approval'){
  await boper.openSettings();
  return {...status,note:'请在系统登录项中允许 WorkBunny 在后台运行，批准后点击重新检测。'};
 }
 return status;
 }finally{changing.delete(boper);}
}
module.exports={changeInputMode};
