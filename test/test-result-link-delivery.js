'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {AgentService}=require('../src/main/agent-service');
const url='https://example.com/game?sharecode=a%2Fb%2Bc&mode=kids#level-10',summary='游戏已做好，可以打开游玩。';
test('result links survive runtime reporting and durable outbox without being read aloud',async()=>{
 const reports=[],records=new Map(),agent=new AgentService({scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},ready:()=>true,epoch:()=>1,autoSchedule:false,journal:{put:async t=>records.set(t.id,structuredClone(t)),authorized:async()=>true},report:async r=>reports.push(r)});
 agent.skills.register({id:'fixture.result',version:1,description:'result fixture',tools:[],capabilities:[],run:async({task,report})=>{task.state.result={summary,text:'实际成果 '+url,links:[{url}]};await report(summary+'\n'+url,'result:1',{links:[{url}],speechText:summary});return {status:'completed'};}});
 const runtime=agent.runtime;
 try{const created=await runtime.start({skill:'fixture.result',goal:'provide a result',subjects:[{application:'system'}]},{role:'owner',verified:true,sources:['owner'],scene:'life'});await runtime.tick(created.id);assert.equal(reports.length,1);assert.equal(reports[0].links[0].url,url);assert.equal(reports[0].speechText,summary);assert(reports[0].text.includes(url));assert.equal(runtime.list()[0].result.links[0].url,url);
  const outbox=records.get(created.id).state.reportOutbox;assert.equal(outbox.length,1);assert.equal(outbox[0].links[0].url,url);assert.equal(outbox[0].speechText,summary);await agent.restoreReports();assert.equal(reports.length,2);assert.equal(reports[1].links[0].url,url);assert.equal(reports[1].speechText,summary);assert.equal(records.get(created.id).state.reportOutbox.length,1);
 }finally{await agent.close();}
});
test('legacy results expose full links while opening rechecks scene, archive, epoch and readiness',async()=>{
 let scene='life',ready=true,epoch=1;const records=new Map(),agent=new AgentService({scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},getScene:()=>scene,ready:()=>ready,epoch:()=>epoch,autoSchedule:false,journal:{put:async t=>records.set(t.id,structuredClone(t)),authorized:async()=>true}});
 try{const created=await agent.start({skill:'work.delegate',goal:'return a game link',subjects:[{application:'workbuddy'}]},{role:'owner',verified:true,sources:['owner'],scene:'life'}),task=agent.runtime.tasks.get(created.id);task.status='completed';task.state.result={summary,text:'完整原答复\n'+url};
  assert.equal(agent.status().tasks[0].result.links[0].url,url);assert.equal(await agent.revealResultLink(created.id,0),url);await assert.rejects(agent.revealResultLink(created.id,1));
  scene='work';await assert.rejects(agent.revealResultLink(created.id,0));scene='life';task.state.listArchive={at:1};await assert.rejects(agent.revealResultLink(created.id,0));delete task.state.listArchive;
  ready=false;await assert.rejects(agent.revealResultLink(created.id,0));ready=true;epoch++;await assert.rejects(agent.revealResultLink(created.id,0));
 }finally{await agent.close();}
});
test('the result-link IPC opens only the server-selected URL and rejects a scope change during lookup',async()=>{
 const source=fs.readFileSync('src/main/index.js','utf8'),start=source.indexOf("ipcMain.handle('pet:agent-result-link'"),end=source.indexOf('\n',start),handlers=new Map(),opened=[],sender={},panel={};let scene='life',pause,release;
 const context={ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},trustedCompanion:()=>{},win:{webContents:sender},panels:new Map([['desktop',{webContents:panel}]]),screenLocked:false,memory:{ready:true,generation:1},currentScene:()=>scene,agent:{revealResultLink:async(id,index)=>{assert.equal(id,'task');assert.equal(index,0);if(pause)await new Promise(r=>release=r);return url;}},shell:{openExternal:async value=>opened.push(value)}};
 vm.runInNewContext(source.slice(start,end),context);const open=handlers.get('pet:agent-result-link');await open({sender},{id:'task',index:0,url:'javascript:alert(1)'});assert.deepEqual(opened,[url]);await assert.rejects(open({sender:{}},{id:'task',index:0}));
 pause=true;const pending=open({sender:panel},{id:'task',index:0});await new Promise(r=>setImmediate(r));scene='work';release();await assert.rejects(pending);assert.equal(opened.length,1);
});
test('the completion queue shows the link but sends only the short summary to TTS',async()=>{
 const source=fs.readFileSync('src/main/index.js','utf8'),start=source.indexOf('async function flushTaskReports()'),end=source.indexOf('/* ── 窗口',start),sent=[],spoken=[];
 const context={Date:{now:()=>10000},quitting:false,taskReports:[{taskId:'task',eventId:'event',epoch:1,text:summary+'\n'+url,links:[{url}],speechText:summary,persisted:true}],taskReportTimer:null,clearTimeout:()=>{},setTimeout:()=>({unref(){}}),screenLocked:false,memory:{ready:true,generation:1},busy:false,speaking:false,composing:false,lastHeardAt:0,taskReportCancelled:()=>false,visibleHere:()=>true,history:[],scopePolicy:{scopeOf:()=>({domain:'life'})},presentedReplies:new Set(),agent:{acknowledgeReport:async()=>{}},send:(name,value)=>sent.push({name,...value}),speak:(text,options)=>spoken.push({text,options}),quietUntil:0,win:null};
 vm.runInNewContext(source.slice(start,end),context);await context.flushTaskReports();assert.equal(sent[0].text,summary+'\n'+url);assert.equal(sent[0].links[0].url,url);assert.equal(sent[0].taskId,'task');assert.equal(spoken[0].text,summary);assert.equal(spoken[0].options.showText,false);
});
