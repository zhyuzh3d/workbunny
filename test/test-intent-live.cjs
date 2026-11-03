'use strict';
// Live model, controlled text scenarios only; no software/UI action is executed.
const assert=require('assert/strict');
const {AgentService}=require('../src/main/agent-service');
async function run(){
 const agent=new AgentService({scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},journal:{put:async()=>{},list:async()=>[],authorized:async()=>true},autoSchedule:false});
 const previous={id:'completed-cedar-work',skill:'work.delegate',goal:'生成 Cedar-UX 的 UTF-8 文件 /tmp/cedar-ux.txt，内容为 Bunny UX context passed.，末尾无换行',subjects:[{application:'workbuddy'}],status:'completed',note:'结果已通过微信发送',result:{summary:'文件已生成并核对',artifacts:[{path:'/tmp/cedar-ux.txt'}]}};
 const context=JSON.stringify([{role:'user',text:'请生成 Cedar-UX 文件 /tmp/cedar-ux.txt，内容 Bunny UX context passed.，末尾无换行；完成后结论和文件都发到文件传输助手。'},{role:'assistant',text:'已生成、核对，并通过文件传输助手发送实际文件。'}]);
 const cases=[['再给刚才那个实验文件末尾加一个空格和“Second pass.”，仍不要换行。这次也只把最新结果和文件发到文件传输助手。','update'],['Append the text "Second pass." to the file we just made. Continue the same work and send the revised file to me on WeChat.','update'],['把刚才最新版成果和实际文件转给Alice，不要重新制作。','task','result.forward'],['这是另一份独立的新任务，请让WorkBuddy新建一个三项清单，不要续办Cedar实验。','task','work.delegate']];
 try{for(let i=0;i<cases.length;i+=2){const results=await Promise.allSettled(cases.slice(i,i+2).map(async([text,kind,skill])=>{const decision=await agent.interpreter.interpret(text,{tasks:[previous],context,actor:{role:'owner',verified:true,channel:'dialogue',sources:['text-fixture'],scene:'life'}});assert.equal(decision.kind,kind,JSON.stringify(decision));if(kind==='update')assert.equal(decision.id,previous.id);if(skill)assert.equal(decision.task.skill,skill);return {case:text.slice(0,35),kind:decision.kind,skill:decision.task?.skill,id:decision.id};}));for(const result of results){if(result.status==='rejected')throw result.reason;console.log(JSON.stringify(result.value));}}console.log(JSON.stringify({passed:true,liveModel:true,controlledTextOnly:true,softwareActions:false}));}finally{await agent.close();}
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;});
