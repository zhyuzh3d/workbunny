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
 const resolving=[...h.agent.runtime.tasks.values()].find(t=>t.skill==='task.resolve');if(resolving)await h.agent.runtime.tick(resolving.id);const child=[...h.agent.runtime.tasks.values()].find(t=>t.skill==='work.delegate');assert(child);assert.equal(child.state.returnTo.taskId,start.id);assert.equal(h.outgoing.length,0);
 await h.agent.runtime.tick(child.id);assert.equal(h.workCount(),1);
 h.desktop.task.status='review';await h.agent.runtime.tick(child.id);await h.agent.runtime.tick(start.id);
 assert.equal(h.outgoing.length,1);assert(h.outgoing[0].includes('verified'));assert.equal(h.reports.length,0);
 await h.agent.runtime.tick(start.id);assert.equal(h.outgoing.length,1,'own outgoing messages must not recursively create work');assert.equal(h.workCount(),1);
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
test('a proven GUI-busy non-dispatch retries promptly without repeating a send',async()=>{
 const h=fixture();h.agent.canOperate=async()=>false;const start=await h.agent.start({skill:'conversation.send',goal:'send once',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{message:'one reply'}},h.owner);
 await h.agent.runtime.tick(start.id);const task=h.agent.runtime.tasks.get(start.id);assert.equal(task.state.lastFailure.code,'E_GUI_BUSY');assert(task.nextCheckAt-task.updatedAt<=3000);assert.equal(h.outgoing.length,0);
 h.agent.canOperate=async()=>true;await h.agent.runtime.tick(start.id);assert.equal(h.outgoing.length,1);assert.equal(task.status,'completed');await h.agent.close();
});
test('the unified entry interprets ordinary language into a registered skill and preserves the owner source',async()=>{
 const h=fixture(),result=await h.agent.command('Make a test report',h.owner);assert(result.ok);await h.agent.runtime.tick(result.id);
 assert.equal(h.agent.runtime.tasks.get(result.id).skill,'work.delegate');assert.deepEqual(h.agent.runtime.tasks.get(result.id).sources,['owner-turn']);await h.agent.close();
});
test('a full runtime still understands owner controls and saves a sixth interpreted task for manual start',async()=>{
 const h=fixture();for(let i=0;i<5;i++)assert((await h.agent.start({skill:'screen.watch',goal:'watch '+i,subjects:[{application:'workbuddy'}]},h.owner)).ok);
 const admitted=await h.agent.command('Make one more report',h.owner);assert(admitted.ok);await h.agent.runtime.tick(admitted.id);
 const task=h.agent.runtime.tasks.get(admitted.id);assert.equal(task.skill,'work.delegate');assert.equal(task.status,'queued');assert.equal(h.workCount(),0);assert.deepEqual(h.agent.status().capacity,{limit:5,active:5,queued:1});assert(h.reports.some(r=>r.text.includes('待启动')));
 const old=[...h.agent.runtime.tasks.values()].find(t=>t.id!==task.id);assert((await h.agent.control('stop',old.id)).ok);await h.agent.runtime.tick(task.id);assert.equal(h.workCount(),0);
 assert((await h.agent.control('resume',task.id)).ok);await h.agent.runtime.tick(task.id);assert.equal(h.workCount(),1);await h.agent.close();
});
test('stop-all stops every business task while the control request survives to acknowledge the actual result',async()=>{
 const h=fixture();for(let i=0;i<3;i++)await h.agent.start({skill:'screen.watch',goal:'watch '+i,subjects:[{application:'workbuddy'}]},h.owner);
 h.agent.interpreter.interpret=async()=>({kind:'control',operation:'stop',all:true});const command=await h.agent.command('停止全部任务',h.owner);await h.agent.runtime.tick(command.id);
 assert.equal(h.agent.runtime.tasks.get(command.id).status,'completed');assert([...h.agent.runtime.tasks.values()].filter(t=>t.id!==command.id).every(t=>t.status==='stopped'));assert(h.reports.some(r=>r.text==='全部任务状态已更新。'));assert.equal(h.agent.runtime.capacity().active,0);await h.agent.close();
});
test('an unknown send without its original before-image cannot be reconciled or replayed',async()=>{
 const h=fixture();let starts=0;
 h.conversationDesktop.start=async function(value){starts++;this.task={...value,id:'physical-unknown',status:'paused',sendState:'unknown',submitAttemptedAt:Date.now(),note:'unknown'};return {ok:true};};
 const result=await h.agent.start({skill:'conversation.send',goal:'send test',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{message:'test'}},h.owner);
 await h.agent.runtime.tick(result.id);assert.equal(h.agent.runtime.tasks.get(result.id).status,'needs_attention');
 const checked=await h.agent.reconcile(result.id);assert.equal(checked.ok,false);assert.match(checked.error,/缺少.*发送前/);assert.equal(starts,1);await h.agent.close();
});
test('resume can finish the exact original pre-submit draft; read-only check cannot send it or create another operation',async()=>{
 const h=fixture(),started=await h.agent.start({skill:'conversation.send',goal:'send hello',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{message:'hello'}},h.owner),task=h.agent.runtime.tasks.get(started.id);
 const physical={id:'original-draft',target:'wechat',operation:'send',status:'paused',draftInserted:true,message:'［Bunny］ hello',wechatOwnership:'owner',recipient:'Alice',sources:[task.id]};
 h.conversationDesktop.task=physical;task.state.conversationOperationId=physical.id;task.status='needs_attention';task.operations.pending={id:'pending',effect:'write',tool:'conversation.send',status:'intent',args:{recipient:'Alice',message:'hello'}};await h.agent.runtime.save(task);
 let resumed=0;h.conversationDesktop.resume=async()=>{resumed++;physical.submitAttemptedAt=Date.now();physical.sendState='confirmed';physical.status='review';return {ok:true};};
 const free=require('../src/main/workbuddy-free'),original=free.freeModel;free.freeModel=async()=> 'hy3';
 try{assert.equal((await h.agent.reconcile(task.id)).ok,false);assert.equal(resumed,0);assert((await h.agent.control('resume',task.id)).ok);assert.equal(resumed,1);assert.equal(task.operations.pending.status,'confirmed');assert.equal(task.operations.pending.result.receipt.operationId,physical.id);assert.equal(h.outgoing.length,0);}finally{free.freeModel=original;await h.agent.close();}
});
test('one resolve action queues verification on the same task while the owner is busy, with an explicit visible next step',async()=>{
 const h=fixture();h.agent.canOperate=async()=>false;const created=await h.agent.start({skill:'conversation.send',goal:'send one hello',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{message:'hello'}},h.owner),task=h.agent.runtime.tasks.get(created.id);
 task.status='needs_attention';task.operations.pending={id:'pending',effect:'write',status:'intent',tool:'conversation.send',args:{recipient:'Alice',message:'hello'}};await h.agent.runtime.save(task);
 const before=h.agent.runtime.tasks.size,result=await h.agent.resolveAttention(task.id);assert(result.ok&&result.pending);assert.equal(h.agent.runtime.tasks.size,before);assert.equal(h.outgoing.length,0);
 const p=h.agent.status().tasks.find(t=>t.id===task.id).presentation;assert.equal(p.guidance.kind,'wechat-send');assert.equal(p.statusLabel,'等待空闲后核对');assert.equal(p.guidance.working,true);assert(p.guidance.detail.includes('不会重复发送'));
 await h.agent.close();
});
test('failed full-screen reconnection remains actionable and never reports that the interrupted watch resumed',async()=>{
 const h=fixture(),created=await h.agent.start({skill:'conversation.manage',goal:'watch Alice',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{behavior:'reply'}},h.owner),task=h.agent.runtime.tasks.get(created.id);
 task.status='needs_attention';task.state.lastFailure={code:'E_APP_CIRCUIT'};await h.agent.runtime.save(task);
 h.agent.scene.reconnect=async()=>({ok:false,error:'全屏仍未能定位微信'});const before=task.counters.wakes;
 const result=await h.agent.resolveAttention(task.id);assert.equal(result.ok,false);assert.equal(result.error,'全屏仍未能定位微信');assert.equal(task.status,'needs_attention');assert.equal(task.counters.wakes,before);assert.equal(h.outgoing.length,0);await h.agent.close();
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
 assert(h.desktop.task.goal.startsWith(original));assert.equal(h.desktop.task.userRequest,original);await h.agent.close();
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
test('a contextual work order preserves the literal owner request while executing the complete goal',async()=>{
 const h=fixture(),original='照刚才的方案做。';const spec={skill:'work.delegate',goal:'创建三项评审清单',context:'已确认需要覆盖输入、输出和恢复；只在临时目录写新文件。',subjects:[{application:'workbuddy'}]};
 const started=await h.agent.start(spec,h.owner,{ownerRequest:original});await h.agent.runtime.tick(started.id);
 assert.match(h.desktop.task.goal,/三项评审清单/);assert.match(h.desktop.task.goal,/输入、输出和恢复/);assert.equal(h.desktop.task.userRequest,original);await h.agent.close();
});
test('an explicit WeChat result channel sends once, emits no speech report and never repeats WorkBuddy work',async()=>{
 const h=fixture();const result=await h.agent.start({skill:'work.delegate',goal:'make report',subjects:[{application:'workbuddy'}],delivery:{channel:'wechat',recipient:'Alice'}},h.owner);
 await h.agent.runtime.tick(result.id);h.desktop.task.status='review';await h.agent.runtime.tick(result.id);
 const task=h.agent.runtime.tasks.get(result.id);assert.equal(task.status,'completed');assert.equal(task.state.delivery.status,'delivered');assert.equal(h.outgoing.length,1);assert.equal(h.reports.length,0);
 await h.agent.runtime.tick(result.id);assert.equal(h.outgoing.length,1);assert.equal(h.workCount(),1);await h.agent.close();
});
test('a busy result delivery retains its collected result across retry and restoration',async()=>{
 const h=fixture();const result=await h.agent.start({skill:'work.delegate',goal:'make report',subjects:[{application:'workbuddy'}],delivery:{channel:'wechat'}},h.owner);
 await h.agent.runtime.tick(result.id);h.desktop.task.status='review';const execute=h.agent.executeConversation.bind(h.agent);h.agent.executeConversation=async()=>({ok:false,dispatched:false,error:'GUI busy'});
 await h.agent.runtime.tick(result.id);assert(h.agent.runtime.tasks.get(result.id).state.result);assert.equal(h.workCount(),1);assert.equal(h.outgoing.length,0);assert.equal(h.reports.length,0);
 h.agent.executeConversation=execute;await h.agent.restore();await h.agent.runtime.tick(result.id);
 assert.equal(h.agent.runtime.tasks.get(result.id).status,'completed');assert.equal(h.outgoing.length,1);assert.equal(h.workCount(),1);await h.agent.close();
});
test('forwarding an existing result never starts WorkBuddy again and respects the selected channel',async()=>{
 let submissions=0,sends=0;const reports=[],scene={metrics:{},native:{request:async()=>({})},assertHealthy:async()=>{},close:async()=>{}};
 const agent=new AgentService({scene,ready:()=>true,epoch:()=>1,autoSchedule:false,journal:{put:async()=>{},list:async()=>[],authorized:async()=>true},report:async r=>reports.push(r)});
 agent.submitWork=async()=>{submissions++;throw Error('must not resubmit');};agent.executeConversation=async a=>{sends++;assert.equal(a.recipient,'Alice');assert.equal(a.message,'真实成果摘要');return {ok:true,verified:true,receipt:{sent:true}};};
 const actor={role:'owner',verified:true,channel:'dialogue',sources:['owner'],scene:'life'};
 const source=await agent.start({skill:'work.delegate',goal:'原任务',subjects:[{application:'workbuddy'}]},actor);
 const original=agent.runtime.tasks.get(source.id);original.status='completed';original.state.result={schema:'bunny.result/v1',revision:2,summary:'真实成果摘要',artifacts:[]};
 const next=await agent.start({skill:'result.forward',goal:'把刚才成果发Alice',subjects:[{application:'bunny'}],parameters:{sourceTaskId:source.id},delivery:{channel:'wechat',recipient:'Alice'}},actor);assert(next.ok,next.error);
 await agent.runtime.tick(next.id);assert.equal(agent.runtime.tasks.get(next.id).status,'completed');assert.equal(submissions,0);assert.equal(sends,1);assert.equal(reports.length,0);await agent.close();
});
test('queued completion reports survive restart and an acknowledged report is never replayed',async()=>{
 const records=new Map(),reports=[];
 const journal={put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()],authorized:async()=>true};
 const make=()=>new AgentService({scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},journal,ready:()=>true,epoch:()=>1,autoSchedule:false,report:async r=>reports.push(r)});
 let agent=make();const start=await agent.start({skill:'work.delegate',goal:'回收报告',subjects:[{application:'workbuddy'}]},{role:'owner',verified:true,sources:['owner'],scene:'life'});
 const task=agent.runtime.tasks.get(start.id);task.status='completed';await agent.routeReport({taskId:task.id,eventId:'completion-1',text:'真实结论',scene:'life',sources:[task.id],epoch:1});assert.equal(reports.length,1);await agent.close();
 agent=make();await agent.restore();assert.equal(reports.length,2);await agent.acknowledgeReport('completion-1');await agent.close();agent=make();await agent.restore();assert.equal(reports.length,2);await agent.close();
});
test('a single explicit owner request can bind and start the same visual owner channel',async()=>{
 const h=fixture(),decision=require('../src/main/agent-interpreter').validateAgentIntent({kind:'bind_owner',subject:{application:'wechat',recipient:'Alice'},enabled:true,listen:true});
 const result=await h.agent.dispatch(decision,h.owner,{ownerRequest:'这轮实验把Alice当我本人，监听并执行那里发来的任务'});assert(result.ok,result.error);const task=h.agent.runtime.tasks.get(result.id);assert.equal(task.skill,'conversation.manage');assert.equal(task.parameters.behavior,'owner');assert(h.agent.isOwner({application:'wechat',recipient:'Alice'},h.owner));await h.agent.close();
});
test('startup restoration finishes before a new owner task is admitted',async()=>{
 const h=fixture();let release;const listing=new Promise(r=>release=r),old=h.agent.runtime.journal.list;h.agent.runtime.journal.list=()=>listing;
 const restore=h.agent.restore();assert.equal(h.agent.status().restoring,true);let admitted=false;const newTask=h.agent.start({skill:'work.delegate',goal:'new owner request',subjects:[{application:'workbuddy'}]},h.owner).then(r=>{admitted=true;return r;});await new Promise(r=>setTimeout(r,5));assert.equal(admitted,false);release([]);await restore;assert((await newTask).ok);assert.equal(h.agent.status().restoring,false);h.agent.runtime.journal.list=old;await h.agent.close();
});
test('a malformed software target is repaired before any task dispatch',async()=>{
 let calls=0;const h=fixture();h.agent.interpreter.request=async options=>{calls++;if(calls===2)assert(options.messages.at(-1).content.includes('执行对象只能是workbuddy'));return {response:{text:JSON.stringify({kind:'task',task:{skill:'work.delegate',goal:'补充实验文件',subjects:[{application:calls===1?'wechat':'workbuddy'}],parameters:{}}})}};};
 const result=await h.agent.command('请补充刚才文件的内容',h.owner);assert(result.ok,result.text);await h.agent.runtime.tick(result.id);assert.equal(calls,2);assert.equal(h.workCount(),0);assert.equal(h.agent.runtime.tasks.get(result.id).subjects[0].application,'workbuddy');await h.agent.close();
});
test('restored task history preserves chronological order for selecting the latest result',async()=>{
 const h=fixture();const a=await h.agent.start({skill:'work.delegate',goal:'older',subjects:[{application:'workbuddy'}]},h.owner),b=await h.agent.start({skill:'work.delegate',goal:'newer',subjects:[{application:'workbuddy'}]},h.owner);h.agent.runtime.tasks.get(a.id).createdAt=1;h.agent.runtime.tasks.get(b.id).createdAt=2;
 for(const task of h.agent.runtime.tasks.values())await h.agent.runtime.save(task);const old=h.agent.runtime.journal.list;h.agent.runtime.journal.list=async()=>(await old()).reverse();await h.agent.restore();assert.deepEqual(h.agent.runtime.list().map(t=>t.goal),['older','newer']);await h.agent.close();
});
test('an admitted owner request survives model failure and restart, then executes as one logical task',async()=>{
 const h=fixture();let attempts=0;h.agent.interpreter.request=async()=>{attempts++;if(attempts===1)throw Error('model service unavailable');return {response:{text:JSON.stringify({kind:'task',task:{skill:'work.delegate',goal:'make one report',subjects:[{application:'workbuddy'}]}})}};};
 const admitted=await h.agent.command('Make one report',h.owner);assert.equal(attempts,0);assert.equal(h.agent.runtime.tasks.get(admitted.id).skill,'task.resolve');await h.agent.runtime.tick(admitted.id);let task=h.agent.runtime.tasks.get(admitted.id);assert.equal(task.status,'waiting');assert.equal(h.workCount(),0);assert.match(task.note,/交办已保存/);assert(task.state.ownerRequest);
 await h.agent.restore();await h.agent.runtime.tick(admitted.id);task=h.agent.runtime.tasks.get(admitted.id);assert.equal(task.skill,'work.delegate');assert.equal(task.id,admitted.id);assert.equal(task.context,undefined);await h.agent.runtime.tick(admitted.id);assert.equal(h.workCount(),1);assert.equal([...h.agent.runtime.tasks.values()].filter(t=>t.skill==='work.delegate').length,1);await h.agent.close();
});
test('a local pause during interpretation prevents adoption and any later desktop submission',async()=>{
 const h=fixture();let release;const pending=new Promise(r=>release=r);h.agent.interpreter.request=async()=>pending;
 const admitted=await h.agent.command('Make one report',h.owner);const running=h.agent.runtime.tick(admitted.id);await new Promise(r=>setTimeout(r,5));await h.agent.control('pause',admitted.id);release({response:{text:JSON.stringify({kind:'task',task:{skill:'work.delegate',goal:'report',subjects:[{application:'workbuddy'}]}})}});await running;assert.equal(h.agent.runtime.tasks.get(admitted.id).status,'paused');assert.equal(h.workCount(),0);await h.agent.close();
});
test('skill parameter validation participates in model repair before persisting an executable intent',async()=>{
 const h=fixture();let calls=0;h.agent.interpreter.request=async options=>{calls++;if(calls===2)assert.match(options.messages.at(-1).content,/工作参数字段不合法/u);return {response:{text:JSON.stringify({kind:'task',task:{skill:'work.delegate',goal:'make one file',subjects:[{application:'workbuddy'}],parameters:calls===1?{filePath:'/tmp/example.txt'}:{}}})}};};
 const admitted=await h.agent.command('make a file with WorkBuddy',h.owner);await h.agent.runtime.tick(admitted.id);const task=h.agent.runtime.tasks.get(admitted.id);assert.equal(calls,2);assert.equal(task.skill,'work.delegate');assert.deepEqual(task.parameters,{});assert.equal(h.workCount(),0);await h.agent.runtime.tick(admitted.id);assert.equal(h.workCount(),1);await h.agent.close();
});
test('a previously cached invalid intent is discarded and reinterpreted in the same task after restart',async()=>{
 const h=fixture(),admitted=await h.agent.command('make one file',h.owner),task=h.agent.runtime.tasks.get(admitted.id);
 task.state.resolvedIntent={kind:'task',task:{skill:'work.delegate',goal:'make one file',subjects:[{application:'workbuddy'}],parameters:{filePath:'/tmp/example.txt'}}};await h.agent.runtime.save(task);await h.agent.restore();await h.agent.runtime.tick(admitted.id);
 const restored=h.agent.runtime.tasks.get(admitted.id);assert.equal(restored.state.resolvedIntent,undefined);assert.match(restored.state.resolutionIssue,/工作参数/u);assert.equal(h.workCount(),0);
 await h.agent.runtime.tick(admitted.id);assert.equal(restored.skill,'work.delegate');await h.agent.runtime.tick(admitted.id);assert.equal(h.workCount(),1);assert.equal(h.agent.runtime.list().length,1);await h.agent.close();
});
test('contact history reuses prior task evidence without mixing contacts, accounts, future tasks or scene scope',async()=>{
 const h=fixture(),{subjectKey}=require('../src/main/conversation-skill');
 const make=async(name,createdAt,identity,scene='life')=>{const started=await h.agent.start({skill:'conversation.manage',goal:'照看 '+name,subjects:[{application:'wechat',recipient:name}],parameters:{behavior:'reply'}},{...h.owner,scene});const t=h.agent.runtime.tasks.get(started.id);t.createdAt=createdAt;t.updatedAt=createdAt;t.state.sceneIdentity={wechat:identity};t.state.conversations={[subjectKey(t.subjects[0])]:{summary:name+'旧项目上下文',progress:{deadline:'Friday'},cursor:{recent:[{direction:'incoming',kind:'text',text:name+' project Cedar is due Friday.',incomingVerified:true}]}}};return t;};
 const identity={pid:717,windowId:1930};const old=await make('Alice',1,identity),other=await make('Bob',2,identity);await make('Alice',3,{pid:100,windowId:100});await make('Alice',4,identity,'private');const current=await make('Alice',5,identity);await make('Alice',6,identity);
 h.agent.memory={ready:true,search:async()=>[]};const result=await h.agent.relatedMemory({...current.subjects[0],query:'项目进度'},current);
 assert.equal(result.items.length,1);assert.equal(result.items[0].sourceId,old.id);assert.match(result.items[0].text,/Cedar/u);assert.doesNotMatch(result.items[0].text,/Bob/u);assert.equal(JSON.parse(result.items[0].text).progress.deadline,'Friday');assert(current.sources.includes(old.id));assert(!current.sources.includes(other.id));
 current.state.sceneIdentity=undefined;assert.equal((await h.agent.relatedMemory({...current.subjects[0],query:'项目'},current)).items.length,0);await h.agent.close();
});
test('failed skill preparation leaves the original saved intent and cannot start a half-prepared job',async()=>{
 const h=fixture(),prepare=h.agent.runtime.prepare;h.agent.runtime.prepare=async t=>{if(t.skill==='work.delegate')throw Error('source task no longer available');await prepare(t);};
 const admitted=await h.agent.command('make one file',h.owner);await h.agent.runtime.tick(admitted.id);await h.agent.runtime.tick(admitted.id);
 assert.equal(h.agent.runtime.tasks.get(admitted.id).skill,'task.resolve');assert.equal(h.records.get(admitted.id).skill,'task.resolve');assert.equal(h.workCount(),0);await h.agent.close();
});
test('a pause during skill preparation commits no executable replacement over the paused intent',async()=>{
 const h=fixture(),prepare=h.agent.runtime.prepare;let release,entered;const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 h.agent.runtime.prepare=async t=>{if(t.skill==='work.delegate'){entered();await pending;}await prepare(t);};
 const admitted=await h.agent.command('make one file',h.owner),running=h.agent.runtime.tick(admitted.id);await started;await h.agent.control('pause',admitted.id);release();await running;
 assert.equal(h.agent.runtime.tasks.get(admitted.id).status,'paused');assert.equal(h.agent.runtime.tasks.get(admitted.id).skill,'task.resolve');assert.equal(h.records.get(admitted.id).skill,'task.resolve');assert.equal(h.records.get(admitted.id).status,'paused');assert.equal(h.workCount(),0);await h.agent.close();
});
test('a composed file job repairs an omitted delivery channel before execution',async()=>{
 const {AgentInterpreter}=require('../src/main/agent-interpreter');let requests=0;
 const interpreter=new AgentInterpreter({skills:{catalog:()=>[],get:()=>({id:'software.execute'})},request:async()=>({response:{text:JSON.stringify({kind:'task',task:{skill:'software.execute',goal:'读取文件并微信发Alice',subjects:[{application:'system'}],...(requests++?{workRequest:{goal:'读取本机实际文件',output:'files'},delivery:{channel:'wechat',recipient:'Alice',includeFiles:true}}:{})}})}})});
 const decision=await interpreter.interpret('读回这个文件，然后微信Alice发送原文件和结论');assert.equal(requests,2);assert.equal(decision.task.delivery.recipient,'Alice');assert.equal(decision.task.delivery.includeFiles,true);
});
test('passive conversation monitoring keeps a new message queued while a composed UI job uses the same app, then replies once without rebaselining',async()=>{
 const h=fixture(),watch=await h.agent.start({skill:'conversation.manage',goal:'Watch Alice normally',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{behavior:'reply'}},h.owner);await h.agent.runtime.tick(watch.id);
 h.agent.scene.observe=async()=>({headerMatched:true,changed:true,draft:'',messages:[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true},{direction:'incoming',kind:'text',text:'One ordinary new message',time:'',incomingVerified:true,observedVerified:true}]});await h.agent.runtime.tick(watch.id);
 const ui=await h.agent.start({skill:'software.execute',goal:'Receive an actual Alice file',workRequest:{goal:'Save the Alice attachment',output:'files'},subjects:[{application:'wechat',recipient:'Alice'},{application:'system'}]},h.owner);
 assert.equal(await h.agent.canOperateForTask(h.agent.runtime.tasks.get(watch.id)),false);assert.equal(await h.agent.canOperateForTask(h.agent.runtime.tasks.get(ui.id)),true);
 h.agent.scene.observe=async()=>({headerMatched:true,changed:true,draft:'',messages:[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true},{direction:'incoming',kind:'text',text:'One ordinary new message',time:'',incomingVerified:true,observedVerified:true}]});
 await h.agent.runtime.tick(watch.id);await h.agent.runtime.tick(watch.id);const task=h.agent.runtime.tasks.get(watch.id);assert.equal(task.inbox.length,1);assert.equal(h.outgoing.length,0);assert(Object.values(task.state.conversations)[0].cursor.ready);
 await h.agent.control('stop',ui.id);await h.agent.runtime.tick(watch.id);assert.equal(h.outgoing.length,1);assert.equal(task.inbox.length,0);await h.agent.runtime.tick(watch.id);assert.equal(h.outgoing.length,1);await h.agent.close();
});

test('owner reposition refreshes only the selected task and clears stale circuit without replaying old messages',async()=>{
 const h=fixture(),created=await h.agent.start({skill:'conversation.manage',goal:'watch Alice',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{behavior:'reply'}},h.owner),task=h.agent.runtime.tasks.get(created.id);
 task.status='needs_attention';task.state.lastFailure={code:'E_APP_CIRCUIT'};task.state.sceneIdentity={wechat:{pid:77,windowId:1}};task.state.conversations={old:{cursor:{ready:true}}};task.inbox=[{key:'prior-account-message'}];task.state.screenAnchors={wechat:{frameId:'old'}};
 h.agent.lastCircuit={reason:'old circuit'};h.agent.scene.circuit=h.agent.lastCircuit;h.agent.scene.reconnect=async()=>{h.agent.scene.circuit=null;h.agent.scene.knownWindow={pid:77,windowId:2};return {ok:true};};
 assert((await h.agent.resolveAttention(task.id)).ok);assert.deepEqual(task.state.sceneIdentity.wechat,{pid:77,windowId:2});assert.equal(h.agent.status().circuit,null);assert.equal(task.inbox.length,0);assert.equal(task.state.conversations,undefined);assert.equal(task.state.screenAnchors.wechat,undefined);assert.equal(h.outgoing.length,0);await h.agent.close();
});
test('reposition never rebinds an uncertain write to a newly logged-in window',async()=>{
 const h=fixture(),created=await h.agent.start({skill:'conversation.send',goal:'send once',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{message:'hello'}},h.owner),task=h.agent.runtime.tasks.get(created.id);let reconnects=0;
 task.operations.pending={effect:'write',status:'intent'};h.agent.scene.reconnect=async()=>{reconnects++;return {ok:true};};
 assert.equal((await h.agent.reconnectWeChat(task.id)).ok,false);assert.equal(reconnects,0);assert.equal(h.outgoing.length,0);await h.agent.close();
});
test('a new message for the same contact supersedes a pre-draft reply and the merged event is sent once',async()=>{
 const h=fixture(),incoming=text=>({direction:'incoming',kind:'text',text,time:'',incomingVerified:true,observedVerified:true});
 let messages=[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true}],starts=0,stopCount=0,entered;
 const started=new Promise(r=>entered=r);h.agent.actionWatchIntervalMs=5;
 h.agent.scene.observe=async()=>({headerMatched:true,changed:true,draft:'',messages:structuredClone(messages)});
 h.conversationDesktop.start=async function(value){
  if(value.operation==='open'){this.running=false;this.task={...value,id:'open',status:'review',steps:[]};return {ok:true};}
  starts++;this.task={...value,id:'send-'+starts,status:'running',steps:[]};
  if(starts===1){this.running=true;entered();return {ok:true};}
  this.running=false;this.task.status='review';this.task.sendState='confirmed';this.task.submitAttemptedAt=Date.now();h.outgoing.push(value.message);messages.push({direction:'outgoing',kind:'text',text:value.message,time:'',observedVerified:true});return {ok:true};
 };
 h.conversationDesktop.stop=async function(){stopCount++;this.running=false;this.task.status='stopped';this.task.note='superseded';};
 const subject={application:'wechat',recipient:'Alice'},task=await h.agent.start({skill:'conversation.manage',goal:'reply',subjects:[subject],parameters:{behavior:'reply'}},h.owner);
 await h.agent.runtime.tick(task.id);messages.push(incoming('first'));await h.agent.runtime.tick(task.id);
 const running=h.agent.runtime.tick(task.id);await started;messages.push(incoming('second'));await running;
 assert.equal(stopCount,1);assert.equal(h.outgoing.length,0);assert.equal(h.agent.runtime.tasks.get(task.id).inbox.length,2);
 await h.agent.runtime.tick(task.id);assert.equal(h.outgoing.length,1);assert.equal(starts,2);assert.equal(h.agent.runtime.tasks.get(task.id).inbox.length,0);
 const writes=Object.values(h.agent.runtime.tasks.get(task.id).operations).filter(o=>o.tool==='conversation.send');assert(writes.some(o=>o.status==='not_dispatched'));assert(writes.some(o=>o.status==='confirmed'));await h.agent.close();
});
test('a different contact event does not interrupt a running reply',async()=>{
 const h=fixture(),subjectA={application:'wechat',recipient:'Alice'},subjectB={application:'wechat',recipient:'Bob'},messages=[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true}];let entered,stops=0;
 const started=new Promise(r=>entered=r);h.agent.actionWatchIntervalMs=5;h.agent.scene.observe=async s=>({headerMatched:s.recipient==='Alice',changed:true,draft:'',messages:structuredClone(messages)});
 h.conversationDesktop.start=async function(value){this.task={...value,id:value.operation==='open'?'open':'send',status:value.operation==='open'?'review':'running',steps:[]};this.running=value.operation==='send';if(this.running)entered();return {ok:true};};
 h.conversationDesktop.stop=async function(){stops++;this.running=false;this.task.status='stopped';};
 const a=await h.agent.start({skill:'conversation.manage',goal:'reply Alice',subjects:[subjectA],parameters:{behavior:'reply'}},h.owner),b=await h.agent.start({skill:'conversation.manage',goal:'reply Bob',subjects:[subjectB],parameters:{behavior:'reply'}},h.owner);
 await h.agent.runtime.tick(a.id);messages.push({direction:'incoming',kind:'text',text:'hello',time:'',incomingVerified:true});await h.agent.runtime.tick(a.id);const running=h.agent.runtime.tick(a.id);await started;
 await h.agent.runtime.enqueue(b.id,{key:'bob-message',subjectKey:require('../src/main/conversation-skill').subjectKey(subjectB),type:'conversation.messages',messages:[{direction:'incoming',kind:'text',text:'from Bob',incomingVerified:true}]});
 assert.equal(stops,0);h.conversationDesktop.running=false;h.conversationDesktop.task.status='review';h.conversationDesktop.task.sendState='confirmed';h.conversationDesktop.task.submitAttemptedAt=Date.now();await running;assert.equal(stops,0);assert.equal(h.agent.runtime.tasks.get(a.id).inbox.length,0);await h.agent.close();
});
test('a newer message prevents submitting an already inserted draft and preserves it for review',async()=>{
 const h=fixture(),subject={application:'wechat',recipient:'Alice'},messages=[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true}];let entered;
 const started=new Promise(r=>entered=r);h.agent.actionWatchIntervalMs=5;h.agent.scene.observe=async()=>({headerMatched:true,changed:true,draft:'',messages:structuredClone(messages)});
 h.conversationDesktop.start=async function(value){
  this.task={...value,id:value.operation==='open'?'open':'send',status:value.operation==='open'?'review':'running',steps:[]};this.running=value.operation==='send';
  if(this.running){await this.actionControl.protect();this.task.draftInserted=true;this.task.steps.push({action:'type',purpose:'task',state:'input-sent'});entered();const service=this;void(async()=>{while(!service.actionControl?.superseded)await new Promise(r=>setTimeout(r,5));try{service.actionControl.assertCurrent();}catch{service.running=false;service.task.status='paused';service.task.note='新消息到来，旧草稿待核对';}})();}return {ok:true};
 };
 const a=await h.agent.start({skill:'conversation.manage',goal:'reply',subjects:[subject],parameters:{behavior:'reply'}},h.owner);await h.agent.runtime.tick(a.id);messages.push({direction:'incoming',kind:'text',text:'first',time:'',incomingVerified:true});await h.agent.runtime.tick(a.id);const running=h.agent.runtime.tick(a.id);await started;messages.push({direction:'incoming',kind:'text',text:'second',time:'',incomingVerified:true});await running;
 const task=h.agent.runtime.tasks.get(a.id);assert.equal(task.status,'needs_attention');assert.equal(task.inbox.length,2);assert.equal(h.outgoing.length,0);assert(Object.values(task.operations).some(o=>o.tool==='conversation.send'&&o.status==='intent'));await h.agent.close();
});
test('new same-contact messages during slow planning are merged before any send',async()=>{
 const h=fixture(),subject={application:'wechat',recipient:'Alice'},messages=[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true}],Brain=require('../src/main/conversation-brain').ConversationBrain,prior=Brain.prototype.decide;let entered,release,calls=0;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);h.agent.actionWatchIntervalMs=5;h.agent.scene.observe=async()=>({headerMatched:true,changed:true,draft:'',messages:structuredClone(messages)});
 Brain.prototype.decide=async function(args){calls++;if(calls===1){entered();await gate;}return {decision:'reply',reply:'reply '+args.incoming.map(m=>m.text).join('+'),summary:'done',completed:false,progress:{},unknown:[]};};
 try{
  const a=await h.agent.start({skill:'conversation.manage',goal:'reply',subjects:[subject],parameters:{behavior:'reply'}},h.owner);await h.agent.runtime.tick(a.id);messages.push({direction:'incoming',kind:'text',text:'first',time:'',incomingVerified:true});await h.agent.runtime.tick(a.id);
  const running=h.agent.runtime.tick(a.id);await started;messages.push({direction:'incoming',kind:'text',text:'second',time:'',incomingVerified:true});
  for(let i=0;i<100&&h.agent.runtime.tasks.get(a.id).inbox.length<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(h.agent.runtime.tasks.get(a.id).inbox.length,2);release();await running;assert.equal(h.outgoing.length,0);
  await h.agent.runtime.tick(a.id);assert.equal(h.outgoing.length,1);assert(h.outgoing[0].includes('first+second'));assert.equal(calls,2);
 }finally{Brain.prototype.decide=prior;release();await h.agent.close();}
});
test('a newer event after submit does not cancel the committed action and is handled afterwards',async()=>{
 const h=fixture(),subject={application:'wechat',recipient:'Alice'},messages=[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true}];let entered,stops=0,starts=0;
 const started=new Promise(r=>entered=r);h.agent.actionWatchIntervalMs=5;h.agent.scene.observe=async()=>({headerMatched:true,changed:true,draft:'',messages:structuredClone(messages)});
 h.conversationDesktop.start=async function(value){
  if(value.operation==='open'){this.running=false;this.task={...value,id:'open',status:'review',steps:[]};return {ok:true};}
  starts++;this.task={...value,id:'sent-'+starts,status:'running',steps:[]};
  if(starts===1){this.running=true;await this.actionControl.commit();this.task.submitAttemptedAt=Date.now();entered();const service=this;void(async()=>{while(!service.actionControl?.superseded)await new Promise(r=>setTimeout(r,5));h.outgoing.push(value.message);messages.push({direction:'outgoing',kind:'text',text:value.message,time:'',observedVerified:true});service.task.status='review';service.task.sendState='confirmed';service.running=false;})();}
  else{this.running=false;this.task.status='review';this.task.submitAttemptedAt=Date.now();this.task.sendState='confirmed';h.outgoing.push(value.message);messages.push({direction:'outgoing',kind:'text',text:value.message,time:'',observedVerified:true});}return {ok:true};
 };
 h.conversationDesktop.stop=async function(){stops++;this.running=false;};const a=await h.agent.start({skill:'conversation.manage',goal:'reply',subjects:[subject],parameters:{behavior:'reply'}},h.owner);
 await h.agent.runtime.tick(a.id);messages.push({direction:'incoming',kind:'text',text:'first',time:'',incomingVerified:true});await h.agent.runtime.tick(a.id);const running=h.agent.runtime.tick(a.id);await started;messages.push({direction:'incoming',kind:'text',text:'second',time:'',incomingVerified:true});await running;
 assert.equal(stops,0);assert.equal(h.outgoing.length,1);assert.equal(h.agent.runtime.tasks.get(a.id).inbox.length,1);await h.agent.runtime.tick(a.id);assert.equal(h.outgoing.length,2);assert.equal(stops,0);await h.agent.close();
});
test('explicitly stopping the parent task cancels its running reply exactly once',async()=>{
 const h=fixture(),subject={application:'wechat',recipient:'Alice'},messages=[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true}];let entered,stops=0;
 const started=new Promise(r=>entered=r);h.agent.scene.observe=async()=>({headerMatched:true,changed:true,draft:'',messages:structuredClone(messages)});
 h.conversationDesktop.start=async function(value){this.task={...value,id:value.operation==='open'?'open':'send',status:value.operation==='open'?'review':'running',steps:[]};this.running=value.operation==='send';if(this.running)entered();return {ok:true};};
 h.conversationDesktop.stop=async function(){stops++;this.running=false;this.task.status='stopped';};
 const a=await h.agent.start({skill:'conversation.manage',goal:'reply',subjects:[subject],parameters:{behavior:'reply'}},h.owner);await h.agent.runtime.tick(a.id);messages.push({direction:'incoming',kind:'text',text:'hello',time:'',incomingVerified:true});await h.agent.runtime.tick(a.id);const running=h.agent.runtime.tick(a.id);await started;
 assert((await h.agent.control('stop',a.id)).ok);await running;assert.equal(stops,1);assert.equal(h.agent.runtime.tasks.get(a.id).status,'stopped');assert.equal(h.outgoing.length,0);await h.agent.close();
});
test('a fresh pre-input check catches a same-contact message even before the periodic observer runs',async()=>{
 const h=fixture(),subject={application:'wechat',recipient:'Alice'},messages=[{direction:'outgoing',kind:'text',text:'old',time:'',observedVerified:true}];let starts=0,forced=0;
 h.agent.actionWatchIntervalMs=60000;h.agent.scene.observe=async(_s,opts)=>{if(opts?.force)forced++;return {headerMatched:true,changed:true,draft:'',messages:structuredClone(messages)};};
 h.conversationDesktop.start=async function(value){
  if(value.operation==='open'){this.running=false;this.task={...value,id:'open',status:'review',steps:[]};return {ok:true};}
  starts++;this.task={...value,id:'send-'+starts,status:'running',steps:[]};this.running=true;
  if(starts===1){messages.push({direction:'incoming',kind:'text',text:'second',time:'',incomingVerified:true});await this.beforeReplyInput();return {ok:true};}
  this.running=false;this.task.status='review';this.task.sendState='confirmed';this.task.submitAttemptedAt=Date.now();h.outgoing.push(value.message);return {ok:true};
 };
 h.conversationDesktop.stop=async function(){this.running=false;this.task.status='stopped';this.task.note='superseded';};
 const a=await h.agent.start({skill:'conversation.manage',goal:'reply',subjects:[subject],parameters:{behavior:'reply'}},h.owner);await h.agent.runtime.tick(a.id);messages.push({direction:'incoming',kind:'text',text:'first',time:'',incomingVerified:true});await h.agent.runtime.tick(a.id);await h.agent.runtime.tick(a.id);
 assert(forced>=1);assert.equal(h.outgoing.length,0);assert.equal(h.agent.runtime.tasks.get(a.id).inbox.length,2);await h.agent.runtime.tick(a.id);assert.equal(h.outgoing.length,1);await h.agent.close();
});
test('a proven pre-dispatch busy failure is retried within the action after fresh observation',async()=>{
 const h=fixture(),calls=[];let freeChecks=0;h.agent.canOperate=async()=>++freeChecks>1;h.agent.scene.observe=async(_s,opts)=>{calls.push(!!opts?.force);return {headerMatched:true,changed:true,draft:'',messages:[]};};
 const result=await h.agent.start({skill:'conversation.send',goal:'one message',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{message:'hello'}},h.owner);await h.agent.runtime.tick(result.id);
 const task=h.agent.runtime.tasks.get(result.id);assert.equal(task.status,'completed');assert.equal(h.outgoing.length,1);assert.deepEqual(calls,[false,true]);const op=Object.values(task.operations).find(o=>o.tool==='conversation.send');assert.equal(op.status,'confirmed');assert.equal(op.lifecycle.attempt,2);await h.agent.close();
});
test('an obsolete reply draft is never resumed or sent during reconciliation',async()=>{
 const h=fixture(),started=await h.agent.start({skill:'conversation.manage',goal:'reply',subjects:[{application:'wechat',recipient:'Alice'}],parameters:{behavior:'reply'}},h.owner),task=h.agent.runtime.tasks.get(started.id);
 const physical={id:'old-draft',target:'wechat',operation:'send',status:'paused',draftInserted:true,supersededByNewMessage:true,message:'［Bunny］ old',wechatOwnership:'owner',recipient:'Alice',sources:[task.id]};
 h.conversationDesktop.task=physical;task.state.conversationOperationId=physical.id;task.status='needs_attention';task.operations.pending={id:'pending',effect:'write',tool:'conversation.send',status:'intent',args:{recipient:'Alice',message:'old'},lifecycle:{phase:'uncertain',reason:'newer-event'}};
 let resumed=0;h.conversationDesktop.resume=async()=>{resumed++;return {ok:true};};const result=await h.agent.reconcile(task.id,{resumeDraft:true});assert.equal(result.ok,false);assert.match(result.error,/过期/);assert.equal(resumed,0);assert.equal(task.operations.pending.status,'intent');await h.agent.close();
});
