'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WeChatObserver}=require('../src/main/wechat-observer');
test('literal input review is blind to the expected key and rejects corrected case, wrong scope and incomplete images',async()=>{
 const expected='LiteralFixture-Key-775',actual='LiteralFixture-key-775';let calls=0,complete=true;
 const observer=new WeChatObserver({imageCrop:()=>Buffer.from('cropped-source'),request:async options=>{calls++;const text=JSON.stringify(options.messages);assert(!text.includes(expected));assert(!text.includes(actual));return {response:{text:JSON.stringify({text:actual,complete})}};}});
 observer.frames.set('source',{buffer:Buffer.alloc(24),preview:'',width:800,height:600,recipient:'Alice',identity:{pid:1,windowId:2},ocr:[{text:expected,confidence:1,x:.4,y:.5,width:.3,height:.03}]});
 const message={visualEvidence:{observationId:'source',textOrigin:{x:.4,y:.5}}},channel={recipient:'Alice',account:'1:2'};
 assert.equal(await observer.verifyLiteralInput(message,{channel,expected}),false,'normal observation and OCR may both have corrected case; independent literal pixels control authentication');
 assert.equal(await observer.verifyLiteralInput(message,{channel,expected:actual}),true);assert.equal(calls,1,'same source is read once without expected-string priming');
 assert.equal(await observer.verifyLiteralInput(message,{channel:{...channel,recipient:'Bob'},expected:actual}),false);
 assert.equal(await observer.verifyLiteralInput(message,{channel:{...channel,account:'1:3'},expected:actual}),false);
 assert.equal(await observer.verifyLiteralInput({visualEvidence:{observationId:'missing'}},{channel,expected:actual}),false);
 observer.evidenceReviews.clear();complete=false;assert.equal(await observer.verifyLiteralInput(message,{channel,expected:actual}),false);
});
