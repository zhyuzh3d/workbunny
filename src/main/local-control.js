'use strict';
// Owner-authorized, local RPC. The private socket exposes registered controls
// only; it never loads native input modules or offers conversation/history IO.
const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const SCHEMA='bunny.local-control/v1';
const MAX_REQUEST_BYTES=16*1024,MAX_RESPONSE_BYTES=256*1024;
const issue=(code,message)=>Object.assign(Error(message),{code});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,80}$/u.test(value);
function socketPath(userData){return path.join(userData,'control','bunny.sock');}
function request(value){
 if(!object(value)||value.schema!==SCHEMA||!validId(value.id)||typeof value.method!=='string'||!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/u.test(value.method)||value.method.length>80||!object(value.params)||Object.keys(value).some(k=>!['schema','id','method','params'].includes(k)))throw issue('E_LOCAL_PROTOCOL','请求需要 schema/id/method/params，且字段必须符合本机控制协议');
 return value;
}
function noParams(params){if(Object.keys(params).length)throw issue('E_LOCAL_PARAMS','此方法不接受参数');}
class OwnerToolRegistry{
 constructor(){this.tools=new Map();this.mutating=false;}
 register(tool){if(!/^[a-z][a-z0-9_]{0,63}$/u.test(tool.name)||this.tools.has(tool.name)||typeof tool.execute!=='function'||!object(tool.inputSchema))throw issue('E_LOCAL_REGISTRY','MCP 工具定义无效或重复');this.tools.set(tool.name,tool);return this;}
 list(){return {tools:[...this.tools.values()].map(({name,title,description,inputSchema,mutating})=>({name,title,description,inputSchema,outputSchema:{type:'object',additionalProperties:true},annotations:{readOnlyHint:!mutating,destructiveHint:false,idempotentHint:!mutating,openWorldHint:false}}))};}
 async call(params,context){if(!object(params)||typeof params.name!=='string'||Object.keys(params).some(k=>!['name','arguments'].includes(k)))throw issue('E_LOCAL_PARAMS','tools/call 参数无效');const tool=this.tools.get(params.name);if(!tool)throw issue('E_LOCAL_METHOD','未注册此 MCP 工具');const args=params.arguments??{};
  try{if(!object(args))throw issue('E_LOCAL_PARAMS','工具参数必须为对象');tool.validate(args);if(tool.mutating&&this.mutating)throw issue('E_LOCAL_BUSY','另一项本机修改尚未完成，请查询状态后再决定');if(tool.mutating)this.mutating=true;
   let result;try{result=await tool.execute(args,context);}finally{if(tool.mutating)this.mutating=false;}
   if(!object(result))throw issue('E_LOCAL_RESULT','工具必须返回结构化对象');return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false};
  }catch(error){const result={error:{code:/^E_[A-Z0-9_]{1,60}$/u.test(error?.code)?error.code:'E_LOCAL_CONTROL',message:String(error?.message||'本机控制失败').slice(0,800)}};return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:true};}
 }
}
function ownerMethods({getScene,setScene,boperControl,speechControl,openSettings,settingsTabs=[]}){
 const registry=new OwnerToolRegistry(),empty={type:'object',properties:{},additionalProperties:false};
 registry.register({name:'scene_get',title:'当前场景',description:'仅返回当前设置中的场景标识，不读取对话或历史。',inputSchema:empty,validate:noParams,execute:()=>({scene:getScene()})});
 registry.register({name:'scene_set',title:'切换场景',description:'通过 Bunny 与 UI 共用的设置及生命周期链路切换场景；开发测试应先切换生活场景。',mutating:true,inputSchema:{type:'object',properties:{scene:{type:'string',enum:['work','life','private']}},required:['scene'],additionalProperties:false},validate:params=>{if(Object.keys(params).length!==1||!['work','life','private'].includes(params.scene))throw issue('E_LOCAL_PARAMS','scene 必须为 work、life 或 private');},execute:async params=>{await setScene(params.scene);return {scene:getScene()};}});
 for(const action of ['status','enable','disable','refresh','settings','test','permissions','authorize_screen'])registry.register({name:'boper_'+action,title:'BOPER '+action,description:action==='test'?'仅在生活场景运行合成材料的本地 BOPER 接收窗口验收，不访问微信或对话。':'由运行中的 Bunny 宿主执行 BOPER '+action+'。',mutating:['enable','disable','settings','test','authorize_screen'].includes(action),timeoutMs:action==='enable'?660000:120000,inputSchema:empty,validate:noParams,execute:()=>boperControl(action)});
 if(typeof speechControl==='function')registry.register({name:'speech_control',title:'本机语音控制',description:'仅生活场景：查询非内容状态、切换普通聆听，或开始/停止/清理最多20秒的既有隔离语音诊断。不返回转写、录音或聊天内容。',mutating:true,inputSchema:{type:'object',properties:{action:{type:'string',enum:['status','listen','diagnostic_start','diagnostic_stop','diagnostic_clear']},on:{type:'boolean'},durationMs:{type:'integer',minimum:1,maximum:20000},pcm:{type:'boolean'}},required:['action'],additionalProperties:false},validate:params=>{
  const allowed={status:['action'],listen:['action','on'],diagnostic_start:['action','durationMs','pcm'],diagnostic_stop:['action'],diagnostic_clear:['action']}[params.action];
  if(!allowed||Object.keys(params).some(key=>!allowed.includes(key))||params.action==='listen'&&typeof params.on!=='boolean'||params.durationMs!==undefined&&(!Number.isSafeInteger(params.durationMs)||params.durationMs<1||params.durationMs>20000)||params.pcm!==undefined&&typeof params.pcm!=='boolean')throw issue('E_LOCAL_PARAMS','语音控制参数无效');
 },execute:(params,context)=>{if(getScene()!=='life')throw issue('E_LOCAL_SCENE','语音调试仅允许生活场景');if(context?.signal?.aborted)throw issue('E_LOCAL_CANCELLED','语音控制已取消');return speechControl(params,context);}});
 if(typeof openSettings==='function')registry.register({name:'settings_open',title:'打开设置',description:'仅打开 Bunny 自己的设置面板，可选择现有 UI 标签；system 对应系统页。',mutating:true,inputSchema:{type:'object',properties:{tab:{type:'string',enum:settingsTabs}},additionalProperties:false},validate:params=>{if(Object.keys(params).some(key=>key!=='tab')||params.tab!==undefined&&!settingsTabs.includes(params.tab))throw issue('E_LOCAL_PARAMS','设置标签无效');},execute:params=>openSettings(params.tab)});
 return {'tools.list':{execute:params=>{noParams(params);return registry.list();}},'tools.call':{timeoutMs:params=>registry.tools.get(params.name)?.timeoutMs,execute:(params,context)=>registry.call(params,context)}};
}
async function privateDirectory(directory){await fs.mkdir(directory,{recursive:true,mode:0o700});const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||process.getuid&&stat.uid!==process.getuid())throw issue('E_LOCAL_PATH','本机控制目录必须由当前用户拥有，且不能是符号链接');await fs.chmod(directory,0o700);}
async function removeStaleSocket(file){
 let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(!stat.isSocket()||stat.isSymbolicLink()||process.getuid&&stat.uid!==process.getuid())throw issue('E_LOCAL_PATH','控制端点已存在且不是当前用户的 Unix socket');
 const listening=await new Promise(resolve=>{const socket=net.createConnection(file);const finish=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>finish(true));socket.once('error',error=>finish(!['ECONNREFUSED','ENOENT'].includes(error.code)));socket.setTimeout(300,()=>finish(true));});
 if(listening)throw issue('E_LOCAL_ALREADY_RUNNING','本机控制端点正在运行');
 const current=await fs.lstat(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});if(current&&current.ino===stat.ino&&current.dev===stat.dev)await fs.unlink(file);
}
class LocalControl{
 constructor({userData,endpoint=userData&&socketPath(userData),methods={},maxConnections=4,maxActive=2,timeoutMs=120000}={}){
  if(typeof endpoint!=='string'||!path.isAbsolute(endpoint)||Buffer.byteLength(endpoint)>103)throw issue('E_LOCAL_PATH','需要长度不超过 103 字节的绝对 Unix socket 路径');
  Object.assign(this,{endpoint,maxConnections,maxActive,timeoutMs});this.methods=new Map();this.clients=new Set();this.active=0;this.mutating=false;this.closed=false;for(const [method,entry]of Object.entries(methods))this.register(method,entry);
 }
 register(method,entry){if(this.server)throw issue('E_LOCAL_REGISTRY','监听开始后不能修改方法清单');if(!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/u.test(method)||this.methods.has(method)||typeof entry?.execute!=='function')throw issue('E_LOCAL_REGISTRY','本机控制方法无效或重复');this.methods.set(method,entry);return this;}
 async start(){
  await privateDirectory(path.dirname(this.endpoint));await removeStaleSocket(this.endpoint);
  this.server=net.createServer(socket=>this.accept(socket));await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.endpoint,()=>{this.server.removeListener('error',reject);resolve();});});
  this.server.on('error',()=>{});await fs.chmod(this.endpoint,0o600);this.socketIdentity=await fs.lstat(this.endpoint);return this;
 }
 respond(socket,id,body){if(socket.destroyed)return;let response={schema:SCHEMA,id:validId(id)?id:null,...body};let line=JSON.stringify(response)+'\n';if(Buffer.byteLength(line)>MAX_RESPONSE_BYTES)line=JSON.stringify({schema:SCHEMA,id:response.id,ok:false,error:{code:'E_LOCAL_RESPONSE_LIMIT',message:'控制结果超过上限；结果不会自动重放'}})+'\n';socket.end(line);}
 error(socket,id,error){this.respond(socket,id,{ok:false,error:{code:/^E_[A-Z0-9_]{1,60}$/u.test(error?.code)?error.code:'E_LOCAL_CONTROL',message:String(error?.message||'本机控制失败').slice(0,800)}});}
 accept(socket){
  socket.on('error',()=>{});if(this.closed||this.clients.size>=this.maxConnections){this.error(socket,null,issue('E_LOCAL_BUSY','本机控制连接数已满'));return;}
  this.clients.add(socket);socket.once('close',()=>this.clients.delete(socket));let bytes=0,parts=[],received=false;socket.setTimeout(5000,()=>{if(!received){this.error(socket,null,issue('E_LOCAL_TIMEOUT','等待请求超时'));socket.destroySoon();}});
  socket.on('data',chunk=>{if(received)return;bytes+=chunk.length;if(bytes>MAX_REQUEST_BYTES){received=true;this.error(socket,null,issue('E_LOCAL_REQUEST_LIMIT','本机控制请求超过 16 KiB'));return;}
   parts.push(chunk);const buffer=Buffer.concat(parts,bytes),newline=buffer.indexOf(10);if(newline<0)return;received=true;socket.setTimeout(0);
   let value;try{if(buffer.subarray(newline+1).toString('utf8').trim())throw issue('E_LOCAL_PROTOCOL','每条连接只接受一次请求');value=request(JSON.parse(buffer.subarray(0,newline).toString('utf8')));}catch(error){this.error(socket,value?.id,error.code?error:issue('E_LOCAL_PROTOCOL','请求不是有效 JSON'));return;}
   void this.dispatch(socket,value);
  });
 }
 async dispatch(socket,value){
  const entry=this.methods.get(value.method);if(!entry){this.error(socket,value.id,issue('E_LOCAL_METHOD','未注册此本机控制方法'));return;}
  if(this.active>=this.maxActive||entry.mutating&&this.mutating){this.error(socket,value.id,issue('E_LOCAL_BUSY','另一项本机控制尚未完成，请查询状态后再决定'));return;}
  this.active++;if(entry.mutating)this.mutating=true;const controller=new AbortController();let responded=false;
  const requestedTimeout=typeof entry.timeoutMs==='function'?entry.timeoutMs(value.params):entry.timeoutMs;
  const timeoutMs=Number.isInteger(requestedTimeout)&&requestedTimeout>=100?Math.min(660000,requestedTimeout):this.timeoutMs;
  const timer=setTimeout(()=>{responded=true;controller.abort();this.error(socket,value.id,issue('E_LOCAL_TIMEOUT','控制请求超时，执行结果不明；请查询状态，不会自动重试'));},timeoutMs);
  try{const result=await entry.execute(value.params,{signal:controller.signal,id:value.id,method:value.method});if(!responded)this.respond(socket,value.id,{ok:true,result});}
  catch(error){if(!responded)this.error(socket,value.id,error);}
  finally{clearTimeout(timer);this.active--;if(entry.mutating)this.mutating=false;}
 }
 async close(){this.closed=true;for(const socket of this.clients)socket.destroy();const server=this.server;this.server=null;if(server)await new Promise(resolve=>server.close(resolve));const stat=await fs.lstat(this.endpoint).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});if(stat&&this.socketIdentity&&stat.ino===this.socketIdentity.ino&&stat.dev===this.socketIdentity.dev)await fs.unlink(this.endpoint);}
}
function sendRequest(endpoint,value,{timeoutMs=125000}={}){
 request(value);return new Promise((resolve,reject)=>{const socket=net.createConnection(endpoint);let bytes=0,parts=[],settled=false;const done=(error,response)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(response);};socket.setTimeout(timeoutMs,()=>done(issue('E_LOCAL_TIMEOUT','未及时收到控制回执；执行结果不明，不会自动重试')));socket.once('error',error=>done(issue(error.code==='ENOENT'||error.code==='ECONNREFUSED'?'E_LOCAL_UNAVAILABLE':'E_LOCAL_CONNECTION',error.code==='ENOENT'||error.code==='ECONNREFUSED'?'Bunny 本机控制接口未运行，或端点路径不正确':'本机控制连接失败')));socket.once('connect',()=>socket.write(JSON.stringify(value)+'\n'));socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_RESPONSE_BYTES){done(issue('E_LOCAL_RESPONSE_LIMIT','本机控制回执超过上限'));return;}parts.push(chunk);const buffer=Buffer.concat(parts,bytes),newline=buffer.indexOf(10);if(newline<0)return;try{const response=JSON.parse(buffer.subarray(0,newline));if(!object(response)||response.schema!==SCHEMA||response.id!==value.id||typeof response.ok!=='boolean')throw Error();done(null,response);}catch{done(issue('E_LOCAL_PROTOCOL','本机控制回执无效'));}});socket.once('end',()=>{if(!settled)done(issue('E_LOCAL_CONNECTION','连接结束，未取得完整控制回执；不会自动重试'));});});
}
module.exports={SCHEMA,LocalControl,OwnerToolRegistry,ownerMethods,socketPath,sendRequest,request,MAX_REQUEST_BYTES,MAX_RESPONSE_BYTES,randomUUID};
