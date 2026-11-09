'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {Asr,asrRecovery,createActivityClock}=require('../src/main/asr'),{createVoiceTurns}=require('../src/main/voice-turns'),{createAsrInputPipeline}=require('../src/main/asr-input-pipeline'),{SpeakerFilter}=require('../src/main/speaker-filter');
const source=fs.readFileSync(require.resolve('../src/main/index.js'),'utf8');
function fixture(t){
 let at=0,next=0,seq=0;const timers=new Map(),children=[],events=[],requests=[];
 const schedule=(fn,ms)=>{const id=++next;timers.set(id,{fn,at:at+ms});return id;},cancel=id=>timers.delete(id);
 const asr=new Asr('/offline/asr',()=>{},()=>{const p=new EventEmitter();Object.assign(p,{pid:children.length+1,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kills:[],kill(signal){this.kills.push(signal);}});children.push(p);return p;});
 const ctx={asr,asrMode:'continuous',asrRecovery,alwaysOn:false,asrFailStreak:0,asrRecoveryBlocked:false,listenRestartTimer:null,voiceInputOwner:null,
  contextEpoch:1,memory:{ready:true,generation:1},quitting:false,screenLocked:false,storageBusy:false,speechDiagnostic:null,asrStatus:{},
  config:{load:()=>({memory:{enabled:false},voice:{alwaysListen:true},asr:{wakeOnly:false}})},systemPreferences:{getMediaAccessStatus:()=> 'granted'},fs:{existsSync:()=>true},ASR_BIN:'/offline/asr',asrOpts:()=>({always:true}),
  Date:{now:()=>at},setTimeout:schedule,clearTimeout:cancel,send:(type,value)=>events.push({type,...value}),log:()=>{},speakerFilter:new SpeakerFilter(),lastLiveText:'',lastDialogueAt:0,
  speechTraceEnabled:false,traceSpeech:()=>{},voiceMetadata:()=>{},handleUtterance:(_text,token)=>requests.push(token),stopSpeaking:()=>{},pushHistory:()=>{},publishSpeakerStatus:()=>{},
  suppressEnrollmentFinal:false,speaking:false,speechGen:0,lastPartialLogAt:0,lastSpeakerStatusAt:0,recentEcho:()=>false,bargeInReady:()=>true,nameHit:()=>true,micPeak:0,micPeakAt:0,micQuietLoggedAt:0,
  require:name=>name==='./voice-turns'?{createVoiceTurns:options=>createVoiceTurns({...options,now:()=>at,setTimer:schedule,clearTimer:cancel})}:name==='./asr-input-pipeline'?{createAsrInputPipeline}:require(name)};
 ctx.applyStatus=value=>{ctx.asrStatus={...ctx.asrStatus,...value};};vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('function startListen(reason)'),source.indexOf('/** 本地小门槛')),ctx);
 vm.runInContext(source.slice(source.indexOf('function publishVoiceLive('),source.indexOf('// Private diagnostics use')),ctx);
 const turns=vm.runInContext('voiceTurns',ctx);
 vm.runInContext(source.slice(source.indexOf('    const asrInput='),source.indexOf("    asr.on('recycle'")),ctx);
 const first=source.indexOf("    asr.on('exit', code => {");vm.runInContext(source.slice(first,source.indexOf('    if (connection.status().ready)',first)),ctx);
 const clock=()=>{asr.activityClock=createActivityClock({wallNow:()=>at,monoNow:()=>at});seq=0;};
 ctx.startListen('user');clock();
 function send(message,p=asr.proc){p.stdout.write(JSON.stringify(message)+'\n');}
 function advance(ms){const end=at+ms;let loops=0;for(;;){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;if(++loops>10000)throw Error('unbounded host timers');const[id,timer]=due;at=timer.at;timers.delete(id);const old=asr.traceRecognizer;timer.fn();if(old!==asr.traceRecognizer)clock();}at=end;}
 t.after(()=>{ctx.quitting=true;turns.reset();asr.kill({discard:true});timers.clear();});
 return {ctx,asr,turns,children,events,requests,timers,send,advance,
  activity:(state,extra={})=>send({t:'activity',state,quietSeconds:state==='quiet'?3:0,at:at/1000,emittedAt:at/1000,seq:++seq,gen:1,...extra}),
  audioFinal:gen=>send({t:'audioFinal',gen,coveredSeq:seq})};
}
test('actual host retains one confirmed request after empty audio coverage near its deadline without reconnecting',t=>{
 const f=fixture(t),child=f.asr.proc;f.activity('active');f.send({t:'partial',v:'synthetic complete owner request'});
 f.advance(500);f.activity('active');f.send({t:'utterance',v:'synthetic complete owner request'});
 f.advance(500);f.activity('active',{gen:3});
 for(let i=0;i<54;i++){f.advance(100);f.activity('active',{gen:3});}
 for(let i=1;i<=12;i++){f.advance(100);f.activity('quiet',{gen:3,quietSeconds:i/10});}
 assert.equal(f.requests.length,0);f.audioFinal(3);f.advance(0);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'synthetic complete owner request');assert.equal(f.requests[0].canCommit(),true);
 for(let i=0;i<20;i++){f.advance(100);f.activity('quiet',{gen:5});}
 assert.equal(f.children.length,1);assert.equal(f.asr.proc,child);assert.deepEqual(child.kills,[]);assert.equal(f.ctx.asrFailStreak,0);
 assert.equal(f.requests.length,1);assert(!f.events.some(e=>e.type==='toast'));
});
test('the host keeps a late native final through quiet and empty coverage after the old text deadline without reconnecting or repeating inference',t=>{
 const f=fixture(t),child=f.asr.proc,text='complete owner request preserved across the two phases';f.activity('active');f.send({t:'partial',v:text,gen:1});
 f.advance(7200);f.activity('active');f.send({t:'utterance',v:text,gen:1});f.advance(100);f.activity('active',{gen:3});
 f.advance(850);f.activity('quiet',{gen:3,quietSeconds:.85});assert.equal(f.asr.proc,child);assert(f.turns.snapshot());assert.equal(f.requests.length,0);
 f.advance(200);f.activity('quiet',{gen:3,quietSeconds:1.05});f.audioFinal(3);
 for(let i=0;i<19;i++){f.advance(100);f.activity('quiet',{gen:5});}
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,text);assert.equal(f.requests[0].canCommit(),true);
 assert.equal(f.asr.proc,child);assert.deepEqual(child.kills,[]);assert.equal(f.ctx.asrFailStreak,0);assert(!f.events.some(event=>event.type==='toast'));
});
test('a late final with continuous successor activity reaches acoustic timeout and uses the existing bounded host recovery',t=>{
 const f=fixture(t),child=f.asr.proc;f.activity('active');f.send({t:'partial',v:'confirmed words waiting for quiet',gen:1});
 f.advance(7200);f.activity('active');f.send({t:'utterance',v:'confirmed words waiting for quiet',gen:1});
 for(let i=0;i<79;i++){f.advance(100);f.activity('active',{gen:3});}
 assert.equal(f.asr.proc,child);f.advance(100);assert.deepEqual(child.kills,['SIGKILL']);assert.equal(f.ctx.asrFailStreak,1);assert.equal(f.requests.length,0);
 assert(f.events.some(event=>event.type==='toast'&&/文字已定稿/.test(event.text)));
});
test('actual host confirmation timeout discards its child and late text/close cannot enter a replacement',t=>{
 const f=fixture(t),old=f.asr.proc;f.send({t:'partial',v:'unconfirmed synthetic instruction'});f.advance(8000);
 assert.deepEqual(old.kills,['SIGKILL']);assert.equal(f.ctx.asrFailStreak,1);assert.equal(f.asr.running,false);assert.equal(f.requests.length,0);
 f.send({t:'partial',v:'late synthetic revision'},old);f.send({t:'utterance',v:'late synthetic final'},old);old.emit('close',0,null);
 assert.equal(f.ctx.asrFailStreak,1);assert.equal(f.children.length,1);f.advance(1200);assert.equal(f.children.length,2);const current=f.asr.proc;
 f.send({t:'final',v:'later old final'},old);old.emit('close',25,null);assert.equal(f.asr.proc,current);assert.equal(f.requests.length,0);assert.equal(f.ctx.asrFailStreak,1);
 assert(f.events.some(e=>e.type==='asrLive'&&e.text===''));assert(f.events.some(e=>e.type==='toast'&&/文字/.test(e.text)));
});
test('three host deadlines stop automatic retry even when native finals and readiness arrive without usable acoustic confirmation',t=>{
 const f=fixture(t);
 for(let attempt=1;attempt<=3;attempt++){
  f.send({t:'ready'});f.send({t:'partial',v:'synthetic pending phrase '+attempt});f.send({t:'utterance',v:'synthetic pending phrase '+attempt});f.advance(8000);
  assert.equal(f.ctx.asrFailStreak,attempt);assert.equal(f.requests.length,0);if(attempt<3)f.advance(1200);
 }
 assert.equal(f.ctx.alwaysOn,false);assert.equal(f.ctx.asrRecoveryBlocked,true);f.advance(60000);assert.equal(f.children.length,3);assert(f.events.some(e=>e.type==='asrError'&&/仍可打字/.test(e.message)));
 f.ctx.startListen('heal');assert.equal(f.children.length,3);f.ctx.startListen('user');assert.equal(f.children.length,4);assert.equal(f.ctx.asrFailStreak,0);
});
test('admission alone does not clear earlier faults and recognizer-stopped feedback never recursively rearms',t=>{
 const f=fixture(t);f.ctx.asrFailStreak=2;f.activity('quiet');f.send({t:'partial',v:'confirmed synthetic phrase'});f.send({t:'utterance',v:'confirmed synthetic phrase'});
 for(let i=0;i<30;i++){f.advance(100);f.activity('quiet');}f.advance(0);assert.equal(f.requests.length,1);assert.equal(f.ctx.asrFailStreak,2);
 f.turns.reset();f.send({t:'partial',v:'another unconfirmed phrase'});const current=f.asr.proc;f.turns.recognizerStopped();assert.equal(f.asr.proc,current);assert.deepEqual(current.kills,[]);f.advance(10000);assert.equal(f.children.length,1);
});
test('three admitted turns whose effect gates never recover still exhaust the shared retry budget',t=>{
 const f=fixture(t);
 for(let attempt=1;attempt<=3;attempt++){
  f.activity('quiet');f.send({t:'partial',v:'synthetic admitted phrase '+attempt});f.send({t:'utterance',v:'synthetic admitted phrase '+attempt});
  for(let i=0;i<30;i++){f.advance(100);f.activity('quiet');}f.advance(0);assert.equal(f.requests.length,attempt);assert.equal(f.ctx.asrFailStreak,attempt-1);
  f.activity('unknown');void f.requests.at(-1).waitForCommit();f.advance(8000);assert.equal(f.ctx.asrFailStreak,attempt);if(attempt<3)f.advance(1200);
 }
 assert.equal(f.ctx.asrRecoveryBlocked,true);f.advance(60000);assert.equal(f.children.length,3);
 assert(f.events.some(e=>e.type==='toast'&&!/未提交交办/.test(e.text)&&/文字/.test(e.text)));
});
test('shutdown, lock, manual-off, diagnostic isolation and changed context never kill or restart a timeout owner',t=>{
 for(const change of [f=>{f.ctx.quitting=true;},f=>{f.ctx.screenLocked=true;},f=>{f.ctx.alwaysOn=false;},f=>{f.ctx.speechDiagnostic={blocked:true};},f=>{f.ctx.contextEpoch++;},f=>{f.ctx.memory.generation++;}]){
  const f=fixture(t),current=f.asr.proc;f.send({t:'partial',v:'pending synthetic phrase'});change(f);f.advance(12000);assert.equal(f.asr.proc,current);assert.deepEqual(current.kills,[]);assert.equal(f.children.length,1);assert.equal(f.ctx.asrFailStreak,0);
 }
});
test('a scheduled rearm rechecks context and a stale turn cannot kill a newer recognizer',t=>{
 const stale=fixture(t);stale.send({t:'partial',v:'pending synthetic phrase'});stale.advance(8000);stale.ctx.contextEpoch++;stale.advance(1200);assert.equal(stale.children.length,1);
 const f=fixture(t);f.send({t:'partial',v:'old synthetic phrase'});f.asr.kill({discard:true});f.asr.start({always:true});const current=f.asr.proc;f.advance(8000);assert.equal(f.asr.proc,current);assert.deepEqual(current.kills,[]);assert.equal(f.children.length,2);assert.equal(f.ctx.asrFailStreak,0);
});
test('real successor text after graceful recycle rebinds the retained turn to its current child without crossing context',t=>{
 const f=fixture(t);f.activity('quiet');f.send({t:'partial',v:'confirmed retained phrase'});f.send({t:'utterance',v:'confirmed retained phrase'});const turn=f.turns.snapshot().id;
 f.advance(100);f.asr.proc.emit('close',0,null);f.advance(1200);const current=f.asr.proc;assert.equal(f.children.length,2);
 f.activity('active');f.send({t:'partial',v:'successor continuation words'});assert.equal(f.turns.snapshot().id,turn);assert.equal(f.ctx.voiceInputOwner.proc,current);
 f.advance(8000);assert.deepEqual(current.kills,['SIGKILL']);assert.equal(f.ctx.asrFailStreak,1);f.send({t:'utterance',v:'late successor final'},current);assert.equal(f.turns.snapshot(),null);assert.equal(f.requests.length,0);f.advance(1200);assert.equal(f.children.length,3);
 const changed=fixture(t);changed.activity('quiet');changed.send({t:'partial',v:'old context phrase'});changed.send({t:'utterance',v:'old context phrase'});changed.advance(100);changed.asr.proc.emit('close',0,null);changed.advance(1200);const next=changed.asr.proc;
 changed.ctx.contextEpoch++;changed.activity('active');changed.send({t:'partial',v:'text after context changed'});changed.advance(8000);assert.deepEqual(next.kills,[]);assert.equal(changed.ctx.asrFailStreak,0);
});
test('a replacement with text but no new activity cannot inherit an old activity epoch to evade its deadline',t=>{
 const f=fixture(t);f.activity('active');f.send({t:'partial',v:'first pending synthetic phrase'});f.advance(8000);assert.equal(f.ctx.asrFailStreak,1);f.advance(1200);
 const current=f.asr.proc;f.send({t:'ready'});f.send({t:'capture'});f.send({t:'partial',v:'replacement phrase without activity'});assert.equal(f.ctx.voiceInputOwner.recognizer,2);f.advance(8000);
 assert.deepEqual(current.kills,['SIGKILL']);assert.equal(f.ctx.asrFailStreak,2);f.send({t:'utterance',v:'late unconfirmed replacement final'},current);assert.equal(f.requests.length,0);assert.equal(f.turns.snapshot(),null);
 f.advance(1200);f.send({t:'partial',v:'third missing activity phrase'});f.advance(8000);assert.equal(f.ctx.asrFailStreak,3);assert.equal(f.ctx.asrRecoveryBlocked,true);f.advance(60000);assert.equal(f.children.length,3);
});
