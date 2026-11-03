'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {transcribeVoice}=require('../src/main/wechat-voice');
function fixture({text='',menu=true,voiceVerified=true}={}){
 const calls=[],window={bundleId:'com.tencent.xinWeChat',pid:12,windowId:8,rect:{x:100,y:100,width:800,height:700}},front={application:{bundleId:window.bundleId,pid:12},windows:[window]};
 const native={request:async(op,payload)=>{calls.push({op,payload});if(op==='frontmost')return front;if(op==='inputIdle')return {hidIdleMs:5000};if(op==='capture')return {pngBase64:'fixture'};if(op==='recognize')return {texts:menu?[{text:'转文字',confidence:.99,x:.5,y:.3,width:.1,height:.03}]:[]};if(op==='click')return {performed:true};throw Error('unexpected '+op);}};
 const scene={native,assertTaskIdentity:async()=>{},assertHealthy:async()=>window,observe:async()=>({headerMatched:true,messages:[{direction:'incoming',kind:'voice',voiceVerified,voiceCenter:{x:.5,y:.4},voiceText:text}]}),invalidate:()=>{}};
 const subject={application:'wechat',recipient:'Alice'},cursor=new (require('../src/main/conversation-cursor').ConversationCursor)();cursor.observe([{direction:'incoming',kind:'voice',text:'[语音]'}]);const state=cursor.snapshot();state.sequence=1;state.recent[0].sequence=1;return {scene,calls,subject,sequence:1,task:{id:'fixture',state:{conversations:{[require('../src/main/conversation-skill').subjectKey(subject)]:{cursor:state}}}},canOperate:async()=>true};
}
test('voice conversion clicks the verified voice and the visible conversion menu',async()=>{
 const f=fixture(),result=await transcribeVoice(f);assert.equal(result.requested,true);const clicks=f.calls.filter(c=>c.op==='click');assert.equal(clicks.length,2);assert.equal(clicks[0].payload.button,'right');assert.equal(clicks[1].payload.windowId,8);
});
test('existing transcript is read without clicking and missing evidence never triggers input',async()=>{
 let f=fixture({text:'你好'});assert.deepEqual(await transcribeVoice(f),{text:'你好',verified:true});assert.equal(f.calls.filter(c=>c.op==='click').length,0);
 f=fixture({voiceVerified:false});assert((await transcribeVoice(f)).pending);assert.equal(f.calls.filter(c=>c.op==='click').length,0);
 f=fixture({menu:false});assert((await transcribeVoice(f)).pending);assert.equal(f.calls.filter(c=>c.op==='click').length,1);
});
test('requested transcription waits without reissuing the conversion',async()=>{
 const f=fixture();const result=await transcribeVoice({...f,requested:true});assert(result.pending);assert.equal(f.calls.filter(c=>c.op==='click').length,0);
});
test('multiple voice bubbles use the queued sequence to select the correct position',async()=>{
 const f=fixture(),first={direction:'incoming',kind:'voice',text:'[语音]',voiceVerified:true,voiceCenter:{x:.5,y:.3}},second={...first,voiceCenter:{x:.5,y:.5}};
 const cursor=new (require('../src/main/conversation-cursor').ConversationCursor)();cursor.observe([{direction:'incoming',kind:'text',text:'old'}]);cursor.observe([{direction:'incoming',kind:'text',text:'old'},first,second]);
 f.task.state.conversations[require('../src/main/conversation-skill').subjectKey(f.subject)].cursor=cursor.snapshot();f.scene.observe=async()=>({headerMatched:true,messages:[{direction:'incoming',kind:'text',text:'old'},first,second]});
 const r=await transcribeVoice({...f,sequence:1});assert(r.requested);const click=f.calls.find(c=>c.op==='click');assert.equal(click.payload.y,310);
});
