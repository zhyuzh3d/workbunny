'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{applicationScene,actionWindow}=require('../src/main/screen-geometry'),{registerScreenTools}=require('../src/main/screen-watch-skill'),{ToolRegistry}=require('../src/main/agent-tools');
const root={windowId:1,pid:77,bundleId:'com.tencent.xinWeChat',layer:0,rect:{x:0,y:31,width:821,height:909}},menu={windowId:2,pid:77,bundleId:root.bundleId,layer:21,rect:{x:370,y:680,width:212,height:483}};
test('an owned menu beyond the main window expands the visual scene and actions bind to that menu rather than the parent window',()=>{
 const scene=applicationScene(root,[menu,root,{...menu,windowId:3,pid:88,bundleId:'other',rect:{x:0,y:0,width:4000,height:3000}}]);assert.deepEqual(scene.rect,{x:0,y:31,width:821,height:1132});assert(scene.expanded);
 const anchor={...root,rect:scene.rect,windowRect:root.rect,sceneWindows:scene.windows.map(w=>({windowId:w.windowId,rect:w.rect}))};assert.equal(actionWindow(anchor,[menu,root],{x:450,y:1040}).windowId,2);assert.throws(()=>actionWindow(anchor,[root],{x:450,y:1040}),/重新观察/);assert.throws(()=>actionWindow(anchor,[{...menu,rect:{...menu.rect,x:400}},root],{x:450,y:1040}),/位置已变化/);
});
const {fixture,paint}=require('./support/visual-fixture.cjs');
function popupFixture(options={}){
 const h=fixture(options);h.location={...h.location,software:'微信',region:{x:.1,y:.1,width:.8,height:.85},mainRegion:{x:.1,y:.1,width:.8,height:.6},monitorRegions:[{x:.1,y:.1,width:.8,height:.85}],texts:[{text:'另存为…',confidence:.3,x:.52,y:.86,width:.08,height:.03}]};
 const tools=new ToolRegistry(),task={id:'popup',skill:'software.execute',state:{}};
 registerScreenTools(tools,{native:h.native,wechatScene:{visual:h.visual},imageResize:bytes=>({mime:'image/png',preview:bytes})});
 const observe=tools.get('screen.observe'),action=tools.get('screen.action');
 return {h,tools,task,observe,action,watch:args=>observe.execute({application:'wechat',...args},{task}),click:frameId=>action.execute(action.validate({application:'wechat',frameId,action:'click',label:'另存为…'}),{task})};
}
test('popup observation crops the entire visually located scene from display pixels without window discovery',async()=>{
 const f=popupFixture(),r=await f.watch();assert(r.changed&&r.preview);assert.equal(r.ocr[0].text,'另存为…');assert.deepEqual(f.h.calls.map(c=>c.op),['displayCapture']);assert.deepEqual(f.h.calls[0].args,{output:'base64'});
 const anchor=f.task.state.screenAnchors.wechat;assert.equal(anchor.mode,'visual');assert.equal(anchor.rect.height,102);assert(anchor.mainRegion.height<1);assert.equal(anchor.windowId,undefined);
 await f.tools.get('screen.commit').execute({application:'wechat'},{task:f.task});const quiet=await f.watch();assert.equal(quiet.changed,false);assert.equal(f.h.requests.length,1,'unchanged pixels reuse visual recognition');assert(f.h.calls.every(c=>c.op==='displayCapture'));
});
test('an actual screen primitive projects a visual menu click below the main application region',async()=>{
 const f=popupFixture(),r=await f.watch(),anchor=f.task.state.screenAnchors.wechat;assert((await f.click(r.frameId)).verified);
 const input=f.h.calls.find(c=>c.op==='displayInput');assert(Math.abs(input.args.x-109.6)<1e-9);assert(Math.abs(input.args.y-101.25)<1e-9);assert(input.args.y>anchor.rect.y+anchor.mainRegion.height*anchor.rect.height);assert.equal(input.args.windowId,undefined);assert(f.h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));
});
test('closing an expanded menu returns fresh image geometry and prevents using the old menu frame',async()=>{
 const f=popupFixture(),first=await f.watch();paint(f.h.image,{x:.1,y:.7,width:.8,height:.25});
 f.h.location={...f.h.location,region:{x:.1,y:.1,width:.8,height:.6},monitorRegions:[{x:.1,y:.1,width:.8,height:.6}],texts:[]};
 const second=await f.watch();assert.notEqual(second.frameId,first.frameId);assert(second.preview);assert.equal(second.height,72);assert.equal(f.task.state.screenAnchors.wechat.rect.height,72);assert.equal(f.task.state.screenAnchors.wechat.frameId,second.frameId);
 await assert.rejects(f.click(first.frameId),e=>e.dispatched===false);assert(!f.h.calls.some(c=>c.op==='displayInput'));
});
test('a popup disappearing after recognition cannot receive its old click',async()=>{
 let captures=0,f;f=popupFixture({beforeCapture:()=>{if(++captures===2)paint(f.h.image,{x:.1,y:.7,width:.8,height:.25});}});
 const first=await f.watch();await assert.rejects(f.click(first.frameId),e=>e.dispatched===false);assert.equal(captures,2);assert(!f.h.calls.some(c=>c.op==='displayInput'));
});
test('forced revalidation returns a new image even when an expanded scene is unchanged',async()=>{
 const f=popupFixture(),first=await f.watch();await f.tools.get('screen.commit').execute({application:'wechat'},{task:f.task});
 const force=await f.watch({force:true});assert(force.preview);assert(force.changed);assert.notEqual(force.frameId,first.frameId);assert.equal(f.h.requests.length,2);assert(f.h.calls.every(c=>c.op==='displayCapture'));
});
