'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
test('physical PCM streams retain sample clocks through batching, format changes, end-of-stream and gaps without opening devices',t=>{
 const binary=process.env.WORKBUNNY_ASR_TEST_BIN;
 if(!binary)return t.skip('set WORKBUNNY_ASR_TEST_BIN after the coordinated build');
 const run=spawnSync(binary,['--self-test-audio-pcm-stream'],{encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stderr||run.stdout);const result=JSON.parse(run.stdout.trim());
 for(const key of ['pcmStream','sampleClock','sameRateNoBuffering','integerLayouts','resampleContinuity','flushOnce','gapReset','highRates'])assert.equal(result[key],true,key);
 assert.equal(result.devicesStarted,false);assert.equal(result.recognizerStarted,false);
});
