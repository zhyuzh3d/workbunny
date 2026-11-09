'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AgentService}=require('../src/main/agent-service'),{AuthorizationService}=require('../src/main/authorization-service');
function fixture(decide){const records=new Map(),reports=[];let requests=0;const journal={put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()],authorized:async()=>true};
 const agent=new AgentService({journal,ready:()=>true,epoch:()=>1,autoSchedule:false,scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},authorization:new AuthorizationService({settings:()=>({terminal:true,systemConfiguration:true}),permissions:async()=>({screenCaptureAllowed:true,accessibilityTrusted:true,postEventAllowed:true})}),report:async r=>reports.push(r),request:async options=>({response:{text:JSON.stringify(await decide(requests++,options))}})});
 agent.runtime.diagnoseRepair=async()=>({action:'change_method',source:'local'});
 return {agent,records,reports,requests:()=>requests,owner:{role:'owner',verified:true,channel:'dialogue',sources:['owner'],scene:'life'}};
}
const uname={application:'system',command:'/usr/bin/uname',args:['-s'],impact:'read',purpose:'核对内核'};
test('a new task repairs a proven non-dispatch using another command and completes from actual output',async()=>{
 const f=fixture(i=>i===0?{done:false,tool:'terminal.execute',args:{...uname,command:'/not-a-real-program'}}:i===1?{done:false,tool:'terminal.execute',args:uname}:{done:true,summary:'已从实际输出确认 Darwin。'});
 const start=await f.agent.start({skill:'system.operate',goal:'核对内核并自行解决路径错误',subjects:[{application:'system'}]},f.owner);
 for(let i=0;i<3;i++)await f.agent.runtime.tick(start.id);const task=f.agent.runtime.tasks.get(start.id);
 assert.equal(task.status,'completed');assert.equal(task.state.attempts.length,2);assert.equal(task.state.attempts[0].dispatched,false);assert.match(task.state.attempts[1].result.stdout,/Darwin/);assert.equal(f.reports.length,1);await f.agent.close();
});
test('a confirmed primitive is not executed twice when restart occurs before its workflow checkpoint',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-once-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'once.txt'),args={...uname,command:'/bin/sh',args:['-c','printf x >> "$1"','test',file]};
 const f=fixture(i=>i===0?{done:false,tool:'terminal.execute',args}:{done:true,summary:'文件已写入一次。'});
 const started=await f.agent.start({skill:'system.operate',goal:'只写一次测试内容',subjects:[{application:'system'}]},f.owner);await f.agent.runtime.tick(started.id);assert.equal(fs.readFileSync(file,'utf8'),'x');
 const saved=f.records.get(started.id);saved.state.attempts=[];saved.state.pendingDecision={done:false,tool:'terminal.execute',args};saved.state.stepSequence=0;
 await f.agent.restore();await f.agent.runtime.tick(started.id);assert.equal(fs.readFileSync(file,'utf8'),'x');assert.equal(f.agent.runtime.tasks.get(started.id).counters.writes,1);await f.agent.runtime.tick(started.id);assert.equal(f.agent.runtime.tasks.get(started.id).status,'completed');await f.agent.close();
});
test('a cross-software task sees only its scoped tool capabilities and can compose observation with a work step',async()=>{
 const f=fixture((i,options)=>{const input=JSON.parse(options.messages[1].content[0].text);assert(!input.tools.some(t=>t.name==='terminal.execute'));return i===0?{done:false,tool:'conversation.observe',args:{application:'wechat',recipient:'Alice'}}:i===1?{done:false,tool:'work.submit',args:{application:'workbuddy',goal:'制作Alice所需的简短清单',criteria:'给出三项清单'}}:{done:true,summary:'已读取来信并交办清单制作。'};});
 f.agent.scene.observe=async()=>({headerMatched:true,messages:[{text:'请给三项清单',direction:'incoming'}]});f.agent.submitWork=async(task,signal,step)=>{assert.equal(step.goal,'制作Alice所需的简短清单');return {ok:true,verified:true,jobId:'actual-binding',sessionId:'exact-session'};};
 const started=await f.agent.start({skill:'software.execute',goal:'读取Alice来信并把清单制作交给WorkBuddy，交办后汇报',subjects:[{application:'wechat',recipient:'Alice'},{application:'workbuddy'}]},f.owner);assert(started.ok,started.error);
 for(let i=0;i<3;i++)await f.agent.runtime.tick(started.id);assert.equal(f.agent.runtime.tasks.get(started.id).status,'completed');assert.equal(f.reports.length,1);await f.agent.close();
});
test('unobserved input is information for Bunny to judge; the host does not dictate a business verdict',async()=>{
 const f=fixture((i,options)=>{const input=JSON.parse(options.messages[1].content[0].text);if(i===1)assert.deepEqual(input.pendingObservation,['workbuddy']);return i===0?{done:false,tool:'screen.action',args:{application:'workbuddy',frameId:'fixture',action:'click',targetType:'icon',pixelX:400,pixelY:300}}:i===1?{done:false,tool:'screen.observe',args:{application:'workbuddy'}}:{done:true,summary:'已在操作后观察并确认。'};});
 let inputs=0,observations=0;
 f.agent.tools.tools.set('screen.action',{...f.agent.tools.get('screen.action'),execute:async()=>{inputs++;return {ok:true,verified:true,receipt:{inputPerformed:true,businessResult:'needs observation'}};}});
 f.agent.tools.tools.set('screen.observe',{...f.agent.tools.get('screen.observe'),execute:async()=>{observations++;return {available:true,changed:false,frameId:'after-input'};}});
 const started=await f.agent.start({skill:'software.execute',goal:'操作后核对软件画面',subjects:[{application:'workbuddy'}]},f.owner);
 await f.agent.runtime.tick(started.id);assert.deepEqual(f.agent.runtime.tasks.get(started.id).state.pendingObservation,['workbuddy']);await f.agent.restore();await f.agent.runtime.tick(started.id);assert.equal(f.agent.runtime.tasks.get(started.id).status,'waiting');await f.agent.runtime.tick(started.id);
 assert.equal(f.agent.runtime.tasks.get(started.id).status,'completed');assert.equal(inputs,1);assert.equal(observations,1);assert.equal(f.requests(),3);await f.agent.close();
});
test('the same input lifecycle supplies fresh evidence so the next model call can finish without requesting a screenshot',async()=>{
 const f=fixture((i,options)=>{const input=JSON.parse(options.messages[1].content[0].text);if(i===1){assert.deepEqual(input.pendingObservation,[]);assert.equal(input.currentFrame.frameId,'after-click');assert.equal(options.messages[1].content.at(-1).type,'image_url');}return i===0?{done:false,tool:'screen.action',args:{application:'workbuddy',frameId:'fixture',action:'click',targetType:'icon',pixelX:400,pixelY:300}}:{done:true,summary:'依据操作后的实际画面确认完成。'};});
 f.agent.tools.tools.set('screen.action',{...f.agent.tools.get('screen.action'),execute:async()=>({ok:true,verified:true,receipt:{inputPerformed:true},observation:{available:true,preview:'data:image/png;base64,fixture',frameId:'after-click',width:800,height:600,at:Date.now()}})});
 const started=await f.agent.start({skill:'software.execute',goal:'点击并自行核查结果',subjects:[{application:'workbuddy'}]},f.owner);await f.agent.runtime.tick(started.id);await f.agent.runtime.tick(started.id);assert.equal(f.agent.runtime.tasks.get(started.id).status,'completed');assert.equal(f.requests(),2);await f.agent.close();
});
test('composed file inspection produces real artifacts and delegates the final text and attachment to the shared delivery pipeline',async t=>{
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bunny-composed-file-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const file=path.join(directory,'context.txt');fs.writeFileSync(file,'Cedar-A20; Thursday.');const delivered=[];
 const f=fixture((i,options)=>{const input=JSON.parse(options.messages[1].content[0].text);assert.deepEqual(input.delivery,{channel:'wechat',recipient:'Alice',includeFiles:true});return i===0?{done:false,tool:'files.inspect',args:{application:'system',path:file}}:{done:true,summary:'实际文件内容为Cedar-A20与Thursday。',artifacts:input.attempts[0].result.artifactManifest.files};});
 f.agent.deliverWork=async(message,task,signal,index)=>{delivered.push({message,index});return {ok:true,verified:true,receipt:{recipient:task.delivery.recipient,sentText:message||'context.txt'}};};
 const started=await f.agent.start({skill:'software.execute',goal:'读回文件后微信发送实际附件和结论',subjects:[{application:'system'}],delivery:{channel:'wechat',recipient:'Alice',includeFiles:true}},f.owner);assert(started.ok,started.error);
 await f.agent.runtime.tick(started.id);await f.agent.runtime.tick(started.id);const task=f.agent.runtime.tasks.get(started.id);assert.equal(task.status,'completed');assert.equal(task.state.delivery.status,'delivered');assert.equal(task.state.result.artifacts[0].path,file);assert.equal(delivered.length,2);assert.equal(delivered[1].index,0);assert.equal(f.reports.length,0);await f.agent.close();
});
test('delivery authorization does not expose unrelated GUI tools to a file-only execution plan',async()=>{
 const f=fixture((i,options)=>{const input=JSON.parse(options.messages[1].content[0].text);assert.equal(input.goal,'Read the specified local file');assert(!input.tools.some(t=>t.name.startsWith('screen.')||t.name.startsWith('conversation.')));return {done:false,tool:'files.inspect',args:{application:'system',path:'/not-existing-bunny-fixture'}};});
 const started=await f.agent.start({skill:'software.execute',goal:'Read a local file, then send it to Alice',workRequest:{goal:'Read the specified local file',output:'files'},subjects:[{application:'system'}],delivery:{channel:'wechat',recipient:'Alice',includeFiles:true}},f.owner);assert(started.ok,started.error);await f.agent.runtime.tick(started.id);assert.equal(f.requests(),1);assert.equal(f.agent.runtime.tasks.get(started.id).state.attempts[0].tool,'files.inspect');await f.agent.close();
});
test('confirmed resources and inspected file artifacts survive the bounded recent-attempt window',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bunny-resource-memory-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'known.txt');fs.writeFileSync(file,'Actual text.');let seen=false;
 const f=fixture((i,options)=>{const input=JSON.parse(options.messages[1].content[0].text);if(i===0)return {done:false,tool:'files.inspect',args:{application:'system',path:file}};assert.equal(input.knownArtifacts[0].path,file);assert.equal(input.confirmedEffects[0].receipt.directory,dir);seen=true;return {done:true,summary:'实际文件已核对。',artifacts:input.knownArtifacts};});
 const created=await f.agent.start({skill:'software.execute',goal:'inspect file',subjects:[{application:'system'}]},f.owner);await f.agent.runtime.tick(created.id);const task=f.agent.runtime.tasks.get(created.id);task.state.attempts=[{tool:'screen.observe',result:{available:true}}];task.operations.resource={id:'resource',effect:'write',status:'confirmed',tool:'files.destination',result:{receipt:{directory:dir}}};await f.agent.runtime.save(task);await f.agent.runtime.tick(created.id);assert(seen);assert.equal(task.state.result.artifacts[0].path,file);assert.equal(task.status,'completed');await f.agent.close();
});
test('invalid primitive arguments are repaired before an operation is persisted or a step is spent',async()=>{
 const f=fixture(i=>({done:false,tool:'screen.action',args:{application:'workbuddy',action:'click',targetType:'icon',pixelX:400,pixelY:300,...(i?{frameId:'current-frame'}:{})}}));let inputs=0;f.agent.tools.tools.set('screen.action',{...f.agent.tools.get('screen.action'),execute:async()=>{inputs++;return {ok:true,verified:true,receipt:{inputPerformed:true}};}});
 const created=await f.agent.start({skill:'software.execute',goal:'click the actual button',subjects:[{application:'workbuddy'}]},f.owner);await f.agent.runtime.tick(created.id);const task=f.agent.runtime.tasks.get(created.id);assert.equal(f.requests(),2);assert.equal(inputs,1);assert.equal(task.state.stepSequence,1);assert.equal(Object.values(task.operations).filter(o=>o.effect==='write').length,1);await f.agent.close();
});
test('a proven visual non-dispatch returns the failed plan to Bunny so she can choose a different observation strategy',async()=>{
 const f=fixture((i,options)=>{const input=JSON.parse(options.messages[1].content[0].text);if(i===1){assert.equal(input.lastFailure.code,'E_VISUAL_TARGET');assert.equal(input.attempts[0].dispatched,false);assert.equal(input.previousVisualDecision.tool,'screen.observe');assert.equal(input.recoveryGuidance.action,'change_method');}return i<2?{done:false,tool:'screen.observe',args:{application:'workbuddy',...(i?{force:true}:{})}}:{done:true,summary:'已依据重新观察的真实画面确认。'};});
 let samples=0;f.agent.runtime.diagnoseRepair=async()=>({action:'change_method',nextStep:'重新观察可见目标',source:'llm'});f.agent.tools.tools.set('screen.observe',{...f.agent.tools.get('screen.observe'),execute:async a=>{samples++;if(samples===1)throw Object.assign(Error('small identity text is unclear'),{code:'E_VISUAL_TARGET',dispatched:false});assert.equal(a.force,true);return {available:true,changed:true,frameId:'fresh'};}});
 const created=await f.agent.start({skill:'software.execute',goal:'核对目标软件当前画面',subjects:[{application:'workbuddy'}]},f.owner);for(let i=0;i<3;i++)await f.agent.runtime.tick(created.id);const task=f.agent.runtime.tasks.get(created.id);assert.equal(task.status,'completed');assert.equal(f.requests(),3);assert.equal(samples,2);assert.equal(task.state.pendingDecision,undefined);await f.agent.close();
});
test('the model can retrieve the full scoped experience when a summary is insufficient',async()=>{
 const full='适用系统检查。\n\n'+('详细方法和失效条件。'.repeat(450));let sawFull=false;
 const f=fixture((i,options)=>{const input=JSON.parse(options.messages[1].content[0].text);
  if(i===0){assert(input.knowledge[0].truncated);assert(input.tools.some(t=>t.name==='experience.read'));return {done:false,tool:'experience.read',args:{reference:'experience-1',limit:12000}};}
  sawFull=input.attempts[0].result.instructions===full;return {done:true,summary:'已读取完整经验。'};
 });
 const created=await f.agent.start({skill:'system.operate',goal:'了解系统检查方法',subjects:[{application:'system'}]},f.owner),task=f.agent.runtime.tasks.get(created.id);
 task.state.operatingKnowledge=[{sourceId:'experience-1',status:'candidate',instructions:full}];
 await f.agent.runtime.tick(created.id);await f.agent.runtime.tick(created.id);
 assert(sawFull);assert.equal(task.status,'completed');
 const read=f.agent.tools.get('experience.read');await assert.rejects(read.execute({reference:'other',offset:0,limit:100},{task}),/不属于/);await f.agent.close();
});

test('the model can adjust an optional context fragment and continue the same goal',async()=>{
 let second;
 const f=fixture((i,options)=>{
  const input=JSON.parse(options.messages[1].content[0].text);
  if(i===0)return {done:false,reassemble:{fragment:'knowledge',detail:'full',limit:1,maxTokens:3000},reason:'需要查看更完整的经验'};
  second=input;return {done:false,tool:'terminal.execute',args:uname};
 });
 const created=await f.agent.start({skill:'system.operate',goal:'核对系统实际状态',criteria:'给出真实输出',subjects:[{application:'system'}]},f.owner),task=f.agent.runtime.tasks.get(created.id);
 task.state.operatingKnowledge=[{sourceId:'a',instructions:'第一条经验。'}, {sourceId:'b',instructions:'第二条经验。'}];
 await f.agent.runtime.tick(created.id);assert.deepEqual(task.state.contextTuning.knowledge,{detail:'full',limit:1,maxTokens:3000});assert.equal(task.counters.writes,0);
 await f.agent.runtime.tick(created.id);assert.equal(second.goal,'核对系统实际状态');assert.equal(second.criteria,'给出真实输出');assert.equal(second.knowledge.length,1);
 assert.equal(task.state.attempts.length,1);assert.match(task.state.attempts[0].result.stdout,/Darwin/);await f.agent.close();
});

test('an exploration checkpoint reviews progress and continues without owner intervention',async()=>{
 let review;const f=fixture((_i,options)=>{review=JSON.parse(options.messages[1].content[0].text).explorationReview;return {done:false,tool:'terminal.execute',args:uname};});
 const started=await f.agent.start({skill:'system.operate',goal:'核对内核',subjects:[{application:'system'}]},f.owner),task=f.agent.runtime.tasks.get(started.id);
 task.state.stepSequence=64;await f.agent.runtime.tick(started.id);
 assert.equal(f.requests(),1);assert.equal(review.from,0);assert.equal(review.to,64);assert.equal(task.state.stepSequence,65);assert.equal(task.state.explorationStart,64);assert.equal(task.counters.writes,1);assert.equal(task.status,'waiting');await f.agent.close();
});
test('revising a task discards its old pending plan while preserving confirmed operations',async()=>{
 const f=fixture(()=>({done:false,tool:'terminal.execute',args:uname})),started=await f.agent.start({skill:'system.operate',goal:'旧目标',subjects:[{application:'system'}]},f.owner),task=f.agent.runtime.tasks.get(started.id);
 task.state.stepSequence=64;task.state.pendingDecision={tool:'terminal.execute',args:{...uname,command:'/old-plan-should-not-run'}};
 assert((await f.agent.runtime.update(task.id,{goal:'新目标'},f.owner)).ok);await f.agent.runtime.tick(task.id);assert.equal(task.state.stepSequence,65);assert.equal(task.state.attempts.at(-1).args.command,'/usr/bin/uname');assert.equal(task.state.explorationStart,64);await f.agent.close();
});
test('authentication circuit immediately pauses an adaptive task rather than consuming all exploration steps',async()=>{
 const f=fixture(()=>({done:false,tool:'screen.observe',args:{application:'wechat'}}));f.agent.scene.visual={observe:async()=>{throw Object.assign(Error('请重新登录'),{code:'E_APP_CIRCUIT',dispatched:false});}};
 const created=await f.agent.start({skill:'software.execute',goal:'观察Alice',subjects:[{application:'wechat',recipient:'Alice'}]},f.owner);await f.agent.runtime.tick(created.id);const task=f.agent.runtime.tasks.get(created.id);
 assert.equal(task.status,'needs_attention');assert.equal(task.state.lastFailure.code,'E_APP_CIRCUIT');assert.equal(task.state.stepSequence,0);assert.equal(f.requests(),1);await f.agent.close();
});
for(const changed of [false,true])test('a slow visual decision '+(changed?'replans on actual changed pixels':'executes after fresh identical pixels'),async()=>{
 let now=1000,inputs=[],checks=0;const image='data:image/png;base64,b2xk',newImage='data:image/png;base64,bmV3';
 const f=fixture((i,options)=>{now+=i===0?31000:0;if(i>0&&changed)assert.equal(JSON.parse(options.messages[1].content[0].text).previousVisualDecision.args.frameId,'original');return {done:false,tool:'screen.action',args:{application:'workbuddy',frameId:i===0?'original':'fresh',action:'click',targetType:'icon',pixelX:400,pixelY:300}};});
 f.agent.runtime.clock=()=>now;
 f.agent.tools.tools.set('screen.observe',{...f.agent.tools.get('screen.observe'),execute:async(a,c)=>{assert.equal(a.force,true);checks++;c.task.state.screenAnchors.workbuddy={...c.task.state.screenAnchors.workbuddy,frameId:'fresh',at:now};return {available:true,changed:true,preview:changed?newImage:image,frameId:'fresh',width:800,height:600,at:now};}});
 f.agent.tools.tools.set('screen.action',{...f.agent.tools.get('screen.action'),execute:async a=>{inputs.push(a.frameId);return {ok:true,verified:true,receipt:{inputPerformed:true}};}});
 const started=await f.agent.start({skill:'software.execute',goal:'operate',subjects:[{application:'workbuddy'}]},f.owner),task=f.agent.runtime.tasks.get(started.id);
 task.state.latestImage={application:'workbuddy',preview:image,frameId:'original',width:800,height:600,at:now};task.state.screenAnchors={workbuddy:{frameId:'original',mode:'visual',sessionId:'fixture-visual-session',rect:{x:0,y:0,width:800,height:600},at:now}};
 await f.agent.runtime.tick(started.id);assert.equal(checks,1);
 if(changed){assert.deepEqual(inputs,[]);assert.equal(task.state.latestImage.preview,newImage);await f.agent.runtime.tick(started.id);}
 assert.deepEqual(inputs,['fresh']);await f.agent.close();
});
