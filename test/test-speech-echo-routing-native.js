'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');

test('native echo routing keeps stereo time order, bounded history and honest raw fallback without opening devices',t=>{
 const binary=process.env.WORKBUNNY_ASR_TEST_BIN;
 if(!binary)return t.skip('set WORKBUNNY_ASR_TEST_BIN after the coordinated build');
 const run=spawnSync(binary,['--self-test-echo-routing'],{encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stderr||run.stdout);
 const result=JSON.parse(run.stdout.trim());
 for(const key of ['echoRouting','timestampOrder','stereoReference','boundedRing','silentReferenceIsLive','staleReferenceBypasses','rawInputPreserved','conversionFrames','boundedCaptureHeadroom','headroomFlush','referenceFailureReleasesRaw'])assert.equal(result[key],true,key);
 assert.equal(result.recognizerStarted,false);assert.equal(result.devicesStarted,false);
});
