'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DesktopService,validateAction}=require('../src/main/desktop-service');
const {conversationReceipt}=require('../src/main/agent-service');
const {ConversationCursor}=require('../src/main/conversation-cursor');
const {fixture}=require('./support/visual-fixture.cjs');
test('the same done judgment retains actual evidence and a different observed body without a new model or literal-equality gate',async t=>{
 const h=fixture();h.native.close=async()=>{};h.native.cancel=async()=>{};let plans=0;
 const service=new DesktopService({native:h.native,imageResize:b=>b,imageCrop:h.crop,bitmap:h.bitmap,planner:async()=>{plans++;return {action:'done',completed:true,evidence:'The actual visible delivered body is shorter than the intended body',receipt:{observed:'delivered',basis:'Actual visible result',observedText:'Thanks'}};}});t.after(()=>service.close());service.visualSessions=new Map([['demo',h.visual]]);
 service.task={id:'synthetic-assessment',target:'demo',goal:'Acknowledge the synthetic input',scene:'life',domain:'life',visibilityFloor:1,message:'Thanks to you',steps:[],startedAt:Date.now()};service.running=true;service.generation=1;service.controller=new AbortController();
 await service.run(1,{...service.task});assert.equal(plans,1);assert.equal(service.task.deliveryAssessment.completed,true);assert.equal(service.task.deliveryAssessment.receipt.observedText,'Thanks');assert.match(service.task.deliveryAssessment.evidence,/shorter/);
 const receipt=conversationReceipt(service.task);assert.equal(receipt.desiredText,'Thanks to you');assert.equal(receipt.observedText,'Thanks');assert.equal(receipt.sentText,'Thanks');assert.equal(receipt.deliveryAssessment.completed,true);assert.equal(h.calls.filter(c=>c.op==='displayInput').length,0);
});
test('missing literal observation remains unknown even when evidence mentions a body; opaque private references never disclose it',()=>{
 const physical={id:'physical',message:'Desired canary',deliveryAssessment:{completed:true,evidence:'The observed body was Actual canary',receipt:{observed:'delivered',basis:'Actual evidence'},source:'visual-planner'}};
 const receipt=conversationReceipt(physical);assert.equal(receipt.observedText,null);assert.equal(receipt.sentText,undefined);assert.equal(receipt.messageKey,undefined);assert.equal(receipt.desiredText,physical.message);assert.equal(receipt.deliveryAssessment.completed,true);
 const privateReceipt=conversationReceipt({...physical,deliveryAssessment:{...physical.deliveryAssessment,receipt:{observed:'delivered',observedText:'Private actual canary'}}},{desiredTextRef:'channel-reply:opaque',visible:false});assert.equal(privateReceipt.desiredTextRef,'channel-reply:opaque');assert.equal(privateReceipt.desiredText,undefined);assert.equal(privateReceipt.observedText,null);assert.equal(privateReceipt.sentText,undefined);assert(!JSON.stringify(privateReceipt).includes('canary'));assert.equal(privateReceipt.deliveryAssessment.evidenceWithheld,true);
 assert.equal(validateAction({action:'done',completed:true,evidence:'Result assessed',receipt:{observed:'delivered',basis:'Actual evidence',observedText:null}}).receipt.observedText,null);
});
test('new cursor receipts use observed text and never insert desired text into an observed baseline; legacy receipts retain compatibility',()=>{
 const original={kind:'text',direction:'incoming',text:'original'},cursor=new ConversationCursor();cursor.observe([original]);const baseline=cursor.snapshot().baseline;
 cursor.noteSent('Desired body',{operationId:'unknown-body',desiredText:'Desired body',observedText:null,deliveryAssessment:{completed:true,evidence:'Delivery assessed'}});assert.deepEqual(cursor.snapshot().baseline,baseline);assert.equal(cursor.snapshot().recent.length,1);assert(cursor.snapshot().consumedSentIds.includes('unknown-body'));assert.equal(cursor.snapshot().lastDeliveryReceipt.observedText,null);
 const actual={kind:'text',direction:'outgoing',text:'Actual shorter'};assert.equal(cursor.observe([original,actual]).uncertain,undefined);assert.equal(cursor.snapshot().recent.at(-1).text,'Actual shorter');
 cursor.noteSent('Wrong fallback',{operationId:'known-body',desiredText:'Desired body',observedText:'Observed body'});assert.equal(cursor.snapshot().recent.at(-1).text,'Observed body');cursor.noteSent('Legacy body',{operationId:'legacy'});assert.equal(cursor.snapshot().recent.at(-1).text,'Legacy body');
});
test('an unknown literal receipt keeps its consumed ID and intent hash only as a later actual self-echo matching hint',()=>{
 const cursor=new ConversationCursor(),before={kind:'text',direction:'outgoing',text:'Original owner fixture'};cursor.observe([before],{ownerChannel:true});
 const receipt=conversationReceipt({id:'actual-send-id',message:'Actual self echo',deliveryAssessment:{completed:true,evidence:'Delivery assessed without literal transcription',receipt:{observed:'delivered'}}},{desiredTextRef:'channel-reply:opaque'});cursor.noteSent('channel-reply:opaque',receipt);
 const observed={kind:'text',direction:'outgoing',text:'Actual self echo'},result=cursor.observe([before,observed],{ownerChannel:true});assert.equal(result.messages.length,0);assert.equal(cursor.snapshot().recent.at(-1).origin,'bunny');assert(cursor.snapshot().consumedSentIds.includes('actual-send-id'));assert.equal(cursor.snapshot().lastDeliveryReceipt.observedText,null,'later echo matching does not rewrite the original observation');
 assert.deepEqual(cursor.observe([before,observed,{kind:'text',direction:'outgoing',text:'A genuinely new owner request'}],{ownerChannel:true}).messages.map(m=>m.text),['A genuinely new owner request']);
});
