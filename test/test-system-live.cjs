'use strict';
// Explicit real model interpretation and process execution; not part of npm test.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {AgentService}=require('../src/main/agent-service'),{AuthorizationService}=require('../src/main/authorization-service'),{FileAgentJournal}=require('../src/main/agent-journal');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bunny-system-live-')));fs.chmodSync(root,0o700);
(async()=>{await require('../src/main/model-catalog').refresh('workbuddy');const journal=new FileAgentJournal(path.join(root,'tasks.json'));await journal.load();
 const reports=[],agent=new AgentService({journal,taskDirectory:root,authorization:new AuthorizationService({settings:()=>({terminal:true,systemConfiguration:true})}),scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},report:async r=>reports.push(r),ready:()=>true,epoch:()=>1});
 try{const file=path.join(root,'receipt.txt'),raw='请你自己用本机非破坏性终端命令，在 '+file+' 新建纯文本文件，写入 Bunny proactive process passed. 然后用终端读回核对。不要交给WorkBuddy。最后一句话告诉我结果。';
  const start=await agent.command(raw,{role:'owner',verified:true,channel:'dialogue',sources:['local-real-system-test'],scene:'life'});assert(start.id,JSON.stringify(start));const end=Date.now()+240000;
  while(Date.now()<end){const task=agent.runtime.tasks.get(start.id);if(task.status==='completed'){assert.equal(task.skill,'system.operate');assert.equal(fs.readFileSync(file,'utf8').trim(),'Bunny proactive process passed.');assert(task.counters.writes>=1);assert.equal(reports.length,1);fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:true,task},null,2));console.log(JSON.stringify({passed:true,root}));return;}if(['needs_attention','waiting_permission'].includes(task.status))throw Error(task.note);await new Promise(r=>setTimeout(r,1000));}throw Error('real system test timed out');
 }finally{await agent.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
