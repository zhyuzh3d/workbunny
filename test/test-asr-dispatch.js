'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),vm=require('vm');
const {SpeakerFilter}=require('../src/main/speaker-filter');
const {Asr}=require('../src/main/asr');const {createVoiceTurns}=require('../src/main/voice-turns');
function fixture(){let at=0,next=0;const timers=new Map(),requests=[],events=[];
 const turns=createVoiceTurns({now:()=>at,setTimer:(fn,ms)=>{const id=++next;timers.set(id,{at:at+ms,fn});return id;},clearTimer:id=>timers.delete(id),onRequest:t=>requests.push({at,turn:t}),onInvalidate:()=>{},onRemember:()=>{}});
 const asr=new Asr('/unused');const source=fs.readFileSync(path.join(__dirname,'../src/main/index.js'),'utf8');
 const handlers=source.slice(source.indexOf("    asr.on('partial', (t) => {"),source.indexOf("    asr.on('final', (t) => {"));
 const ctx={asr,voiceTurns:turns,speakerFilter:new SpeakerFilter(),suppressEnrollmentFinal:false,screenLocked:false,stopSpeaking:()=>{},publishSpeakerStatus:()=>{},lastSpeakerStatusAt:0,Date:{now:()=>at},send:(type,data)=>events.push({type,...data}),log:()=>{},alwaysOn:true,speaking:false,lastPartialLogAt:0,lastLiveText:'',lastSpokeAt:0,echoLike:()=>false,recentEcho:()=>false,micPeak:0,micPeakAt:0,micQuietLoggedAt:0};
 vm.runInNewContext(handlers,ctx);
 function advance(ms){const end=at+ms;while(true){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;at=due[1].at;timers.delete(due[0]);due[1].fn();}at=end;}
 function levels(ms,value=.08){for(let i=0;i<ms/200;i++){advance(200);asr.onMessage({t:'level',v:value});}}
 return{asr,turns,requests,events,advance,levels,ctx};}
test('real ASR handlers dispatch after one second despite ongoing microphone noise and confirm the final',async()=>{
 const f=fixture();f.asr.onMessage({t:'partial',v:'贝比你在吗'});f.levels(1200);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].at,1000);
 f.asr.onMessage({t:'utterance',v:'贝比你在吗？'});f.levels(4000);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].turn.isCurrent(),true);
 assert.equal(await f.requests[0].turn.waitForCommit(),true);
 assert.equal(f.events.filter(e=>e.type==='asrLevel').length,26);
});
test('loud input without new recognized words cannot cancel a valid response; new words do cancel it',()=>{
 const f=fixture();f.asr.onMessage({t:'partial',v:'贝比帮我整理'});f.levels(1200,.5);
 assert.equal(f.requests.length,1);const old=f.requests[0].turn;
 f.asr.onMessage({t:'utterance',v:'贝比帮我整理。'});f.levels(400,.8);assert.equal(old.isCurrent(),true);
 f.asr.onMessage({t:'partial',v:'再列出待办'});assert.equal(old.isCurrent(),false);
 f.levels(1000,.1);assert.equal(f.requests.length,2);assert.match(f.requests[1].turn.text,/整理。\n再列出待办/);
});
test('late final from disabled continuous listening never becomes a manual chat',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/main/index.js'),'utf8');
 const handler=source.slice(source.indexOf("    asr.on('final', (t) => {"),source.indexOf("    asr.on('recycle'"));
 const asr=new Asr('/unused'),requests=[],events=[],messages=[];
 const ctx={asr,speakerFilter:new SpeakerFilter(),suppressEnrollmentFinal:false,alwaysOn:false,speaking:false,handleUtterance:text=>requests.push(text),log:()=>{},send:(type,data)=>events.push({type,...data}),pushHistory:(...a)=>messages.push(a),think:q=>requests.push(q)};
 vm.runInNewContext(handler,ctx);
 asr.always=true;asr.emit('final','停用之前尚未提交的半句');
 assert.equal(requests.length,0);assert.equal(messages.length,0);assert.equal(events.length,0);
 asr.always=false;asr.emit('final','真正的手动录音');
 assert.equal(requests.length,1);assert.equal(messages.length,0);assert.equal(requests[0],'真正的手动录音','manual ASR goes through the same semantic admission as continuous listening');
});

test('non-owner evidence rejects new words without cancelling an already confirmed owner turn',()=>{
 const f=fixture(), vector=index=>Array.from({length:28},(_,i)=>Number(i===index));
 f.ctx.speakerFilter.load({schema:'local-speaker/v1',samples:[vector(0),vector(0),vector(0)],threshold:.9});f.ctx.speakerFilter.enabled=true;
 const feature=index=>({t:'voiceFeatures',vector:vector(index),frames:40,quality:.9,durationMs:400});
 f.asr.onMessage(feature(1));f.asr.onMessage({t:'partial',v:'其他人在聊天'});f.levels(1200);assert.equal(f.requests.length,0);
 f.asr.onMessage(feature(0));f.asr.onMessage({t:'partial',v:'贝比你在吗'});f.levels(1200);f.asr.onMessage({t:'utterance',v:'贝比你在吗？'});
 const owner=f.requests[0].turn;f.asr.onMessage(feature(1));assert(owner.isCurrent(),'a completed owner turn is not cancelled by another speaker');
 f.asr.onMessage({t:'partial',v:'旁人后来说话'});assert.equal(f.requests.length,1);
});
test('self echo is filtered throughout a long playback and its ending tail',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/main/index.js'),'utf8');let at=30000;
 const ctx={speaking:true,lastSpokeAt:0,recentSpeech:'这是已经播放了三十秒的长句，仍然不能把自己的声音当作用户插话。',Date:{now:()=>at}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function echoLike('),source.indexOf('let activeAudioId =')),ctx);
 assert(ctx.recentEcho('已经播放了三十秒的长句'));assert(!ctx.recentEcho('贝比请停下，我有个新想法'));
 ctx.speaking=false;ctx.lastSpokeAt=at;at+=2000;assert(ctx.recentEcho('仍然不能把自己的声音当作用户插话'));
 at+=1000;assert(!ctx.recentEcho('已经播放了三十秒的长句'),'a later owner repetition is admitted');
});
test('switching from one-shot recording to continuous listening replaces the recognizer generation',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/main/index.js'),'utf8');let killed=0,started=0;
 const asr={running:true,always:false,kill(opts){assert(opts.discard);killed++;this.running=false;},start(opts){assert(opts.always);started++;this.running=true;this.always=true;}};
 const ctx={asr,asrMode:'continuous',storageBusy:false,screenLocked:false,memory:{ready:true},alwaysOn:false,systemPreferences:{getMediaAccessStatus:()=> 'granted'},
  config:{load:()=>({memory:{enabled:true},voice:{alwaysListen:true}})},fs:{existsSync:()=>true},ASR_BIN:'fixture',send(){},log(){},Date,asrStatus:{},asrStartedAt:0,asrOpts:always=>({always})};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function startListen('),source.indexOf('function stopListen(')),ctx);
 ctx.startListen('test');assert.equal(killed,1);assert.equal(started,1);assert(ctx.alwaysOn);ctx.startListen('again');assert.equal(started,1);
});
