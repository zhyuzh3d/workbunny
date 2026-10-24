'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),vm=require('vm');
const {Asr}=require('../src/main/asr');const {createVoiceTurns}=require('../src/main/voice-turns');
function fixture(){let at=0,next=0;const timers=new Map(),requests=[],events=[];
 const turns=createVoiceTurns({now:()=>at,setTimer:(fn,ms)=>{const id=++next;timers.set(id,{at:at+ms,fn});return id;},clearTimer:id=>timers.delete(id),onRequest:t=>requests.push({at,turn:t}),onInvalidate:()=>{},onRemember:()=>{}});
 const asr=new Asr('/unused');const source=fs.readFileSync(path.join(__dirname,'../src/main/index.js'),'utf8');
 const handlers=source.slice(source.indexOf("    asr.on('partial', (t) => {"),source.indexOf("    asr.on('final', (t) => {"));
 vm.runInNewContext(handlers,{asr,voiceTurns:turns,Date:{now:()=>at},send:(type,data)=>events.push({type,...data}),log:()=>{},alwaysOn:true,speaking:false,lastPartialLogAt:0,lastLiveText:'',lastSpokeAt:0,echoLike:()=>false,micPeak:0,micPeakAt:0,micQuietLoggedAt:0});
 function advance(ms){const end=at+ms;while(true){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;at=due[1].at;timers.delete(due[0]);due[1].fn();}at=end;}
 function levels(ms,value=.08){for(let i=0;i<ms/200;i++){advance(200);asr.onMessage({t:'level',v:value});}}
 return{asr,turns,requests,events,advance,levels};}
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
