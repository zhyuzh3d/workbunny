'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {Asr,asrRecovery,shouldNotifyAsrFailure}=require('../src/main/asr');
const source=fs.readFileSync(require.resolve('../src/main/index.js'),'utf8');

test('the real host error observer ignores recognition failures but retains actual capture notifications',()=>{
 const events=[],statuses=[],asr=new Asr('/offline');
 const context={asr,speakerFilter:{enrollment:null},applyStatus:value=>statuses.push(value),log(){},send:(type,value)=>events.push({type,value}),shouldNotifyAsrFailure};
 const start=source.indexOf("    asr.on('error', (m, failure) => {");
 vm.runInNewContext(source.slice(start,source.indexOf("    asr.on('exit'",start)),context);
 asr.onMessage({t:'error',v:'empty finalizer failed',kind:'recognition',code:24,reason:'finalizer',fatal:true,gen:1});
 assert.deepEqual(events,[]);assert.equal(statuses.length,1);assert.equal(asr.partial,'');
 asr.inputFailed=false;asr.stopping=false;
 asr.onMessage({t:'error',v:'capture unavailable',kind:'capture',code:25,reason:'vad-timeout',fatal:true});
 assert.equal(events.length,1);assert.equal(events[0].type,'asrError');assert.equal(events[0].value.message,'capture unavailable');
});

test('the actual host silently retries recognition and starts a separate budget for capture faults',()=>{
 const events=[],delays=[];
 const context={asr:{running:false,lastFailure:{kind:'recognition',fatal:true,code:24}},config:{load:()=>({voice:{alwaysListen:true},memory:{enabled:false}})},
  quitting:false,screenLocked:false,storageBusy:false,speechDiagnostic:null,asrRecoveryBlocked:false,alwaysOn:true,asrMode:'continuous',asrFailStreak:0,
  listenRestartTimer:null,asrStatus:{},memory:null,asrRecovery,shouldNotifyAsrFailure,log(){},send:(...args)=>events.push(args),scheduleListenRestart:value=>delays.push(value)};
 vm.runInNewContext(source.slice(source.indexOf('function mayRecoverListening()'),source.indexOf('/** Only empty/nonlinguistic')),context);
 for(let i=0;i<8;i++)assert.equal(context.recoverListening(24),true);
 assert.deepEqual(delays,[1200,2400,4800,8000,8000,8000,8000,8000]);assert.deepEqual(events,[]);assert.equal(context.alwaysOn,true);
 context.asr.lastFailure={kind:'capture',fatal:true,code:25};context.recoverListening(25);
 assert.equal(context.asrFailStreak,1,'recognition failures do not consume the capture budget');assert.equal(context.alwaysOn,true);
 context.recoverListening(25);context.recoverListening(25);assert.equal(context.alwaysOn,false);
 assert(events.some(([type])=>type==='asrError'));
});

test('unconfirmed turn loss stays silent; only an accepted pending operation reports non-execution',()=>{
 const events=[],recovered=[],context={log(){},send:(...args)=>events.push(args),recoverVoiceConfirmation:value=>recovered.push(value)};
 vm.runInNewContext(source.slice(source.indexOf('function handleVoiceInputFailure('),source.indexOf('/** Only empty/nonlinguistic')),context);
 context.handleVoiceInputFailure('unconfirmed fragment discarded',{admitted:false,reason:'confirmation-timeout',effectWaiting:false});
 context.handleVoiceInputFailure('no semantic acceptance',{admitted:true,reason:'acoustic-timeout',effectWaiting:false});
 assert.deepEqual(events,[]);assert.equal(recovered.length,2);
 context.handleVoiceInputFailure('accepted operation was not executed',{reason:'commit-timeout',effectWaiting:true});
 assert.equal(events.length,1);assert.equal(events[0][0],'toast');
});

test('a fatal recognition error with legacy exit zero still follows quiet failure recovery',()=>{
 const outcome=asrRecovery({mode:'single',code:0,failures:4,failure:{kind:'recognition',code:6,fatal:true}});
 assert.equal(outcome.requiresOwner,false);assert.equal(outcome.failures,5);assert.equal(outcome.delayMs,8000);
});
