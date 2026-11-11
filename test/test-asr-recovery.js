'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{asrRecovery}=require('../src/main/asr');
test('recurrent unconfirmed/VAD faults stop automatic microphone retries even after readiness and four seconds of capture',()=>{
 let failures=0;const outcomes=[];for(let i=0;i<3;i++){const result=asrRecovery({mode:'continuous',code:25,failures});failures=result.failures;outcomes.push(result);}
 assert.deepEqual(outcomes.map(r=>r.delayMs),[1200,1200,null]);assert.equal(outcomes[2].requiresOwner,true);
});
test('a normal recycle rearms promptly and clears earlier failure state',()=>{
 assert.deepEqual(asrRecovery({mode:'single',code:0,failures:8}),{failures:0,delayMs:150,requiresOwner:false});assert.equal(asrRecovery({mode:'continuous',code:0,failures:8}).failures,0);
});
test('other repeated faults back off within a fixed limit without inferring a permission failure',()=>{
 assert.equal(asrRecovery({mode:'continuous',code:24,failures:2}).delayMs,12000);assert.equal(asrRecovery({mode:'continuous',code:null,failures:100}).delayMs,60000);assert.equal(asrRecovery({mode:'continuous',code:24,failures:2}).requiresOwner,false);
});
test('the production host stops repeated unconfirmed recovery, rejects background restart and permits explicit owner resume',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../src/main/index.js'),'utf8'),callbacks={},retries=[],events=[],starts=[];
 const context={asr:{on:(name,callback)=>{callbacks[name]=callback;},running:false,start:opts=>starts.push(opts)},applyStatus:()=>{},voiceTurns:{recognizerStopped:()=>{}},quitting:false,screenLocked:false,storageBusy:false,speechDiagnostic:null,memory:null,listenRestartTimer:null,asrStatus:{},config:{load:()=>({memory:{enabled:false},voice:{alwaysListen:true}})},alwaysOn:true,asrMode:'continuous',asrFailStreak:0,asrRecoveryBlocked:false,asrRecovery,send:(...args)=>events.push(args),scheduleListenRestart:delay=>retries.push(delay),log:()=>{}};
 vm.runInNewContext(source.slice(source.indexOf('function mayRecoverListening()'),source.indexOf('/** Only empty/nonlinguistic')),context);
 const first=source.indexOf("    asr.on('exit', code => {"),last=source.indexOf('    if (connection.status().ready)',first);vm.runInNewContext(source.slice(first,last),context);
 for(let i=0;i<3;i++)callbacks.exit(25);
 assert.deepEqual(retries,[1200,1200]);assert.equal(context.alwaysOn,false);assert.equal(context.asrRecoveryBlocked,true);assert(events.some(([event,value])=>event==='asrError'&&value.message.includes('仍可打字')));
 Object.assign(context,{speechDiagnostic:null,storageBusy:false,systemPreferences:{getMediaAccessStatus:()=> 'granted'},config:{load:()=>({memory:{enabled:false},voice:{alwaysListen:true}})},screenLocked:false,memory:null,fs:{existsSync:()=>true},ASR_BIN:'/offline',asrStatus:{},asrOpts:()=>({always:true})});
 const start=source.indexOf('function startListen(reason)'),end=source.indexOf('function stopListen()',start);vm.runInNewContext(source.slice(start,end),context);
 context.startListen('heal');assert.equal(starts.length,0);context.startListen('user');assert.equal(starts.length,1);assert.equal(context.asrRecoveryBlocked,false);assert.equal(context.asrFailStreak,0);
 context.quitting=true;context.startListen('user');callbacks.exit(25);assert.equal(starts.length,1);assert.deepEqual(retries,[1200,1200]);
});
