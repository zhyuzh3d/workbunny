'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {sanitizeSpeechTrace}=require('../src/main/speech-trace'),{Asr}=require('../src/main/asr'),{createVoiceTurns}=require('../src/main/voice-turns');
test('speech trace accepts only fixed stages and finite numeric metadata, never arbitrary text or object keys',()=>{
 const secret='private-transcript-canary',levels=[.1,.2];
 const record=sanitizeSpeechTrace({stage:'result',gen:2,textChars:8,confirmed:true,rms:levels,peak:[NaN],start:Infinity,end:secret,transcript:secret,deviceUID:secret,[secret]:5,nested:{value:secret}});
 assert.deepEqual(record,{stage:'result',gen:2,textChars:8,confirmed:true,rms:[.1,.2]});assert.notEqual(record.rms,levels);assert(!JSON.stringify(record).includes(secret));
 assert.equal(sanitizeSpeechTrace({stage:secret,chars:2}),null);assert.equal(sanitizeSpeechTrace({stage:'result',rms:Array(65).fill(.2)}).rms,undefined);
});
test('separate semantic and effect state diagnostics retain fixed numeric reasons without private content',()=>{
 const secret='private-audio-canary';
 const row=sanitizeSpeechTrace({stage:'turn-gate-closed',turn:3,accepted:true,finalized:true,commitReady:false,waitingAudio:true,gateClosedMs:80,reasonCode:8,
  reason:secret,transcript:secret,pcm:secret,deviceUID:secret,apiKey:secret});
 assert.deepEqual(row,{stage:'turn-gate-closed',turn:3,accepted:true,finalized:true,commitReady:false,waitingAudio:true,gateClosedMs:80,reasonCode:8});
 assert(!JSON.stringify(row).includes(secret));
 assert.deepEqual(sanitizeSpeechTrace({stage:'turn-gate-ready',gateClosedMs:Infinity,reasonCode:NaN,waitingAudio:secret}),{stage:'turn-gate-ready'});
});
test('ordinary model and actual effect checkpoints permit only bounded metadata',()=>{
 for(const stage of ['voice-admitted','voice-model-start','voice-model-end','voice-model-abort','voice-effects-waiting','voice-effects-allowed','voice-task-admitted']){
  const row=sanitizeSpeechTrace({stage,elapsedMs:1200,taskAdmitted:false,current:true,activityAgeMs:605,quietSeconds:3.26,activitySeq:19,sourceGen:3,
   body:'private-content',request:{apiKey:'private-key'},task:{goal:'private-goal'}});
  assert.deepEqual(row,{stage,elapsedMs:1200,taskAdmitted:false,current:true,activityAgeMs:605,quietSeconds:3.26,activitySeq:19,sourceGen:3});
 }
});
function asrFixture(t){
 const spawned=[],trace=[],utterances=[];
 const asr=new Asr('/fixture/asr',()=>{},(_bin,args)=>{const child=new EventEmitter();Object.assign(child,{pid:spawned.length+1,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:()=>{}});spawned.push({child,args});return child;});
 asr.on('error',()=>{});asr.on('speechTrace',value=>trace.push(value));asr.on('utterance',value=>utterances.push(value));t.after(()=>asr.kill({discard:true}));return {asr,spawned,trace,utterances};
}
test('ASR diagnostics are opt-in and do not change recognized events',t=>{
 const f=asrFixture(t),text='完整原话保留在正常通道';f.asr.start({always:true});assert(!f.spawned[0].args.includes('--speech-trace'));
 f.asr.onMessage({t:'speechTrace',stage:'result',textChars:text.length,transcript:text});f.asr.onMessage({t:'utterance',v:text});assert.deepEqual(f.trace,[]);assert.deepEqual(f.utterances,[text]);
 f.asr.kill({discard:true});f.asr.start({always:true,trace:true});assert(f.spawned[1].args.includes('--speech-trace'));
 f.asr.onMessage({t:'speechTrace',stage:'result',textChars:text.length,transcript:text});f.asr.onMessage({t:'utterance',v:text});
 assert.deepEqual(f.trace.map(value=>value.stage),['result','raw-utterance']);assert(!JSON.stringify(f.trace).includes(text));assert.deepEqual(f.utterances,[text,text]);
 const count=f.trace.length;f.asr.onMessage({t:'utterance',v:'old process'},f.spawned[0].child);assert.equal(f.trace.length,count);
});
test('a failed ASR trace observer cannot interrupt the normal recognition event',t=>{
 const f=asrFixture(t);f.asr.start({always:true,trace:true});f.asr.on('speechTrace',()=>{throw Error('diagnostic observer unavailable');});
 assert.doesNotThrow(()=>f.asr.onMessage({t:'utterance',v:'确认原文'}));assert.deepEqual(f.utterances,['确认原文']);
});
function turns(trace){
 let at=0,next=0;const timers=new Map(),requests=[],remembered=[];
 const c=createVoiceTurns({now:()=>at,setTimer:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:at+delay});return id;},clearTimer:id=>timers.delete(id),onRequest:token=>requests.push(token),onInvalidate:()=>{},onRemember:text=>remembered.push(text),onTrace:trace});
 const advance=ms=>{const end=at+ms;for(;;){const entry=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;at=entry[1].at;timers.delete(entry[0]);entry[1].fn();}at=end;};
 c.partial('保留前段');c.final('保留前段。');advance(500);c.partial('继续后段');c.final('继续后段。');advance(3000);requests.at(-1).remember();
 return {text:c.snapshot().text,remembered};
}
test('turn traces contain only metadata and cannot alter merging or persistence even if the observer fails',()=>{
 const trace=[],plain=turns();assert.deepEqual(turns(value=>trace.push(sanitizeSpeechTrace(value))),plain);assert.deepEqual(turns(()=>{throw Error('diagnostic observer unavailable');}),plain);
 assert.deepEqual(plain.remembered,['保留前段。\n继续后段。']);assert(!JSON.stringify(trace).includes('保留'));assert(trace.some(value=>value.stage==='turn-remember'&&value.segments===2));
});
