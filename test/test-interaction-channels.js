'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ToolRegistry}=require('../src/main/agent-tools'),{registerSoftwareTools}=require('../src/main/software-tools');
const {registerScreenTools}=require('../src/main/screen-watch-skill'),{DialogueChannels}=require('../src/main/dialogue-channels');
const {fixture,bitmap,crop}=require('./support/visual-fixture.cjs');
const provider=(application='demo',execute=async()=>({verified:true,receipt:{observed:'actual-result'}}))=>({id:'fixed-'+application,application,methods:['read'],authorize:async()=>{},execute});
const task=()=>({id:'cross-channel-fixture',skill:'software.execute',capabilities:['service.call','terminal.execute','screen.read','screen.input'],subjects:[{application:'demo'},{application:'wechat',recipient:'Alice'}],state:{},operations:{},sources:[]});
test('one task keeps per-operation software/mode authority; visual-only aliases cannot use service, command or structured UI',async()=>{
 const tools=new ToolRegistry(),calls=[];registerSoftwareTools(tools,{native:{request:async(op,a)=>{calls.push(op);return {bundleId:a.bundleId};}},services:[provider(),provider('wechat')]});const t=task();
 const good=tools.check('software.service',{application:'demo',service:'fixed-demo',method:'read',input:{}},t);assert.equal((await good.tool.execute(good.input,{task:t})).verified,true);
 for(const channel of ['service','terminal','structured-ui'])assert.throws(()=>require('../src/main/interaction-policy').assertChannel('com.tencent.xinWeChat',channel),e=>e.code==='E_INTERACTION_CHANNEL');
 assert.throws(()=>tools.check('software.service',{application:'wechat',service:'fixed-wechat',method:'read',input:{}},t),e=>e.code==='E_INTERACTION_CHANNEL');
 assert.throws(()=>tools.check('software.command',{application:'wechat',command:'/usr/bin/true',args:[],impact:'read',purpose:'probe'},t));
 assert.throws(()=>tools.check('software.interface',{application:'wechat'},t));
 const normal=tools.check('software.interface',{application:'demo'},t);await normal.tool.execute(normal.input,{task:t});assert.deepEqual(calls,['softwareInfo','softwareInterface']);
 assert.throws(()=>tools.check('software.service',{application:'demo',service:'fixed-wechat',method:'read',input:{}},t),/对应目标/);
});
test('unregistered services are not available and connectors require independent authorization before any request',async()=>{
 const tools=new ToolRegistry(),t=task();registerSoftwareTools(tools,{native:{}});assert(!tools.catalog(undefined,t).some(t=>t.name==='software.service'));
 let dispatched=0;const denied={...provider(),authorize:async()=>{throw Object.assign(Error('connector authorization denied'),{dispatched:false});},execute:async()=>{dispatched++;}};
 const registry=new ToolRegistry();registerSoftwareTools(registry,{native:{},services:[denied]});const checked=registry.check('software.service',{application:'demo',service:'fixed-demo',method:'read',input:{}},t);await assert.rejects(checked.tool.execute(checked.input,{task:t}),/authorization denied/);assert.equal(dispatched,0);
});
test('service cancellation is bounded and an already-sent request remains unknown, never proved undispatched',async()=>{
 const tools=new ToolRegistry(),t=task(),controller=new AbortController();let entered,receivedSignal;
 const began=new Promise(r=>entered=r);registerSoftwareTools(tools,{native:{},services:[provider('demo',async({signal})=>{receivedSignal=signal;entered();return new Promise(()=>{});})]});
 const checked=tools.check('software.service',{application:'demo',service:'fixed-demo',method:'read',input:{}},t),running=checked.tool.execute(checked.input,{task:t,signal:controller.signal});await began;controller.abort();await assert.rejects(running,e=>e.code==='E_ABORTED'&&e.dispatched!==false);assert.equal(receivedSignal.aborted,true);
});
test('cross-target visual observation/action have independent anchors, default image contracts, and no metadata fallback',async()=>{
 const h=fixture();h.advance(Date.now()-100000);const tools=new ToolRegistry(),t=task();registerScreenTools(tools,{native:h.native,bitmap,imageCrop:crop,request:async()=>({response:{text:JSON.stringify(h.location)}}),wechatScene:{visual:h.visual}});
 const run=async(name,args)=>{const checked=tools.check(name,args,t);return checked.tool.execute(checked.input,{task:t});};
 const wx=await run('screen.observe',{application:'wechat'}),demo=await run('screen.observe',{application:'demo'});assert.equal(wx.available,true);assert.equal(demo.available,true);assert.notEqual(t.state.screenAnchors.wechat.sessionId,t.state.screenAnchors.demo.sessionId);
 await assert.rejects(run('screen.action',{application:'demo',frameId:wx.frameId,action:'click',targetType:'icon',pixelX:80,pixelY:45}),e=>e.dispatched===false);
 const effect=await run('screen.action',{application:'demo',frameId:demo.frameId,action:'click',targetType:'icon',pixelX:80,pixelY:45});assert(effect.receipt.inputPerformed);assert(t.state.screenAnchors.wechat);assert(t.state.screenAnchors.demo,'confirmed input retains the current same-session visual anchor');
 assert(h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));assert(!JSON.stringify(h.calls).match(/windowId|bundleId|"pid"|frontmost|recognize/u));
});
test('legacy WeChat account grants are not inherited, while independent structured identities retain their old contract',async()=>{
 const channels=new DialogueChannels(),subject={application:'wechat',recipient:'Alice'};
 assert.throws(()=>channels.descriptor(subject,{pid:1,windowId:2}),/不继承/);
 const a=fixture(),b=fixture(),first=channels.descriptor(subject,a.visual.identity()),second=channels.descriptor(subject,b.visual.identity());assert.notEqual(first.id,second.id);assert.match(first.account,/^visual:/);
 assert.equal(channels.descriptor({application:'demo',recipient:'fixture'},{pid:1,windowId:2}).account,'1:2');
});
test('ordinary terminal scope cannot conceal an explicitly targeted software launcher or interface command',async()=>{
 const {terminalArgs,executeTerminal}=require('../src/main/system-tools'),base={application:'system',impact:'read',purpose:'fixture direct-target boundary'};
 for(const [command,args]of [['/usr/bin/open',['-a','WeChat']],['/usr/bin/open',['-a','微信.app']],['/usr/bin/open',['-b','com.tencent.xinWeChat']],['/usr/bin/open',['weixin://fixture']],['/usr/bin/osascript',['-e','tell application "WeChat" to activate']],['/usr/bin/defaults',['read','com.tencent.xinWeChat']],['/tmp/WeChat.app/Contents/MacOS/WeChat',[]]]){
  assert.throws(()=>terminalArgs({...base,command,args}),e=>e.code==='E_INTERACTION_CHANNEL');
  await assert.rejects(executeTerminal({...base,command,args},{task:{id:'never-start'},directory:'/not-created-by-this-fixture'}),e=>e.code==='E_INTERACTION_CHANNEL');
 }
 assert.doesNotThrow(()=>terminalArgs({...base,command:'/usr/bin/open',args:['-a','DemoApp']}));
});
