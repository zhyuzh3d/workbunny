'use strict';

// One input owner for the application. Capture/AX bridges are deliberately not
// input executors; their private input intents are admitted here by the host.
const path=require('node:path');
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {EventEmitter}=require('node:events');
const {JsonLines}=require('./json-lines');
const policy=require('./interaction-policy');
const failure=(code,message,extra={})=>Object.assign(Error(message),{code,dispatched:false,...extra});
function defaultRuntime(){return process.resourcesPath?path.join(process.resourcesPath,'bin/boper-runtime'):path.join(__dirname,'../../build/native/boper-runtime');}
function defaultControl(){return process.resourcesPath?path.join(process.resourcesPath,'bin/boper-control.node'):path.join(__dirname,'../../build/native/boper-control.node');}
function effects(value={}){return {dispatched:value.dispatched===true||value.reportsSubmitted>0||value.dispatchOutcomeUnknown===true,reportsSubmitted:Number.isSafeInteger(value.reportsSubmitted)?value.reportsSubmitted:0,clipboardChanged:value.clipboardChanged===true,...(Number.isSafeInteger(value.clipboardChangeCount)?{clipboardChangeCount:value.clipboardChangeCount}:{}),...(typeof value.releaseConfirmed==='boolean'?{releaseConfirmed:value.releaseConfirmed}:{}),...(value.completion?{completion:value.completion}:{})};}
class BoperService extends EventEmitter{
 constructor(options={}){super();this.options=options;this.enabled=options.enabled===true;this.spawn=options.spawn||spawn;this.proc=null;this.pending=new Map();this.responses=new JsonLines(256*1024);this.nextId=1;this.active=null;this.fault=null;this.transition=null;this.closed=false;this.configurationGeneration=0;}
 configure(options={}){if(this.active||this.transition)throw failure('E_BOPER_BUSY','输入会话活动时不能修改 BOPER 配置');this.options={...this.options,...options};if(options.stateFile&&typeof options.enabled!=='boolean'){try{const data=JSON.parse(fs.readFileSync(options.stateFile,'utf8'));this.enabled=data.enabled===true;}catch(error){if(error.code!=='ENOENT')this.fault=failure('E_BOPER_CONFIG','BOPER 配置不可读，输入已停发');}}if(typeof options.enabled==='boolean')this.enabled=options.enabled;this.spawn=this.options.spawn||spawn;return this.status();}
 _persist(){if(!this.options.stateFile)return;const file=this.options.stateFile,temporary=file+'.'+randomUUID()+'.tmp';fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});try{fs.writeFileSync(temporary,JSON.stringify({schema:'bunny.boper-config/v1',enabled:this.enabled})+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}finally{try{fs.unlinkSync(temporary);}catch{}}}
 setEnabledIntent(enabled){if(enabled!==true)throw failure('E_BOPER_TRANSITION','关闭虚拟模式须等待 disable() 释放旧输入');if(this.active)throw failure('E_BOPER_BUSY','请先停止活动输入');this.enabled=true;this.nativeStatus=null;this._persist();const value=this.status();this.emit('status',value);return value;}
 control(){if(!this.addon)this.addon=this.options.control||require(this.options.controlPath||defaultControl());return this.addon;}
 status(){return {enabled:this.enabled,backend:this.enabled?'virtual-hid':'cg-event',state:this.transition?'transitioning':this.fault?'fault':this.enabled?(this.nativeStatus?.ready===true?'ready':this.nativeStatus?.state||'unavailable'):'ready',capabilities:{globalInput:true,targetedInput:!this.enabled,targetedText:false,directUnicode:false,clipboardPaste:true},...(this.options.setupGuide?{setupGuide:this.options.setupGuide}:{}),...(this.nativeStatus?{native:this.nativeStatus}:{}),...(this.fault?{error:{code:this.fault.code||'E_BOPER_FAULT',message:this.fault.message}}:{}),active:!!this.active};}
 async refreshStatus(){if(this.enabled){try{this.nativeStatus=await this.control().status();if(!this.nativeStatus.error&&this.faultKind==='probe'){this.fault=null;this.faultKind=null;}}catch(error){if(!this.fault||this.faultKind==='probe'){this.fault=error;this.faultKind='probe';}}}const value=this.status();this.emit('status',value);return value;}
 async enable(){return this._transition(true);}
 async disable(){return this._transition(false);}
 async _transition(enabled){
  if(this.transition)throw failure('E_BOPER_BUSY','BOPER 正在切换输入模式');
  this.transition=(async()=>{
   try{await this.stop('backend-change');}catch(error){if(!enabled)throw error;}
   if(!enabled&&this.fault&&this.faultKind==='input')throw failure('E_BOPER_RELEASE_UNKNOWN','旧输入状态尚未安全释放，不能切换后端');
   this.configurationGeneration++;this.enabled=enabled;this._persist();
   if(enabled){try{
    await this.control().register();
    if(this.fault&&this.faultKind==='input')await this._recoverOwnState();
    else{this.fault=null;this.faultKind=null;}
    for(let attempt=0;attempt<10;attempt++){
     this.nativeStatus=await this.control().status();
     if(this.nativeStatus.ready===true||this.nativeStatus.serviceStatus!=='enabled'||this.nativeStatus.error||attempt===9)break;
     await new Promise(resolve=>setTimeout(resolve,150));
    }
   }catch(error){if(!this.fault||this.faultKind!=='input'){this.fault=error;this.faultKind='probe';}}}
   else{this.fault=null;this.faultKind=null;this.nativeStatus=null;}
  })();try{await this.transition;}finally{this.transition=null;}const value=this.status();this.emit('status',value);return value;
 }
 async _recoverOwnState(){
  // Explicit recovery only: terminate the old executor before resetting the
  // helper's own virtual devices. No failed Operation is submitted again.
  const child=this.proc;if(child)this._discardRuntime(child,failure('E_BOPER_RECOVERY','旧输入执行器已终止，正在复位自身虚拟状态'));
  try{const recovered=await this._bounded(this.control().recover(),12500);
   if(recovered?.releaseConfirmed!==true||recovered?.ready!==true||recovered?.sessionActive===true)throw failure('E_BOPER_RECOVERY_UNCONFIRMED','自身虚拟状态复位或就绪尚未确认');
   this.nativeStatus=recovered;this.fault=null;this.faultKind=null;return recovered;
  }catch(error){this.fault=error;this.faultKind='input';throw error;}
 }
 async recover(){
  if(this.transition)throw failure('E_BOPER_BUSY','BOPER 正在切换或复位');if(!this.enabled)throw failure('E_VIRTUAL_HID_UNAVAILABLE','请先启用 VirtualHID，再明确复位自身虚拟状态');
  this.transition=(async()=>{try{await this.stop('explicit-recovery');}catch{}await this._recoverOwnState();})();try{await this.transition;}finally{this.transition=null;}const value=this.status();this.emit('status',value);return value;
 }
 assertAvailable(context={}){if(this.closed)throw failure('E_BOPER_CLOSED','BOPER 已关闭');if(this.transition)throw failure('E_BOPER_TRANSITION','输入后端正在切换，尚未接纳键鼠操作');if(this.fault)throw failure('E_BOPER_FAULT','BOPER 已停发：'+this.fault.message);const requiresVirtual=context.requiredInputBackend==='virtual-hid'||policy.inputRequirement(context.application)==='virtual-hid';if(requiresVirtual&&!this.enabled)throw failure('E_INPUT_BACKEND_REQUIRED','此软件直接键鼠操作需要启用 VirtualHID');if(this.enabled&&this.nativeStatus?.ready!==true)throw failure('E_VIRTUAL_HID_UNAVAILABLE','VirtualHID 尚未就绪；请完成驱动、后台服务和系统批准');if(this.enabled&&(context.targetPid||context.background))throw failure('E_BACKGROUND_UNSUPPORTED','VirtualHID 不支持后台定向输入；请重新取得 GUI 并核对前台目标');return this.status();}
 _validate(context){if(!context||typeof context.ownerId!=='string'||!context.ownerId||typeof context.validate!=='function')throw failure('E_BOPER_CONTEXT','缺少当前宿主输入授权，未派发键鼠');if(context.signal?.aborted)throw failure('E_ABORTED','输入操作已取消');const result=context.validate();if(result&&typeof result.then==='function')throw failure('E_BOPER_CONTEXT','输入授权复核必须同步完成');if(result===false)throw failure('E_BOPER_CONTEXT','输入授权已失效');const global=this.options.validateInputContext?.(context);if(global&&typeof global.then==='function'||global===false)throw failure('E_BOPER_CONTEXT','当前宿主控制状态不允许输入');this.assertAvailable(context);}
 _start(){if(this.proc)return;const child=this.spawn(this.options.binaryPath||defaultRuntime(),[],{stdio:['pipe','pipe','pipe','pipe']});this.proc=child;this.responses.reset();child.stdout.on('data',chunk=>{if(this.proc!==child)return;try{this.responses.push(chunk,response=>{if(!Number.isSafeInteger(response.id)||typeof response.ok!=='boolean')throw Error('Invalid BOPER response');const item=this.pending.get(response.id);if(!item)return;this.pending.delete(response.id);clearTimeout(item.timer);if(response.ok)item.resolve(response.result||{});else{const detail=typeof response.error==='object'?response.error:{};item.reject(failure(detail.code||response.code||'E_BOPER_NATIVE',detail.message||response.error||'BOPER 执行失败',{...effects(response.result),inputOutcome:response.result||{}}));}});}catch(error){this._broken(child,error);}});child.stdout.on('error',e=>this._broken(child,e));child.stdin.on('error',e=>this._broken(child,e));child.stdio?.[3]?.on('error',e=>this._broken(child,e));child.stderr.on('data',()=>{});child.on('error',e=>this._broken(child,e));child.on('close',()=>this._broken(child,failure('E_BOPER_EXIT','BOPER 执行器已退出')));}
 _discardRuntime(child,error){if(this.proc!==child)return;this.proc=null;this.responses.reset();for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(failure(error.code||'E_BOPER_CONNECTION',error.message,{dispatched:item.action==='execute',inputOutcome:{completion:item.action==='execute'?'unknown':'not-dispatched'}}));}this.pending.clear();try{child.kill('SIGKILL');}catch{}}
 _broken(child,error){if(this.proc!==child)return;const active=this.active;this._discardRuntime(child,error);if(active){this.fault=error;this.faultKind='input';this.active=null;clearInterval(active.renew);active.context.signal?.removeEventListener('abort',active.abort);try{if(active.virtual)Promise.resolve(this.addon?.revokeSession?.({inputSessionId:active.inputSessionId})).catch(()=>{});}catch{}}this.emit('status',this.status());}
 _request(action,payload={},timeoutMs=3000,control=false){this._start();const child=this.proc,id=this.nextId++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);const error=failure('E_BOPER_TIMEOUT','BOPER 回执超时；不会自动重放',{dispatched:action==='execute',inputOutcome:{completion:action==='execute'?'unknown':'not-dispatched'}});reject(error);if(action==='execute'||action==='stop'||action==='closeSession')this._broken(child,error);},timeoutMs);this.pending.set(id,{resolve,reject,timer,action});const stream=control?child.stdio?.[3]:child.stdin;if(!stream){clearTimeout(timer);this.pending.delete(id);reject(failure('E_BOPER_CONTROL','缺少独立停止通道'));return;}try{stream.write(JSON.stringify({id,action,...payload})+'\n',error=>{if(!error)return;const item=this.pending.get(id);if(!item)return;clearTimeout(item.timer);this.pending.delete(id);reject(failure('E_BOPER_CONNECTION',error.message,{dispatched:action==='execute'}));this._broken(child,error);});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});}
 async _bounded(promise,timeoutMs=2200){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('E_BOPER_CONTROL_TIMEOUT','BOPER 控制回执超时')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 async _revoke(active){if(!this.addon||!active.virtual)return;await this._bounded(this.addon.revokeSession({inputSessionId:active.inputSessionId}));}
 async _initialize(active){
  try{
   const authorization=this.enabled?this.control().authorizeRuntime({pid:active.child.pid,inputSessionId:active.inputSessionId,leaseMs:1500}):Promise.resolve({});
   // A late authorization must be revoked even after a bounded cancellation
   // has returned. It can never initiate another runtime or open a session.
   Promise.resolve(authorization).then(()=>{if(active.cancelled||this.active!==active)return this._revoke(active);}).catch(()=>{});
   const delegation=await this._bounded(authorization);
   if(active.cancelled||this.active!==active)throw failure('E_ABORTED','输入会话已取消');
   this._validate(active.context);active.phase='opening';
   await this._request('beginSession',{backend:this.enabled?'virtual-hid':'cg-event',inputSessionId:active.inputSessionId,leaseMs:1500,displayBounds:active.context.displayBounds||[],...delegation});
   if(active.cancelled||this.active!==active)throw failure('E_ABORTED','输入会话已取消');
   active.phase='ready';
   active.renew=setInterval(()=>{
    if(this.active!==active||active.cancelled||active.renewing)return;
    active.renewing=true;
    Promise.resolve().then(()=>{
     if(this.active!==active||active.cancelled)return;
     this._validate(active.context);
     return active.virtual?this._bounded(this.control().renewSession({inputSessionId:active.inputSessionId,leaseMs:1500})):null;
    }).then(()=>{
     if(this.active===active&&!active.cancelled)return this._request('renewSession',{inputSessionId:active.inputSessionId,leaseMs:1500},1000,true);
    }).catch(error=>{
     // A released lease can fail after another owner has begun. Only its
     // still-current session may fault input or invoke the shared stop path.
     if(this.active!==active||active.cancelled)return;
     this.fault=error;this.faultKind='input';return this.stop('lease-invalid').catch(()=>{});
    }).finally(()=>{active.renewing=false;});
   },500);active.renew.unref?.();
  }catch(error){
   this._discardRuntime(active.child,error);
   try{await this._revoke(active);}catch(revokeError){this.fault=revokeError;this.faultKind='input';}
   if(this.active===active&&!active.stopping)this.active=null;
   active.context.signal?.removeEventListener('abort',active.abort);throw error;
  }
 }
 async execute(operation,context,{scopeId,operationId=randomUUID(),timeoutMs=12000}={}){
  this._validate({...context,targetPid:operation.params?.targetPid});if(!scopeId)throw failure('E_BOPER_CONTEXT','缺少输入操作归属');
  if(this.active&&(this.active.context.ownerId!==context.ownerId||this.active.scopeId!==scopeId||this.active.executing||this.active.phase!=='ready'||this.active.cancelled))throw failure('E_BOPER_BUSY','另一个键鼠操作尚未释放；本次未派发');
  let active=this.active;
  if(!active){this._start();active={context,scopeId,inputSessionId:randomUUID(),executing:false,phase:'authorizing',child:this.proc,cancelled:false,virtual:this.enabled};this.active=active;active.abort=()=>{this.cancelOwner(context.ownerId,'abort').catch(()=>{});};context.signal?.addEventListener('abort',active.abort,{once:true});active.initialization=this._initialize(active);await active.initialization;}
  if(active.cancelled||this.active!==active)throw failure('E_ABORTED','输入会话已取消');this._validate(context);active.executing=true;
  try{const result=await this._request('execute',{inputSessionId:active.inputSessionId,operationId,operation},Math.min(30000,Math.max(1500,timeoutMs)));return {...result,...effects(result)};}
  catch(error){if(error.dispatched!==false||error.inputOutcome?.clipboardChanged){try{await this.stop('execution-interrupted');}catch{}}throw error;}finally{active.executing=false;}
 }
 async endScope(ownerId,scopeId){if(!this.active||this.active.context.ownerId!==ownerId||this.active.scopeId!==scopeId)return {releaseConfirmed:true};return this.stop('operation-complete');}
 async cancelOwner(ownerId,reason='cancel'){if(this.active?.context.ownerId!==ownerId)return {releaseConfirmed:true,unrelatedOwner:true};return this.stop(reason);}
 async stop(reason='stop'){
  const active=this.active;if(!active)return {releaseConfirmed:!this.fault||this.faultKind==='probe'};if(active.stopping)return active.stopping;
  active.cancelled=true;clearInterval(active.renew);active.context.signal?.removeEventListener('abort',active.abort);
  active.stopping=(async()=>{try{
   if(active.phase!=='ready'){
    // Stopping an unopened id can race with beginSession on another pipe.
    // Reap this executor instead; it has not accepted any execute request.
    this._discardRuntime(active.child,failure('E_ABORTED','输入会话建立已取消'));
    await this._bounded(Promise.resolve(active.initialization).catch(()=>{}));
    await this._revoke(active);return {releaseConfirmed:true,notOpened:true};
   }
   const result=await this._request('stop',{inputSessionId:active.inputSessionId,reason},1800,true);
   if(result.releaseConfirmed!==true)throw failure('E_BOPER_RELEASE_UNKNOWN','输入释放尚未确认',{dispatched:true,inputOutcome:result});return result;
  }catch(error){this.fault=error;this.faultKind='input';throw error;}finally{
   try{await this._revoke(active);}catch(error){this.fault=error;this.faultKind='input';}
   if(this.active===active)this.active=null;this.emit('status',this.status());
  }})();return active.stopping;
 }
 async openSettings(){return this.options.openSettings?this.options.openSettings():this.control().openSettings();}
 async shutdown(){try{await this.stop('shutdown');}finally{this.closed=true;const child=this.proc;if(child)this._broken(child,failure('E_BOPER_CLOSED','BOPER 已关闭'));}}
}
let singleton;
function getBoperService(){return singleton||(singleton=new BoperService());}
function configureBoper(options){return getBoperService().configure(options);}
module.exports={BoperService,getBoperService,configureBoper,defaultRuntime,defaultControl};
