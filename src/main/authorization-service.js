'use strict';
const requirements={
 'screen.observe':['screenCaptureAllowed'],'screen.activate':['screenCaptureAllowed','postEventAllowed'],'screen.action':['screenCaptureAllowed','postEventAllowed'],
 'terminal.execute':['terminal'], 'software.command':['terminal'], 'software.interface':['accessibilityTrusted'], 'software.control':['accessibilityTrusted'], 'software.recover':['accessibilityTrusted'], 'system.configure':['systemConfiguration'], 'system.restore':['systemConfiguration'],
 'work.submit':['screenCaptureAllowed','postEventAllowed'],
 'result.deliver':['screenCaptureAllowed','accessibilityTrusted','postEventAllowed'],
 'result.attach':['screenCaptureAllowed','accessibilityTrusted','postEventAllowed'],
 'conversation.open':['screenCaptureAllowed','postEventAllowed'],
 'conversation.transcribe':['screenCaptureAllowed','postEventAllowed'],
 'conversation.save':['screenCaptureAllowed','postEventAllowed'],
 'conversation.send':['screenCaptureAllowed','postEventAllowed'],
 'conversation.observe':['screenCaptureAllowed']
};
const titles={terminal:'非破坏性终端',systemConfiguration:'操作系统配置修改',screenCaptureAllowed:'屏幕录制',accessibilityTrusted:'辅助功能/输入控制',postEventAllowed:'模拟键鼠',boperReady:'BOPER 虚拟键鼠就绪'};
const localSetting = name => name === 'terminal' || name === 'systemConfiguration';
function requiredFor(tool, args = {}) {
 const required = [...(requirements[tool.name] || [])];
 if (['terminal.execute','software.command'].includes(tool.name) && args.impact === 'configuration') required.push('systemConfiguration');
 return required;
}
function denied(tool, args, missing) {
 return Object.assign(Error('需要'+missing.map(k=>titles[k]||k).join('、')+'授权，完成后继续原任务'),
  { code:'E_PERMISSION_REQUIRED', dispatched:false, missing, permissionRequest:{ tool:tool.name, args:structuredClone(args) } });
}
class AuthorizationService{
 constructor({settings=()=>({}),permissions=async()=>({}),inputStatus=()=>null,onMissing=async()=>{},onResolved=async()=>{}}={}){Object.assign(this,{settings,permissions,inputStatus,onMissing,onResolved});this.last=new Map();this.notified=new Set();}
 async inspect(tool,args={}){
  const required=requiredFor(tool,args);
  const scope=typeof tool.scope==='function'?tool.scope(args):{};
  const requiresVirtual=require('./interaction-policy').inputRequirement(args.application||scope?.application)==='virtual-hid';
  let input=null;if(required.includes('postEventAllowed')||requiresVirtual){const value=this.inputStatus();input=value&&typeof value.then==='function'?await value:value;}
  const requestedFields=required.filter(k=>!localSetting(k)&&!(k==='postEventAllowed'&&(input?.enabled||requiresVirtual)));
  const system=requestedFields.length?await this.permissions(requestedFields):{},flags=this.settings();
  const missing=required.filter(k=>{
   if(k==='postEventAllowed'&&requiresVirtual)return false;
   if(k==='postEventAllowed'&&input?.enabled)return input.backend!=='virtual-hid'||input.state!=='ready';
   return localSetting(k)?flags[k]!==true:system[k]!==true;
  }).map(k=>k==='postEventAllowed'&&input?.enabled?'boperReady':k);
  if(requiresVirtual&&(input?.backend!=='virtual-hid'||input?.state!=='ready'))missing.unshift('boperReady');
  return missing;
 }
 async check(tool,args,task,{signal,isCurrent=()=>true}={}){
  const missing=await this.inspect(tool,args);if(signal?.aborted||!isCurrent())throw Object.assign(Error('任务已停止，未继续申请权限'),{dispatched:false});const record={tool:tool.name,checkedAt:Date.now(),missing};this.last.set(task.id,record);
  task.state??={};task.state.authorizationChecks??=[];const previous=task.state.authorizationChecks.at(-1);if(previous?.tool!==record.tool||JSON.stringify(previous?.missing)!==JSON.stringify(missing)){task.state.authorizationChecks.push(record);task.state.authorizationChecks=task.state.authorizationChecks.slice(-24);}
  if(!missing.length){
   await this.resolve(task.id);
   const settings = requiredFor(tool,args).filter(localSetting);
   if (!settings.length) return;
   return () => {
    const current = this.settings();
    const revoked = settings.filter(key => current[key] !== true);
    if (revoked.length) throw denied(tool,args,revoked);
   };
  }
  const error=denied(tool,args,missing);
  if(!this.notified.has(task.id)){this.notified.add(task.id);await this.onMissing({taskId:task.id,goal:task.goal,missing,message:error.message});}
  throw error;
 }
 async resolve(taskId){if(this.notified.delete(taskId))await this.onResolved(taskId);}
 changed(){this.notified.clear();}
}
module.exports={AuthorizationService,permissionTitles:titles};
