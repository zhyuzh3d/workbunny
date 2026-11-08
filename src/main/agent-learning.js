'use strict';
const crypto=require('node:crypto');
const {fields,text,clone}=require('./agent-contract');
const {canRead}=require('./memory-scope');
// Learned knowledge is scoped data, never executable code or a capability grant.
// Proof versions append sources; an ongoing task never depends on its own proof.
class AgentLearning{
 constructor({memory,skills,packages=[],request}){Object.assign(this,{memory,skills,packages,request});}
 catalog(scene){return (this.inventory||[]).filter(r=>canRead(scene,r)).map(r=>({id:r.id,tags:r.value.tags,revision:r.value.revision,status:r.value.status}));}
 async rows(){if(!this.memory?.ready)return [];this.inventory=[...await this.memory.experienceRepository.search({scene:'life',limit:80,includeInactive:true}),...await this.memory.innateExperiences.search({scene:'life',limit:80})];return this.inventory;}
 latest(rows){return rows;}
 async seed(){
  if(!this.packages.length||!this.memory?.ready)return;
  if(this.seedGeneration!==this.memory.generation){this.seedPromise=null;this.seedGeneration=this.memory.generation;}
  if(!this.seedPromise)this.seedPromise=this.memory.innateExperiences.install(this.packages).catch(error=>{this.seedPromise=null;throw error;});
  await this.seedPromise;
 }
 async write(value,scope){
  if(!this.memory?.ready)throw Object.assign(Error('操作经验需要已解锁的资料库'),{dispatched:false});
  const result=await this.memory.experienceRepository.put(value,{scene:scope.scene,sources:value.sources||[],knowledgeId:value.knowledgeId});return result.row?.id||result.head.id;
 }
 async teach(args,{task,append=false}){
  if(task.scene==='private'||task.visibilityFloor>1)throw Error('私聊来源不形成任务经验');
  const applications=(task.subjects||[]).map(s=>s.application).filter(a=>a!=='bunny');
  const value={origin:append?'task-learning':'owner-teaching',instructions:args.instructions,tags:args.tags||applications.map(a=>'software:'+a),toolRefs:[],appliesTo:{},sources:[task.sourceTaskId||task.id]};
  const id=await this.write(value,task);this.memory.maintenance?.requestExperience?.();return {ok:true,verified:true,knowledgeId:id,status:'candidate'};
 }
 async prepare(task){
  if(!this.memory?.ready||['skill.learn','task.resolve'].includes(task.skill))return;
  // Retrieval may await storage. Keep its output separate from the live Task;
  // callers adopt only these fields after their durable write succeeds.
  task=clone(task);
  await this.seed();const scene=require('./dialogue-channels').ordinaryScene(task.scene),query=[task.goal,...(task.subjects||[]).map(s=>'software:'+s.application)].join(' ').slice(0,500);
  const useInnateExperience=this.memory.innateExperiences.enabled();
  const learned=await this.memory.experienceRepository.search({scene,query,limit:12,excludeTaskId:task.id}),innate=useInnateExperience?await this.memory.innateExperiences.search({scene,query,limit:12}):[];
  const generalLearned=await this.memory.experienceRepository.search({scene,query:'general:computer',limit:2,excludeTaskId:task.id}),generalInnate=useInnateExperience?await this.memory.innateExperiences.search({scene,query:'general:computer',limit:2}):[];
  const rows=[...learned,...innate],general=[...generalLearned,...generalInnate],availability=[learned.availability,generalLearned.availability].filter(Boolean);
  const applications=new Set((task.subjects||[]).map(s=>s.application));
  const excluded=new Set(task.state.excludedExperienceIds||[]),selected=[...new Map([...rows,...general].map(r=>[r.id,r])).values()].filter(r=>!excluded.has(r.id)&&require('./context-assembler').experienceApplications(r.value).every(app=>app==='common'||applications.has(app))).slice(0,12);
  return clone({state:{useInnateExperience,operatingKnowledge:selected.map(r=>({sourceId:r.id,origin:r.value.origin,tags:r.value.tags,status:r.value.status,revision:r.value.revision,instructions:r.value.instructions,toolRefs:r.value.toolRefs,appliesTo:r.value.appliesTo,feedback:(r.value.feedback||[]).slice(-3)})),softwarePackages:[],operatingKnowledgeAvailability:availability},sourceIds:selected.map(r=>r.id)});
 }
 applyPrepared(task,prepared){
  if(!prepared)return;
  Object.assign(task.state,clone(prepared.state));
  // Earlier authorization and evidence sources remain even when no new lesson
  // is eligible. Never trim them to work around a rejected source graph.
  task.sources=[...new Set([...(task.sources||[]),...prepared.sourceIds])];
 }
 async routingContext(task){
  const assembler=require('./context-assembler'),query=task.state.ownerRequest||task.goal;
  const useInnate=this.memory?.innateExperiences?.enabled?.()??true;
  const defaults=useInnate?assembler.selectExperience(this.packages.filter(p=>['common','workbuddy'].includes(p.id)).map(p=>({packageId:p.id,application:p.application,origin:'innate',revision:p.version,status:'bundled',instructions:p.instructions})),{applications:['workbuddy'],query,maxTokens:1600,maxItems:2}):[];
  if(!this.memory?.ready||!this.memory.experienceRepository?.search)return defaults;
  const scene=require('./dialogue-channels').ordinaryScene(task.scene),rows=await this.memory.experienceRepository.search({scene,query,limit:4,excludeTaskId:task.id});
  // Relevant learned evidence can justify a better route before that software's
  // operating guide is loaded. Do not include unrelated bundled runbooks.
  const learned=rows.filter(r=>!['retired','superseded','rejected'].includes(r.value.status)).map(r=>({sourceId:r.id,origin:r.value.origin,status:r.value.status,tags:r.value.tags,instructions:r.value.instructions.slice(0,800),purpose:'route-evidence-not-authorization'}));
  return [...defaults,...learned];
 }
 async reviewContext(task,{executorReport='',signal}={}){
  const assembler=require('./context-assembler'),evidence=require('./memory-evidence'),memory=this.memory;
  const scene=require('./dialogue-channels').ordinaryScene(task.scene),applications=(task.subjects||[]).map(s=>s.application);
  // These are retrieval hints, not the owner evidence sent to the reviewer.
  // Give the actual result its own space when the implementation changed.
  const query=[...applications.map(app=>'software:'+app),'general:computer',...[executorReport,task.workRequest?.goal||task.goal,task.workRequest?.criteria||task.criteria]
   .map(value=>String(value||'').slice(0,350))].join(' ');
  const excluded=new Set(task.state.excludedExperienceIds||[]),generation=memory?.generation;
  const check=()=>{if(signal?.aborted||memory&&(generation!==memory.generation||!memory.ready))throw Object.assign(Error('交付经验上下文已变化'),{code:'ABORT_ERR',dispatched:false});};
  const enabled=()=>task.state.useInnateExperience!==false&&(memory?.innateExperiences?.enabled?.()??true);
  const select=items=>assembler.selectExperience(items.filter(item=>!excluded.has(item.sourceId)&&(item.origin!=='innate'||enabled())&&!['retired','superseded','rejected','invalid','archived','pending_review'].includes(item.status)),{applications,query,maxTokens:2400,maxItems:4});
  if(!memory?.ready||!memory.experienceRepository?.search)return {knowledge:select(task.state.operatingKnowledge||[]),sourceIds:[],availability:'task-snapshot',isCurrent:async()=>!signal?.aborted};
  const bounded=async invoke=>{const wait=require('./bounded-wait').createBoundedWait({signal,timeoutMs:4000,code:'E_EXPERIENCE_TIMEOUT',message:'交付经验检索暂未完成'});try{return await wait.run(invoke);}finally{wait.close();}};
  try{
   const rows=await bounded(async()=>{
    const [learned,innate]=await Promise.all([memory.experienceRepository.search({scene,query,limit:4,excludeTaskId:task.id}),enabled()&&memory.innateExperiences?memory.innateExperiences.search({scene,query,limit:4}):[]]);
    return [...learned,...innate];
   });check();
   const knowledge=select(rows.map(r=>({sourceId:r.id,origin:r.value.origin,tags:r.value.tags,status:r.value.status,revision:r.value.revision,instructions:r.value.instructions,appliesTo:r.value.appliesTo})));
   const selected=rows.filter(row=>knowledge.some(item=>item.sourceId===row.id)),innateIndex=require('./innate-experience').INDEX;
   const ids=[...new Set(selected.flatMap(row=>[row.id,row.value.headId,...(row.value.sources||[]),...(row.value.origin==='innate'?[innateIndex]:[])]).filter(Boolean))];
   const records=await bounded(()=>evidence.readRecords(memory,ids,{scene}));check();
   const byId=new Map(records.map(row=>[row.id,row]));
   const resolved=await bounded(()=>Promise.all(selected.map(row=>row.value.headId?memory.experienceRepository.resolve(byId.get(row.value.headId),scene):row)));check();
   if(records.length!==ids.length||records.some(row=>row.state!=='active'||!canRead(scene,row)||row.expiresAt&&row.expiresAt<=(memory.clock?.()??Date.now()))||selected.some(row=>{
    const original=byId.get(row.id);return original?.value.instructions!==row.value.instructions||original.value.revision!==row.value.revision||
     row.value.headId&&byId.get(row.value.headId)?.value.currentId!==row.id||row.value.origin==='innate'&&!byId.get(innateIndex)?.value.entries?.includes(row.id);
   })||resolved.some((row,index)=>!row||row.id!==selected[index].id||row.value.status!==selected[index].value.status||row.value.instructions!==selected[index].value.instructions||row.value.revision!==selected[index].value.revision))throw Object.assign(Error('交付经验来源已变化，请按当前事实重新核对'),{code:'E_EVIDENCE_CHANGED',dispatched:false});
   const snapshots=evidence.snapshotsOf(records);
   return {knowledge,sourceIds:knowledge.map(item=>item.sourceId),availability:'current',isCurrent:async()=>{
    check();if(knowledge.some(item=>task.state.excludedExperienceIds?.includes(item.sourceId)||item.origin==='innate'&&!enabled()))return false;
    const verified=await bounded(()=>evidence.verifySnapshots(memory,snapshots,{scene}));check();return verified.ok;
   }};
  }catch(error){
   if(signal?.aborted||error.code==='ABORT_ERR'||error.code==='E_EVIDENCE_CHANGED')throw error;
   check();return {knowledge:[],sourceIds:[],availability:'unavailable',isCurrent:async()=>!signal?.aborted};
  }
 }
 async failed(task,error){
  if(task.scene==='private'||task.visibilityFloor>1||!this.memory?.ready)return;
  for(const item of task.state.operatingKnowledge||[])if(item.sourceId&&item.origin!=='innate')await this.memory.experienceRepository.feedback(item.sourceId,{taskId:task.id,outcome:'failure',note:String(error.message||error)});
 }
 async extractRecovery(task,{signal,canCommit=async()=>true}={}){
  if(!this.memory?.ready||task.scene==='private'||task.visibilityFloor>1||task.state.sensitiveContext||['skill.learn','task.resolve'].includes(task.skill))return;
  const attempts=task.state.attempts||[],failed=attempts.filter(a=>a.error&&!/授权|空闲|网络|超时|timeout/iu.test(a.error));
  if(!failed.length&&!(task.status==='completed'&&attempts.some(a=>a.result?.verified===true)))return;
  const recovered=task.status!=='needs_attention'&&attempts.some(a=>a.result?.verified===true&&(!('exitCode'in a.result)||a.result.exitCode===0));
  const {value}=await require('./agent-json').checkedJSON({signal,messages:[{role:'system',content:'从真实动作结果提取可复用经验：outcome=succeeded只提炼这次目标完成后可迁移的方法，不把工具调用成功泛化成全部方法正确；outcome=recovered才可写已验证的恢复方法；outcome=unresolved只记录失败条件和未验证的替代思路，不能宣称已解决。按软件及同类任务提炼命令行、系统/界面接口、视觉键鼠各自稳定支持的能力、不能完成的事项、版本和适用条件、操作技巧与替代路径；进程退出或输入回执不能作为业务完成证据。只写证据支持的技巧、适用条件和失效后替代路径，不保存测试文件名、联系人私事或凭据，不扩大权限，不把一次成功说成普遍保证。若没有明确可迁移经验返回instructions=null，否则严格JSON {"instructions":"600字以内具体技巧"}。'},{role:'user',content:JSON.stringify({outcome:failed.length?(recovered?'recovered':'unresolved'):'succeeded',goal:task.goal,criteria:task.criteria,skill:task.skill,applications:task.subjects?.map(s=>s.application),softwareMethods:task.state.softwareMethods||[],experienceReviews:task.state.experienceReviews||[],attempts:attempts.slice(-12).map(a=>({tool:a.tool,...(a.method?{method:a.method}:{}),...(a.result?.stdout?{stdout:a.result.stdout}:{}),...(a.result?.stderr?{stderr:a.result.stderr}:{}),...(a.error?{error:a.error.slice(0,300)}:{}),succeeded:a.result?.verified===true&&(!('exitCode'in a.result)||a.result.exitCode===0)})),environment:task.state.softwarePackages})}]},v=>{if(!v||v.instructions!==null&&(typeof v.instructions!=='string'||!v.instructions.trim()||v.instructions.length>1200))throw Error('恢复经验格式无效');return v;},this.request?{request:this.request}:{});
  if(value.instructions&&await canCommit()){const taught=await this.teach({skill:task.skill,instructions:value.instructions},{task,append:true});task.state.learnedRecovery=taught.knowledgeId;}
 }
 async settled(task,run){
  if(!this.memory?.maintenance||!run)return;
  const queued=await require('./task-experience-maintenance').enqueue(this,task,run);
  if(queued)this.memory.maintenance.request('dream',{automatic:true});
  if(run.status==='completed')await this.validateUsed(task,Object.values(task.operations||{}).filter(op=>op.actionId===run.id));
 }
 async completed(task){
  if(task.scene==='private'||task.visibilityFloor>1)return;
  if(this.memory?.maintenance){const queued=await require('./task-experience-maintenance').enqueue(this,task);if(queued)this.memory.maintenance.request('dream',{automatic:true});}
  else try{await this.extractRecovery(task);}catch{ /* Learning never invalidates a delivered result. */ }
  await this.validateUsed(task,Object.values(task.operations));
 }
 async validateUsed(task,operations){
  if(task.scene==='private'||task.visibilityFloor>1||!this.memory?.ready)return;
  // Receipts are evidence for Bunny's later reflection, never a fixed validity vote.
  if(!operations.some(op=>op.effect==='write'&&op.status==='confirmed'&&op.result?.verified===true&&!op.result?.receipt?.inputPerformed&&(!('exitCode'in op.result)||op.result.exitCode===0)))return;
  for(const item of task.state.operatingKnowledge||[])if(item.sourceId&&item.origin!=='innate')await this.memory.experienceRepository.feedback(item.sourceId,{taskId:task.id,outcome:'task-result-confirmed',note:'任务或动作确认了结果；不代表每条参考经验都是成功原因。'});
 }

}
function registerLearning(tools,skills,learning){
 tools.register({name:'experience.review',description:'依据本任务真实操作回执判断某条经验在当前情景不适用；本任务立即停止沿用，保留旧经验与失败证据供整理，不按失败次数永久删除。改用新方法成功后由统一回收形成修订经验。',effect:'read',capabilities:[],
  inputSchema:{type:'object',properties:{sourceId:{type:'string'},reason:{type:'string'},operationIds:{type:'array',items:{type:'string'}}},required:['sourceId','reason','operationIds'],additionalProperties:false},
  validate:v=>{fields(v,['sourceId','reason','operationIds'],'经验复核');text(v.sourceId,'经验来源',256);text(v.reason,'复核原因',1000);if(!Array.isArray(v.operationIds)||!v.operationIds.length||v.operationIds.length>8||v.operationIds.some(id=>typeof id!=='string'))throw Error('经验复核需要实际操作回执');return v;},
  execute:async(a,{task})=>{
   if(!(task.state.operatingKnowledge||[]).some(k=>k.sourceId===a.sourceId)||a.operationIds.some(id=>!task.operations[id]||!task.operations[id].finishedAt))throw Object.assign(Error('经验或复核证据不属于当前任务'),{dispatched:false});
   task.state.excludedExperienceIds=[...new Set([...(task.state.excludedExperienceIds||[]),a.sourceId])];
   task.state.experienceReviews??=[];task.state.experienceReviews.push({...a,at:Date.now()});task.state.experienceReviews=task.state.experienceReviews.slice(-12);
   if(learning.memory?.ready&&task.scene!=='private'&&task.visibilityFloor<=1&&!task.state.sensitiveContext){
    const item=task.state.operatingKnowledge.find(k=>k.sourceId===a.sourceId);
    if(item.origin==='innate')await learning.memory.experienceRepository.put({instructions:'先天经验的适用修订（依据实际操作回执）：'+a.reason,tags:item.tags,origin:'task-learning',appliesTo:item.appliesTo||{}},{scene:task.scene,sources:[task.id,a.sourceId]});
    else await learning.memory.experienceRepository.feedback(a.sourceId,{taskId:task.id,outcome:'not-applicable-here',note:a.reason});
   }
   return {ok:true,excludedForThisTask:true,sourceId:a.sourceId};
  }});
 tools.register({name:'skill.learn',description:'保存可修订的操作经验及标签，带来源和轻量修订记录；经验是参考，不扩大权限。',effect:'write',capabilities:['skill.learn'],
  validate:v=>{fields(v,['instructions','tags'],'操作经验');return {instructions:text(v.instructions,'操作经验',6000),...(v.tags?{tags:require('./experience-pack').tags(v.tags)}:{})};},execute:(a,c)=>learning.teach(a,c)});
 skills.register({id:'skill.learn',title:'学习操作经验',version:1,description:'主人传授或修正可复用经验。parameters={instructions:完整经验,tags:可选标签数组}，subjects=[{application:"bunny"}]。适用条件、成败反馈由Dream统一整理。',
  tools:['skill.learn'],capabilities:['skill.learn'],validate:(spec,actor)=>{if(!['dialogue','bound-contact','authenticated-channel'].includes(actor.channel))throw new Error('学习经验需要已核实的主人交办入口');text(spec.parameters.instructions,'操作经验',6000);},
  async run({task,call,report}){await call({tool:'skill.learn',key:'learn-once',args:{instructions:task.parameters.instructions,...(task.parameters.tags?{tags:task.parameters.tags}:{})}});await report('已保存这条操作经验。后续会按情景参考，并结合实践持续整理改进。','learned');return {status:'completed',note:'操作经验已保存为候选',state:task.state};}});
}
module.exports={AgentLearning,registerLearning};
