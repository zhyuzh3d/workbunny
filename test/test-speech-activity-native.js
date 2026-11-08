'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
test('vendored libfvad matches its pinned unmodified source and release notices',()=>{
 const root=path.resolve('native/vendor/libfvad'),source=JSON.parse(fs.readFileSync(path.join(root,'SOURCE.json')));
 assert.equal(source.commit,'532ab666c20d3cfda38bca63abbb0f152706c369');assert.equal(source.license,'BSD-3-Clause');
 for(const [name,expected]of Object.entries(source.files))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex'),expected,name);
 for(const name of ['LICENSE','AUTHORS','PATENTS','SOURCE.json'])assert.deepEqual(fs.readFileSync(path.resolve('licenses','libfvad-'+name)),fs.readFileSync(path.join(root,name)));
});
test('native activity observer has bounded frames, channel consensus and generation isolation without recognition',t=>{
 const binary=process.env.WORKBUNNY_ASR_TEST_BIN;if(!binary)return t.skip('set WORKBUNNY_ASR_TEST_BIN after the coordinated build');
 const run=spawnSync(binary,['--self-test-speech-activity'],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr||run.stdout);
 const result=JSON.parse(run.stdout.trim());assert.equal(result.speechActivity,true);assert.equal(result.mode,0);assert.equal(result.frameMs,10);assert.equal(result.recognizerStarted,false);
 for(const key of ['partialFrames','allChannels','generationIsolation','physicalStreamContinuity','gapReset','inputUnchanged','resourceBounds'])assert.equal(result[key],true,key);
});
