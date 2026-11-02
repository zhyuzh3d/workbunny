'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {screenWatchSkill}=require('../src/main/screen-watch-skill');
test('generic screen watching calls no model on quiet pixels and reports only a newly matched condition',async()=>{
 let requests=0,reports=0,changed=false,matched=false,commits=0;
 const skill=screenWatchSkill({request:async()=>{requests++;return {response:{text:JSON.stringify({matched,summary:'visible test state',evidence:'test evidence'})}};}});
 const task={goal:'wait for result',criteria:'visible completion',subjects:[{application:'chrome'}],parameters:{},schedule:{intervalSeconds:60},completion:'manual',state:{},counters:{wakes:0}};
 const context={task,now:1000,call:async a=>a.tool==='screen.commit'?(commits++,{}):{available:true,changed,preview:'data:image/png;base64,eA==',at:1000},report:async()=>{reports++;},script:async()=>{throw Error('no script authorized');}};
 await skill.run(context);assert.equal(requests,0);changed=true;
 await skill.run(context);assert.equal(requests,1);assert.equal(reports,0);matched=true;
 await skill.run(context);await skill.run(context);assert.equal(reports,1);assert.equal(commits,3);
 matched=false;await skill.run(context);matched=true;await skill.run(context);assert.equal(reports,2);
});
