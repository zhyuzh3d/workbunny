'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const binary=process.env.WORKBUNNY_ASR_TEST_BIN||path.resolve('bin/asr');
test('a provisional single-word answer receives its native final and leaves eligibility to the host',t=>{
 if(!fs.existsSync(binary))return t.skip('native ASR is not built');
 const run=spawnSync(binary,['--self-test-short-final'],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr||run.stdout);
 const rows=run.stdout.trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(row=>row.t),['partial','utterance','selfTest']);
 assert.equal(rows[0].v,'好');assert.equal(rows[1].v,'好');assert.equal(rows[1].gen,7);assert.equal(rows[2].recognizerStarted,false);
});
test('native publication explicitly retracts withdrawn provisional words without fabricating an audio final',t=>{
 if(!fs.existsSync(binary))return t.skip('native ASR is not built');
 const run=spawnSync(binary,['--self-test-transcript-retract'],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr||run.stdout);
 const rows=run.stdout.trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(row=>row.t),['partial','retract','selfTest']);
 assert.equal(rows[0].gen,7);assert.equal(rows[1].gen,7);assert.equal(rows[1].v,undefined);assert.equal(rows[1].coveredSeq,undefined);assert.equal(rows[2].transcriptRetraction,true);assert.equal(rows[2].recognizerStarted,false);
});
test('recognized ranges require independent multi-frame speech support and preserve capture ownership',t=>{
 if(!fs.existsSync(binary))return t.skip('native ASR is not built');
 const run=spawnSync(binary,['--self-test-acoustic-evidence'],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr||run.stdout);
 const result=JSON.parse(run.stdout.trim());
 for(const key of ['acousticEvidence','quietRejected','unknownRejected','transientRejected','rangeOwnership','captureClock','realSpeechPreserved','partialFrameOwnership'])assert.equal(result[key],true,key);
 assert.equal(result.recognizerStarted,false);
});
test('native speech keeps final phrases, replaces volatile ranges and preserves audio across rollover without microphone access',t=>{
 if(!fs.existsSync(binary))return t.skip('native ASR is not built');
 const run=spawnSync(binary,['--self-test-transcript'],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr||run.stdout);
 const result=JSON.parse(run.stdout.trim());assert.equal(result.transcriptRanges,true);assert.equal(result.rolloverAudio,true);
});
test('optional native speech trace contains only fixed stages and finite numeric metadata without starting recognition',t=>{
 if(!fs.existsSync(binary))return t.skip('native ASR is not built');
 const run=spawnSync(binary,['--self-test-transcript','--speech-trace'],{encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stderr||run.stdout);assert(!run.stdout.includes('private-trace-canary'));
 const rows=run.stdout.trim().split('\n').map(JSON.parse),trace=rows.filter(row=>row.t==='speechTrace');
 const stages=['tap-capture','echo-output','analyzer-input','replay','session-start','result','finish-start','finish-return','results-end','utterance','recycle'];
 assert.deepEqual(trace.map(row=>row.stage),stages);assert.equal(rows.at(-1).t,'selfTest');
 const fields=new Set(['at','gen','currentGen','frames','rate','channels','measuredChannels','rms','peak','muted','aec','accepted','converted','conversionError','buffers','pendingFrames','pendingSeconds','directBuffers','directFrames','queuedBuffers','queuedFrames','replayedBuffers','replayedFrames','start','end','finalizedThrough','isFinal','textChars','combinedChars','removedSegments','touchesFinalized','confirmed','current','ok','utteranceCount']);
 for(const row of trace){for(const [key,value] of Object.entries(row)){
  if(['t','stage'].includes(key))continue;assert(fields.has(key),key);
  assert(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||Array.isArray(value)&&value.every(n=>typeof n==='number'&&Number.isFinite(n)),key);
 }assert.equal(row.gen,7);assert.equal(row.currentGen,0);assert.equal(row.queuedBuffers,2);assert.equal(row.queuedFrames,320);assert.equal(row.pendingFrames,320);assert.deepEqual(row.rms,[.25]);assert.deepEqual(row.peak,[.25]);}
 const result=trace.find(row=>row.stage==='result');assert.equal(result.removedSegments,1);assert.equal(result.touchesFinalized,true);
 assert.equal(rows.some(row=>['ready','auth','partial','utterance','tap','capture'].includes(row.t)),false);
});
