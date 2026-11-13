'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {screenWatchSkill}=require('../src/main/screen-watch-skill');
function pixelWatch({regions,matched=false}={}){
 const {fixture}=require('./support/visual-fixture.cjs'),{ToolRegistry}=require('../src/main/agent-tools'),{registerScreenTools}=require('../src/main/screen-watch-skill');
 const h=fixture(),tools=new ToolRegistry(),events=[];let judgments=0;
 const task={id:'synthetic-screen-watch',skill:'screen.watch',goal:'观察导出进度',criteria:'导出状态可见',subjects:[{application:'wechat'}],parameters:{condition:'导出完成',...(regions?{regions}:{})},schedule:{intervalSeconds:5},completion:'manual',state:{},counters:{wakes:0}};
 registerScreenTools(tools,{native:h.native,wechatScene:{visual:h.visual},imageResize:bytes=>({mime:'image/png',preview:bytes})});
 const skill=screenWatchSkill({request:async()=>{judgments++;return {response:{text:JSON.stringify({matched,summary:'synthetic state',evidence:'synthetic pixels'})}};}});
 const context={task,now:1000,call:async({tool,args})=>{const entry=tools.get(tool);return entry.execute(entry.validate(args),{task});},enqueue:async(event,{advance})=>{advance(task);events.push(event);return {ok:true};},report:async()=>{},script:async()=>{}};
 return {h,task,tools,events,skill,context,get judgments(){return judgments;},step:async()=>{task.counters.wakes++;return skill.run(context);}};
}
test('quiet watch pixels stay quiet beyond the frame cache and an explicit small region triggers one judgment',async()=>{
 const region={x:.1,y:.8,width:.1,height:.05},f=pixelWatch({regions:[region]});
 await f.step();assert.equal(f.judgments,1);
 for(let i=0;i<9;i++)await f.step();
 assert.equal(f.judgments,1,'evicting the committed frame from the input cache does not create a pixel change');
 assert.equal(f.h.requests.length,1,'unchanged pixels reuse location recognition');
 const r=f.h.location.region,absolute={x:r.x+region.x*r.width,y:r.y+region.y*r.height,width:region.width*r.width,height:region.height*r.height};
 assert(f.h.visual.anchor.monitorRegions.some(b=>JSON.stringify(b)===JSON.stringify(absolute)));
 f.h.paint(f.h.image,absolute);await f.step();assert.equal(f.judgments,2,'a small explicit region outside the model monitors is observed');
 await f.step();assert.equal(f.judgments,2,'the handled change becomes the new sample baseline');
 assert(f.h.calls.every(c=>c.op==='displayCapture'));
});
test('a new watch goal selects new monitors and evaluates unchanged pixels independently of the previous match',async()=>{
 const f=pixelWatch({matched:true});await f.step();assert.equal(f.events.length,1);assert.equal(f.task.state.lastMatched,true);
 const identity=f.h.visual.identity(),monitor={x:.2,y:.7,width:.3,height:.1};f.h.location={...f.h.location,monitorRegions:[monitor]};
 f.task.parameters.condition='上传完成';f.task.criteria='上传状态可见';f.task.state.goalRevision=1;
 await f.step();assert.equal(f.judgments,2);assert.equal(f.h.requests.length,2);assert.equal(f.events.length,2);assert.equal(f.events[1].goalRevision,1);
 assert.deepEqual(f.h.visual.anchor.monitorRegions.map(b=>({...b})),[monitor]);assert.deepEqual(f.h.visual.identity(),identity,'changing observation goals does not rebind visual identity');
 const prompt=f.h.requests.at(-1).messages[1].content[0].text;assert(prompt.includes('上传完成'));assert(prompt.includes('上传状态可见'));assert(prompt.includes('"goalRevision":1'));
 await f.step();assert.equal(f.judgments,2);assert(f.h.calls.every(c=>c.op==='displayCapture'));
});
test('watch regions have one bounded target-relative contract for task and tool validation',()=>{
 const f=pixelWatch(),tool=f.tools.get('screen.observe'),valid={x:0,y:0,width:1,height:1};
 for(const regions of [[],Array(13).fill(valid),[{...valid,x:.1}],[{...valid,width:'1'}],[{...valid,extra:true}]]){
  assert.throws(()=>tool.validate({application:'wechat',regions}));
  assert.throws(()=>f.skill.validate({...f.task,parameters:{regions}}));
 }
 assert.doesNotThrow(()=>tool.validate({application:'wechat',regions:[valid]}));assert.doesNotThrow(()=>f.skill.validate({...f.task,parameters:{regions:[valid]}}));
});
test('ordinary goal Actions can use independent cheap pixel samples and their own observation objective',async()=>{
 const f=pixelWatch();f.task.skill='software.execute';f.task.actionRuns={a:{goal:'Observe one current result area',criteria:'Detect stable changes in that area'}};f.task.operations={sample:{actionId:'a'}};
 const invoke=(name,args)=>{const tool=f.tools.get(name);return tool.execute(tool.validate({application:'wechat',...args}),{task:f.task,operationId:'sample'});};
 const first=await invoke('screen.observe',{sampleId:'result-a'});assert(first.changed);await invoke('screen.commit',{sampleId:'result-a'});
 for(let i=0;i<9;i++)assert.equal((await invoke('screen.observe',{sampleId:'result-a'})).changed,false);
 assert.equal(f.h.requests.length,1,'quiet ordinary Actions do not invoke another model to locate the app');
 const prompt=f.h.requests[0].messages[1].content[0].text;assert(prompt.includes('Observe one current result area'));assert(prompt.includes('Detect stable changes'));
 const other=await invoke('screen.observe',{sampleId:'result-b'});assert(other.changed);await invoke('screen.commit',{sampleId:'result-b'});
 assert.equal((await invoke('screen.observe',{sampleId:'result-a'})).changed,false,'committing another sample cannot replace the first baseline');
 f.h.paint(f.h.image,f.h.location.monitorRegions[0]);assert.equal((await invoke('screen.observe',{sampleId:'result-a'})).changed,true);await invoke('screen.commit',{sampleId:'result-a'});
 assert.equal((await invoke('screen.observe',{sampleId:'result-a'})).changed,false);assert(f.h.calls.every(c=>c.op==='displayCapture'));
});
test('generic screen watching calls no model on quiet pixels and reports only a newly matched condition',async()=>{
 let requests=0,reports=0,changed=false,matched=false,commits=0;const events=[];
 const skill=screenWatchSkill({request:async()=>{requests++;return {response:{text:JSON.stringify({matched,summary:'visible test state',evidence:'test evidence'})}};}});
 const task={goal:'wait for result',criteria:'visible completion',subjects:[{application:'chrome'}],parameters:{},schedule:{intervalSeconds:60},completion:'manual',state:{},counters:{wakes:0}};
 const context={task,now:1000,enqueue:async (event,{advance})=>{advance(task);events.push(event);return {ok:true};},call:async a=>a.tool==='screen.commit'?(commits++,{}):{available:true,changed,preview:'data:image/png;base64,eA==',at:1000},report:async()=>{reports++;},script:async()=>{throw Error('no script authorized');}};
 await skill.run(context);assert.equal(requests,0);changed=true;
 await skill.run(context);assert.equal(requests,1);assert.equal(reports,0);matched=true;
 await skill.run(context);assert.equal(reports,0);await skill.run({...context,event:events.shift()});await skill.run(context);assert.equal(reports,1);assert.equal(commits,3);
 matched=false;await skill.run(context);matched=true;await skill.run(context);await skill.run({...context,event:events.shift()});assert.equal(reports,2);
});
test('slow recognition schedules the next poll after completion and quiet checks refresh the visible check time',async()=>{
 let clock=1000,changed=true,models=0;
 const skill=screenWatchSkill({request:async()=>{models++;clock+=9000;return {response:{text:JSON.stringify({matched:false,summary:'Still working',evidence:'Progress indicator'})}};}});
 const task={goal:'watch',subjects:[{application:'workbuddy'}],parameters:{},schedule:{intervalSeconds:5},completion:'manual',state:{},counters:{wakes:1}};
 const context={task,now:1000,clock:()=>clock,call:async a=>{if(a.tool==='screen.commit')return {};clock+=500;return {available:true,changed,preview:'data:image/png;base64,eA==',at:clock};},report:async()=>{},script:async()=>{}};
 const first=await skill.run(context);assert.equal(first.nextCheckAt,clock+5000);assert.equal(task.state.lastCheckedAt,1500);
 changed=false;clock+=5000;const quiet=await skill.run(context);assert.equal(quiet.nextCheckAt,clock+5000);assert.equal(task.state.lastCheckedAt,clock);assert.equal(models,1);
});
test('a matched trigger survives a delayed, failed action and is resumed before sampling a quiet frame',async()=>{
 let requests=0,samples=0,attempts=0,reports=0,saved,keys=[],event;
 const skill=screenWatchSkill({request:async()=>{requests++;return {response:{text:JSON.stringify({matched:true,summary:'condition met',evidence:'visible'})}};}});
 let task={goal:'watch',subjects:[{application:'wechat'}],parameters:{onMatch:[{tool:'conversation.send',args:{application:'wechat',recipient:'Alice',message:'hello'}}]},schedule:{intervalSeconds:5},completion:'manual',state:{},counters:{wakes:1}};
 const context={task,now:1000,enqueue:async (value,{advance})=>{advance(task);event=structuredClone(value);saved=structuredClone(task.state);return {ok:true};},call:async a=>a.tool==='screen.commit'?{}:(samples++,{available:true,changed:true,preview:'data:image/png;base64,eA==',at:1000}),checkpoint:async()=>{saved=structuredClone(task.state);},report:async()=>{reports++;},script:async plan=>{keys.push(plan.steps[0].key);if(++attempts===1)throw Object.assign(Error('busy'),{dispatched:false});}};
 await skill.run(context);assert.equal(event.type,'screen.condition');await assert.rejects(skill.run({...context,event}),/busy/);assert.equal(requests,1);assert.equal(samples,1);
 task={...task,state:structuredClone(saved),counters:{wakes:2}};context.task=task;context.call=async a=>a.tool==='screen.commit'?{}:(samples++,{available:true,changed:false});
 await skill.run({...context,event});assert.equal(requests,1);assert.equal(samples,1,'the durable event continues independently of later quiet frames');assert.equal(reports,1);assert.equal(keys[0],keys[1]);
});
