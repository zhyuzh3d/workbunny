'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DesktopService } = require('../src/main/desktop-service');
const scope = { id:'wechat-fixture', target:'wechat', operation:'send', recipient:'Alice', message:'hello',
 goal:'给Alice发送hello',workModel:'deepseek-v4.1-flash',thinking:'high',steps:[] };
const shot = { preview:'data:image/png;base64,YQ==',ocr:[] };
test('bilingual OCR duplicates cannot prevent exact readback of an already inserted draft',()=>{
 const {wechatMessageVisible}=require('../src/main/desktop-service');
 const frame={ocr:[{text:'[ᕱᕱ]',confidence:1,x:.33,y:.837,width:.08,height:.016},{text:'Good evening —',confidence:1,x:.42,y:.837,width:.3,height:.016},{text:'Good evening 一',confidence:.5,x:.42,y:.837,width:.3,height:.016},{text:'Message 123 received.',confidence:1,x:.33,y:.86,width:.3,height:.016},{text:'Message 123 received.',confidence:1,x:.33,y:.86,width:.3,height:.016}]};
 assert(wechatMessageVisible(frame,'［ᕱᕱ］ Good evening — Message 123 received.','composer'));assert(!wechatMessageVisible(frame,'［ᕱᕱ］ Good evening — Message 124 received.','composer'));
});
test('an approved continuation reuses one visual judgment; plain OCR does not decide submission for Bunny',()=>{
 const {visualDraftSubmit}=require('../src/main/desktop-service'),crypto=require('crypto'),frame={preview:'actual',ocr:[{text:'Alice',confidence:.99,x:.4,y:.05,width:.1,height:.03},{text:'hello',confidence:.99,x:.4,y:.8,width:.1,height:.03},{text:'发送(S)',confidence:.99,x:.9,y:.94,width:.05,height:.03}]};
 assert.equal(visualDraftSubmit(scope,frame,true),null,'a visible button alone is not a model decision');
 frame.draftProof={matched:true,taskId:scope.id,messageHash:crypto.createHash('sha256').update(scope.message).digest('hex'),imageHash:crypto.createHash('sha256').update(frame.preview).digest('hex'),nextAction:{action:'click',purpose:'submit',x:.925,y:.955}};
 assert.equal(visualDraftSubmit(scope,frame,true).purpose,'submit');assert.equal(visualDraftSubmit({...scope,submitAttemptedAt:1},frame,true),null);
 assert.equal(visualDraftSubmit(scope,{...frame,preview:'different'},true),null,'exact OCR cannot reauthorize a stale model continuation');
 assert.equal(visualDraftSubmit({...scope,recipient:'Bob'},frame,true),null);assert.equal(visualDraftSubmit({...scope,message:'changed'},frame,true),null);assert.equal(visualDraftSubmit(scope,frame,false),null);assert.equal(visualDraftSubmit({...scope,attachment:{}},frame,true),null);
});
test('WeChat planning has explicit action JSON and retries only bounded read-only output exhaustion', async()=>{
 const calls=[];
 const s=new DesktopService({native:{},modelRequest:async options=>{
  calls.push(options);
  if(calls.length===1)throw Object.assign(new Error('limit'),{code:'E_OUTPUT_LIMIT'});
  return {text:JSON.stringify({action:'done',completed:false,evidence:'等待可用画面'})};
 }});
 const result=await s.nextAction(scope,shot,new AbortController().signal);
 assert.equal(result.completed,false);assert.equal(calls.length,2);
 assert.deepEqual(calls.map(c=>c.maxTokens),[2048,8192]);
 assert(calls.every(c=>c.thinking==='low'&&c.extraBody.reasoning_effort==='low'));
 assert(calls[0].messages[0].content.includes('"action":"type"'));
 const payload=JSON.parse(calls[0].messages[1].content[0].text);
 assert.equal(payload.recipient,'Alice');assert.equal(payload.windowTarget,undefined);
});
test('WeChat before/after screenshots are in one multimodal turn and do not survive another task',async()=>{
 const calls=[],s=new DesktopService({native:{},modelRequest:async o=>{calls.push(o);return {text:'{"action":"wait"}'};}});
 s.wechatBeforeSubmit={taskId:scope.id,preview:'data:image/png;base64,Yg=='};
 await s.nextAction({...scope,submitAttempted:true},shot,new AbortController().signal);
 assert.equal(calls[0].messages.filter(m=>m.role==='user').length,1);
 assert.equal(calls[0].messages[1].content.filter(p=>p.type==='image_url').length,2);
 await s.nextAction({...scope,id:'another-task',submitAttempted:true},shot,new AbortController().signal);
 assert.equal(calls[1].messages[1].content.filter(p=>p.type==='image_url').length,1);
});
test('an inconclusive post-send view retries full-screen location twice without any further input',async()=>{
 const {fixture}=require('./support/visual-fixture.cjs'),h=fixture();h.location.software='微信';h.native.close=async()=>{};
 let frames=0,decisions=0,inputs=0;const now=Date.now(),s=new DesktopService({native:h.native,imageCrop:h.crop,bitmap:h.bitmap,planner:async()=>{decisions++;return {action:'done',completed:false,evidence:'画面尚未核对'};}});
 s.visualSessions=new Map([['wechat',h.visual]]);
 s.task={...scope,domain:'life',scene:'life',visibilityFloor:1,startedAt:now,attemptStartedAt:now,submitAttemptedAt:now-1000,draftInserted:true,status:'running',steps:[]};s.running=true;s.generation=1;s.controller=new AbortController();s.displayRegionAnchor={mode:'visual'};
 const capture=s.capture.bind(s);s.capture=async(...args)=>{frames++;return capture(...args);};s.act=async()=>{inputs++;};
 try{await s.runOwned(1,{...scope,startedAt:now,attemptStartedAt:now});assert.equal(frames,3);assert.equal(decisions,3);assert.equal(inputs,0);assert.equal(s.displayRegionAnchor,null);assert.equal(s.task.status,'paused');assert(s.task.proofCorrection.includes('全屏重新定位'));assert.equal(h.calls.filter(c=>c.op==='displayCapture').length,5,'activation, three observations and final read-only verification');assert(h.calls.every(c=>c.op==='displayCapture'));}finally{await s.close();}
});
