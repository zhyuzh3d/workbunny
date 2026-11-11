'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const binary=process.env.WORKBUNNY_ASR_TEST_BIN;
test('private native diagnostic fixtures never request microphone, assets or recognition',t=>{
 if(!binary)return t.skip('set WORKBUNNY_ASR_TEST_BIN to the freshly built diagnostic helper');
 assert(fs.existsSync(binary));
 const run=spawnSync(binary,['--self-test-speech-diagnostic'],{encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stderr||run.stdout);assert(!run.stdout.includes('private-diagnostic-canary'));
 const result=JSON.parse(run.stdout.trim());
 for(const key of ['speechDiagnostic','privatePermissions','noOverwrite','symlinkRejected','bufferOrder','planeOffsets','yieldClassification','caps','deadline','writeFailure','disabledNoFiles','echoOptIn','echoPlaneOffsets','sharedPcmCap'])assert.equal(result[key],true,key);
 assert.equal(result.recognizerStarted,false);
});
test('native diagnostic is opt in and is wired before permissions or language assets',()=>{
 const source=fs.readFileSync(path.resolve('native/asr.swift'),'utf8');
 assert(source.indexOf('if hasFlag("--self-test-speech-diagnostic")')<source.indexOf('if listMics {'));
 assert(source.indexOf('if hasFlag("--speech-diagnostic-dir")')<source.indexOf('Task { await run() }'));
 assert(source.includes('|| speechDiagnostic != nil'));
 assert(source.includes('if speechDiagnostic != nil { fail("私有语音诊断所需语言资源未安装'));
 assert(source.includes('reportingOptions: [.volatileResults, .fastResults]'));
 assert(source.includes('SpeechAnalyzer(modules: [detector, transcriber])'));
 assert(source.includes('SpeechDetector(detectionOptions: .init(sensitivityLevel: detectionLevel), reportResults: false)'));
 assert(source.includes('let freshActivity = endpointPolicy.observe('));
 assert(source.includes('if freshActivity && state == .active { speakerFeatures.speechDetected(true) }'));
});
