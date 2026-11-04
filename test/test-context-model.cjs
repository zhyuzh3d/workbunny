'use strict';
// Real read-only model, synthetic context modules. No desktop/WeChat input.
const assert=require('node:assert/strict');
const {ConversationBrain}=require('../src/main/conversation-brain'),{createContextSession}=require('../src/main/context-assembler');
(async()=>{
 await require('../src/main/model-catalog').refresh('workbuddy');const loads=[],session=createContextSession({fragments:[
  {id:'task_status',description:'Actual current task monitoring snapshot, including the project reference and output count.',load:async()=>{loads.push('task_status');return [{id:'synthetic-task',project:'Aurora',status:'running',artifactCount:7,note:'Compare with the previous owner request stored in memory.'}];}},
  {id:'memory_search',description:'Look up previous owner requests by query.',load:async p=>{loads.push('memory_search');return {query:p.query,project:'Aurora',ownerRequestedArtifactCount:7,source:'synthetic historical fixture'};}}
 ]});
 const began=Date.now(),brain=new ConversationBrain(),result=await brain.decide({task:{goal:'Reply to owner requests',criteria:'Accurate replies',parameters:{behavior:'reply'},state:{}},subject:{application:'wechat',recipient:'Synthetic contact'},conversation:{},incoming:[{kind:'text',text:'当前任务的产物数量是否已经达到我之前交代的数量？请查看实际任务状态和之前的约定，再回答。',incomingVerified:true}],channelContext:{permission:{owner:true,scene:'life'},taskOverview:'1 active task; details available on demand.',contextSession:session}});
 assert(loads.includes('task_status'));assert(loads.includes('memory_search'));assert.equal(result.ownerAction,undefined,'a status query must not dispatch a new task');assert(/[7七]/u.test(result.reply));console.log(JSON.stringify({passed:true,actualModel:true,syntheticContextModules:true,actualWeChat:false,elapsedMs:Date.now()-began,loads,reply:result.reply}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
