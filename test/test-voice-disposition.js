'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateReply,responseFormat,recoverCognitiveChat}=require('../src/main/reply-format');
const {requestReply}=require('../src/main/reply-request');
const body=(text,turnDisposition)=>JSON.stringify({kind:'chat',text,...(turnDisposition===undefined?{}:{turnDisposition})});
test('voice disposition is strict, chat-only and scoped; missing legacy ASR fields preserve delivery',()=>{
 for(const disposition of ['keep','replace']){assert.equal(validateReply(body('answer',disposition),{allowTurnDisposition:true}).turnDisposition,disposition);assert.throws(()=>validateReply(body('answer',disposition)),{code:'E_REPLY_PROTOCOL'});}
 assert.equal(validateReply(body('legacy answer'),{allowTurnDisposition:true}).turnDisposition,'keep');assert.equal(validateReply(body('typed answer')).turnDisposition,undefined);
 for(const value of [null,true,'replace-all','',0])assert.throws(()=>validateReply(body('answer',value),{allowTurnDisposition:true}),{code:'E_REPLY_PROTOCOL'});
 for(const kind of ['skip','action'])assert.throws(()=>validateReply(JSON.stringify({kind,turnDisposition:'keep',...(kind==='action'?{intent:{action:'stop'}}:{})}),{allowTurnDisposition:true}),{code:'E_REPLY_PROTOCOL'});
 assert.throws(()=>validateReply('{"kind":"chat","text":"x","turnDisposition":"replace","unexpected":true}',{allowTurnDisposition:true}),{code:'E_REPLY_PROTOCOL'});
});
test('voice schema requests explicit disposition without extending typed or action contracts',()=>{
 const normal=responseFormat('grok').json_schema.schema.anyOf,voice=responseFormat('grok',undefined,{allowTurnDisposition:true}).json_schema.schema.anyOf;
 assert.equal(normal[0].properties.turnDisposition,undefined);assert.deepEqual(voice[0].properties.turnDisposition.enum,['keep','replace']);assert(voice[0].required.includes('turnDisposition'));assert.equal(voice[1].properties.turnDisposition,undefined);
});
test('cognitive chat recovery cannot obtain cancellation authority from a malformed envelope',()=>{
 const broken=JSON.stringify({protocol:'dialogue-v2',stages:[{stage:'review',bad:true},{stage:'reply',reply:JSON.parse(body('safe text','replace'))},{stage:'prediction',expect:null}]});const recovered=recoverCognitiveChat(broken,{allowTurnDisposition:true});assert.equal(recovered.text,'safe text');assert.equal(recovered.turnDisposition,'keep');
});
test('same-call voice protocol returns a validated replacement while ordinary malformed fields still fail',async()=>{
 let calls=0;const reply=await requestReply({request:{allowTurnDisposition:true,messages:[{role:'user',content:'new question'}]},chat:async()=>{calls++;return {raw:body('new answer','replace')};}});assert.equal(calls,1);assert.equal(reply.reply.turnDisposition,'replace');
});
