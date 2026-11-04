'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {transcribeVoice}=require('../src/main/wechat-voice'),{subjectKey}=require('../src/main/conversation-skill');
function fixture(){const subject={application:'wechat',recipient:'Alice'};return {subject,sequence:3,task:{id:'voice-task',state:{conversations:{[subjectKey(subject)]:{cursor:{ready:true,recent:[{kind:'voice',direction:'incoming',sequence:3,voiceCenter:{x:.44,y:.78}},{kind:'text',direction:'incoming',sequence:4,text:'separately observed transcript'},{kind:'voice',direction:'incoming',sequence:5}]}}}}},operationId:'read-voice-3'};}
test('voice adapter supplies the original target to the shared visual Action and returns its actual read result',async()=>{
 const f=fixture();let received;
 const result=await transcribeVoice({...f,execute:async args=>{received=args;return {ok:true,verified:true,text:'明天的会议改到下午3点了。'};}});
 assert.equal(received.operation,'read');assert.equal(received.readRequest.sequence,3);assert.equal(received.readRequest.ordinalFromLatestKnownVoice,2);assert.deepEqual(received.readRequest.originalPosition,{x:.44,y:.78});assert.equal(received.task,f.task);assert.equal(received.operationId,f.operationId);
 assert(result.verified);assert.equal(result.text,'明天的会议改到下午3点了。');assert.deepEqual(result.perception.transforms,['asr','ocr','vision']);
});
test('an unfinished read keeps the logical target instead of claiming conversion or inventing a transcript',async()=>{
 const f=fixture();const result=await transcribeVoice({...f,execute:async()=>({ok:false,error:'Bunny正在依据当前画面调整方法'})});assert(result.pending);assert.equal(result.verified,undefined);assert.equal(result.text,undefined);
 const empty=await transcribeVoice({...f,execute:async()=>({ok:true,verified:true,text:''})});assert(empty.pending);assert.equal(empty.verified,undefined);
});
test('task cancellation prevents a new visual Action and is forwarded through an active one',async()=>{
 const f=fixture(),controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(transcribeVoice({...f,signal:controller.signal,execute:async()=>{calls++;}}));assert.equal(calls,0);
 const active=new AbortController();await transcribeVoice({...f,signal:active.signal,execute:async args=>{assert.equal(args.signal,active.signal);return {ok:true,verified:true,text:'actual text'};}});
});
