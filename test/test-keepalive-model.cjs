'use strict';
// Actual model + isolated SQLite + one harmless terminal command; no GUI.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {MemoryService}=require('../src/main/memory-service'),{AgentService}=require('../src/main/agent-service');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-keepalive-model-'));let memory,agent;
(async()=>{await require('../src/main/model-catalog').refresh('workbuddy');memory=new MemoryService({dir:path.join(root,'vault'),bin:path.resolve('bin/vault'),openKey:async()=>Buffer.alloc(32,97),getSettings:()=>({enabled:true,extract:false,scene:'life'})});await memory.init();assert(memory.ready,memory.error);
 const source=await memory.addMessage('user','执行隔离保活实验，只输出已指定的测试标记，不读取资料。');
 const scene={native:{request:async()=>({})},metrics:{},invalidate(){},close:async()=>{}};agent=new AgentService({memory,scene,autoSchedule:false,ready:()=>true,taskDirectory:path.join(root,'tasks')});
 const start=await agent.start({skill:'system.operate',goal:'只执行一次 terminal.execute：/bin/echo KEEPALIVE_RECOVERED_21，并根据真实stdout确认完成。不读取用户文件，不修改系统配置。',criteria:'实际stdout包含指定标记，只执行一次',subjects:[{application:'system'}]}, {role:'owner',verified:true,channel:'dialogue',scene:'life',sources:[source.id]});assert(start.ok,start.error);
 const task=agent.runtime.tasks.get(start.id),goal=task.goal,began=Date.now();task.nextCheckAt=Date.now()+120000;agent.runtime.keepalive.state(task).lastActivityAt=Date.now()-61000;await agent.runtime.save(task);
 agent.runtime.keepalive.inspect(agent.runtime);const pending=[...agent.runtime.keepalive.pending.values()];assert.equal(pending.length,1);await pending[0].work;assert.equal(task.goal,goal);assert.equal(Object.keys(task.operations).length,0);assert(task.state.keepaliveGuidance);
 for(let n=0;n<6&&task.status!=='completed';n++)await agent.runtime.tick(task.id);
 assert.equal(task.status,'completed',task.note);const commands=Object.values(task.operations).filter(o=>o.tool==='terminal.execute');assert.equal(commands.length,1);assert.equal(commands[0].status,'confirmed');assert.equal(commands[0].result.stdout.trim(),'KEEPALIVE_RECOVERED_21');
 const result={passed:true,actualModel:true,actualTerminal:true,actualGUI:false,sameTaskResumed:true,commandCount:1,elapsedMs:Date.now()-began,guidance:task.state.keepaliveGuidance};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({...result,directory:root}));
})().catch(e=>{console.error(JSON.stringify({failed:e.message,directory:root}));process.exitCode=1;}).finally(async()=>{await agent?.close();await memory?.close();});
