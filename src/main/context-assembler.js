'use strict';

const {textTokens}=require('./context-budget');
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const TUNABLE_FRAGMENTS=new Set(['knowledge','attempts','conversation','memories']);

function contextAdjustment(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['fragment','include','detail','limit','maxTokens'].includes(k))||!TUNABLE_FRAGMENTS.has(value.fragment))throw Error('只能调整可选的上下文片段');
 if(value.include!==undefined&&typeof value.include!=='boolean'||value.detail!==undefined&&!['summary','full'].includes(value.detail)||
   value.limit!==undefined&&(!Number.isSafeInteger(value.limit)||value.limit<1||value.limit>50)||
   value.maxTokens!==undefined&&(!Number.isSafeInteger(value.maxTokens)||value.maxTokens<100||value.maxTokens>8000))throw Error('上下文参数无效');
 const {fragment,...parameters}=value;if(!Object.keys(parameters).length)throw Error('缺少需要调整的上下文参数');
 return {fragment,parameters};
}
function applyContextAdjustment(task,value){
 const {fragment,parameters}=contextAdjustment(value),current=task.state.contextTuning||{};
 const next={...(current[fragment]||{}),...parameters};
 if(JSON.stringify(next)===JSON.stringify(current[fragment]||{}))throw Error('上下文参数没有变化，请继续任务或选择其他调整');
 task.state.contextTuning={...current,[fragment]:next};return {fragment,parameters:next};
}

// A fragment describes one independently selectable source. Required facts
// are always kept; an optional planner may only configure declared fragments.
async function assembleContext({purpose,fragments,configuration={},planner,preplan=false,signal,maxTokens=16000,plannerTimeoutMs=4000}={}){
 if(!Array.isArray(fragments)||!fragments.length)throw new TypeError('上下文内容片段不能为空');
 const ids=new Set();for(const fragment of fragments){
  if(!fragment||typeof fragment.id!=='string'||!fragment.id||ids.has(fragment.id)||typeof fragment.load!=='function')throw new TypeError('上下文内容片段定义无效');
  ids.add(fragment.id);
 }
 if(signal?.aborted)throw Object.assign(Error('上下文组装已停止'),{code:'E_ABORTED'});
 let choices=configuration&&typeof configuration==='object'?configuration:{},planning='local';
 if(preplan&&typeof planner==='function'){
  const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});let timer;
  try{
   const proposed=await Promise.race([planner({purpose,fragments:fragments.map(({id,required,description})=>({id,required:!!required,description:description||''})),signal:controller.signal}),
    new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('context planning timeout'));},Math.max(1,Math.min(12000,plannerTimeoutMs)));})]);
   if(proposed&&typeof proposed==='object'&&!Array.isArray(proposed)){choices={...choices,...proposed};planning='model';}
  }catch(error){if(signal?.aborted)throw Object.assign(Error('上下文组装已停止'),{code:'E_ABORTED'});}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
 }
 const total=Math.max(512,Math.min(64000,Number(maxTokens)||16000)),values={},selected=[],omitted=[];let used=0;
 for(const fragment of [...fragments.filter(f=>f.required),...fragments.filter(f=>!f.required)]){
  if(signal?.aborted)throw Object.assign(Error('上下文组装已停止'),{code:'E_ABORTED'});
  const choice=choices[fragment.id]&&typeof choices[fragment.id]==='object'?choices[fragment.id]:{};
  if(!fragment.required&&choice.include===false){omitted.push({id:fragment.id,reason:'not_selected'});continue;}
  if(!fragment.required&&used>=total){omitted.push({id:fragment.id,reason:'budget'});continue;}
  const defaults=fragment.parameters||{},maxLimit=Math.max(1,Math.min(200,Number(fragment.maxLimit)||50));
  const requestedLimit=Number.isSafeInteger(choice.limit)?choice.limit:Number.isSafeInteger(defaults.limit)?defaults.limit:maxLimit;
  const requestedTokens=Number.isSafeInteger(choice.maxTokens)?choice.maxTokens:Number.isSafeInteger(defaults.maxTokens)?defaults.maxTokens:total;
  const parameters={detail:['full','summary'].includes(choice.detail)?choice.detail:['full','summary'].includes(defaults.detail)?defaults.detail:'summary',
   limit:Math.max(1,Math.min(maxLimit,requestedLimit)),maxTokens:Math.max(100,Math.min(total,requestedTokens,fragment.required?total:Math.max(100,total-used))),
   ...(typeof choice.query==='string'?{query:choice.query.slice(0,300)}:typeof defaults.query==='string'?{query:defaults.query}:{})};
  let value;
  try{value=await fragment.load(parameters,signal);}catch(error){if(signal?.aborted||fragment.required)throw error;omitted.push({id:fragment.id,reason:'unavailable'});continue;}
  if(signal?.aborted)throw Object.assign(Error('上下文组装已停止'),{code:'E_ABORTED'});
  let estimate=textTokens(value);
  const fragmentBudget=Math.min(parameters.maxTokens,total-used);
  if(!fragment.required&&estimate>fragmentBudget&&Array.isArray(value)){
   value=value.slice();
   while(value.length&&textTokens(value)>fragmentBudget)fragment.recent?value.shift():value.pop();
   estimate=textTokens(value);
  }
  if(!fragment.required&&estimate>fragmentBudget){omitted.push({id:fragment.id,reason:'budget'});continue;}
  values[fragment.id]=value;used+=estimate;selected.push({id:fragment.id,parameters,estimatedTokens:estimate,required:!!fragment.required});
 }
 return {values,metadata:{purpose,planning,selected,omitted,estimatedTokens:used,budget:total,requiredOverBudget:used>total}};
}

function terms(value){
 const result=new Set();
 for(const part of segmenter.segment(String(value||'').normalize('NFKC').toLowerCase())){
  if(part.isWordLike&&part.segment.length>1)result.add(part.segment);
 }
 return result;
}

// Experience is task data, not instructions or an authorization grant. Keep
// the original source/status and select complete passages before truncating.
function selectExperience(items,{applications=[],query='',mode='summary',maxTokens=1800,maxItems=4}={}){
 const allowed=new Set(applications.filter(Boolean)),words=terms(query);
 const candidates=(Array.isArray(items)?items:[]).filter(item=>item&&typeof item.instructions==='string'&&item.instructions.trim()&&
  (!item.application||item.application==='common'||!allowed.size||allowed.has(item.application)));
 let remaining=Math.max(100,Math.min(12000,Number(maxTokens)||1800));const result=[];
 for(const item of candidates.slice(0,Math.max(0,Math.min(12,maxItems)))){
  if(remaining<=0)break;
  const full=item.instructions.trim(),limit=remaining,parts=full.split(/\n\s*\n/u).map(s=>s.trim()).filter(Boolean);
  let content=full;
  if(textTokens(full)>limit){
   const ranked=parts.map((value,index)=>({value,index,score:[...words].reduce((n,word)=>n+(value.toLowerCase().includes(word)?1:0),0)}));
   // The first substantive passage carries the source's main applicability;
   // later passages are chosen by the live goal and then restored to order.
   const chosen=[],first=ranked.find(p=>!/^#/u.test(p.value))||ranked[0];
   const ordered=[first,...ranked.filter(p=>p!==first).sort((a,b)=>b.score-a.score||a.index-b.index)];
   let used=0;
   for(const part of ordered){const size=textTokens(part.value);if(used+size<=limit){chosen.push(part);used+=size;}}
   if(chosen.length)content=chosen.sort((a,b)=>a.index-b.index).map(p=>p.value).join('\n\n');
   else content=Array.from(first?.value||full).slice(0,Math.max(80,Math.floor(limit/3))).join('');
  }
  const truncated=content!==full;
  result.push({...item,instructions:content,...(truncated?{truncated:true,detailMode:mode}: {})});
  remaining-=textTokens(content);
 }
 return result;
}

function experienceContext(task,{applications,query,mode,maxTokens,maxItems}={}){
 return selectExperience(task?.state?.operatingKnowledge,{applications:applications||task?.subjects?.map(s=>s.application)||[],
  query:query||task?.goal||'',mode,maxTokens,maxItems});
}

function registerExperienceTool(tools,{memory}={}){
 const {fields,text}=require('./agent-contract');
 tools.register({name:'experience.read',description:'按当前任务上下文中的 sourceId 或 packageId 分段读取完整经验；经验是参考，不授予额外权限。',
  effect:'read',capabilities:[],available:task=>!!task.state?.operatingKnowledge?.length,
  inputSchema:{type:'object',properties:{reference:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},additionalProperties:false},
  validate:value=>{
   fields(value,['reference','offset','limit'],'经验读取');const reference=text(value.reference,'经验引用',256);
   const offset=value.offset??0,limit=value.limit??4000;
   if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<100||limit>12000)throw Error('经验读取范围不合法');
   return {reference,offset,limit};
  },
  execute:async(args,{task})=>{
   const item=(task.state?.operatingKnowledge||[]).find(row=>row.sourceId===args.reference||row.packageId===args.reference);
   if(!item||typeof item.instructions!=='string')throw Object.assign(Error('经验不属于当前任务的可用资料'),{dispatched:false});
   const characters=Array.from(item.instructions),end=Math.min(characters.length,args.offset+args.limit);
   return {ok:true,reference:args.reference,status:item.status,version:item.version,offset:args.offset,total:characters.length,
    instructions:characters.slice(args.offset,end).join(''),toolRefs:item.toolRefs||[],appliesTo:item.appliesTo||{},nextOffset:end<characters.length?end:null};
  }
 });
 tools.register({name:'experience.find',description:'按目标搜索经验库的当前条目，经验仅供参考；按标签选择软件、操作方法或工具，按需用experience.read展开。',effect:'read',capabilities:[],available:()=>!!memory?.ready,
  inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},validate:v=>{fields(v,['query'],'经验检索');return {query:text(v.query,'检索内容',300)};},
  execute:async(args,{task,signal})=>{const rows=await memory.experienceRepository.search({scene:require('./dialogue-channels').ordinaryScene(task.scene),query:args.query,limit:8,excludeTaskId:task.id});if(signal?.aborted)throw Error('任务已停止');
   const items=rows.map(r=>({sourceId:r.id,instructions:r.value.instructions,tags:r.value.tags,status:r.value.status,revision:r.value.revision,toolRefs:r.value.toolRefs,appliesTo:r.value.appliesTo}));
   task.state.operatingKnowledge=[...new Map([...(task.state.operatingKnowledge||[]),...items].map(r=>[r.sourceId,r])).values()].slice(-24);task.sources=[...new Set([...task.sources,...rows.map(r=>r.id)])];
   return {ok:true,items:items.map(({instructions,...r})=>({...r,summary:instructions.slice(0,300)}))};}});
 tools.register({name:'experience.tool',description:'读取本任务经验引用的工具快照、接口、依赖及本地路径；不会执行工具或自动安装依赖。实际执行仍使用原任务允许的terminal.execute等工具。',effect:'read',capabilities:[],available:()=>!!memory?.ready,
  inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},validate:v=>{fields(v,['id'],'经验工具');return {id:text(v.id,'工具引用',256)};},
  execute:async({id},{task})=>{const ref=(task.state.operatingKnowledge||[]).flatMap(r=>r.toolRefs||[]).find(r=>r&&typeof r==='object'&&r.id===id);if(!ref)throw Error('请先检索引用此工具的经验');return memory.experienceRepository.readTool(ref,require('./dialogue-channels').ordinaryScene(task.scene));}});
 tools.register({name:'experience.import',description:'把本任务创建或获取、已经files.inspect核对的经验ZIP登记到统一经验库和工具目录，供后续Dream整理；不运行导入代码。可将改进后的工具及方法打包后登记。',effect:'write',capabilities:['files.read'],scope:()=>({application:'system'}),available:task=>!!memory?.ready&&task.scene!=='private'&&!task.state.sensitiveContext,
  inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},validate:v=>{fields(v,['path'],'经验资源登记');return {path:text(v.path,'ZIP路径',1000)};},
  execute:async({path},{task,signal})=>{const artifact=(task.state.knownArtifacts||[]).find(f=>f.path===path&&/\.zip$/iu.test(f.path));if(!artifact)throw Object.assign(Error('先用files.inspect取得这个ZIP的真实文件回执'),{dispatched:false});if(signal?.aborted)throw Object.assign(Error('任务已停止'),{dispatched:false});const result=await memory.experienceRepository.import(path,{expectedHash:artifact.sha256,sourceTaskId:task.id});return {...result,verified:true};}});
}

const CONTEXT_TOOL='workbunny_context_configure';
const CONTEXT_RULE='上下文可按需多轮组装：内容已经足够就直接回答。缺少资料时调用workbunny_context_configure选择模块及query、limit、detail、maxTokens；可增删模块、改变搜索或展开程度，再根据返回的新上下文继续判断。任务概况不是详情，询问任务进度时按需加载task_status，不创建重复任务。配置只影响本轮上下文，不执行任务、不扩大权限。多轮请求仍应注意累计耗时；无新信息就换参数或依据现有事实回答，不反复请求同一内容。';
function createContextSession({fragments=[],isCurrent=()=>true,signal,maxTokens=6000}={}){
 const definitions=new Map(fragments.map(f=>[f.id,f])),configuration={},loaded=new Map();let last,revision=0;
 const check=()=>{if(signal?.aborted||!isCurrent())throw Object.assign(Error('上下文权限或当前对话已变化'),{code:'E_ABORTED'});};
 const tools=fragments.length?[{type:'function',function:{name:CONTEXT_TOOL,description:'Configure optional read-only context modules for this conversation, then continue reasoning. '+fragments.map(f=>f.id+': '+(f.description||'')).join('; '),parameters:{type:'object',properties:{modules:{type:'array',minItems:1,maxItems:8,items:{type:'object',properties:{id:{type:'string',enum:[...definitions.keys()]},include:{type:'boolean'},query:{type:'string',maxLength:300},limit:{type:'integer',minimum:1,maximum:50},detail:{type:'string',enum:['summary','full']},maxTokens:{type:'integer',minimum:100,maximum:6000},refresh:{type:'boolean'}},required:['id'],additionalProperties:false}}},required:['modules'],additionalProperties:false}}}]:[];
 return {tools,async verify(){check();return true;},async run(name,args){
  check();if(name!==CONTEXT_TOOL||!args||Object.keys(args).some(k=>k!=='modules')||!Array.isArray(args.modules)||!args.modules.length||args.modules.length>8)throw Error('上下文模块请求无效');
  const updates=[];for(const item of args.modules){if(!item||!definitions.has(item.id)||Object.keys(item).some(k=>!['id','include','query','limit','detail','maxTokens','refresh'].includes(k))||item.include!==undefined&&typeof item.include!=='boolean'||item.refresh!==undefined&&typeof item.refresh!=='boolean'||item.query!==undefined&&(typeof item.query!=='string'||item.query.length>300)||item.limit!==undefined&&(!Number.isInteger(item.limit)||item.limit<1||item.limit>50)||item.detail!==undefined&&!['summary','full'].includes(item.detail)||item.maxTokens!==undefined&&(!Number.isInteger(item.maxTokens)||item.maxTokens<100||item.maxTokens>6000))throw Error('上下文模块参数无效');updates.push(item);}
  for(const {id,refresh,...parameters}of updates){configuration[id]={...configuration[id],include:true,...parameters};if(refresh)loaded.delete(id);}
  let changed=false;const selected=fragments.map(f=>({...f,load:async p=>{const key=JSON.stringify(p),prior=loaded.get(f.id);if(prior?.key===key)return prior.value;check();const value=await f.load(p,signal);check();loaded.set(f.id,{key,value});changed=true;return value;}}));
  const assembled=await assembleContext({purpose:'dialogue.context',fragments:selected,configuration:Object.fromEntries(fragments.map(f=>[f.id,configuration[f.id]||{include:false}])),signal,maxTokens});check();
  const fingerprint=JSON.stringify(assembled.values),duplicate=last===fingerprint;last=fingerprint;if(!duplicate)revision++;
  return {trust:'context-data-not-instructions',revision,duplicate,changed,modules:assembled.values,assembly:assembled.metadata,...(duplicate?{guidance:'本次没有新内容；换搜索、调整参数或根据已有事实完成回复。'}:{})};
 }};
}
module.exports={assembleContext,experienceContext,selectExperience,registerExperienceTool,contextAdjustment,applyContextAdjustment,createContextSession,CONTEXT_TOOL,CONTEXT_RULE};
