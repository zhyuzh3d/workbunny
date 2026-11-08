 'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {wechatAuthReason}=require('../src/main/wechat-auth-state'),{DesktopService}=require('../src/main/desktop-service');
const row=text=>({text,confidence:.9});
test('security prompt and split login UI are recognized without treating a message about login as the login screen',()=>{
 assert.match(wechatAuthReason([row('为了你的账号安全，请重新登录。')]),/重新登录/);
 assert.match(wechatAuthReason([row('为了你的账号安全'),row('请重新登录')]),/重新登录/);
 assert.match(wechatAuthReason([row('进入微信')]),/登录界面/);
 assert.equal(wechatAuthReason([row('搜索'),row('登录')]),null);
 assert.equal(wechatAuthReason([row('Alice'),row('明天帮我看看登录问题')]),null);
});
test('legacy notification and direct desktop routes share the circuit before activating WeChat',async()=>{
 const calls=[],svc=new DesktopService({native:{request:async op=>calls.push(op)},beforeWeChat:async()=>{throw Object.assign(Error('微信已暂停'),{code:'E_APP_CIRCUIT',dispatched:false});}});svc.running=true;svc.task={id:'auth-fixture',scene:'life',domain:'life',visibilityFloor:1,steps:[]};
 await assert.rejects(svc.runOwned(0,{target:'wechat'}),e=>e.code==='E_APP_CIRCUIT');assert.deepEqual(calls,[]);
});
test('legacy visual route rejects a login click and propagates the shared fault before any native input',async()=>{
 const calls=[],faults=[],svc=new DesktopService({native:{request:async op=>calls.push(op)},onWeChatUnavailable:async reason=>faults.push(reason)});
 await assert.rejects(svc.act({action:'click',x:.5,y:.5},{bundleId:'com.tencent.xinWeChat'},{ocr:[row('进入微信')]},0),e=>e.code==='E_APP_CIRCUIT'&&e.dispatched===false);
 assert.equal(calls.length,0);assert.equal(faults.length,1);
});
