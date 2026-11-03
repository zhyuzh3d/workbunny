'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {ToolRegistry}=require('../src/main/agent-tools'),{registerScreenActions}=require('../src/main/screen-action-tools'),{GuiLease}=require('../src/main/gui-lease');
test('a visual primitive consumes one current anchor, shares the GUI lease, and never reports the business goal completed',async()=>{
 const tools=new ToolRegistry(),calls=[],lease=new GuiLease(),rect={x:20,y:30,width:800,height:600};const native={request:async(op,args)=>{calls.push({op,args});if(op==='frontmost')return {application:{bundleId:'wb',pid:12},windows:[{bundleId:'wb',windowId:7,pid:12,rect}]};if(op==='capture')return {pngBase64:'fixture'};if(op==='recognize')return {texts:[]};return {performed:true};}};
 registerScreenActions(tools,{native,lease,applications:{workbuddy:'wb'}});const tool=tools.get('screen.action'),task={id:'test',state:{screenAnchors:{workbuddy:{frameId:'frame',at:Date.now(),bundleId:'wb',pid:12,windowId:7,rect,previewWidth:800,previewHeight:600}}}},args=tool.validate({application:'workbuddy',frameId:'frame',action:'click',targetType:'icon',pixelX:400,pixelY:300});
 const result=await tool.execute(args,{task});assert.equal(result.verified,true);assert.equal(result.receipt.businessResult,'需要重新观察');assert.equal(calls.find(c=>c.op==='click').args.x,420);assert(lease.isFree());await assert.rejects(tool.execute(args,{task}),e=>e.dispatched===false);assert.equal(calls.filter(c=>c.op==='click').length,1);
});
test('WeChat primitive navigation cannot directly send text or close its window',()=>{
 const tools=new ToolRegistry();registerScreenActions(tools,{native:{},applications:{wechat:'wx'}});const validate=tools.get('screen.action').validate,base={application:'wechat',frameId:'frame'};
 assert.throws(()=>validate({...base,action:'type',text:'hello'}),/正文/);assert.throws(()=>validate({...base,action:'key',key:'q',modifiers:['cmd']}),/关闭/);assert.throws(()=>validate({...base,action:'key',key:'enter',modifiers:[]}),/发送/);
 assert.equal(validate({...base,recipient:'Alice',action:'type',text:'Alice',purpose:'navigation'}).text,'Alice');
});
test('right mouse is an ordinary primitive and a file-dialog purpose cannot type a message into a chat',async()=>{
 const {fileDialogKind}=require('../src/main/screen-action-tools'),row=text=>({text,confidence:1});assert.equal(fileDialogKind(['存储为：','取消','存储'].map(row)),'save');assert.equal(fileDialogKind(['前往文件夹：','取消'].map(row)),'folder');assert.equal(fileDialogKind(['Alice','发送','取消'].map(row)),null);
 const tools=new ToolRegistry(),calls=[],rect={x:0,y:30,width:800,height:600},native={request:async(op,args)=>{calls.push({op,args});if(op==='frontmost')return {application:{bundleId:'wx',pid:12},windows:[{bundleId:'wx',windowId:7,pid:12,rect}]};if(op==='capture')return {pngBase64:'fixture'};if(op==='recognize')return {texts:['Alice','发送'].map(row)};return {performed:true};}};
 registerScreenActions(tools,{native,wechatScene:{assertTaskIdentity:async()=>{}},applications:{wechat:'wx'}});const tool=tools.get('screen.action'),anchor=()=>({frameId:'frame',at:Date.now(),bundleId:'wx',pid:12,windowId:7,rect,previewWidth:800,previewHeight:600}),task={id:'file-task',state:{fileDestinations:[{directory:'/tmp/receive-empty-fixture',expectedPath:'/tmp/receive-empty-fixture/review.txt'}],screenAnchors:{wechat:anchor()}}};
 await assert.rejects(tool.execute(tool.validate({application:'wechat',frameId:'frame',action:'type',text:'/tmp/receive-empty-fixture',purpose:'file-dialog'}),{task}),e=>e.dispatched===false);assert(!calls.some(c=>c.op==='type'));
 task.state.screenAnchors.wechat=anchor();await tool.execute(tool.validate({application:'wechat',frameId:'frame',action:'click',button:'right',pixelX:400,pixelY:300}),{task});assert.equal(calls.at(-1).args.button,'right');
});
test('a visual file dialog accepts only its prepared directory and yields immediately when the owner intervenes',async t=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bunny-save-dialog-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const expectedPath=path.join(directory,'file.txt'),rect={x:0,y:30,width:800,height:600},tools=new ToolRegistry(),calls=[];let idle=1000;
 const native={request:async(op,args)=>{calls.push({op,args});if(op==='frontmost')return {application:{bundleId:'wx',pid:12},windows:[{bundleId:'wx',windowId:7,pid:12,rect}]};if(op==='capture')return {pngBase64:'fixture'};if(op==='recognize')return {texts:['前往文件夹：','取消'].map(text=>({text,confidence:1}))};if(op==='inputIdle')return {hidIdleMs:idle};return {performed:true};}};
 registerScreenActions(tools,{native,wechatScene:{assertTaskIdentity:async()=>{}},applications:{wechat:'wx'}});const tool=tools.get('screen.action'),anchor=()=>({frameId:'frame',at:Date.now(),bundleId:'wx',pid:12,windowId:7,rect,previewWidth:800,previewHeight:600}),task={id:'file-task',state:{fileDestinations:[{directory,expectedPath}],screenAnchors:{wechat:anchor()}}},args=tool.validate({application:'wechat',frameId:'frame',action:'type',text:directory,purpose:'file-dialog'});
 assert((await tool.execute(args,{task})).verified);assert.equal(calls.filter(c=>c.op==='type').length,1);
 task.state.screenAnchors.wechat=anchor();idle=100;await assert.rejects(tool.execute(args,{task}),e=>e.dispatched===false&&e.code==='E_GUI_BUSY');assert.equal(calls.filter(c=>c.op==='type').length,1);
 task.state.screenAnchors.wechat=anchor();idle=1000;fs.writeFileSync(expectedPath,'keep');await assert.rejects(tool.execute(args,{task}),/不覆盖/);assert.equal(calls.filter(c=>c.op==='type').length,1);assert.equal(fs.readFileSync(expectedPath,'utf8'),'keep');
});
test('a real left click in the composer send area is rejected after projection, while right-click exploration remains possible',async()=>{
 const tools=new ToolRegistry(),rect={x:0,y:0,width:800,height:600};let inputs=0;registerScreenActions(tools,{native:{request:async op=>{if(op==='frontmost')return {application:{bundleId:'wx',pid:12},windows:[{bundleId:'wx',windowId:7,pid:12,rect}]};if(op==='capture')return {pngBase64:'fixture'};if(op==='recognize')return {texts:[]};inputs++;return {performed:true};}},wechatScene:{assertTaskIdentity:async()=>{}},applications:{wechat:'wx'}});const tool=tools.get('screen.action'),task={id:'test',state:{screenAnchors:{wechat:{frameId:'frame',at:Date.now(),bundleId:'wx',pid:12,windowId:7,rect,previewWidth:800,previewHeight:600}}}},base={application:'wechat',frameId:'frame',action:'click',targetType:'region',pixelX:416,pixelY:534};
 await assert.rejects(tool.execute(tool.validate({...base,button:'left'}),{task}),/发送区/);assert.equal(inputs,0);assert((await tool.execute(tool.validate({...base,button:'right'}),{task})).verified);assert.equal(inputs,1);
});
test('a failed read-only preflight is proven not dispatched, but an input timeout remains uncertain',async()=>{
 const tools=new ToolRegistry(),rect={x:0,y:0,width:800,height:600};let preflightFails=true;
 const native={request:async op=>{if(op==='frontmost'){if(preflightFails)throw Error('metadata unavailable');return {application:{bundleId:'wb',pid:12},windows:[{bundleId:'wb',windowId:7,pid:12,rect}]};}if(op==='capture')return {pngBase64:'fixture'};if(op==='recognize')return {texts:[]};throw Error('input timed out');}};registerScreenActions(tools,{native,applications:{workbuddy:'wb'}});const tool=tools.get('screen.action'),task={id:'test',state:{screenAnchors:{workbuddy:{frameId:'frame',at:Date.now(),bundleId:'wb',pid:12,windowId:7,rect,previewWidth:800,previewHeight:600}}}},args=tool.validate({application:'workbuddy',frameId:'frame',action:'click',targetType:'icon',pixelX:400,pixelY:300});
 await assert.rejects(tool.execute(args,{task}),e=>e.dispatched===false);preflightFails=false;await assert.rejects(tool.execute(args,{task}),e=>e.dispatched===undefined);
});
test('text targets use fresh OCR rather than model arithmetic; delete controls and stale frames never receive input',async()=>{
 const tools=new ToolRegistry(),rect={x:0,y:31,width:821,height:909},inputs=[],row=(text,cx,cy)=>({text,confidence:.9,x:(cx-15)/821,y:(cy-8)/909,width:30/821,height:16/909});
 const native={request:async(op,args)=>{if(op==='frontmost')return {application:{bundleId:'wx',pid:12},windows:[{windowId:7,pid:12,bundleId:'wx',rect}]};if(op==='capture')return {pngBase64:'fixture'};if(op==='recognize')return {texts:[row('取消',350,481),row('删除',471,481)]};inputs.push(args);return {performed:true,point:{x:args.x,y:args.y}};}};
 registerScreenActions(tools,{native,wechatScene:{assertTaskIdentity:async()=>{}},applications:{wechat:'wx'}});const tool=tools.get('screen.action'),anchor=()=>({frameId:'actual-frame',at:Date.now(),bundleId:'wx',pid:12,windowId:7,rect,previewWidth:821,previewHeight:909}),task={id:'test',state:{screenAnchors:{wechat:anchor()}}};
 await tool.execute(tool.validate({application:'wechat',frameId:'actual-frame',action:'click',label:'取消',pixelX:471,pixelY:700}),{task});assert.equal(inputs.length,1);assert.equal(inputs[0].x,350);assert.equal(inputs[0].y,512);
 task.state.screenAnchors.wechat=anchor();await assert.rejects(tool.execute(tool.validate({application:'wechat',frameId:'actual-frame',action:'click',targetType:'region',pixelX:471,pixelY:481}),{task}),/破坏性/);assert.equal(inputs.length,1);
 assert.throws(()=>tool.validate({application:'wechat',frameId:'actual-frame',action:'click',label:'删除'}),/非破坏性/);assert.throws(()=>tool.validate({application:'wechat',frameId:'actual-frame',action:'click',targetType:'icon',pixelX:.5,pixelY:.5}),/整数/);
 await assert.rejects(tool.execute(tool.validate({application:'wechat',frameId:'stale-frame',action:'click',label:'取消'}),{task}),e=>e.dispatched===false);assert.equal(inputs.length,1);
});

test('moved windows reject keyboard and text even when size is unchanged',async()=>{
 const tools=new ToolRegistry(),rect={x:20,y:30,width:800,height:600},calls=[];
 const native={request:async op=>{calls.push(op);return {application:{bundleId:'wb',pid:12},windows:[{windowId:7,pid:12,rect:{...rect,x:120,y:130}}]};}};
 registerScreenActions(tools,{native,applications:{workbuddy:'wb'}});const tool=tools.get('screen.action'),task={id:'move',state:{screenAnchors:{workbuddy:{frameId:'frame',at:Date.now(),bundleId:'wb',pid:12,windowId:7,rect}}}};
 for(const input of [{action:'type',text:'test'},{action:'key',key:'a',modifiers:['cmd']}])await assert.rejects(tool.execute(tool.validate({application:'workbuddy',frameId:'frame',...input}),{task}),e=>e.dispatched===false);
 assert.deepEqual(calls,['frontmost','frontmost']);
});
test('WeChat authentication overlays stop every primitive before input, including navigation keys',async()=>{
 const tools=new ToolRegistry(),rect={x:0,y:30,width:800,height:600},inputs=[],faults=[];
 registerScreenActions(tools,{applications:{wechat:'wx'},wechatScene:{assertTaskIdentity:async()=>{},trip:async reason=>faults.push(reason)},native:{request:async op=>{
  if(op==='frontmost')return {application:{bundleId:'wx',pid:12},windows:[{windowId:7,pid:12,rect}]};
  if(op==='capture')return {pngBase64:'fixture'};
  if(op==='recognize')return {texts:[{text:'为了你的账号安全，请重新登录。',confidence:.9}]};inputs.push(op);return {performed:true};
 }}});
 const tool=tools.get('screen.action'),task={id:'logout',state:{screenAnchors:{wechat:{frameId:'frame',at:Date.now(),bundleId:'wx',pid:12,windowId:7,rect}}}};
 await assert.rejects(tool.execute(tool.validate({application:'wechat',frameId:'frame',action:'key',key:'f',modifiers:['cmd']}),{task}),e=>e.code==='E_APP_CIRCUIT'&&e.dispatched===false);
 assert.equal(inputs.length,0);assert.equal(faults.length,1);
 assert.throws(()=>tool.validate({application:'wechat',frameId:'frame',action:'click',label:'发送',purpose:'file-dialog'}),/conversation.send/);
});
