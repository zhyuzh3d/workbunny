'use strict';
// Explicit real WorkBuddy/WeChat acceptance; never run by npm test.
const {app,nativeImage}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {DesktopNative}=require('../src/main/desktop-native'),{DesktopService}=require('../src/main/desktop-service'),{AgentService}=require('../src/main/agent-service');
const {GuiLease}=require('../src/main/gui-lease'),{FileAgentJournal}=require('../src/main/agent-journal'),{Monitor}=require('../src/main/monitor'),{observeWorkBuddy}=require('../src/main/workbuddy-observation');
const {prepareVisionPreview}=require('../src/main/vision-preview');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bunny-orchestrator-v2-')));fs.chmodSync(root,0o700);app.setPath('userData',path.join(root,'electron'));
const save=(n,v)=>fs.writeFileSync(path.join(root,n),JSON.stringify(v,null,2),{mode:0o600});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let agent,desktop,conversation,monitor;const reports=[];
async function wait(id){const end=Date.now()+900000;while(Date.now()<end){const task=agent.runtime.tasks.get(id);if(task.status==='completed')return task;if(task.status==='needs_attention')throw Error(task.note);if(agent.scene.circuit)throw Error(agent.scene.circuit.reason);await sleep(700);}throw Error('Timed out: real delegated work');}
async function run(){
 await app.whenReady();await require('../src/main/model-catalog').refresh('workbuddy');
 const resize=b=>prepareVisionPreview(nativeImage.createFromBuffer(b)),crop=(b,r)=>nativeImage.createFromBuffer(b).crop(r).toPNG(),lease=new GuiLease();
 monitor=new Monitor();monitor.start(path.join(os.homedir(),'.workbuddy/projects'));
 const make=()=>new DesktopNative(path.resolve('bin/desktop'));
 const persist=async t=>save('physical-'+t.target+'.json',t);
 desktop=new DesktopService({native:make(),lease,owner:'live-work',imageResize:resize,imageCrop:crop,persist,observeWorkBuddy:t=>observeWorkBuddy(monitor,t),emit:s=>{if(s.task)console.log(JSON.stringify({physical:s.task.status,note:s.task.note}));}});
 conversation=new DesktopService({native:make(),lease,owner:'live-delivery',imageResize:resize,imageCrop:crop,persist});
 const journal=new FileAgentJournal(path.join(root,'tasks.json'));await journal.load();
 agent=new AgentService({desktop,conversationDesktop:conversation,journal,native:make(),imageResize:resize,bitmap:b=>{const i=nativeImage.createFromBuffer(b);return {data:i.toBitmap(),...i.getSize()};},ready:()=>true,epoch:()=>1,canOperate:async()=>lease.isFree(),report:async r=>{reports.push(r);save('reports.json',reports);},emit:s=>{const tasks=s.tasks.map(t=>({id:t.id,status:t.status,note:t.note,delivery:t.delivery}));const key=JSON.stringify(tasks);if(key!==run.last){console.log(key);run.last=key;}}});
 const owner={role:'owner',verified:true,channel:'dialogue',sources:['owner-upgrade-test-2026-11-02'],scene:'life'};
 const file=path.join(root,'result.txt'),expected='Bunny orchestration v2 passed.';
 const raw='请在 '+file+' 创建UTF-8纯文本文件，内容逐字为 '+JSON.stringify(expected)+'，末尾不要换行。只创建这一份新文件，勿修改其他文件。';
 const start=await agent.start({skill:'work.delegate',goal:raw,context:'这是虚构的 Cedar 评审任务。执行原文要求，最终只简短报告文件已生成和核对结果。',subjects:[{application:'workbuddy'}],workContext:process.argv.includes('--workspace')?{workspace:'WorkBaby'}:{mode:'none'},...(process.argv.includes('--wechat')?{delivery:{channel:'wechat',recipient:'文件传输助手'}}:{})},owner,{ownerRequest:raw});
 assert(start.ok,start.error);const task=await wait(start.id);assert.equal(fs.readFileSync(file,'utf8'),expected);assert(task.state.result);assert.equal(desktop.task.workRoute.prepared,true);
 if(process.argv.includes('--wechat')){assert.equal(reports.length,0);assert.equal(task.state.delivery.status,'delivered');}else assert.equal(reports.length,1);
 const firstJob=task.state.job.jobId,firstSession=task.state.job.sessionId;
 await desktop.native.request('activate',{bundleId:'com.tencent.workbuddy.mac'},8000);await sleep(700);
 const front=await desktop.native.request('frontmost'),window=front.windows.find(w=>w.bundleId==='com.tencent.workbuddy.mac'&&w.layer===0&&w.rect.width>300);
 await desktop.native.request('workbuddyNavigate',{expected:front.application,windowId:window.windowId,operation:'newTask'},8000);await sleep(600);
 const expectedNext=expected+' Follow-up checked.',nextRaw='继续原任务，在 '+file+' 把内容改成 '+JSON.stringify(expectedNext)+'，仍不加末尾换行。只修改此实验文件，读回核对。';
 const next=await agent.start({skill:'work.delegate',goal:nextRaw,subjects:[{application:'workbuddy'}],parameters:{sourceTaskId:task.id}},owner,{ownerRequest:nextRaw});assert(next.ok,next.error);
 const continued=await wait(next.id);assert.notEqual(continued.state.job.jobId,firstJob);assert.equal(continued.state.job.sessionId,firstSession);assert.equal(continued.state.result.revision,2);assert.equal(task.state.result.revision,1);assert.equal(fs.readFileSync(file,'utf8'),expectedNext);
 save('result.json',{passed:true,newRoundReceipt:true,sameSession:true,revision:continued.state.result.revision,result:continued.state.result});console.log(JSON.stringify({passed:true,directory:root}));
}
run().catch(e=>{save('failure.json',{error:e.message});console.error(e.stack);process.exitCode=1;}).finally(async()=>{for(const t of agent?.runtime.list()||[])if(!['completed','stopped','expired'].includes(t.status))await agent.runtime.control('stop',t.id);await agent?.close();await conversation?.close();await desktop?.close();monitor?.stop();app.exit(process.exitCode||0);});
