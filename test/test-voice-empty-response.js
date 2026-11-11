'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ChatResponse}=require('../src/main/chat-response'),{requestReply}=require('../src/main/reply-request');
const completion=(content,finish='stop',extra={})=>{const response=new ChatResponse('offline');response.event({choices:[{message:{content,...extra},finish_reason:finish}]});return response.result();};
const request=()=>({messages:[{role:'user',content:'synthetic ASR candidate'}],timeoutMs:1000,allowEmptyVoiceDecision:true,allowActions:true});
test('explicit completed empty ASR content is one successful ignore, without a repair request',async()=>{
 for(const content of ['', '  ']){let calls=0;const result=await requestReply({selfRepair:true,request:request(),chat:async()=>{calls++;return completion(content);}});assert.equal(calls,1);assert.equal(result.reply.skipped,true);assert.equal(result.emptyDecision,true);assert.equal(result.text,'');}
});
test('empty JSON chat is a validated protocol response, without a format repair',async()=>{
 let calls=0;const result=await requestReply({request:request(),chat:async()=>{calls++;return {raw:'{"kind":"chat","text":""}'};}});assert.equal(calls,1);assert.equal(result.reply.skipped,true);assert.equal(result.text,'');
});
test('skip and empty voice decisions never invoke presentation or speech callbacks',async()=>{
 const wrapped=reply=>JSON.stringify({protocol:'dialogue-v2',stages:[{stage:'review',grade:'unassessed',note:'synthetic evidence',grasp:'insufficient',pace:'listen'},{stage:'reply',reply},{stage:'prediction',expect:null}]});
 for(const cognitive of [false,true])for(const reply of [{kind:'skip'},{kind:'chat',text:''}]){
  const events=[];const raw=cognitive?wrapped(reply):JSON.stringify(reply);
  const result=await requestReply({request:{...request(),cognitive,onDelta:text=>events.push(['presentation',text]),onSentence:text=>events.push(['speech',text])},chat:async()=>({raw})});
  assert.equal(result.reply.skipped,true);assert.equal(result.text,'');assert.deepEqual(events,[]);
 }
 const shown=[],spoken=[];
 await requestReply({request:{...request(),onDelta:raw=>shown.push(raw),onSentence:text=>spoken.push(text)},chat:async()=>({raw:'{"kind":"chat","text":"A real answer."}'})});
 assert.equal(shown.length,1);assert.deepEqual(spoken,['A real answer.']);
});
test('missing packets, uncompleted streams, output limits, reasoning-only and ordinary text-channel empty responses stay errors',async()=>{
 for(const make of [()=>new ChatResponse('offline').result(),()=>completion('','length'),()=>completion('',null),()=>completion('','stop',{reasoning_content:'private chain'})])await assert.rejects(requestReply({request:request(),chat:async()=>make()}),error=>['E_EMPTY_RESPONSE','E_OUTPUT_LIMIT'].includes(error.code));
 await assert.rejects(requestReply({request:{...request(),allowEmptyVoiceDecision:false},chat:async()=>completion('')}),{code:'E_EMPTY_RESPONSE'});
});
test('successful empty content inside the complete cognitive envelope ignores once while malformed envelopes still fail',async()=>{
 const raw=JSON.stringify({protocol:'dialogue-v2',stages:[{stage:'review',grade:'unassessed',note:'synthetic evidence',grasp:'insufficient',pace:'listen'},{stage:'reply',reply:{kind:'chat',text:''}},{stage:'prediction',expect:null}]});let calls=0;
 const result=await requestReply({request:{...request(),cognitive:true},chat:async()=>{calls++;return {raw};}});assert.equal(calls,1);assert.equal(result.reply.skipped,true);assert.equal(result.text,'');
 await assert.rejects(requestReply({maxRepairs:0,request:request(),chat:async()=>({raw:'{"kind":"chat","text":"","unexpected":true}'})}),{code:'E_REPLY_PROTOCOL'});
});
