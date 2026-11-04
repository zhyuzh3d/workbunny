'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WeChatObserver}=require('../src/main/wechat-observer');
const {ConversationCursor,locateObserved}=require('../src/main/conversation-cursor');

function makeObserver(belongs){
 const ocr=[{text:'Alice',x:.4,y:.05,width:.1,height:.02,confidence:1},{text:'改成周四了。',x:.41,y:.62,width:.1,height:.02,confidence:1}];
 const voice={direction:'incoming',kind:'voice',text:'[语音]',time:'',confidence:.98,leftAvatar:{x:.34,y:.57},voiceCenter:{x:.44,y:.57},voiceText:''};
 const next={direction:'incoming',kind:'text',text:'改成周四了。',time:'',confidence:.98,leftAvatar:{x:.34,y:.62}};
 let requests=0;
 const observer=new WeChatObserver({native:{},imageResize:()=>({mime:'image/png',preview:Buffer.from('image')}),request:async()=>({response:{text:JSON.stringify(requests++===0?{headerMatched:true,recipientUnread:false,draft:'',messages:[voice,next]}:{belongs})}})});
 return {observer,ocr};
}
test('a visually confirmed transcript stays attached to its voice, not a new message',async()=>{
 const {observer,ocr}=makeObserver(true),v=await observer.inspect({recipient:'Alice'},{pngBase64:Buffer.from('image').toString('base64'),ocr});
 assert.equal(v.messages.length,1);assert.equal(v.messages[0].voiceText,'改成周四了。');assert.equal(v.messages[0].voiceVerified,true);
});
test('a separate following message remains independent when visual association is not confirmed',async()=>{
 const {observer,ocr}=makeObserver(false),v=await observer.inspect({recipient:'Alice'},{pngBase64:Buffer.from('image').toString('base64'),ocr});
 assert.equal(v.messages.length,2);assert.equal(v.messages[0].voiceText,'');
});
test('queued voice remains locatable after its duplicate transcript is reconciled',()=>{
 const voice={direction:'incoming',kind:'voice',text:'[语音]',voiceVerified:true},transcript={direction:'incoming',kind:'text',text:'改成周四了。'},old={direction:'incoming',kind:'text',text:'prior'};
 const cursor=new ConversationCursor();cursor.observe([old]);cursor.observe([old,voice,transcript]);const state=cursor.snapshot();
 const fresh={...voice,voiceText:transcript.text};assert.equal(locateObserved(state,[old,fresh],1),fresh);
});
test('identical earlier voice transcripts use surrounding message order to locate the pending one',()=>{
 const voice={direction:'incoming',kind:'voice',text:'[语音]',voiceVerified:true},transcript={direction:'incoming',kind:'text',text:'改成周四了。'},old={direction:'outgoing',kind:'text',text:'old confirmation'},anchor={direction:'outgoing',kind:'text',text:'latest confirmation'};
 const cursor=new ConversationCursor();cursor.observe([voice,transcript,old,anchor]);cursor.observe([voice,transcript,old,anchor,voice,transcript]);const state=cursor.snapshot();
 const first={...voice,voiceText:transcript.text},last={...voice,voiceText:transcript.text};assert.equal(locateObserved(state,[first,old,anchor,last],1),last);
});

test('media occurrence is identified by its reliable anchor and order despite transcript wording differences',()=>{
 const {locateObserved,messageKey}=require('../src/main/conversation-cursor');
 const anchor={direction:'outgoing',kind:'text',text:'Unique preceding reply'},voice={direction:'incoming',kind:'voice',text:'[语音]'},transcript={direction:'incoming',kind:'text',text:'明天下午3点开会'};
 const state={recent:[{...anchor,key:messageKey(anchor)}, {...voice,key:messageKey(voice),sequence:3},{...transcript,key:messageKey(transcript),sequence:4}]};
 const current=[anchor,{...voice,voiceVerified:true,voiceCenter:{x:.5,y:.6},voiceText:'明天下午三点开会'}];
 assert.equal(locateObserved(state,current,3),current[1]);
 assert.equal(locateObserved(state,[anchor,current[1],{...current[1]}],3),null,'different media counts do not identify the original occurrence');
 assert.equal(locateObserved(state,[{...anchor,text:'different anchor'},current[1]],3),null,'a missing reliable anchor is not permission to guess');
});
