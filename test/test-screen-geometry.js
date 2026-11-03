'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{applicationScene,actionWindow}=require('../src/main/screen-geometry'),{registerScreenTools}=require('../src/main/screen-watch-skill'),{ToolRegistry}=require('../src/main/agent-tools');
const root={windowId:1,pid:77,bundleId:'com.tencent.xinWeChat',layer:0,rect:{x:0,y:31,width:821,height:909}},menu={windowId:2,pid:77,bundleId:root.bundleId,layer:21,rect:{x:370,y:680,width:212,height:483}};
test('an owned menu beyond the main window expands the visual scene and actions bind to that menu rather than the parent window',()=>{
 const scene=applicationScene(root,[menu,root,{...menu,windowId:3,pid:88,bundleId:'other',rect:{x:0,y:0,width:4000,height:3000}}]);assert.deepEqual(scene.rect,{x:0,y:31,width:821,height:1132});assert(scene.expanded);
 const anchor={...root,rect:scene.rect,windowRect:root.rect,sceneWindows:scene.windows.map(w=>({windowId:w.windowId,rect:w.rect}))};assert.equal(actionWindow(anchor,[menu,root],{x:450,y:1040}).windowId,2);assert.throws(()=>actionWindow(anchor,[root],{x:450,y:1040}),/重新观察/);assert.throws(()=>actionWindow(anchor,[{...menu,rect:{...menu.rect,x:400}},root],{x:450,y:1040}),/位置已变化/);
});
test('popup observation falls back to full external display capture then crops the whole application scene',async()=>{
 const calls=[],tools=new ToolRegistry(),native={request:async(op,args)=>{calls.push({op,args});if(op==='frontmost')return {application:{bundleId:root.bundleId,pid:77},windows:[menu,root]};if(op==='capture')return {pngBase64:Buffer.from('fixture').toString('base64'),width:821,height:1132};throw Error('Unexpected call: '+op);}};
 registerScreenTools(tools,{native,wechatScene:{assertHealthy:async()=>{}},imageResize:()=>({mime:'image/jpeg',preview:Buffer.from('fixture')})});const task={id:'popup',state:{}},r=await tools.get('screen.observe').execute({application:'wechat'},{task});assert(r.changed&&r.preview);assert.deepEqual(calls.map(c=>c.op),['frontmost','capture']);assert.equal(calls[1].args.relocate,true);assert.equal(calls[1].args.captureMode,'displayStream');assert.equal(task.state.screenAnchors.wechat.rect.height,1132);assert.equal(task.state.screenAnchors.wechat.windowRect.height,909);await tools.get('screen.commit').execute({application:'wechat'},{task});const quiet=await tools.get('screen.observe').execute({application:'wechat'},{task});assert.equal(quiet.changed,false);assert.equal(quiet.preview,undefined);assert.equal(calls.at(-1).args.relocate,false);
});
test('an actual screen primitive projects a menu click below the parent to the owned popup',async()=>{
 const {registerScreenActions}=require('../src/main/screen-action-tools'),scene=applicationScene(root,[menu,root]),calls=[],tools=new ToolRegistry();registerScreenActions(tools,{native:{request:async(op,args)=>{calls.push({op,args});if(op==='frontmost')return {application:{bundleId:root.bundleId,pid:77},windows:[menu,root]};if(op==='capture')return {pngBase64:'fixture'};if(op==='recognize')return {texts:[{text:'另存为…',confidence:.3,x:440/821,y:(1030-31)/1132,width:20/821,height:20/1132}]};return {performed:true};}},wechatScene:{assertTaskIdentity:async()=>{}},applications:{wechat:root.bundleId}});
 const task={id:'popup',state:{screenAnchors:{wechat:{windowId:1,pid:77,bundleId:root.bundleId,rect:scene.rect,windowRect:root.rect,sceneWindows:scene.windows.map(w=>({windowId:w.windowId,rect:w.rect})),previewWidth:821,previewHeight:1132,frameId:'popup',at:Date.now()}}}},tool=tools.get('screen.action');assert((await tool.execute(tool.validate({application:'wechat',frameId:'popup',action:'click',label:'另存为…'}),{task})).verified);assert.equal(calls.find(c=>c.op==='click').args.windowId,2);assert.equal(calls.find(c=>c.op==='click').args.y,1040);
});
test('closing an expanded menu forces a fresh image reference and geometry instead of reusing its old image with parent coordinates',async()=>{
 let popup=true;const calls=[],tools=new ToolRegistry(),native={request:async(op,args)=>{calls.push({op,args});if(op==='frontmost')return {application:{bundleId:root.bundleId,pid:77},windows:popup?[menu,root]:[root]};if(op==='capture')return {pngBase64:Buffer.from('popup').toString('base64'),width:821,height:1132};if(op==='visualSample'){assert.equal(args.reset,true);return {changed:false,baseline:true,pngBase64:Buffer.from('parent').toString('base64'),width:821,height:909};}throw Error(op);}};
 registerScreenTools(tools,{native,wechatScene:{assertHealthy:async()=>{}},imageResize:bytes=>({mime:'image/jpeg',preview:bytes})});const task={id:'scene-transition',state:{}},tool=tools.get('screen.observe'),first=await tool.execute({application:'wechat'},{task});popup=false;const second=await tool.execute({application:'wechat'},{task});assert.notEqual(second.frameId,first.frameId);assert(second.preview);assert.equal(second.height,909);assert.equal(task.state.screenAnchors.wechat.rect.height,909);assert.equal(task.state.screenAnchors.wechat.frameId,second.frameId);
});

test('a popup disappearing during OCR cannot receive its old click',async()=>{
 const scene=applicationScene(root,[menu,root]),tools=new ToolRegistry();let fronts=0,inputs=0;
 require('../src/main/screen-action-tools').registerScreenActions(tools,{applications:{wechat:root.bundleId},wechatScene:{assertTaskIdentity:async()=>{}},native:{request:async op=>{
  if(op==='frontmost')return {application:{bundleId:root.bundleId,pid:77},windows:++fronts===1?[menu,root]:[root]};
  if(op==='capture')return {pngBase64:'fixture'};
  if(op==='recognize')return {texts:[{text:'另存为…',confidence:.9,x:440/821,y:999/1132,width:20/821,height:20/1132}]};inputs++;return {performed:true};
 }}});
 const task={id:'vanished',state:{screenAnchors:{wechat:{windowId:1,pid:77,bundleId:root.bundleId,rect:scene.rect,windowRect:root.rect,sceneWindows:scene.windows.map(w=>({windowId:w.windowId,rect:w.rect})),previewWidth:821,previewHeight:1132,frameId:'popup',at:Date.now()}}}},tool=tools.get('screen.action');
 await assert.rejects(tool.execute(tool.validate({application:'wechat',frameId:'popup',action:'click',label:'另存为…'}),{task}),e=>e.dispatched===false);assert.equal(inputs,0);
});
test('forced revalidation returns a new image even when an expanded scene is unchanged',async()=>{
 const tools=new ToolRegistry(),native={request:async op=>op==='frontmost'?{application:{bundleId:root.bundleId,pid:77},windows:[menu,root]}:op==='capture'?{pngBase64:Buffer.from('same').toString('base64'),width:821,height:1132}:Promise.reject(Error(op))};
 registerScreenTools(tools,{native,wechatScene:{assertHealthy:async()=>{}},imageResize:bytes=>({mime:'image/jpeg',preview:bytes})});const task={id:'recheck',state:{}},observe=tools.get('screen.observe');
 const first=await observe.execute({application:'wechat'},{task});await tools.get('screen.commit').execute({application:'wechat'},{task});
 const force=await observe.execute(observe.validate({application:'wechat',force:true}),{task});assert(force.preview);assert.notEqual(force.frameId,first.frameId);
});
