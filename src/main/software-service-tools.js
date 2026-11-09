'use strict';
// Host-owned connectors only: targets, methods and authority are registered.
// This does not expose arbitrary HTTP, URLs, scripts or code execution.
const {fields,text,clone}=require('./agent-contract');
function registerSoftwareServices(tools,providers=[]){
 const services=new Map();
 for(const p of providers){if(!p||typeof p.id!=='string'||services.has(p.id)||typeof p.application!=='string'||!Array.isArray(p.methods)||!p.methods.length||p.methods.some(m=>typeof m!=='string')||typeof p.authorize!=='function'||typeof p.execute!=='function')throw Error('服务连接器必须有固定目标、方法、独立授权与执行器');services.set(p.id,Object.freeze({...p,methods:Object.freeze([...p.methods])}));}
 const resolve=a=>{const p=services.get(a.service);if(!p||p.application!==a.application||!p.methods.includes(a.method))throw Object.assign(Error('没有对应目标及方法的已注册服务连接器'),{dispatched:false});require('./interaction-policy').assertChannel(p.application,'service');return p;};
 tools.register({name:'software.service',description:'调用宿主已注册并独立授权的固定软件服务方法；没有提供者时不可用，不接受任意URL、代码或临时连接器。返回真实服务结果，业务完成须核验；副作用未知时不换模式重放。',effect:'write',capabilities:['service.call'],scope:a=>({application:a.application}),available:task=>task.subjects.some(s=>[...services.values()].some(p=>p.application===s.application)),
  inputSchema:{type:'object',additionalProperties:false,required:['application','service','method','input'],properties:{application:{type:'string'},service:{type:'string',enum:[...services.keys()],description:[...services.values()].map(p=>p.id+' → '+p.application+'; methods: '+p.methods.join(', ')).join('\n')},method:{type:'string',enum:[...new Set([...services.values()].flatMap(p=>p.methods))]},input:{type:'object'},timeoutSeconds:{type:'integer',minimum:1,maximum:60}}},
  validate:a=>{fields(a,['application','service','method','input','timeoutSeconds'],'软件服务');for(const k of ['application','service','method'])text(a[k],k,160);if(!a.input||typeof a.input!=='object'||Array.isArray(a.input)||JSON.stringify(a.input).length>24000)throw Error('服务输入无效');if(a.timeoutSeconds!==undefined&&(!Number.isInteger(a.timeoutSeconds)||a.timeoutSeconds<1||a.timeoutSeconds>60))throw Error('服务时限无效');const p=resolve(a);return {...a,input:p.validate?p.validate(clone(a.input),a.method):clone(a.input)};},
  execute:async(a,c)=>{
   const p=resolve(a),controller=new AbortController();let began=false,timer,abort;
   const live=()=>{if(c.signal?.aborted||controller.signal.aborted)throw Object.assign(Error('服务操作已停止'),{...(began?{}:{dispatched:false})});};live();
   const stopped=new Promise((_,reject)=>{abort=()=>{controller.abort();reject(Object.assign(Error('服务操作已取消，已发出请求的副作用须核对'),{code:'E_ABORTED',...(began?{}:{dispatched:false})}));};c.signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('服务请求超时，结果未确认，不能换模式重放'),{code:'E_SERVICE_TIMEOUT',...(began?{}:{dispatched:false})}));},(a.timeoutSeconds||30)*1000);});
   try{const result=await Promise.race([(async()=>{live();await p.authorize({task:c.task,method:a.method,input:a.input,signal:controller.signal});live();began=true;return p.execute({method:a.method,input:a.input,signal:controller.signal,operationId:c.operationId});})(),stopped]);require('./software-tools').remember(c.task,{application:a.application,channel:'service',method:a.method,operationId:c.operationId,outcome:'result-received',verified:result?.verified===true});return result;}
   catch(error){if(!began)error.dispatched=false;throw error;}
   finally{clearTimeout(timer);c.signal?.removeEventListener('abort',abort);}
  }
 });
}
module.exports={registerSoftwareServices};
