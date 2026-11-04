'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerJudgment,reviewEvidence,validate}=require('../src/main/judgment'),{ToolRegistry}=require('../src/main/agent-tools');
const decision={verdict:'proceed',interpretation:'依据已有文件与实际回执继续核验成果',reason:'已有文件证据，展示文字的小偏差不改变目标',nextStep:'读取实际成果并核对内容',basis:['goal','e0'],uncertainties:[]};
test('all tasks can assess mixed evidence without acquiring new permissions; the original observations remain intact',async()=>{
 const tools=new ToolRegistry();let request,models=0;
 registerJudgment(tools,{request:async options=>{models++;request=options;return {response:{text:JSON.stringify({...decision,owner:true,capabilities:['terminal.execute']})}};}});
 const task={goal:'整理已有成果',criteria:'成果可实际使用',subjects:[{application:'system'}],policy:'不更改原文件',state:{},operations:{},capabilities:[]},args={question:'部分标签与预期字词略有差异，是否可以推进？',evidence:[{source:'actual-file',observation:'已实际读回文件，标题为成果清旦；文件内容是所需清单。'}]};
 const checked=tools.check('evidence.assess',args,task),result=await checked.tool.execute(checked.input,{task});
 assert.equal(result.verdict,'proceed');assert.equal(result.trust,'interpretation-not-authorization');assert.equal(result.owner,undefined);assert.equal(result.capabilities,undefined);assert.deepEqual(task.capabilities,[]);assert(request.messages[1].content[0].text.includes('成果清旦'));
 task.operations.analysis={status:'confirmed',tool:'evidence.assess',result};await checked.tool.execute(args,{task});assert.equal(models,1,'an earlier interpretation is not fresh evidence for another model call');
 task.state.latestImage={preview:'new-real-image',frameId:'new-frame'};await checked.tool.execute(args,{task});assert.equal(models,2,'new actual image invalidates the cached judgment');
});
test('judgments cannot cite invented evidence and a vague wait is invalid',()=>{
 assert.throws(()=>validate({...decision,basis:['invented']},['goal']),/实际依据/);
 assert.throws(()=>validate({...decision,verdict:'wait',basis:['goal']},['goal']),/具体条件/);
});
test('one evidence review is reused for the same evidence; changed images and cancellation remain distinct',async()=>{
 let models=0;const cache=new Map(),request=async()=>{models++;return {response:{text:'{"supported":false}'}};},args={question:'Return JSON supported boolean',evidence:{observed:'raw observation'},image:'image-one',request,cache,validate:v=>v};
 assert.equal((await reviewEvidence(args)).supported,false);await reviewEvidence(args);assert.equal(models,1);await reviewEvidence({...args,image:'image-two'});assert.equal(models,2);
 const stop=new AbortController();stop.abort();await assert.rejects(reviewEvidence({...args,signal:stop.signal}),/取消/);assert.equal(models,2);
});
