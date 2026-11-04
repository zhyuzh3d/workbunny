'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WeChatObserver}=require('../src/main/wechat-observer');
test('a grounded independent reading resolves conflicting text evidence while retaining the actual typo for later interpretation',async()=>{
 let calls=0;const rows=[{text:'Alice',confidence:1,x:.4,y:.03,width:.1,height:.02},{text:'明天开灰',confidence:1,x:.45,y:.35,width:.2,height:.03}];
 const original={reviewIndices:[0],headerMatched:true,recipientUnread:false,latestPending:false,draft:'',messages:[{direction:'incoming',kind:'text',text:'明天开会',time:'',confidence:.98,leftAvatar:{x:.36,y:.35},textOrigin:{x:.45,y:.35}}]};
 const observer=new WeChatObserver({native:{},imageResize:b=>({preview:b,ocr:b,mime:'image/png'}),request:async()=>{calls++;return {response:{text:JSON.stringify(calls===2?{readings:[{index:0,supported:true,text:'明天开灰'}]}:original)}};}});
 const view=await observer.inspect({recipient:'Alice'},{pngBase64:Buffer.from('fixture').toString('base64'),ocr:rows});
 assert.equal(view.messages[0].text,'明天开灰','raw message is not silently rewritten to a semantic interpretation');assert.equal(view.messages[0].incomingVerified,true);assert.equal(view.messages[0].visualEvidence.textSource,'independent-vision');
 await observer.inspect({recipient:'Alice'},{pngBase64:Buffer.from('fixture').toString('base64'),ocr:rows});assert.equal(calls,3,'the identical conflict uses its cached independent proof');
});
test('readable visual input is not forced into repeated model checks by unrelated OCR differences',async()=>{
 let calls=0;const observer=new WeChatObserver({native:{},imageResize:b=>({preview:b,mime:'image/png'}),request:async()=>{calls++;return {response:{text:JSON.stringify({headerMatched:true,recipientUnread:false,draft:'',messages:[{direction:'incoming',kind:'text',text:'完整可读的画面原文',time:'',confidence:.98,leftAvatar:{x:.36,y:.35},textOrigin:{x:.45,y:.35}}]})}};}});
 const view=await observer.inspect({recipient:'Alice'},{pngBase64:Buffer.from('fixture').toString('base64'),ocr:[{text:'Alice',confidence:1,x:.4,y:.03},{text:'OCR错读',confidence:1,x:.45,y:.35}]});
 assert.equal(calls,1);assert(view.messages[0].incomingVerified);
});
test('Bunny can read a grounded voice transcript despite OCR numeral differences without waiting for character equality',async()=>{
 let calls=0;const observer=new WeChatObserver({native:{},imageResize:b=>({preview:b,mime:'image/png'}),request:async()=>{calls++;return {response:{text:JSON.stringify({headerMatched:true,recipientUnread:false,draft:'',messages:[{direction:'incoming',kind:'voice',text:'[语音]',time:'',confidence:.98,leftAvatar:{x:.36,y:.4},voiceCenter:{x:.48,y:.4},voiceText:'明天下午三点开会'}]})}};}});
 const view=await observer.inspect({recipient:'Alice'},{pngBase64:Buffer.from('fixture').toString('base64'),ocr:[{text:'Alice',confidence:1,x:.4,y:.03},{text:'明天下午3点开会',confidence:1,x:.45,y:.46}]});
 assert.equal(calls,1);assert(view.messages[0].voiceVerified);assert.equal(view.messages[0].voiceText,'明天下午三点开会');
});
