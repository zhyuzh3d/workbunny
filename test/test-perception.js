'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const p=require('../src/main/perception'),actors=require('../src/main/message-identity');
test('sensor extension retains conversion provenance without conferring authority or inventing raw evidence',()=>{
 p.registerSensor('camera.fixture',{channel:'camera',originalFormat:'image',format:'text',transforms:['barcode']});
 const source=p.fromSensor('camera.fixture','frame-1');assert.equal(source.channel,'camera');assert.equal(source.level,'converted');
 assert.equal(p.speech('turn-1').evidenceId,undefined,'a speech event is not a retained audio recording');assert.equal(p.speech('turn-1').observationId,'turn-1');
 const voice=p.voiceTranscript('image-1');assert.equal(voice.originalFormat,'audio');assert.equal(voice.evidenceFormat,'image');assert.deepEqual(voice.transforms,['asr','ocr','vision']);
 const normalized=p.record({...source,owner:true,verified:true,level:'direct'});assert(!('owner'in normalized));assert(!('verified'in normalized));assert.equal(normalized.level,'converted');
 const external=actors.identity('user',{characterId:'contact:test',perception:normalized});assert.equal(actors.isOwner(external),false);
 assert.equal(p.record({channel:'screen',sensor:'unknown'}),null);assert.equal(p.record({...source,schema:'future/v9'}),null);assert.equal(p.record({...source,transforms:[{}]}),null);
 assert.throws(()=>p.fromSensor('not.registered'));assert.throws(()=>p.registerSensor('camera.fixture',{}));
});
test('raw evidence storage has independent count, byte and expiry bounds and reads do not renew observation time',()=>{
 let now=0;const store=new p.EvidenceStore({maxItems:2,maxBytes:12,ttlMs:10,clock:()=>now});
 const frame=()=>({buffer:Buffer.alloc(4),preview:'xx'});
 store.set('a',frame());store.set('b',frame());assert.equal(store.bytes,12);store.set('c',frame());assert.equal(store.get('a'),undefined);assert(store.get('b'));
 now=5;assert(store.get('c'));now=11;assert.equal(store.get('c'),undefined);assert.equal(store.bytes,0);
 store.set('oversize',{buffer:Buffer.alloc(13)});assert.equal(store.size,0);store.set('d',frame());store.clear();assert.equal(store.bytes,0);
});
test('channel history, memory derivation and model input preserve ASR provenance while keeping raw content separate',async t=>{
 const {MemoryService}=require('../src/main/memory-service');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-perception-'));
 const memory=new MemoryService({dir,bin:path.resolve('bin/vault'),openKey:async()=>Buffer.alloc(32,101),getSettings:()=>({enabled:true,extract:false,scene:'life'})});await memory.init();assert(memory.ready,memory.error);
 t.after(async()=>{await memory.close();fs.rmSync(dir,{recursive:true,force:true});});
 const message=await memory.addMessage('user','会议改到明天下午三点。',{scene:'life',perception:p.speech('turn:test'),asrNameMatch:true});
 const wire=JSON.parse(actors.wire(actors.inputRow(message)).content);assert.equal(wire.text,message.value.content);assert.equal(wire.perception.level,'converted');assert.deepEqual(wire.perception.transforms,['asr']);assert.equal(wire.asrNameMatch,true);
 await memory.write([{id:'derived-summary',kind:'summary',ts:Date.now(),domain:'life',visibilityFloor:1,value:{origin:'doze',content:'会议时间变更的摘要。',sources:[message.id]}}]);
 const summary=(await require('../src/main/memory-evidence').readRecords(memory,['derived-summary']))[0];assert.equal(summary.value.perception.level,'inferred');assert.deepEqual(summary.value.perception.sourceChannels,['microphone']);assert.deepEqual(summary.value.sources,[message.id]);
 let payload;const {ConversationBrain}=require('../src/main/conversation-brain');const brain=new ConversationBrain({request:async options=>{payload=JSON.parse(options.messages.at(-1).content);return {response:{text:JSON.stringify({decision:'reply',reply:'收到。',summary:'已回应',progress:{},unknown:[],completed:false})}};}});
 await brain.decide({task:{goal:'回复',criteria:'回应',policy:'',parameters:{behavior:'reply'},state:{}},subject:{application:'wechat',recipient:'Alice'},conversation:{},incoming:[{text:message.value.content,kind:'text',fromVoice:true,incomingVerified:true,perception:p.voiceTranscript('frame:1')}]});
 assert.equal(payload.incoming[0].perception.sensor,'wechat.asr');assert.deepEqual(payload.incoming[0].perception.transforms,['asr','ocr','vision']);assert.equal(payload.incoming[0].text,message.value.content);
 const {AgentService}=require('../src/main/agent-service');let commandPayload;
 const agent=new AgentService({memory,autoSchedule:false,getScene:()=> 'life',scene:{metrics:{},native:{},close:async()=>{}},desktop:{},request:async options=>{commandPayload=JSON.parse(options.messages.at(-1).content);return {response:{text:JSON.stringify({kind:'chat',text:'已收到会议时间信息。'})}};}});
 const command=await agent.command(message.value.content,{role:'owner',verified:true,channel:'dialogue',scene:'life',sources:[message.id]});assert(command.ok,command.error);
 await agent.runtime.tick(command.id);assert.equal(commandPayload.perception.channel,'microphone');assert.equal(commandPayload.perception.level,'converted');assert.equal(commandPayload.currentOwnerRequest,message.value.content);await agent.close();
});
