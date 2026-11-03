'use strict';
// Repairs are small, request-scoped adjustments, never executable code or new authority.
const crypto=require('node:crypto');
const {parseStrictJson}=require('./strict-json');
const BLOCKED=new Set(['E_PERMISSION_REQUIRED','E_TASK_AUTH','E_APP_CIRCUIT','E_GUI_BUSY','ABORT_ERR','E_ABORTED']);
const OPTIONS={context:['compact_context','retry','defer'],schema:['repair_schema','retry','defer'],output:['increase_output','retry','defer'],unexpected:['retry','defer']};
function category(error){
 const code=String(error?.code||'');if(BLOCKED.has(code))return null;
 if(['E_CONTEXT_WINDOW','E_CONTEXT_BUDGET'].includes(code))return 'context';
 if(['E_MODEL_SCHEMA','E_REPLY_PROTOCOL'].includes(code))return 'schema';
 if(['E_OUTPUT_LIMIT','E_EMPTY_RESPONSE'].includes(code))return 'output';
 if(/(?:timeout|超时|network|网络|连接|ECONNRESET|ETIMEDOUT)/iu.test(String(error?.message||'')))return null;
 return 'unexpected';
}
function incident(task,error){return crypto.createHash('sha256').update(JSON.stringify([task.skill,error.code||'E_STEP',String(error.message||''),task.inbox?.[0]?.key||'',task.state?.stepSequence||0,task.state?.goalRevision||0])).digest('hex').slice(0,24);}
async function advise({kind,skill,code,attempt,phase,errorType,schemaAudit,signal,request,timeoutMs=12000}){
 const choices=OPTIONS[kind];if(!choices)throw Error('unsupported repair category');
 const context={kind,skill,code,attempt,...(phase?{phase}:{}),...(errorType?{errorType}:{}),...(schemaAudit?{schemaAudit}:{}),allowedActions:choices, constraints:'仅诊断可恢复的模型或任务错误；不能修改任务目标、权限、实际数据或已确认操作。'};
 try{
  const invoke=request||require('./verification-transport').requestVerification,controller=new AbortController();
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)controller.abort();
  let timer;
  let response;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('diagnostic timeout'));},Math.min(12000,Math.max(1,timeoutMs)));});
   response=await Promise.race([invoke({signal:controller.signal,messages:[{role:'system',content:'你是Bunny的错误诊断器。只根据提供的错误类别与运行元数据选择一个允许的修复动作；不能执行工具或要求扩大权限。输出严格JSON {"action":"允许动作之一"}。不需要任务正文。'},{role:'user',content:JSON.stringify(context)}]}),timeout]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
  const value=parseStrictJson(response?.response?.text||'');
  if(!value||Array.isArray(value)||Object.keys(value).length!==1||!choices.includes(value.action))throw Error('invalid advice');
  return {action:value.action,source:'llm'};
 }catch(error){
  if(signal?.aborted)throw error;
  return {action:{context:'compact_context',schema:'repair_schema',output:'increase_output',unexpected:'defer'}[kind],source:'local'};
 }
}
function auditSchemas(catalog){
 let checked=0,issues=0;const visit=s=>{
  if(!s||typeof s!=='object'||Array.isArray(s)){issues++;return;}
  if(s.type==='object'){
   if(s.properties!==undefined&&(!s.properties||typeof s.properties!=='object'||Array.isArray(s.properties)))issues++;
   const properties=s.properties&&typeof s.properties==='object'?s.properties:{};
   if(s.required!==undefined&&(!Array.isArray(s.required)||s.required.some(k=>typeof k!=='string'||!Object.hasOwn(properties,k))))issues++;
   for(const child of Object.values(properties))visit(child);
  }
  if(s.type==='array'&&s.items)visit(s.items);
  if(s.enum!==undefined&&(!Array.isArray(s.enum)||!s.enum.length))issues++;
 };
 for(const tool of catalog||[])if(tool.inputSchema){checked++;visit(tool.inputSchema);}
 return {checked,issues};
}
function applyAction(profile={},action,{code}={}){
 const next={...profile};
 if(action==='compact_context'){next.contextLevel=Math.min(2,(next.contextLevel||0)+1);if(code==='E_CONTEXT_WINDOW')next.budgetScale=.5;}
 if(action==='repair_schema')next.schemaHint=true;
 if(action==='increase_output')next.maxTokens=8192;
 return next;
}
// Whitelist only replaceable historical context; never trim task goals,
// current incoming messages, targets, authorization, tools, or receipts.
function compactValue(value,level){
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value))return value.map(x=>compactValue(x,level));
 const limits=level>1?{conversation:5,memories:2,attempts:3,knowledge:2,operatingKnowledge:2,recentEnded:1}:{conversation:10,memories:4,attempts:6,knowledge:4,operatingKnowledge:4,recentEnded:3};
 const protectedKeys=new Set(['incoming','ownerTask','currentOwnerRequest','goal','criteria','policy','subject','subjects','delivery','workRequest','ownerRequest','tools','confirmedEffects','knownArtifacts','currentFrame']);
 const next=Object.create(null);for(const [key,item] of Object.entries(value)){
  if(protectedKeys.has(key)){next[key]=item;continue;}
  if(Array.isArray(item)&&Object.hasOwn(limits,key)){
   const selected=['conversation','attempts','recentEnded'].includes(key)?item.slice(-limits[key]):item.slice(0,limits[key]);
   next[key]=selected.map(x=>compactValue(x,level));
  }else if(key==='context'&&typeof item==='string'&&typeof value.currentOwnerRequest==='string'){
   try{const parsed=JSON.parse(item);next[key]=Array.isArray(parsed)&&parsed.every(x=>x&&typeof x==='object'&&typeof x.role==='string')?JSON.stringify(parsed.slice(-(level>1?3:6))):item;}catch{next[key]=item;}
  }else next[key]=compactValue(item,level);
 }return next;
}
function applyProfile(options,profile){
 if(!profile)return options;
 const level=Math.min(2,Math.max(0,Number(profile.contextLevel)||0));
 const messages=(options.messages||[]).map(m=>{
  if(!level||m.role!=='user')return {...m};
  const compactText=t=>{try{return JSON.stringify(compactValue(JSON.parse(t),level));}catch{return t;}};
  return {...m,content:typeof m.content==='string'?compactText(m.content):Array.isArray(m.content)?m.content.map(part=>part?.type==='text'&&typeof part.text==='string'?{...part,text:compactText(part.text)}:part):m.content};
 });
 if(profile.schemaHint){
  const hint='上次结果没有通过本地 schema 校验。请重新依据原请求生成严格符合所给字段、类型和工具参数的完整 JSON；不要添加字段或改变任务范围。';
  const system=messages.find(m=>m.role==='system'&&typeof m.content==='string');
  if(system)system.content+='\n'+hint;else messages.unshift({role:'system',content:hint});
 }
 return {...options,messages,...(profile.maxTokens?{maxTokens:Math.min(8192,Math.max(4096,Number(profile.maxTokens)||4096))}:{}),...(profile.budgetScale===.5?{budgetScale:.5}:{})};
}
module.exports={category,incident,advise,applyAction,applyProfile,compactValue,auditSchemas};
