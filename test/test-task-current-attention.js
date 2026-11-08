'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {taskGuidance,currentTaskFailure}=require('../src/main/task-presentation');
const {AgentRuntime}=require('../src/main/agent-runtime');
const {ToolRegistry}=require('../src/main/agent-tools');
const {SkillRegistry}=require('../src/main/agent-skills');

function task(){return {skill:'work.delegate',status:'needs_attention',note:'current pointer refusal',
 operations:{submit:{id:'submit',tool:'work.submit',status:'confirmed',finishedAt:200,result:{jobId:'physical'}}},
 state:{job:{jobId:'physical'},lastFailure:{code:'E_WORKBUDDY_DRAFT_CONFLICT',message:'old conflict',at:100},
 workCheckpoint:{phase:'draft-ready',submissionRound:1,priorSubmission:{handoffSent:true}},
 workAttention:{kind:'work-follow-up',jobId:'physical',round:1,resultPreserved:true,code:'E_GUI_POINTER_BLOCKED',report:'本次指针操作未发出，保留补充草稿',at:300}}};}
test('current follow-up draft attention supersedes a confirmed original submission failure without mutation',()=>{
 const value=task(),before=structuredClone(value),guide=taskGuidance(value);
 assert.equal(guide.title,'补充草稿待继续');assert.match(guide.detail,/原成果已保留/);assert.match(guide.detail,/尚未提交/);assert.match(guide.detail,/指针操作未发出/);
 assert.doesNotMatch(guide.detail,/原提交结果仍待核对|请先保存或处理草稿/);assert.equal(guide.kind,'retry');assert.deepEqual(value,before);
 assert.equal(currentTaskFailure(value),null);assert.equal(value.state.lastFailure.code,'E_WORKBUDDY_DRAFT_CONFLICT');
});
test('uncertain follow-up input does not claim its fill or submit was confirmed',()=>{
 const value=task();value.state.workCheckpoint.phase='input-unknown';const guide=taskGuidance(value);
 assert.equal(guide.title,'补充草稿写入待核对');assert.match(guide.detail,/原成果已保留/);assert.match(guide.detail,/写入结果仍需核对/);assert.doesNotMatch(guide.detail,/已填写，尚未提交/);
});
test('an original receipt without a preserved result is described only as retained progress',()=>{
 const value=task();value.state.workAttention.resultPreserved=false;const guide=taskGuidance(value);
 assert.match(guide.detail,/原会话进展已保留/);assert.doesNotMatch(guide.detail,/原成果已保留/);
});
test('attention from another physical job or round cannot override a current failure',()=>{
 for(const change of [a=>a.jobId='other-job',a=>a.round=2]){
  const value=task();value.state.lastFailure={code:'E_TASK_AUTH',at:250};change(value.state.workAttention);
  assert.equal(taskGuidance(value).kind,'source');
 }
 const newer=task();newer.state.lastFailure={code:'E_TASK_AUTH',at:400};assert.equal(taskGuidance(newer).kind,'source');
});
test('a resolved operation failure is retained but an unrelated confirmed receipt cannot resolve it',()=>{
 const value=task();delete value.state.workAttention;value.state.lastFailure.operationId='failed';
 value.operations.failed={id:'failed',status:'intent'};assert.equal(currentTaskFailure(value),value.state.lastFailure);
 value.operations.failed={id:'failed',status:'confirmed',finishedAt:200};assert.equal(currentTaskFailure(value),null);
 value.state.lastFailure.actionId='failed-action';value.operations.failed.actionId='another-action';assert.equal(currentTaskFailure(value),value.state.lastFailure);
 assert.equal(value.state.lastFailure.message,'old conflict');
});
test('an active initial draft conflict keeps its existing actionable guidance',()=>{
 const value=task();delete value.state.job;delete value.state.workAttention;value.operations.submit.status='not_dispatched';
 assert.equal(taskGuidance(value).title,'等待处理 WorkBuddy 草稿');
});
test('a sent follow-up attention does not describe a draft as undispatched',()=>{
 const value=task();value.state.workCheckpoint.phase='submission-unknown';value.state.workAttention.report='本轮接收仍待核对，不重复发送';
 const guide=taskGuidance(value);assert.equal(guide.title,'补充要求待核对');assert.match(guide.detail,/原成果已保留/);assert.match(guide.detail,/不重复发送/);assert.doesNotMatch(guide.detail,/尚未提交/);
});

function runtimeFixture({uncertain=false,skipRetry=false}={}){
 const records=new Map(),tools=new ToolRegistry();let attempts=0,now=100;
 tools.register({name:'fixture.write',description:'offline fake write',effect:'write',capabilities:['conversation.send'],scope:a=>a,
  execute:async()=>{attempts++;if(attempts===1)throw Object.assign(Error('fixture refusal'),{code:'E_WORKBUDDY_DRAFT_CONFLICT',...(uncertain?{}:{dispatched:false})});return {ok:true,verified:true};}});
 const call={tool:'fixture.write',key:'same-operation',args:{application:'wechat',recipient:'Alice'}};
 const skills=new SkillRegistry(tools).register({id:'test.failure',version:1,description:'offline fake skill',tools:['fixture.write'],capabilities:['conversation.send'],
  run:async({call:execute})=>{if(!skipRetry||attempts===0)await execute(call);return {status:'waiting'};}});
 const journal={put:async value=>records.set(value.id,structuredClone(value)),list:async()=>[],authorized:async value=>records.has(value.id)};
 const runtime=new AgentRuntime({journal,tools,skills,autoSchedule:false,clock:()=>now,epoch:()=>1});
 return {runtime,advance:()=>{now+=100;},start:()=>runtime.start({skill:'test.failure',goal:'offline failure recovery',subjects:[{application:'wechat',recipient:'Alice'}]},
  {role:'owner',verified:true,sources:['fixture-owner'],scene:'life'})};
}
test('runtime records operation provenance and resolves only that later confirmed operation',async()=>{
 const h=runtimeFixture();try{
  const {id}=await h.start();await h.runtime.tick(id);const value=h.runtime.tasks.get(id),failure=value.state.lastFailure;
  assert(failure.operationId);assert(failure.actionId);assert.equal(value.operations[failure.operationId].status,'not_dispatched');
  h.advance();await h.runtime.control('resume',id);await h.runtime.tick(id);
  assert.equal(value.state.lastFailure,failure);assert.equal(failure.code,'E_WORKBUDDY_DRAFT_CONFLICT');assert.equal(failure.resolvedAt,200);assert.equal(failure.resolution,'operation-confirmed');assert.equal(currentTaskFailure(value),null);
 }finally{await h.runtime.close();}
});
test('successful unrelated progress retains an unconfirmed operation failure',async()=>{
 const h=runtimeFixture({skipRetry:true});try{
  const {id}=await h.start();await h.runtime.tick(id);const value=h.runtime.tasks.get(id),failure=value.state.lastFailure;
  h.advance();await h.runtime.control('resume',id);await h.runtime.tick(id);
  assert.equal(failure.resolvedAt,undefined);assert.equal(currentTaskFailure(value),failure);
 }finally{await h.runtime.close();}
});
test('explicit reconciliation resolves the matching failure while preserving its evidence',async()=>{
 const h=runtimeFixture({uncertain:true});try{
  const {id}=await h.start();await h.runtime.tick(id);const value=h.runtime.tasks.get(id),failure=value.state.lastFailure;
  assert.equal(value.operations[failure.operationId].status,'intent');h.advance();
  assert.equal((await h.runtime.confirmReconciled(id,failure.operationId,{ok:true,verified:true})).ok,true);
  assert.equal(failure.resolvedAt,200);assert.equal(failure.resolution,'operation-confirmed');assert.equal(failure.message,'fixture refusal');assert.equal(currentTaskFailure(value),null);
 }finally{await h.runtime.close();}
});
