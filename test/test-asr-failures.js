'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {Asr,asrRecovery,shouldNotifyAsrFailure}=require('../src/main/asr');

test('recognition failure metadata silently retires uncertain input without manufacturing final coverage',()=>{
 const asr=new Asr('/offline'),events=[],visible=[];asr.always=true;asr.traceRecognizer=4;
 for(const type of ['inputReset','audioFinal','utterance','final'])asr.on(type,()=>events.push(type));
 asr.on('error',(message,failure)=>{events.push('error');if(shouldNotifyAsrFailure(failure))visible.push(message);});
 asr.onMessage({t:'partial',v:'uncertain words',gen:7});
 asr.onMessage({t:'error',v:'语音定稿失败',kind:'recognition',reason:'finalizer',code:24,gen:7,fatal:true,text:'private-canary',pcm:[1,2]});
 assert.deepEqual(asr.lastFailure,{kind:'recognition',recognizer:4,reason:'finalizer',code:24,sourceGen:7,fatal:true});
 assert.equal(asr.lastError,'语音定稿失败');assert.equal(asr.partial,'');assert.equal(asr.stopping,true);
 assert.deepEqual(events,['inputReset','error']);assert.deepEqual(visible,[]);
 for(const t of ['partial','utterance','final','audioFinal'])asr.onMessage({t,v:'retired words',gen:7,coveredSeq:12});
 assert.deepEqual(events,['inputReset','error']);assert(!JSON.stringify(asr.lastFailure).includes('private-canary'));
});

test('notification policy uses failure ownership rather than code or localized wording',()=>{
 const asr=new Asr('/offline'),received=[];asr.on('error',(message,failure)=>received.push({message,failure,notify:shouldNotifyAsrFailure(failure)}));
 for(const kind of ['recognition','capture','permission','resources','startup','protocol','unknown'])
  asr.onMessage({t:'error',v:'语音定稿失败',kind,code:25});
 assert.deepEqual(received.map(row=>row.notify),[false,true,true,true,true,true,true]);
 for(const patch of [{},{kind:'private-canary'},{kind:null}])asr.onMessage({t:'error',v:'识别失败',code:24,...patch});
 for(const row of received.slice(-3)){assert.equal(row.failure.kind,'unknown');assert.equal(row.notify,true);}
 asr.onMessage({t:'error',kind:'recognition',code:1.5,reason:'private canary',gen:-1,fatal:'true'});
 assert.deepEqual(asr.lastFailure,{kind:'recognition',recognizer:0});assert.equal(shouldNotifyAsrFailure(),true);
});

test('fatal recognition failures reject late text in one-shot recording as well as continuous listening',()=>{
 for(const always of [false,true]){
  const asr=new Asr('/offline'),finals=[];asr.always=always;asr.on('error',()=>{});
  for(const type of ['final','utterance','audioFinal'])asr.on(type,value=>finals.push(value));
  asr.onMessage({t:'error',kind:'recognition',reason:'results',code:24,fatal:true});
  for(const t of ['final','utterance','audioFinal'])asr.onMessage({t,v:'uncertain words',gen:7,coveredSeq:12});
  assert.deepEqual(finals,[]);
 }
});

test('a terminal capture error preserves its visible category and does not reset an already retired capture twice',()=>{
 const asr=new Asr('/offline'),events=[];asr.always=true;
 asr.on('inputReset',()=>events.push('reset'));asr.on('error',(_message,failure)=>events.push(shouldNotifyAsrFailure(failure)));
 asr.onMessage({t:'capture-health',reason:'vad-timeout',gen:7,captureEpoch:1,textChars:0,current:true,pendingText:false});
 asr.onMessage({t:'error',kind:'capture',reason:'vad-timeout',code:25,fatal:true});
 assert.deepEqual(events,['reset',true]);assert.equal(asrRecovery({code:25,failures:2,failure:asr.lastFailure}).requiresOwner,true);
});

test('repeated recognition failures recover with a short capped backoff while capture retains its owner-intervention budget',()=>{
 let failures=0;const delays=[];
 for(let i=0;i<12;i++){
  const recovery=asrRecovery({mode:'continuous',code:25,failures,failure:{kind:'recognition'}});
  failures=recovery.failures;delays.push(recovery.delayMs);assert.equal(recovery.requiresOwner,false);
 }
 assert.deepEqual(delays.slice(0,5),[1200,2400,4800,8000,8000]);assert.equal(delays.at(-1),8000);
 for(const failure of [{kind:'capture'},undefined]){
  const recovery=asrRecovery({mode:'continuous',code:25,failures:2,failure});
  assert.equal(recovery.requiresOwner,true);assert.equal(recovery.delayMs,null);
 }
 assert.deepEqual(asrRecovery({mode:'continuous',code:0,failures:12,failure:{kind:'recognition'}}),{failures:0,delayMs:1200,requiresOwner:false});
});

test('restart clears prior failure metadata and a retired process cannot misclassify its replacement',t=>{
 const children=[],errors=[],asr=new Asr('/offline',()=>{},()=>{
  const p=new EventEmitter();Object.assign(p,{pid:children.length+1,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});children.push(p);return p;
 });
 asr.on('error',(message,failure)=>errors.push(failure));t.after(()=>asr.kill({discard:true}));
 const send=(p,kind)=>p.stdout.write(JSON.stringify({t:'error',v:'fixture error',kind,code:24,fatal:true})+'\n');
 asr.start({always:true});send(children[0],'recognition');assert.equal(asr.lastFailure.kind,'recognition');
 asr.kill({discard:true});asr.start({always:true});assert.equal(asr.lastFailure,null);assert.equal(asr.lastError,null);
 send(children[0],'recognition');assert.equal(asr.lastFailure,null);assert.equal(errors.length,1);
 send(children[1],'capture');assert.equal(asr.lastFailure.kind,'capture');assert.equal(errors.length,2);
});

test('the actual empty finalizer failure stays unconfirmed and reaches the host as quiet recognition recovery',t=>{
 const binary=process.env.WORKBUNNY_ASR_TEST_BIN;if(!binary)return t.skip('requires the matching native test build');
 const run=require('node:child_process').spawnSync(binary,['--self-test-empty-checkpoint','--fail-finalizer'],{encoding:'utf8',timeout:5000});
 assert.equal(run.status,24,run.stderr||run.stdout);const rows=run.stdout.trim().split('\n').map(JSON.parse);
 const asr=new Asr('/offline'),visible=[],finals=[];asr.always=true;
 asr.on('error',(message,failure)=>{if(shouldNotifyAsrFailure(failure))visible.push(message);});
 for(const type of ['audioFinal','utterance','final'])asr.on(type,value=>finals.push(value));
 for(const row of rows)asr.onMessage(row);
 assert.equal(asr.lastFailure.kind,'recognition');assert.equal(asr.lastFailure.reason,'finalizer');assert.equal(asr.lastFailure.fatal,true);
 assert.equal(asrRecovery({mode:'continuous',code:run.status,failures:20,failure:asr.lastFailure}).requiresOwner,false);
 assert.deepEqual(visible,[]);assert.deepEqual(finals,[]);
});
