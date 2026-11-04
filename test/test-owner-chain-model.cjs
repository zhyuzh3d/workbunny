'use strict';
// Actual model + vault + terminal integration. The conversation transport is
// explicitly synthetic; this does not establish real WeChat delivery.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {MemoryService}=require('../src/main/memory-service'),{AgentService}=require('../src/main/agent-service');
const {OwnerSecurity}=require('../src/main/owner-security'),{DialogueChannels}=require('../src/main/dialogue-channels');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-owner-chain-')),pause=ms=>new Promise(r=>setTimeout(r,ms));
const marker='OWNER_CHAIN_STDOUT_731',transport=[],window={pid:999,windowId:888,rect:{x:0,y:0,width:800,height:900}};
let memory,agent,security,channels;
async function run(){
 memory=new MemoryService({dir:path.join(root,'vault'),bin:path.resolve('bin/vault'),openKey:async()=>crypto.randomBytes(32),getSettings:()=>({enabled:true,extract:false,scene:'life'})});
 await memory.init();assert(memory.ready,memory.error);
 security=await new OwnerSecurity({file:path.join(root,'security.json'),encrypt:t=>Buffer.from(t),decrypt:b=>b.toString(),onChange:()=>channels?.revokeAll()}).init();
 channels=memory.dialogueChannels=new DialogueChannels({memory,security,getScene:()=> 'life'});await security.setEnabled(true);await security.change('SyntheticIdentity-'+crypto.randomUUID());
 let visible=[{direction:'incoming',kind:'text',text:'Old baseline',incomingVerified:true,observedVerified:true}];
 const scene={knownWindow:window,metrics:{},assertHealthy:async()=>window,assertTaskIdentity:async t=>{t.state.sceneIdentity={wechat:window};},invalidate:()=>{},close:async()=>{},observe:async()=>({headerMatched:true,changed:true,messages:structuredClone(visible),draft:''})};
 const desktop={running:false,screenshot:{captureSource:'synthetic-test-transport'},
  async start(value){this.task={...value,id:crypto.randomUUID(),status:'review',sendState:'confirmed',submitAttemptedAt:Date.now(),steps:[]};if(value.operation==='send'){transport.push(value.message);visible.push({direction:'outgoing',kind:'text',text:value.message,observedVerified:true});}return {ok:true};},accept:async()=>({ok:true}),stop:async()=>{},close:async()=>{}};
 agent=new AgentService({desktop,conversationDesktop:desktop,memory,channels,scene,autoSchedule:false,canOperate:async()=>true,getScene:()=> 'life',epoch:()=>memory.generation,report:async()=>{}});
 const source=await memory.addMessage('user','Authorize isolated synthetic owner-channel integration.');
 const start=await agent.start({skill:'conversation.manage',goal:'Respond to owner requests and return task results in this channel.',subjects:[{application:'wechat',recipient:'SyntheticOwner'}],parameters:{behavior:'reply'},schedule:{intervalSeconds:3}}, {role:'owner',verified:true,channel:'dialogue',scene:'life',sources:[source.id]});assert(start.ok,start.error);
 await agent.runtime.tick(start.id);
 visible.push({direction:'incoming',kind:'text',text:security.key+' Please perform this task yourself: use terminal.execute to run /bin/echo '+marker+', verify the exact stdout, and report that stdout back in this conversation. Do not modify files or read private memories.',incomingVerified:true,observedVerified:true});
 await agent.runtime.tick(start.id);
 const began=Date.now(),deadline=began+180000;
 while(Date.now()<deadline){
  await agent.runtime.tick();
  const child=[...agent.runtime.tasks.values()].find(t=>t.state.returnTo?.taskId===start.id);
  if(child?.status==='needs_attention')throw Error(child.note);
  if(child?.status==='completed'&&child.state.reportOutbox?.every(r=>r.status==='delivered')&&transport.some(t=>t.includes(marker))){
   assert(Object.values(child.operations).some(op=>op.tool==='terminal.execute'&&op.status==='confirmed'&&op.result.stdout?.trim()===marker));
   assert(transport.every(t=>!t.includes(security.key)));
   const result={passed:true,elapsedMs:Date.now()-began,skill:child.skill,actualModel:true,actualVault:true,actualTerminalStdout:true,syntheticConversationTransport:true,actualWeChat:false};
   fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({...result,directory:root}));return;
  }
  await pause(500);
 }
 throw Error('Owner chain exceeded its 180-second integration deadline');
}
run().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await agent?.close();if(security)await security.change('');await memory?.close();});
