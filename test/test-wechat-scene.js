'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WeChatScene}=require('../src/main/wechat-scene');
test('unchanged conversation pixels reuse the actual interpretation despite draft changes and a slow background model',()=>{
 const data=Buffer.alloc(100*100*4),identity={pid:77,windowId:9},url=b=>'data:image/png;base64,'+b.toString('base64');
 const scene=new WeChatScene({native:{},bitmap:b=>({width:100,height:100,data:b})});
 scene.knownWindow=identity;scene.last={observationId:'known',header:'Alice',headerMatched:true,conversationBottom:.8,messages:[{text:'actual known input'}]};
 scene.observer.frames.set('known',{preview:url(data),identity});scene.inflight=new Promise(()=>{});
 const draft=Buffer.from(data);draft.fill(255,(90*100+50)*4,(90*100+52)*4);
 assert.equal(scene.reuseObservation({recipient:'Alice'},{preview:url(draft),at:2}).messages[0].text,'actual known input');
 const body=Buffer.from(draft);body.fill(255,(50*100+50)*4,(50*100+52)*4);
 assert.equal(scene.reuseObservation({recipient:'Alice'},{preview:url(body),at:3}),null,'actual new conversation pixels still require independent interpretation');
 assert.equal(scene.reuseObservation({recipient:'Bob'},{preview:url(draft)}),null);
 scene.knownWindow={...identity,pid:78};assert.equal(scene.reuseObservation({recipient:'Alice'},{preview:url(draft)}),null);
});
function fixture(){let now=1000,visible=true,login=false,changed=true;const calls=[],faults=[];let inspections=0;
 const native={request:async(op)=>{calls.push(op);
  if(op==='frontmost')return {application:{bundleId:'other.app'},windows:visible?[{bundleId:'com.tencent.xinWeChat',pid:77,windowId:9,layer:0,rect:{x:0,y:30,width:821,height:909}}]:[]};
  if(op==='visualSample')return {baseline:changed,changed:false,geometryChanged:false,width:821,height:909,...(changed?{pngBase64:Buffer.from('fixture').toString('base64')}:{})};
  if(op==='capture')return {pngBase64:Buffer.from('full-display-fixture').toString('base64')};
  if(op==='recognize')return {texts:login?[{text:'扫码登录',confidence:1,x:.4,y:.2}]:[{text:'Alice',confidence:1,x:.4,y:.06}]};
  if(op==='visualCommit')return {committed:true};if(op==='visualForget')return {};throw Error(op);
 },close:async()=>{}};
 const scene=new WeChatScene({native,imageResize:()=>({}),subjects:()=>[{application:'wechat',recipient:'Alice'},{application:'wechat',recipient:'文件传输助手'}],clock:()=>now,onCircuit:async fault=>faults.push(fault)});
 scene.observer.inspect=async()=>{inspections++;return {headerMatched:true,messages:[],draft:''};};
 return {scene,calls,faults,inspectionCount:()=>inspections,advance:()=>{now+=60000;},setQuiet:()=>{changed=false;},hide:()=>{visible=false;},login:()=>{login=true;}};
}
test('shared unchanged scene does not repeatedly OCR or invoke a model for multiple contacts',async()=>{
 const h=fixture();assert((await h.scene.observe({recipient:'Alice'})).headerMatched);
 await h.scene.observe({recipient:'文件传输助手'});assert.equal(h.inspectionCount(),1);assert.equal(h.calls.filter(c=>c==='visualSample').length,1);
 h.setQuiet();h.advance();assert.equal((await h.scene.observe({recipient:'Alice'})).changed,false);
 assert.equal(h.inspectionCount(),1);assert.equal(h.calls.filter(c=>c==='recognize').length,1);
});
test('disappearance permanently latches the circuit without activating, launching or sending',async()=>{
 const h=fixture();await h.scene.observe({recipient:'Alice'});h.hide();h.advance();
 const result=await h.scene.observe({recipient:'Alice'});assert(result.unavailable);const count=h.calls.length;
 assert.equal(h.calls.filter(c=>c==='capture').length,1);assert.match(result.reason,/已取得全屏画面/);
 await h.scene.observe({recipient:'Alice'});await assert.rejects(h.scene.assertHealthy(),e=>e.code==='E_APP_CIRCUIT'&&e.dispatched===false);
 assert.equal(h.calls.length,count);assert.equal(h.faults.length,1);assert(!h.calls.some(c=>['activate','click','key','type'].includes(c)));
});
test('login screen trips before model inspection and never clicks a login button',async()=>{
 const h=fixture();h.login();const result=await h.scene.observe({recipient:'Alice'});assert(result.unavailable);assert.equal(h.inspectionCount(),0);assert.equal(h.faults.length,1);
});
test('a task restored with a different WeChat identity stops before observing or input',async()=>{
 const h=fixture(),task={state:{sceneIdentity:{wechat:{pid:76,windowId:8}}}};
 await assert.rejects(h.scene.assertTaskIdentity(task),e=>e.code==='E_APP_CIRCUIT');
 assert.deepEqual(h.calls,['frontmost']);assert.equal(h.faults.length,1);
});
