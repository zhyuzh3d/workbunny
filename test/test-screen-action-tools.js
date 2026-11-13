'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ToolRegistry}=require('../src/main/agent-tools'),{registerScreenActions,fileDialogKind,labelTarget,destructiveLabel}=require('../src/main/screen-action-tools'),{GuiLease}=require('../src/main/gui-lease');
const {fixture,paint}=require('./support/visual-fixture.cjs');
const row=text=>({text,confidence:1,x:.2,y:.3,width:.2,height:.1});
test('an explicit new activation operation can retry a confirmed inactive target once, while default and duplicate decisions only observe',async()=>{
 const h=fixture(),tools=new ToolRegistry(),lease=new GuiLease(),task={id:'activation-choice',subjects:[{application:'demo'}]};h.location={...h.location,active:false,activationRegion:{x:.6,y:.12,width:.1,height:.05},activationEvidence:'synthetic safe title area'};
 registerScreenActions(tools,{native:h.native,lease,visualFor:()=>h.visual});const tool=tools.get('screen.activate'),context=id=>({task,operationId:id,signal:new AbortController().signal});
 assert.equal((await tool.execute(tool.validate({application:'demo'}),context('first'))).activated,false);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
 await tool.execute(tool.validate({application:'demo'}),context('read-only-retry'));await tool.execute(tool.validate({application:'demo',retry:true}),context('first'));assert.equal(h.calls.filter(c=>c.op==='displayInput').length,1);
 await tool.execute(tool.validate({application:'demo',retry:true}),context('new-decision'));assert.equal(h.calls.filter(c=>c.op==='displayInput').length,2);assert(lease.isFree());
});
async function setup(application='demo',options={}){
 const h=fixture(options),tools=new ToolRegistry(),lease=new GuiLease(),task={id:'visual-primitive',skill:'software.execute',state:{}},faults=[];
 registerScreenActions(tools,{native:h.native,lease,applications:{demo:'unused',wechat:'unused'},wechatScene:{trip:async reason=>faults.push(reason)},visualFor:()=>h.visual,...options});
 const refresh=async()=>{const frame=await h.visual.observe({relocate:true});task.state.screenAnchors={[application]:{mode:'visual',identity:frame.identity,sessionId:frame.identity.sessionId,frameId:frame.visualFrameId,visualFrameId:frame.visualFrameId,at:Date.now(),rect:frame.desktopRect,mainRegion:frame.mainRegion,previewWidth:frame.width,previewHeight:frame.height,ocr:frame.texts}};return frame;};
 const frame=await refresh(),tool=tools.get('screen.action'),run=async args=>tool.execute(tool.validate({application,frameId:task.state.screenAnchors[application]?.frameId||frame.visualFrameId,...args}),{task});return {...h,h,tools,tool,lease,task,faults,refresh,run,frame};
}
test('known operations can share a fresh anchor while each input retains live pixel guards and GUI ownership',async()=>{
 const f=await setup(),args={action:'click',targetType:'icon',pixelX:80,pixelY:45};const result=await f.run(args);assert(result.verified);assert.match(result.receipt.businessResult,/业务结果待自主判断/);assert.equal(f.calls.at(-1).op,'displayInput');assert.equal(f.calls.at(-1).args.x,100);assert(f.lease.isFree());
 await f.run({action:'key',key:'a',modifiers:['cmd']});assert.equal(f.calls.filter(c=>c.op==='displayInput').length,2);assert(f.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));
 paint(f.h.image,{x:.2,y:.12,width:.3,height:.15},250);const changed=await f.run(args);assert(changed.visualFeedback.checks[0].identityChanged);assert.equal(f.calls.filter(c=>c.op==='displayInput').length,3,'ordinary changes reach the task as feedback');assert(f.task.state.screenAnchors.demo);
});
test('WeChat navigation cannot directly send text, close the app or use the clipboard',async()=>{
 const f=await setup('wechat'),base={application:'wechat',frameId:f.frame.visualFrameId};
 assert.throws(()=>f.tool.validate({...base,action:'type',text:'hello'}),/正文/);assert.throws(()=>f.tool.validate({...base,action:'key',key:'q',modifiers:['cmd']}),/关闭/);assert.throws(()=>f.tool.validate({...base,action:'key',key:'enter',modifiers:[]}),/发送/);
 await assert.rejects(f.run({action:'key',key:'v',modifiers:['cmd']}),e=>e.dispatched===false);assert.equal(f.calls.filter(c=>c.op==='displayInput').length,0);
});
test('right mouse is an ordinary primitive and a file-dialog purpose cannot type into a chat',async()=>{
 assert.equal(fileDialogKind(['存储为：','取消','存储'].map(row)),'save');assert.equal(fileDialogKind(['前往文件夹：','取消'].map(row)),'folder');assert.equal(fileDialogKind(['Alice','发送','取消'].map(row)),null);
 const f=await setup('wechat');f.task.state.fileDestinations=[{directory:'/tmp/not-opened-by-this-fixture'}];await assert.rejects(f.run({action:'type',text:'/tmp/not-opened-by-this-fixture',purpose:'file-dialog'}),e=>e.dispatched===false);await f.run({action:'click',button:'right',pixelX:80,pixelY:45});assert.equal(f.calls.at(-1).args.button,'right');
});
test('a visual file dialog checks task admission and preserves an existing destination file',async t=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bunny-save-visual-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let admitted=true;
 const f=await setup('wechat',{canOperate:async()=>admitted});f.h.location.texts=['前往文件夹：','取消'].map(row);await f.refresh();f.task.state.fileDestinations=[{directory}];await f.run({action:'type',text:directory,purpose:'file-dialog'});assert.equal(f.calls.filter(c=>c.op==='displayInput').length,1);
 await f.refresh();admitted=false;await assert.rejects(f.run({action:'type',text:directory,purpose:'file-dialog'}),e=>e.dispatched===false);admitted=true;fs.writeFileSync(path.join(directory,'preserve.txt'),'original');await assert.rejects(f.run({action:'type',text:directory,purpose:'file-dialog'}),/不覆盖/);assert.equal(f.calls.filter(c=>c.op==='displayInput').length,1);
});
test('projected WeChat send and close regions reject left clicks while right-click exploration remains available',async()=>{
 const f=await setup('wechat');for(const [pixelX,pixelY]of [[140,85],[1,1]])await assert.rejects(f.run({action:'click',targetType:'icon',pixelX,pixelY}),e=>e.dispatched===false);await f.run({action:'click',button:'right',pixelX:140,pixelY:85});assert.equal(f.calls.filter(c=>c.op==='displayInput').length,1);
});
test('failed visual preflight is undispatched while a native input timeout remains uncertain',async()=>{
 const f=await setup();f.task.goal='Make a payment';paint(f.h.image,{x:.2,y:.12,width:.3,height:.15},250);await assert.rejects(f.run({action:'click',targetType:'icon',pixelX:80,pixelY:45}),e=>e.dispatched===false);assert(!f.calls.some(c=>c.op==='displayInput'));
 const late=await setup('demo',{onInput:()=>{throw Error('input receipt timeout');}});await assert.rejects(late.run({action:'click',targetType:'icon',pixelX:80,pixelY:45}),e=>e.dispatched!==false);assert.equal(late.calls.filter(c=>c.op==='displayInput').length,1);
});
test('VLM labels locate text, destructive controls and stale frames never receive input',async()=>{
 const f=await setup();f.h.location.texts=[row('继续')];await f.refresh();await f.run({action:'click',label:'继续'});assert.equal(f.calls.at(-1).args.x,68);assert.throws(()=>f.tool.validate({application:'demo',frameId:'frame',action:'click',label:'删除'}),/破坏/);
 await f.refresh();f.task.state.screenAnchors.demo.at-=31000;await assert.rejects(f.run({action:'click',label:'继续'}),e=>e.dispatched===false);
});
test('major-impact targets retain strict keyboard and text evidence without querying any app metadata',async()=>{
 const f=await setup();f.task.goal='Make a payment';paint(f.h.image,{x:.2,y:.12,width:.3,height:.15},250);for(const args of [{action:'type',text:'test'},{action:'key',key:'a',modifiers:['cmd']}])await assert.rejects(f.run(args),e=>e.dispatched===false);assert(!f.calls.some(c=>c.op==='displayInput'));assert(f.calls.every(c=>c.op==='displayCapture'));
});
test('authentication text in a visual observation stops navigation input without a login click',async()=>{
 const f=await setup('wechat');f.task.state.screenAnchors.wechat.ocr=[row('为了你的账号安全，请重新登录。')];for(const action of [{action:'key',key:'f',modifiers:['cmd']},{action:'click',targetType:'icon',pixelX:80,pixelY:45},{action:'scroll',pixelX:80,pixelY:45,deltaY:100},{action:'type',recipient:'Alice',text:'Alice',purpose:'navigation'}])await assert.rejects(f.run(action),e=>e.code==='E_APP_CIRCUIT'&&e.dispatched===false);assert(f.faults.length>=1);assert(!f.calls.some(c=>c.op==='displayInput'));
});
test('revoked channel authority stops a visually valid operation before any input and releases the lease',async()=>{
 const f=await setup('wechat',{assertWeChatInput:()=>{throw Object.assign(Error('channel revoked'),{code:'E_CHANNEL_CHANGED',dispatched:false});}});await assert.rejects(f.run({action:'key',key:'f',modifiers:['cmd']}),e=>e.code==='E_CHANNEL_CHANGED'&&e.dispatched===false);assert(f.lease.isFree());assert(!f.calls.some(c=>c.op==='displayInput'));
});
test('decorative bullets do not hide labels or bypass destructive checks',()=>{assert.deepEqual(labelTarget('转文字',[{text:'• 转文字',confidence:.3,x:.4,y:.5,width:.1,height:.04}]),{x:.45,y:.52});assert(destructiveLabel('• 删除'));});
test('an omitted text row may be verified against the actual screenshot and observeAfter remains optional',async()=>{
 let observations=0;const f=await setup('demo',{observe:async()=>{observations++;assert(!f.lease.isFree());return {available:true,frameId:'after',preview:'actual-image'};}}),location=f.h.location;f.h.location={matched:true,evidence:'实际截图中此坐标为唯一继续按钮'};
 const result=await f.run({action:'click',label:'继续',targetType:'text',pixelX:80,pixelY:45,observeAfter:true});assert(result.receipt.inputPerformed);assert.equal(result.observation.frameId,'after');assert.equal(observations,1);assert(f.lease.isFree());
 f.h.location=location;await f.refresh();f.h.location={matched:true,evidence:'当前实际截图中为同一唯一继续按钮'};const next=await f.run({action:'click',label:'继续',targetType:'text',pixelX:80,pixelY:45,observeAfter:false});assert(next.receipt.inputPerformed);assert.equal(next.observation,undefined);assert.equal(observations,1,'observeAfter=false does not acquire an extra effect observation');
});
test('failure of effect observation preserves a known dispatched input receipt',async()=>{
 const f=await setup('demo',{observe:async()=>{throw Error('capture unavailable');}}),result=await f.run({action:'click',targetType:'icon',pixelX:80,pixelY:45,observeAfter:true});assert(result.receipt.inputPerformed);assert.equal(result.observationError.message,'capture unavailable');assert.equal(f.calls.filter(c=>c.op==='displayInput').length,1);
});
