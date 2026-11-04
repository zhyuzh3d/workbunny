'use strict';
// Repairs are small, request-scoped adjustments, never executable code or new authority.
const crypto=require('node:crypto');
const {parseStrictJson}=require('./strict-json');
const BLOCKED=new Set(['E_PERMISSION_REQUIRED','E_TASK_AUTH','E_APP_CIRCUIT','E_GUI_BUSY','E_CAPTURE_BUSY','E_NO_PROGRESS','ABORT_ERR','E_ABORTED']);
const OPTIONS={context:['compact_context','retry','defer'],schema:['repair_schema','retry','defer'],output:['increase_output','retry','defer'],response:['compact_response','retry','defer'],unexpected:['retry','defer'],stall:['reobserve','change_method','wait','ask_owner']};
function category(error){
 const code=String(error?.code||'');if(BLOCKED.has(code))return null;
 if(['E_CONTEXT_WINDOW','E_CONTEXT_BUDGET'].includes(code))return 'context';
 if(['E_MODEL_SCHEMA','E_REPLY_PROTOCOL'].includes(code))return 'schema';
 if(['E_OUTPUT_LIMIT','E_EMPTY_RESPONSE'].includes(code))return 'output';
 if(code==='E_PAYLOAD_TOO_LARGE')return 'response';
 if(/(?:timeout|超时|network|网络|连接|ECONNRESET|ETIMEDOUT)/iu.test(String(error?.message||'')))return null;
 return 'unexpected';
}
function incident(task,error){return crypto.createHash('sha256').update(JSON.stringify([task.skill,error.code||'E_STEP',String(error.message||''),task.inbox?.[0]?.key||'',task.state?.stepSequence||0,task.state?.goalRevision||0])).digest('hex').slice(0,24);}
async function advise({kind,skill,code,attempt,phase,errorType,schemaAudit,progress,signal,request,timeoutMs=12000}){
 const choices=OPTIONS[kind];if(!choices)throw Error('unsupported repair category');
 const timing=progress?Object.fromEntries(['elapsedMs','withoutProgressMs','waitingMs','stage','stageElapsedMs','repeatedEvidence','reviews','lastMethod','waitReason','facts','spent'].filter(k=>Object.hasOwn(progress,k)).map(k=>[k,progress[k]])):undefined;
 const context={kind,skill,code,attempt,...(phase?{phase}:{}),...(errorType?{errorType}:{}),...(schemaAudit?{schemaAudit}:{}),...(timing?{progress:timing}:{}),allowedActions:choices, constraints:'仅诊断可恢复的模型或任务错误；不能修改任务目标、权限、实际数据或已确认操作。连续核查没有新证据时要改变方法，不能用同一检查或笼统等待重复续期；时间只用于决策，不可编造成功或重发未知写入。'};
 try{
  const invoke=request||require('./verification-transport').requestVerification,controller=new AbortController();
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)controller.abort();
  let timer;
  let response;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('diagnostic timeout'));},Math.min(12000,Math.max(1,timeoutMs)));});
   response=await Promise.race([invoke({signal:controller.signal,messages:[{role:'system',content:require('./action-progress').GUIDANCE+'你是Bunny，负责根据错误类别与运行元数据自主决定恢复方法，不能扩大权限。'+(kind==='stall'?'耗时和重复是供你判断的事实，不是任务失败结论。判断怎样取得关键新信息、换方法、等待实际条件或请求主人帮助。输出JSON {"action":"允许动作之一","nextStep":"具体下一步及依据"}；选择wait时另加waitFor为具体等待条件、waitMs为下次检查间隔（毫秒）。不要反复重试同一无效检查。':'输出严格JSON {"action":"允许动作之一"}。不需要任务正文。')},{role:'user',content:JSON.stringify(context)}]}),timeout]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
  const value=parseStrictJson(response?.response?.text||'');
  if(!value||Array.isArray(value)||!choices.includes(value.action)||kind!=='stall'&&Object.keys(value).length!==1)throw Error('invalid advice');
  if(kind==='stall'&&value.nextStep!==undefined&&(typeof value.nextStep!=='string'||!value.nextStep.trim()||value.nextStep.length>1000))throw Error('invalid next step');
  if(kind==='stall'&&value.action==='wait'&&(typeof value.waitFor!=='string'||!value.waitFor.trim()||value.waitFor.length>300||!Number.isFinite(value.waitMs)))throw Error('waiting needs a condition');
  return {action:value.action,source:'llm',...(kind==='stall'?{nextStep:value.nextStep,waitFor:value.waitFor,waitMs:value.waitMs}:{})};
 }catch(error){
  if(signal?.aborted)throw error;
  return {action:{context:'compact_context',schema:'repair_schema',output:'increase_output',response:'compact_response',unexpected:'defer',stall:'reobserve'}[kind],source:'local'};
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
 if(action==='compact_response')next.responseLevel=Math.min(2,(next.responseLevel||0)+1);
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
 const response=profile.responseLevel?{maxTokens:profile.responseLevel>1?1024:2048,thinking:'low',budgetScale:.5,extraBody:{...options.extraBody,reasoning_effort:'low'}}:{};
 return {...options,messages,...(profile.maxTokens?{maxTokens:Math.min(8192,Math.max(4096,Number(profile.maxTokens)||4096))}:{}),...(profile.budgetScale===.5?{budgetScale:.5}:{}),...response};
}
module.exports={OPTIONS,category,incident,advise,applyAction,applyProfile,compactValue,auditSchemas};
