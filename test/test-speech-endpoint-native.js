'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
function run(t,flag){const binary=process.env.WORKBUNNY_ASR_TEST_BIN;if(!binary){t.skip('set WORKBUNNY_ASR_TEST_BIN after the coordinated native build');return;}return spawnSync(binary,[flag],{encoding:'utf8',timeout:5000});}
test('capture recovery separates stopped transport from live-capture VAD failure and asynchronously coalesces configuration notifications',t=>{
 const result=run(t,'--self-test-capture-recovery');if(!result)return;assert.equal(result.status,0,result.stderr||result.stdout);
 const rows=result.stdout.trim().split('\n').map(JSON.parse),summary=rows.find(row=>row.t==='selfTest');
 for(const key of ['captureRecovery','transportBeforeVad','liveCaptureVadFailure','coalesced','generationIsolation','lateJobCancelled','resumedCaptureRecheck','notificationAsync','pendingTextFeedback'])assert.equal(summary[key],true,key);
 assert.equal(summary.recognizerStarted,false);
 const receipts=rows.filter(row=>row.t==='capture-health');assert.equal(receipts.length,5);
 for(const row of receipts){assert.deepEqual(Object.keys(row).sort(),['activityAgeMs','at','captureAgeMs','captureEpoch','current','gen','pendingText','reason','t','textChars']);assert.equal(row.current,true);assert.equal(row.gen,7);for(const key of ['at','activityAgeMs','captureAgeMs'])assert(Number.isFinite(row[key])&&row[key]>=0);}
 assert.equal(receipts[0].reason,'transport-timeout');assert.equal(receipts[0].pendingText,false);assert.equal(receipts[1].reason,'vad-timeout');assert.equal(receipts[1].pendingText,true);
 assert(!rows.some(row=>['utterance','final','audioFinal','auth','ready','tap','capture'].includes(row.t)));
});
test('real helper recovery exits through the existing host retry contract and asks for repetition only for pending text',t=>{
 const binary=process.env.WORKBUNNY_ASR_TEST_BIN;if(!binary)return t.skip('requires the matching native test build');
 for(const reason of ['transport-timeout','configuration-changed','vad-timeout'])for(const pending of [false,true]){
  const result=spawnSync(binary,['--self-test-capture-abort','--fixture',reason,...(pending?['--pending-text']:[])],{encoding:'utf8',timeout:5000});assert.equal(result.status,reason==='vad-timeout'?25:22,result.stderr||result.stdout);
  const rows=result.stdout.trim().split('\n').map(JSON.parse),receipt=rows.find(row=>row.t==='capture-health'),error=rows.find(row=>row.t==='error');
  assert.equal(receipt.reason,reason);assert.equal(receipt.pendingText,pending);assert.equal(error.v.includes('重新说'),pending);
  assert.equal(rows.filter(row=>row.t==='retract').length,pending?1:0);assert.equal(rows.at(-1).t,'end');
  assert(!rows.some(row=>['utterance','final','audioFinal','auth','ready','tap','capture'].includes(row.t)));
 }
});
test('endpoint tri-state, silence, health, bounded duration and finalization callback order use pure monotonic fixtures',t=>{
 const result=run(t,'--self-test-speech-endpoint');if(!result)return;assert.equal(result.status,0,result.stderr||result.stdout);const row=JSON.parse(result.stdout);assert.equal(row.speechEndpoint,true);assert.equal(row.speechFinalizationBarrier,true);
 assert.equal(row.unchangedVolatileFinalization,true);assert.equal(row.finalizerFailureRejected,true);
 assert.equal(row.readyReceiptsSurviveTimeout,true);
});
test('actual native driver rechecks same-generation activity, stale timers, health and queued audio ownership',t=>{
 const result=run(t,'--self-test-speech-endpoint-driver');if(!result)return;assert.equal(result.status,0,result.stderr||result.stdout);const rows=result.stdout.trim().split('\n').map(JSON.parse),row=rows.find(value=>value.t==='selfTest');for(const key of ['speechEndpointDriver','sameGenerationRecheck','generationIsolation','healthRecheck','queuedEvidenceOwnership'])assert.equal(row[key],true,key);assert.equal(row.recognizerStarted,false);
});
test('activity metadata and asynchronous endpoint notifications preserve short eligible windows without stale jobs',t=>{
 const result=run(t,'--self-test-speech-endpoint-notifications');if(!result)return;assert.equal(result.status,0,result.stderr||result.stdout);
 const rows=result.stdout.trim().split('\n').map(JSON.parse),summary=rows.find(row=>row.t==='selfTest'),activity=rows.filter(row=>row.t==='activity');
 for(const key of ['speechEndpointNotifications','narrowWindow','coalesced','sameGenerationCancellation','generationIsolation','yieldBeforeHandler','closedLateJob'])assert.equal(summary[key],true,key);
 assert.equal(summary.recognizerStarted,false);assert.equal(activity.length,3);assert.deepEqual(activity.map(row=>row.gen),[50,50,51]);assert.equal(activity[1].state,'unknown');assert.equal(activity[1].quietSeconds,0);
 for(let i=0;i<activity.length;i++){const row=activity[i];assert.deepEqual(Object.keys(row).sort(),['at','emittedAt','gen','quietSeconds','seq','state','t']);assert(['active','quiet','unknown'].includes(row.state));assert(Number.isSafeInteger(row.seq));assert(row.emittedAt>=row.at);if(i)assert(row.seq>activity[i-1].seq);}
});
test('missing acoustic evidence exits with explicit unconfirmed feedback without submitting or starting recognition',t=>{
 const result=run(t,'--self-test-unconfirmed-abort');if(!result)return;assert.equal(result.status,25,result.stderr||result.stdout);const rows=result.stdout.trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(row=>row.t),['error','end']);assert.equal(rows[0].code,25);assert(!rows.some(row=>['auth','ready','utterance','final','tap','capture'].includes(row.t)));
});
test('actual empty-session publication waits for the barrier and emits its exact coverage once without a text utterance',t=>{
 const result=run(t,'--self-test-empty-audio-final');if(!result)return;assert.equal(result.status,0,result.stderr||result.stdout);
 const rows=result.stdout.trim().split('\n').map(JSON.parse),summary=rows.find(row=>row.t==='selfTest');
 for(const key of ['emptyAudioFinal','barrierRequired','exactCoverage','onceOnly'])assert.equal(summary[key],true,key);
 assert.equal(summary.recognizerStarted,false);assert.deepEqual(rows.filter(row=>row.t==='audioFinal'),[{t:'audioFinal',gen:7,coveredSeq:42}]);
 assert(!rows.some(row=>['auth','ready','utterance','tap','capture'].includes(row.t)));
});
test('empty checkpoints reject active, unknown, stale, old and unfed sources while fresh quiet drains exact coverage below 900ms',t=>{
 const result=run(t,'--self-test-empty-checkpoint');if(!result)return;assert.equal(result.status,0,result.stderr||result.stdout);
 const rows=result.stdout.trim().split('\n').map(JSON.parse),summary=rows.find(row=>row.t==='selfTest');
 for(const key of ['emptyCheckpoint','rejectsUncoveredActivity','freshQuietRechecked','inputStreamDrained','bothReceiptsRequired','coverageOnce'])assert.equal(summary[key],true,key);
 assert.equal(summary.recognizerStarted,false);assert.deepEqual(rows.filter(row=>row.t==='audioFinal'),[{t:'audioFinal',gen:7,coveredSeq:42}]);
 assert(!rows.some(row=>['auth','ready','utterance','tap','capture'].includes(row.t)));
 for(const row of rows.filter(row=>row.t==='final'))assert.equal(row.v,'');
});
test('empty checkpoint stream drain cannot fabricate audio coverage when the finalizer fails',t=>{
 const binary=process.env.WORKBUNNY_ASR_TEST_BIN;if(!binary)return t.skip('requires the matching native test build');
 const result=spawnSync(binary,['--self-test-empty-checkpoint','--fail-finalizer'],{encoding:'utf8',timeout:5000});assert.equal(result.status,24,result.stderr||result.stdout);
 const rows=result.stdout.trim().split('\n').map(JSON.parse);assert(!rows.some(row=>['audioFinal','utterance','final'].includes(row.t)));assert.equal(rows.find(row=>row.t==='error').code,24);
});
