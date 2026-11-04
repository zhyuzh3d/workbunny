'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WeChatObserver}=require('../src/main/wechat-observer');
test('coarse media coordinates recover through independent local pixels instead of relaxing the sender boundary',async()=>{
 let reviews=0,supported=true;const observer=new WeChatObserver({imageResize:b=>({mime:'image/png',preview:b}),imageCrop:(_b,r)=>{assert(r.width>0&&r.height>0);return Buffer.from('actual-local-region');},request:async options=>{
  if(options.messages[0].content.includes('靠近中间')){reviews++;return {response:{text:JSON.stringify({supported,kind:'voice',avatar:{x:.09,y:.5},center:{x:.25,y:.5}})}};}
  return {response:{text:JSON.stringify({headerMatched:true,recipientUnread:false,latestPending:false,draft:'',messages:[{direction:'incoming',kind:'voice',text:'[语音]',time:'',confidence:.95,leftAvatar:{x:.315,y:.6},voiceCenter:{x:.44,y:.6},voiceText:''}]})}};
 }});
 const frame={pngBase64:Buffer.alloc(24).toString('base64'),width:800,height:800,ocr:[{text:'Alice',x:.4,y:.05,confidence:1}]};
 const first=await observer.inspect({recipient:'Alice'},frame);assert.equal(first.messages[0].voiceVerified,true);assert(first.messages[0].visualEvidence.avatar.x>.32);
 await observer.inspect({recipient:'Alice'},frame);assert.equal(reviews,1,'unchanged local evidence reuses its independent result');
 observer.evidenceReviews.clear();supported=false;const ambiguous=await observer.inspect({recipient:'Alice'},frame);assert.equal(ambiguous.messages[0].voiceVerified,false,'unsupported evidence does not widen the allowed sender region');
});
