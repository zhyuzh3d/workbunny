'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {screenWatchSkill}=require('../src/main/screen-watch-skill');
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
