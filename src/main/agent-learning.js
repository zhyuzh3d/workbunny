'use strict';
const crypto=require('node:crypto');
const {fields,text}=require('./agent-contract');
const {canRead}=require('./memory-scope');
// Learned knowledge is scoped data, never executable code or a capability grant.
// Proof versions append sources; an ongoing task never depends on its own proof.
class AgentLearning{
 constructor({memory,skills}){Object.assign(this,{memory,skills});}
 async rows(){
  if(!this.memory?.ready)return [];
  const result=[];let cursor={};
  for(;;){const rows=await this.memory.query('task',200,{...cursor,state:'all',scene:null});
   for(const row of rows)if(row.state==='active'&&row.value.taskType==='agent-skill')result.push(row);
   if(rows.length<200)break;const last=rows.at(-1);cursor={before:last.ts,beforeId:last.id};
  }return result;
 }
 latest(rows){const result=new Map();for(const row of rows){const old=result.get(row.value.knowledgeId);if(!old||row.value.revision>old.value.revision)result.set(row.value.knowledgeId,row);}return [...result.values()];}
 async write(value,scope){
  if(!this.memory?.ready)throw Object.assign(new Error('技能经验需要已解锁的本地资料库'),{dispatched:false});
  const id='agent-skill-'+crypto.randomUUID();
  await this.memory.write([{id,kind:'task',ts:Date.now(),domain:scope.scene,visibilityFloor:scope.visibilityFloor,value:{...value,taskType:'agent-skill'}}]);
  return id;
 }
 async teach(args,{task}){
  this.skills.get(args.skill);
  const rows=this.latest(await this.rows()).filter(r=>canRead(task.scene,r)&&r.value.scene===task.scene&&r.value.skill===args.skill);
  // One bounded current instruction per skill and scene; new teaching supersedes it.
  const old=rows.sort((a,b)=>b.ts-a.ts)[0];
  const value={schema:'bunny.skill-knowledge/v1',knowledgeId:old?.value.knowledgeId||crypto.randomUUID(),skill:args.skill,
   instructions:args.instructions,scene:task.scene,revision:(old?.value.revision||0)+1,status:'candidate',proofs:[],sources:[task.id]};
  const id=await this.write(value,task);return {ok:true,verified:true,knowledgeId:id,status:'candidate'};
 }
 async prepare(task){
  if(task.skill==='skill.learn')return;
  const rows=this.latest(await this.rows()).filter(r=>r.value.skill===task.skill&&canRead(task.scene,r)&&r.value.scene===task.scene).slice(-4);
  task.state.operatingKnowledge=rows.map(r=>({sourceId:r.id,status:r.value.status,instructions:r.value.instructions}));
  task.sources=[...new Set([...task.sources,...rows.map(r=>r.id)])];
  task.visibilityFloor=Math.max(task.visibilityFloor,...rows.map(r=>r.visibilityFloor??r.value.visibilityFloor??0));
 }
 async completed(task){
  const used=task.state.operatingKnowledge||[];
  if(!used.length||!Object.values(task.operations).some(op=>op.effect==='write'&&op.status==='confirmed'))return;
  const rows=await this.rows(),latest=this.latest(rows);
  for(const item of used){const original=rows.find(r=>r.id===item.sourceId);if(!original)continue;
   const current=latest.find(r=>r.value.knowledgeId===original.value.knowledgeId);if(!current||current.value.instructions!==item.instructions)continue;
   if(current.value.proofs.includes(task.id))continue;
   const proofs=[...current.value.proofs,task.id].slice(-8);
   await this.write({...current.value,revision:current.value.revision+1,proofs,status:proofs.length>=2?'validated':'candidate',sources:[current.id,task.id]},task);
  }
 }
}
function registerLearning(tools,skills,learning){
 tools.register({name:'skill.learn',description:'保存主人传授的操作经验，带来源与版本；实际核验后积累证明，不修改代码或扩大权限。',effect:'write',capabilities:['skill.learn'],
  validate:v=>{fields(v,['skill','instructions'],'技能经验');return {skill:text(v.skill,'技能ID',100),instructions:text(v.instructions,'操作经验',6000)};},execute:(a,c)=>learning.teach(a,c)});
 skills.register({id:'skill.learn',title:'学习操作经验',version:1,description:'主人传授或修正已有技能的操作方法。parameters={skill:已有技能ID,instructions:完整经验}，subjects=[{application:"bunny"}]。经验保存为候选，两次真实核验后标记已验证。',
  tools:['skill.learn'],capabilities:['skill.learn'],validate:(spec,actor)=>{if(actor.channel!=='dialogue')throw new Error('学习或修正技能经验请从本机主人对话交办');skills.get(spec.parameters.skill);text(spec.parameters.instructions,'操作经验',6000);},
  async run({task,call,report}){await call({tool:'skill.learn',key:'learn-once',args:{skill:task.parameters.skill,instructions:task.parameters.instructions}});await report('已保存这条操作经验。后续会在原权限内参考，并用实际核验积累证明。','learned');return {status:'completed',note:'操作经验已保存为候选',state:task.state};}});
}
module.exports={AgentLearning,registerLearning};
