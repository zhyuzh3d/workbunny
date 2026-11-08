'use strict';
// Repairs are small, request-scoped adjustments, never executable code or new authority.
const crypto=require('node:crypto');
const {parseStrictJson}=require('./strict-json');
const BLOCKED=new Set(['E_PERMISSION_REQUIRED','E_TASK_AUTH','E_APP_CIRCUIT','E_GUI_BUSY','E_CAPTURE_BUSY','E_GUI_FOCUS_CHANGED','E_SUBMISSION_UNCERTAIN','E_NO_PROGRESS','E_WORKBUDDY_DRAFT_CONFLICT','E_WORKBUDDY_ROUTE_CONFLICT','ABORT_ERR','E_ABORTED']);
const OPTIONS={context:['compact_context','retry','defer'],schema:['repair_schema','retry','defer'],output:['increase_output','retry','defer'],response:['compact_response','retry','defer'],unexpected:['retry','defer'],stall:['reobserve','change_method','wait','ask_owner']};
function diagnostic(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const result={};for(const key of ['operation','method','model'])if(typeof value[key]==='string'&&/^[a-zA-Z0-9_.:-]{1,80}$/u.test(value[key]))result[key]=value[key];
 if(Number.isSafeInteger(value.candidateCount)&&value.candidateCount>=0&&value.candidateCount<=10000)result.candidateCount=value.candidateCount;
 if(value.guardChecks&&typeof value.guardChecks==='object'&&!Array.isArray(value.guardChecks)){
  const checks=Object.entries(value.guardChecks).filter(([key,passed])=>/^[a-zA-Z][a-zA-Z0-9]{0,47}$/u.test(key)&&typeof passed==='boolean').slice(0,16);
  if(checks.length)result.guardChecks=Object.fromEntries(checks);
 }
 for(const key of ['expectedBundleId','actualBundleId'])if(typeof value[key]==='string'&&/^[a-zA-Z0-9_.-]{1,160}$/u.test(value[key]))result[key]=value[key];
 for(const key of ['expectedPid','actualPid','expectedWindowId'])if(Number.isSafeInteger(value[key])&&value[key]>0)result[key]=value[key];
 if(value.completion&&typeof value.completion==='object'&&!Array.isArray(value.completion)){
  const source=value.completion,completion={};
  if(typeof source.model==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/u.test(source.model))completion.model=source.model;
  if(Number.isSafeInteger(source.maxOutputTokens)&&source.maxOutputTokens>0)completion.maxOutputTokens=source.maxOutputTokens;
  if(typeof source.finishReason==='string'&&/^[a-zA-Z0-9_-]{1,40}$/u.test(source.finishReason))completion.finishReason=source.finishReason;
  if(typeof source.hasReasoning==='boolean')completion.hasReasoning=source.hasReasoning;
  const usage=require('./chat-response').sanitizeUsage(source.usage);if(usage)completion.usage=usage;
  if(Object.keys(completion).length)result.completion=completion;
 }
 if(value.transport&&typeof value.transport==='object'&&!Array.isArray(value.transport)){
  const source=value.transport,transport={};
  if(['broker','local-jsonl'].includes(source.source))transport.source=source.source;
  if(['http-response','pipe-discovery','frame'].includes(source.stage))transport.stage=source.stage;
  if(['model-completion','model-catalog'].includes(source.requestKind))transport.requestKind=source.requestKind;
  if(Number.isSafeInteger(source.limitBytes)&&source.limitBytes>0)transport.limitBytes=source.limitBytes;
  if(Object.keys(transport).length)result.transport=transport;
 }
 if(value.schemaAudit&&typeof value.schemaAudit==='object'&&!Array.isArray(value.schemaAudit)){
  const source=value.schemaAudit,schemaAudit={};
  if(typeof source.protocol==='string'&&/^[a-z][a-z0-9-]{0,47}$/u.test(source.protocol))schemaAudit.protocol=source.protocol;
  if(typeof source.field==='string'&&/^[a-zA-Z][a-zA-Z0-9.\[\]]{0,95}$/u.test(source.field))schemaAudit.field=source.field;
  if(typeof source.expected==='string'&&/^[a-z][a-z0-9|._-]{0,95}$/u.test(source.expected))schemaAudit.expected=source.expected;
  if(['object','array','string','number','boolean','null','undefined'].includes(source.actualType))schemaAudit.actualType=source.actualType;
  if(Object.keys(schemaAudit).length)result.schemaAudit=schemaAudit;
 }
 const budget=require('./context-budget').diagnostic(value.budget);if(budget)result.budget=budget;
 return Object.keys(result).length?result:undefined;
}
function category(error){
 const code=String(error?.code||'');if(BLOCKED.has(code))return null;
 if(['E_CONTEXT_WINDOW','E_CONTEXT_BUDGET'].includes(code))return 'context';
 if(['E_MODEL_SCHEMA','E_REPLY_PROTOCOL'].includes(code))return 'schema';
 if(['E_OUTPUT_LIMIT','E_EMPTY_RESPONSE'].includes(code))return 'output';
 if(code==='E_PAYLOAD_TOO_LARGE')return 'response';
 if(/(?:timeout|超时|network|网络|连接|ECONNRESET|ETIMEDOUT)/iu.test(String(error?.message||'')))return null;
 return 'unexpected';
}
function incident(task,error,progress){
 const facts=diagnostic(error.diagnostic);
 // Changing timestamps or estimated request sizes does not create new
 // external evidence and must not renew the bounded recovery allowance.
 if(facts?.budget)facts.budget=Object.fromEntries(['context','output','inputBudget','imageCount'].filter(k=>Object.hasOwn(facts.budget,k)).map(k=>[k,facts.budget[k]]));
 return crypto.createHash('sha256').update(JSON.stringify([task.skill,error.code||'E_STEP',String(error.message||''),facts,task.inbox?.[0]?.key||'',task.state?.goalRevision||0,[...(progress?.state?.evidence||[])].sort()])).digest('hex').slice(0,24);
}
async function advise({kind,skill,code,attempt,phase,errorType,schemaAudit,progress,diagnostic:methodDiagnostic,signal,request,timeoutMs=12000}){
 const choices=OPTIONS[kind];if(!choices)throw Error('unsupported repair category');
 const timing=progress?Object.fromEntries(['elapsedMs','withoutProgressMs','waitingMs','stage','stageElapsedMs','repeatedEvidence','reviews','lastMethod','waitReason','facts','spent'].filter(k=>Object.hasOwn(progress,k)).map(k=>[k,progress[k]])):undefined;
 const safeDiagnostic=diagnostic(methodDiagnostic);
 const context={kind,skill,code,attempt,...(safeDiagnostic?{diagnostic:safeDiagnostic}:{}),...(phase?{phase}:{}),...(errorType?{errorType}:{}),...(schemaAudit?{schemaAudit}:{}),...(timing?{progress:timing}:{}),allowedActions:choices, constraints:'仅诊断可恢复的模型或任务错误；不能修改任务目标、权限、实际数据或已确认操作。连续核查没有新证据时要改变方法，不能用同一检查或笼统等待重复续期；时间只用于决策，不可编造成功或重发未知写入。'};
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
 // Input-window reductions belong to the one request rejected by the provider.
 // Persist content/output adjustments, never a previous request's input ceiling.
 const {budgetScale:legacyBudgetScale,...next}=profile;
 if(action==='compact_context')next.contextLevel=Math.min(2,(next.contextLevel||0)+1);
 if(action==='repair_schema')next.schemaHint=true;
 if(action==='increase_output'){next.maxTokens=8192;delete next.responseLevel;}
 if(action==='compact_response'){next.responseLevel=Math.min(2,(next.responseLevel||0)+1);delete next.maxTokens;}
 return next;
}
// One read-only retry changes the budget in the direction required by the
// observed failure. The caller owns the attempt count; this never repeats an
// action or alternates between opposite limits within another retry loop.
function responseRecovery(options,error){
 const requested=Number(options.maxTokens)||4096,effective=error?.diagnostic?.completion?.maxOutputTokens,current=Number.isSafeInteger(effective)&&effective>0?effective:requested;
 let maxTokens;
 if(error?.code==='E_OUTPUT_LIMIT'){
  if(current<requested||current>=8192)return null;
  maxTokens=applyAction({},'increase_output').maxTokens;
 }else if(error?.code==='E_PAYLOAD_TOO_LARGE'){
  maxTokens=Math.min(applyProfile(options,applyAction({},'compact_response')).maxTokens,Math.floor(current/2));
  if(maxTokens<512||maxTokens>=current)return null;
 }else return null;
 const {max_tokens,max_completion_tokens,max_output_tokens,...extraBody}=options.extraBody||{};
 return {...options,maxTokens,thinking:'low',extraBody:{...extraBody,reasoning_effort:'low'}};
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
 const response=profile.responseLevel?{maxTokens:profile.responseLevel>1?1024:2048,thinking:'low',extraBody:{...options.extraBody,reasoning_effort:'low'}}:{};
 return {...options,messages,...(profile.maxTokens?{maxTokens:Math.min(8192,Math.max(4096,Number(profile.maxTokens)||4096))}:{}),...response};
}
module.exports={OPTIONS,diagnostic,category,incident,advise,applyAction,applyProfile,responseRecovery,compactValue,auditSchemas};
