'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');

test('sample-clock support authorizes sustained direct activity without editing transcribed words',t=>{
 if(process.platform!=='darwin')return t.skip('requires the Swift toolchain');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'workbunny-acoustic-evidence-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const fixture=path.join(directory,'main.swift'),binary=path.join(directory,'evidence');
 fs.writeFileSync(fixture,`
import Foundation
func check(_ value: @autoclosure () -> Bool, _ label: String) {
    guard value() else { fatalError(label) }
}
func frame(_ start: Double, _ end: Double, _ active: Bool = true) -> SpeechAcousticFrame {
    SpeechAcousticFrame(start: start, end: end, active: active)
}
var isolated = SpeechAcousticEvidence()
isolated.append(seconds: 0.5, capturedAt: 10.5, classified: [frame(0, 0.05), frame(0.05, 0.3, false), frame(0.3, 0.35)])
check(!isolated.supports(start: 0, end: 0.5), "isolated direct hits and hangover cannot be summed")
var sustained = SpeechAcousticEvidence()
sustained.append(seconds: 0.04, capturedAt: 10.04, classified: [frame(0, 0.04)])
check(!sustained.supports(start: 0, end: 0.04), "unfinished support stays provisional")
sustained.append(seconds: 0.16, capturedAt: 10.2, classified: [frame(0, 0.02), frame(0.02, 0.16, false)])
check(sustained.supports(start: 0, end: 0.06), "direct run spans hardware buffers")
check(!sustained.supports(start: 0.06, end: 0.2), "earlier speech cannot support a later range")
check(!sustained.supports(start: 0.05, end: 0.2), "a tiny overlap with earlier speech is insufficient")
check(!sustained.supports(start: -1, end: 0.1) && !sustained.supports(start: 0, end: .infinity), "invalid ranges")
check(!sustained.supports(start: 0, end: 0.21), "future input cannot be authorized")
check(!sustained.supports(start: 0, end: 0), "missing duration is unknown")
var fragmented = SpeechAcousticEvidence()
fragmented.append(seconds: 0.005, capturedAt: 20.005)
fragmented.append(seconds: 0.005, capturedAt: 20.01, classified: [frame(-0.005, 0.005)])
fragmented.append(seconds: 0.05, capturedAt: 20.06, classified: [frame(0, 0.05)])
check(fragmented.supports(start: 0, end: 0.06), "completed frame covers its earlier callback remainder")
let capture = fragmented.captureRange(start: 0, end: 0.06)!
check(abs(capture.0 - 20) < 0.000001 && abs(capture.1 - 20.06) < 0.000001, "capture clock is preserved")
var unknownGap = SpeechAcousticEvidence()
unknownGap.append(seconds: 0.03, capturedAt: 30.03, classified: [frame(0, 0.03)])
unknownGap.append(seconds: 0.01, capturedAt: 30.04)
unknownGap.append(seconds: 0.03, capturedAt: 30.07, classified: [frame(0, 0.03)])
check(!unknownGap.supports(start: 0, end: 0.07), "unclassified audio breaks direct continuity")
var nextGeneration = SpeechAcousticEvidence()
nextGeneration.append(seconds: 0.005, capturedAt: 40.005, classified: [frame(-0.005, 0.005)])
nextGeneration.append(seconds: 0.05, capturedAt: 40.055, classified: [frame(0, 0.05)])
check(!nextGeneration.supports(start: 0, end: 0.055), "previous generation samples cannot complete a current run")
var malformed = SpeechAcousticEvidence()
malformed.append(seconds: 0.1, capturedAt: 50.1, classified: [frame(.nan, 0.1), frame(0, 1), frame(-1, 0.1)])
check(!malformed.supports(start: 0, end: 0.1), "invalid classifications cannot authenticate input")
var transcript = SpeechTranscript()
transcript.accept(text: "fixture short", start: 0, end: 0.05, finalizedThrough: 0.05)
check(transcript.text == "fixture short" && transcript.confirmed, "support never rewrites system text")
print("acoustic support fixtures passed")
`);
 const compiled=spawnSync('xcrun',['swiftc',path.resolve('native/speech-transcript.swift'),fixture,'-o',binary],{encoding:'utf8',timeout:30000});
 assert.equal(compiled.status,0,compiled.stderr||compiled.stdout);
 const run=spawnSync(binary,[],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr||run.stdout);
 assert.match(run.stdout,/acoustic support fixtures passed/);
});
