'use strict';
const crypto=require('node:crypto');
const {fields,text}=require('./agent-contract');
const {canRead}=require('./memory-scope');
// Learned knowledge is scoped data, never executable code or a capability grant.
// Proof versions append sources; an ongoing task never depends on its own proof.
class AgentLearning{
 constructor({memory,skills,packages=[],request}){Object.assign(this,{memory,skills,packages,request});}
 catalog(scene){return (this.inventory||[]).filter(r=>canRead(scene,r)).map(r=>({id:r.id,tags:r.value.tags,revision:r.value.revision,status:r.value.status}));}
 async rows(){if(!this.memory?.ready)return [];this.inventory=await this.memory.experienceRepository.search({scene:'life',limit:80,includeInactive:true});return this.inventory;}
 latest(rows){return rows;}
 async seed(){
  if(!this.packages.length||!this.memory?.ready)return;
  if(!this.seedPromise)this.seedPromise=(async()=>{for(const p of this.packages){
   const sections=p.instructions.split(/(?=^##\s)/mu).filter(text=>text.trim());
   const pack={schema:'bunny.experience-pack/v1',id:'org.workbunny.'+p.id,version:String(p.version),title:p.id,hash:crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex'),tools:[],experiences:sections.map((instructions,i)=>({id:p.id+'-'+i,title:instructions.split('\n')[0].replace(/^#+\s*/u,''),instructions,summary:instructions.slice(0,240),tags:p.id==='common'?['general:computer']:['software:'+p.application],appliesTo:{platform:'macOS'},toolRefs:[]}))};
   await this.memory.experienceRepository.importData(pack,new Map(),{bundled:true});
  }})().catch(error=>{this.seedPromise=null;throw error;});await this.seedPromise;
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
  await this.seed();const scene=require('./dialogue-channels').ordinaryScene(task.scene),query=[task.goal,...(task.subjects||[]).map(s=>'software:'+s.application)].join(' ').slice(0,500);
  const rows=await this.memory.experienceRepository.search({scene,query,limit:12,excludeTaskId:task.id});
  const general=await this.memory.experienceRepository.search({scene,query:'general:computer',limit:2,excludeTaskId:task.id});
  const selected=[...new Map([...rows,...general].map(r=>[r.id,r])).values()].slice(0,12);
  task.state.operatingKnowledge=selected.map(r=>({sourceId:r.id,tags:r.value.tags,status:r.value.status,revision:r.value.revision,instructions:r.value.instructions,toolRefs:r.value.toolRefs,appliesTo:r.value.appliesTo}));
  task.state.softwarePackages=[];task.sources=[...new Set([...(task.sources||[]),...selected.map(r=>r.id)])];this.inventory=selected;
 }
 async failed(task,error){
  if(task.scene==='private'||task.visibilityFloor>1||!this.memory?.ready)return;
  for(const item of task.state.operatingKnowledge||[])if(item.sourceId)await this.memory.experienceRepository.feedback(item.sourceId,{taskId:task.id,outcome:'failure',note:String(error.message||error)});
 }
 async extractRecovery(task,{signal,canCommit=async()=>true}={}){
  if(!this.memory?.ready||task.scene==='private'||task.visibilityFloor>1||task.state.sensitiveContext||['skill.learn','task.resolve'].includes(task.skill))return;
  const attempts=task.state.attempts||[],failed=attempts.filter(a=>a.error&&!/授权|空闲|网络|超时|timeout/iu.test(a.error));
  if(!failed.length&&!(task.status==='completed'&&attempts.some(a=>a.result?.verified===true)))return;
  const recovered=task.status!=='needs_attention'&&attempts.some(a=>a.result?.verified===true&&(!('exitCode'in a.result)||a.result.exitCode===0));
  const {value}=await require('./agent-json').checkedJSON({signal,messages:[{role:'system',content:'从真实动作结果提取可复用经验：outcome=succeeded只提炼这次目标完成后可迁移的方法，不把工具调用成功泛化成全部方法正确；outcome=recovered才可写已验证的恢复方法；outcome=unresolved只记录失败条件和未验证的替代思路，不能宣称已解决。只写证据支持的技巧、适用条件和失效后替代路径，不保存测试文件名、联系人私事或凭据，不扩大权限，不把一次成功说成普遍保证。若没有明确可迁移经验返回instructions=null，否则严格JSON {"instructions":"600字以内具体技巧"}。'},{role:'user',content:JSON.stringify({outcome:failed.length?(recovered?'recovered':'unresolved'):'succeeded',goal:task.goal,criteria:task.criteria,skill:task.skill,applications:task.subjects?.map(s=>s.application),attempts:attempts.slice(-12).map(a=>({tool:a.tool,...(a.error?{error:a.error.slice(0,300)}:{}),succeeded:a.result?.verified===true&&(!('exitCode'in a.result)||a.result.exitCode===0)})),environment:task.state.softwarePackages})}]},v=>{if(!v||v.instructions!==null&&(typeof v.instructions!=='string'||!v.instructions.trim()||v.instructions.length>1200))throw Error('恢复经验格式无效');return v;},this.request?{request:this.request}:{});
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
  for(const item of task.state.operatingKnowledge||[])if(item.sourceId)await this.memory.experienceRepository.feedback(item.sourceId,{taskId:task.id,outcome:'task-result-confirmed',note:'任务或动作确认了结果；不代表每条参考经验都是成功原因。'});
 }

}
function registerLearning(tools,skills,learning){
 tools.register({name:'skill.learn',description:'保存可修订的操作经验及标签，带来源和轻量修订记录；经验是参考，不扩大权限。',effect:'write',capabilities:['skill.learn'],
  validate:v=>{fields(v,['instructions','tags'],'操作经验');return {instructions:text(v.instructions,'操作经验',6000),...(v.tags?{tags:require('./experience-pack').tags(v.tags)}:{})};},execute:(a,c)=>learning.teach(a,c)});
 skills.register({id:'skill.learn',title:'学习操作经验',version:1,description:'主人传授或修正可复用经验。parameters={instructions:完整经验,tags:可选标签数组}，subjects=[{application:"bunny"}]。适用条件、成败反馈由Dream统一整理。',
  tools:['skill.learn'],capabilities:['skill.learn'],validate:(spec,actor)=>{if(!['dialogue','bound-contact','authenticated-channel'].includes(actor.channel))throw new Error('学习经验需要已核实的主人交办入口');text(spec.parameters.instructions,'操作经验',6000);},
  async run({task,call,report}){await call({tool:'skill.learn',key:'learn-once',args:{instructions:task.parameters.instructions,...(task.parameters.tags?{tags:task.parameters.tags}:{})}});await report('已保存这条操作经验。后续会按情景参考，并结合实践持续整理改进。','learned');return {status:'completed',note:'操作经验已保存为候选',state:task.state};}});
}
module.exports={AgentLearning,registerLearning};
