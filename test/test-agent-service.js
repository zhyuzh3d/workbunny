'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentService}=require('../src/main/agent-service');
function fixture(){
 const records=new Map(),outgoing=[],reports=[];let messages=[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true}],workCount=0;
 const scene={metrics:{},native:{request:async()=>({})},circuit:null,assertHealthy:async()=>{},invalidate:()=>{},close:async()=>{},
  observe:async()=>({headerMatched:true,changed:true,draft:'',messages:structuredClone(messages)})};
 const desktop={running:false,task:null,screenshot:{captureSource:'fixture'},publicStatus(){return {screenshot:'data:image/png;base64,eA=='};},
  async start(value){if(value.target==='workbuddy'){workCount++;this.task={...value,id:'work-'+workCount,status:'monitoring',handoffSent:true,monitorSessionId:'fixture-session',note:'working'};}
   else{this.task={...value,id:'send-'+(outgoing.length+1),status:'review',sendState:'confirmed',submitAttemptedAt:Date.now()};if(value.operation==='send'){outgoing.push(value.message);messages.push({direction:'outgoing',kind:'text',text:value.message,time:'',observedVerified:true});}}
   return {ok:true,id:this.task.id};},async accept({report}){this.task.status='accepted';this.task.report=report;},async stop(){this.running=false;}};
 const conversationDesktop={...desktop,task:null};
 const request=async opts=>{
  const input=JSON.parse(opts.messages[1].content);
  if(input.currentOwnerRequest)return {response:{text:JSON.stringify({kind:'task',task:{skill:'work.delegate',goal:input.currentOwnerRequest,subjects:[{application:'workbuddy'}],completion:'goal'}})}};
  return {response:{text:JSON.stringify({decision:'reply',reply:'Bunny test reply',summary:'noted',completed:false,progress:{},unknown:[]})}};
 };
 const agent=new AgentService({desktop,conversationDesktop,scene,ready:()=>true,epoch:()=>1,canOperate:async()=>true,
  journal:{put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()].map(t=>structuredClone(t)),authorized:async t=>records.has(t.id)},
  autoSchedule:false,request,verify:async()=>({verdict:'pass',report:'Actual fixture artifact verified'}),report:async r=>reports.push(r)});
 const owner={role:'owner',verified:true,channel:'dialogue',sources:['owner-turn'],scene:'life'};
 return {agent,owner,desktop,conversationDesktop,outgoing,reports,records,append:text=>messages.push({direction:'outgoing',kind:'text',text,time:'',observedVerified:true}),workCount:()=>workCount};
}
test('a bound owner conversation creates a real child task, acknowledges once and returns its verified result through the same queue',async()=>{
 const h=fixture(),subject={application:'wechat',recipient:'文件传输助手'};
 await h.agent.bindOwner(subject,h.owner);
 const start=await h.agent.start({skill:'conversation.manage',goal:'接收主人交办',subjects:[subject],parameters:{behavior:'owner'}},h.owner);
 assert(start.ok);await h.agent.runtime.tick(start.id);h.append('Create an isolated test report');await h.agent.runtime.tick(start.id);await h.agent.runtime.tick(start.id);
 const child=[...h.agent.runtime.tasks.values()].find(t=>t.skill==='work.delegate');assert(child);assert.equal(child.state.returnTo.taskId,start.id);assert.equal(h.outgoing.length,1);
 await h.agent.runtime.tick(child.id);assert.equal(h.workCount(),1);
 h.desktop.task.status='review';await h.agent.runtime.tick(child.id);await h.agent.runtime.tick(start.id);
 assert.equal(h.outgoing.length,2);assert(h.outgoing[1].includes('verified'));assert.equal(h.reports.length,0);
 await h.agent.runtime.tick(start.id);assert.equal(h.outgoing.length,2,'own outgoing messages must not recursively create work');assert.equal(h.workCount(),1);
 await h.agent.close();
});
test('ordinary contacts and remote messages cannot bind themselves as the owner',async()=>{
 const h=fixture(),subject={application:'wechat',recipient:'Alice'};
 const started=await h.agent.start({skill:'conversation.manage',goal:'test',subjects:[subject],parameters:{behavior:'owner'}},h.owner);assert.equal(started.ok,false);
 await assert.rejects(h.agent.bindOwner(subject,{...h.owner,channel:'bound-contact'}),/本机/);
 await assert.rejects(h.agent.dispatchOwner({...subject,text:'do work',eventKey:'fake'},{task:{parameters:{behavior:'reply'},authority:h.owner}}),/不是/);
 assert.equal(h.workCount(),0);await h.agent.close();
});
test('owner bindings in different scenes cannot overwrite one another',async()=>{
 const h=fixture(),subject={application:'wechat',recipient:'Alice'};
 await h.agent.bindOwner(subject,h.owner);await h.agent.bindOwner(subject,{...h.owner,scene:'private'},false);
 assert(h.agent.isOwner(subject,h.owner));assert.equal(h.agent.isOwner(subject,{...h.owner,scene:'private'}),false);await h.agent.close();
});
test('a queued conversation command that was canceled before execution emits no GUI input',async()=>{
 const h=fixture(),controller=new AbortController();controller.abort();
 const result=await h.agent.executeConversation({application:'wechat',recipient:'Alice',operation:'send',message:'should not send',task:{},signal:controller.signal});
 assert.equal(result.dispatched,false);assert.equal(h.outgoing.length,0);await h.agent.close();
});
test('the unified entry interprets ordinary language into a registered skill and preserves the owner source',async()=>{
 const h=fixture(),result=await h.agent.command('Make a test report',h.owner);assert(result.ok);
 assert.equal(h.agent.runtime.tasks.get(result.id).skill,'work.delegate');assert.deepEqual(h.agent.runtime.tasks.get(result.id).sources,['owner-turn']);await h.agent.close();
});
test('an unknown send without its original before-image cannot be reconciled or replayed',async()=>{
 const h=fixture();let starts=0;
 h.conversationDesktop.start=async function(value){starts++;this.task={...value,id:'physical-unknown',status:'paused',sendState:'unknown',submitAttemptedAt:Date.now(),note:'unknown'};return {ok:true};};
 const result=await h.agent.start({skill:'conversation.send',goal:'send test',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{message:'test'}},h.owner);
 await h.agent.runtime.tick(result.id);assert.equal(h.agent.runtime.tasks.get(result.id).status,'needs_attention');
 const checked=await h.agent.reconcile(result.id);assert.equal(checked.ok,false);assert.match(checked.error,/缺少.*发送前/);assert.equal(starts,1);await h.agent.close();
});
test('a restored delegated job is checked against its bound live session without a new GUI submission',async()=>{
 const h=fixture(),started=await h.agent.start({skill:'work.delegate',goal:'Create test report',subjects:[{application:'workbuddy'}]},h.owner);
 await h.agent.runtime.tick(started.id);const physical=structuredClone(h.desktop.task);h.desktop.task=null;
 const saved=[];h.desktop.persist=async record=>saved.push(record);h.desktop.observeWorkBuddy=async task=>{assert.equal(task.id,physical.id);return {status:'ok',summary:'Actual bound session completed the test report'};};
 h.agent.memory={ready:true,db:{request:async()=>({rows:[{state:'active',value:physical}]})},decode:row=>row,addMessageOnce:async()=>{}};
 await h.agent.runtime.tick(started.id);assert.equal(h.workCount(),1);assert.equal(h.agent.runtime.tasks.get(started.id).status,'completed');assert.equal(saved[0].status,'accepted');await h.agent.close();
});
test('delegation forwards the original owner wording and evidence path instead of a model paraphrase',async()=>{
 const h=fixture(),original='Create a UTF-8 file at /private/tmp/bunny-test.txt containing exactly "Test passed."';
 const started=await h.agent.dispatch({kind:'task',task:{skill:'work.delegate',goal:'Create a test file',subjects:[{application:'workbuddy'}]}},h.owner,{ownerRequest:original});
 await h.agent.runtime.tick(started.id);assert.equal(h.agent.runtime.tasks.get(started.id).state.ownerRequest,original);
 assert.equal(h.desktop.task.goal,original);assert.equal(h.desktop.task.userRequest,original);await h.agent.close();
});
test('an explicit owner interval overrides an interpreter default before task admission',async()=>{
 const h=fixture(),result=await h.agent.start({skill:'conversation.manage',goal:'Watch Alice',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{behavior:'reply'},schedule:{intervalSeconds:60}},h.owner,{ownerRequest:'请每10秒观察Alice的新消息'});
 assert(result.ok);assert.equal(h.agent.runtime.tasks.get(result.id).schedule.intervalSeconds,10);await h.agent.close();
});
test('a future reply-once condition cannot control an ended historical task',async()=>{
 const {AgentInterpreter}=require('../src/main/agent-interpreter');let requests=0;
 const interpreter=new AgentInterpreter({skills:{catalog:()=>[]},request:async options=>{
  const input=JSON.parse(options.messages[1].content);assert.equal(input.tasks.length,0);assert.equal(input.recentEnded[0].id,'old');
  requests++;return {response:{text:JSON.stringify(requests===1?{kind:'control',operation:'stop',id:'old'}:{kind:'task',task:{skill:'conversation.manage',goal:'下一轮回复一次后停止',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{behavior:'reply'},completion:'first_match'}})}};
 }});
 const decision=await interpreter.interpret('请对Alice下一轮来信回复一次后停止',{tasks:[{id:'old',goal:'prior watch',status:'stopped'}]});
 assert.equal(requests,2);assert.equal(decision.kind,'task');assert.equal(decision.task.completion,'first_match');
});
test('an explicit duration remains separate from observation cadence and expires the task',async()=>{
 const h=fixture();
 const started=await h.agent.start({skill:'conversation.manage',goal:'watch',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{behavior:'notify'}},h.owner,{ownerRequest:'每60秒观察，持续30分钟'});
 assert(started.ok);const task=h.agent.runtime.tasks.get(started.id);assert.equal(task.schedule.intervalSeconds,60);assert.equal(task.schedule.durationMinutes,30);assert.equal(task.expiresAt-task.createdAt,1800000);
 task.expiresAt=Date.now()-1;await h.agent.runtime.tick(started.id);assert.equal(task.status,'expired');assert.equal(h.outgoing.length,0);await h.agent.close();
});
test('a status query reports the actual cadence and does not change the task',async()=>{
 const h=fixture(),started=await h.agent.start({skill:'conversation.manage',goal:'watch Alice',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{behavior:'notify'},schedule:{intervalSeconds:60}},h.owner);
 const before=JSON.stringify(h.agent.runtime.tasks.get(started.id)),result=await h.agent.dispatch({kind:'control',operation:'status',id:started.id},h.owner);
 assert(result.ok);assert.match(result.text,/每60秒检查/);assert.equal(JSON.stringify(h.agent.runtime.tasks.get(started.id)),before);assert.equal(h.outgoing.length,0);await h.agent.close();
});
