'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WeChatScene}=require('../src/main/wechat-scene'),{fixture,paint}=require('./support/visual-fixture.cjs');
test('unchanged conversation pixels reuse the actual interpretation despite a draft change and a slow model',()=>{
 const data=Buffer.alloc(100*100*4),identity=fixture().visual.identity(),url=b=>'data:image/png;base64,'+b.toString('base64');const scene=new WeChatScene({native:{},bitmap:b=>({width:100,height:100,data:b})});
 scene.knownIdentity=identity;scene.last={observationId:'known',header:'Alice',headerMatched:true,conversationBottom:.8,messages:[{text:'actual known input'}]};scene.observer.frames.set('known',{preview:url(data),identity});scene.inflight=new Promise(()=>{});
 const draft=Buffer.from(data);draft.fill(255,(90*100+50)*4,(90*100+52)*4);assert.equal(scene.reuseObservation({recipient:'Alice'},{preview:url(draft),at:2}).messages[0].text,'actual known input');
 const body=Buffer.from(draft);body.fill(255,(50*100+50)*4,(50*100+52)*4);assert.equal(scene.reuseObservation({recipient:'Alice'},{preview:url(body),at:3}),null);assert.equal(scene.reuseObservation({recipient:'Bob'},{preview:url(draft)}),null);scene.knownIdentity=fixture().visual.identity();assert.equal(scene.reuseObservation({recipient:'Alice'},{preview:url(draft)}),null);
});
function setup(){const h=fixture(),faults=[];let inspections=0;h.location.texts=[{text:'Alice',confidence:1,x:.4,y:.06,width:.2,height:.03}];const scene=new WeChatScene({native:h.native,imageResize:bytes=>bytes,imageCrop:h.crop,bitmap:h.bitmap,subjects:()=>[{application:'wechat',recipient:'Alice'},{application:'wechat',recipient:'文件传输助手'}],onCircuit:async fault=>faults.push(fault)});scene.visual=h.visual;scene.observer.visual=h.visual;scene.observer.inspect=async()=>{inspections++;return {headerMatched:true,messages:[],draft:''};};return {h,scene,faults,inspections:()=>inspections,advance:()=>{scene.lastAt-=60000;}};}
test('shared unchanged scene reuses VLM interpretation for multiple contacts without OCR or app queries',async()=>{
 const f=setup();assert((await f.scene.observe({recipient:'Alice'})).headerMatched);await f.scene.observe({recipient:'文件传输助手'});assert.equal(f.inspections(),1);f.advance();assert.equal((await f.scene.observe({recipient:'Alice'})).changed,false);assert.equal(f.inspections(),1);assert.equal(f.h.requests.length,1);assert(f.h.calls.every(c=>c.op==='displayCapture'));
});
test('occlusion preserves the visual identity and can recover without latching an account circuit or sending input',async()=>{
 const f=setup();await f.scene.observe({recipient:'Alice'});const original=f.h.location,identity=f.scene.knownIdentity;f.h.location={available:false,unavailableKind:'occluded',reason:'目标被遮挡，无法从实际画面确认'};paint(f.h.image,{x:.1,y:.1,width:.8,height:.8},250);f.advance();
 await assert.rejects(f.scene.observe({recipient:'Alice'}),e=>e.code==='E_VISUAL_TARGET'&&e.dispatched===false&&e.diagnostic.visualState.kind==='occluded');assert.equal(f.scene.circuit,null);assert.equal(f.faults.length,0);
 f.h.location=original;assert((await f.scene.observe({recipient:'Alice'})).headerMatched);assert.deepEqual(f.scene.knownIdentity,identity);assert(f.h.calls.every(c=>c.op==='displayCapture'));
});
test('a visible security/login screen stops before conversation inspection or any login click',async()=>{
 const f=setup();f.h.location={available:false,unavailableKind:'security',evidence:'原生安全提示中可见请重新登录',reason:'实际画面是安全登录提示'};const result=await f.scene.observe({recipient:'Alice'});assert(result.unavailable);assert.equal(f.scene.circuit.kind,'security');assert.equal(f.inspections(),0);assert.equal(f.faults.length,1);const calls=f.h.calls.length;await assert.rejects(f.scene.assertHealthy(),e=>e.code==='E_APP_CIRCUIT'&&e.diagnostic.visualState.kind==='security');assert.equal(f.h.calls.length,calls);assert(f.h.calls.every(c=>c.op==='displayCapture'));
});
test('a single unclassified false or inactive target remains an observation failure rather than an account diagnosis',async()=>{
 for(const result of [{available:false,reason:'账户身份小字看不清'},{available:false,unavailableKind:'login',reason:'可能是登录界面'},{...fixture().location,active:false}]){
  const f=setup();f.h.location=result;await assert.rejects(f.scene.assertHealthy(),e=>e.code==='E_VISUAL_TARGET'&&e.diagnostic.visualState.requiresOwner===false);assert.equal(f.scene.circuit,null);assert.equal(f.faults.length,0);assert(f.h.calls.every(c=>c.op==='displayCapture'));
 }
});
test('a restored legacy window identity is not adopted into the new visual session',async()=>{
 const f=setup(),task={state:{sceneIdentity:{wechat:{pid:76,windowId:8}}}};await assert.rejects(f.scene.assertTaskIdentity(task),e=>e.code==='E_APP_CIRCUIT');assert.equal(f.faults.length,1);assert(!f.h.calls.some(c=>c.op==='displayInput'));
});
