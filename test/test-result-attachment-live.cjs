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
 conversation=new DesktopService({native:make(),lease,owner:'live-delivery',imageResize:resize,imageCrop:crop,persist,emit:s=>{if(s.screenshot){fs.writeFileSync(path.join(root,'latest-physical.png'),Buffer.from(s.screenshot.split(',')[1],'base64'));if(conversation.wechatBeforeSubmit)save('before-submit.json',conversation.wechatBeforeSubmit);}if(s.task?.lastWeChatReceipt)save('last-receipt.json',s.task.lastWeChatReceipt);}});
 const journal=new FileAgentJournal(path.join(root,'tasks.json'));await journal.load();
 agent=new AgentService({desktop,conversationDesktop:conversation,journal,native:make(),imageResize:resize,bitmap:b=>{const i=nativeImage.createFromBuffer(b);return {data:i.toBitmap(),...i.getSize()};},ready:()=>true,epoch:()=>1,canOperate:async()=>lease.isFree(),report:async r=>{reports.push(r);save('reports.json',reports);},emit:s=>{const tasks=s.tasks.map(t=>({id:t.id,status:t.status,note:t.note,delivery:t.delivery}));const key=JSON.stringify(tasks);if(key!==run.last){console.log(key);run.last=key;}}});
 const owner={role:'owner',verified:true,channel:'dialogue',sources:['owner-upgrade-test-2026-11-02'],scene:'life'};
 const file=path.join(root,'bunny-result-'+Date.now()+'.txt'),expected='Bunny actual attachment passed.';fs.writeFileSync(file,expected);
 const source=await agent.start({skill:'work.delegate',goal:'真实附件实验来源',subjects:[{application:'workbuddy'}]},owner);assert(source.ok,source.error);
 const original=agent.runtime.tasks.get(source.id);original.status='completed';original.state.result={schema:'bunny.result/v1',revision:1,summary:'Bunny 真实附件交付测试。',artifacts:[{path:file,sha256:require('crypto').createHash('sha256').update(expected).digest('hex'),size:Buffer.byteLength(expected)}]};await agent.runtime.save(original);
 const next=await agent.start({skill:'result.forward',goal:'把这个实验成果和真实文件发到文件传输助手',subjects:[{application:'bunny'}],parameters:{sourceTaskId:source.id},delivery:{channel:'wechat',recipient:'文件传输助手'}},owner);assert(next.ok,next.error);
 const task=await wait(next.id);assert.equal(task.state.delivery.status,'delivered');assert.equal(task.state.delivery.files.length,1);assert.equal(reports.length,0);
 save('result.json',{passed:true,actualWeChat:true,delivery:task.state.delivery,file});console.log(JSON.stringify({passed:true,directory:root}));
}
run().catch(e=>{save('failure.json',{error:e.message});console.error(e.stack);process.exitCode=1;}).finally(async()=>{for(const t of agent?.runtime.list()||[])if(!['completed','stopped','expired'].includes(t.status))await agent.runtime.control('stop',t.id);await agent?.close();await conversation?.close();await desktop?.close();monitor?.stop();app.exit(process.exitCode||0);});
