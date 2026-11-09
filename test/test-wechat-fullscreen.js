'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService}=require('../src/main/desktop-service'),{fixture,paint}=require('./support/visual-fixture.cjs');
function setup(){const h=fixture(),service=new DesktopService({native:h.native,imageCrop:h.crop,bitmap:h.bitmap});service.visualSessions=new Map([['wechat',h.visual]]);service.task={target:'wechat',scene:'life',domain:'life',visibilityFloor:1};service.running=true;service.generation=1;return {...h,h,service,scope:{...h.visual.identity(),target:'wechat'}};}
test('WeChat display pixels are cropped only to a region located by the screenshot VLM',async()=>{
 const h=setup(),shot=await h.service.capture(h.scope,1);assert.deepEqual(h.calls[0].args,{output:'base64'});assert.equal(shot.captureSource,'CGDisplayStream');assert.deepEqual(shot.rect,{x:20,y:12,width:160,height:96});assert.deepEqual(shot.sourceRect,{x:0,y:0,width:200,height:120});assert.equal(h.requests.length,1);assert(!JSON.stringify(h.calls).match(/windowId|bundleId|"pid"|frontmost|recognize/u));
});
test('unverified backends and stale display frames stop before target input',async()=>{
 for(const change of [{backend:'ScreenCaptureKit'},{capturedAt:90000}]){const h=setup(),original=h.native.request;h.native.request=async(op,args)=>({...await original(op,args),...change});await assert.rejects(h.service.capture(h.scope,1),e=>e.code==='E_VISUAL_TARGET');assert(!h.calls.some(c=>c.op==='displayInput'));}
});
test('target movement is reidentified from pixels and old frame evidence cannot be inherited',async()=>{
 const h=setup(),old=await h.service.capture(h.scope,1);paint(h.h.image,{x:.1,y:.1,width:.8,height:.8},200);h.h.location={...h.h.location,region:{x:.13,y:.1,width:.8,height:.8},mainRegion:{x:.13,y:.1,width:.8,height:.8},monitorRegions:[{x:.13,y:.1,width:.8,height:.5}]};const shot=await h.service.capture(h.scope,1);assert.equal(shot.rect.x,26);assert.equal(h.requests.length,2);await assert.rejects(h.visual.input(old.visualFrameId,{action:'click',x:100,y:60}),e=>e.dispatched===false);
});
test('lost visual activity or an occluded target stops without asking the OS which application is frontmost',async()=>{
 const h=setup();h.h.location.active=false;await assert.rejects(h.service.capture(h.scope,1),e=>e.code==='E_VISUAL_TARGET'&&e.dispatched===false);assert(h.calls.every(c=>c.op==='displayCapture'));
});
