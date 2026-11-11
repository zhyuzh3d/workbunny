'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('only the exact empty quiet VAD rejection settles results; successful finalizer remains mandatory',t=>{
 if(process.platform!=='darwin')return t.skip('requires Swift');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-empty-rejection-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'main.swift'),`
import Foundation
func check(_ x: Bool){if !x {fatalError("empty rejection boundary")}}
func error(_ domain: String="SFSpeechErrorDomain",_ code: Int=1,_ reason: String="RecogRejected") -> NSError {NSError(domain:domain,code:code,userInfo:[NSLocalizedDescriptionKey:reason])}
func accepted(_ e: Error=error(),detector: Bool=true,current: Bool=true,quiet: Bool=true,requested: Bool=true,seconds: Double=1,hadText: Bool=false,empty: Bool=true,valid: Bool=true)->Bool {
 isEmptySpeechRejection(e,detectorEnabled:detector,current:current,endingQuiet:quiet,requested:requested,inputSeconds:seconds,everHadText:hadText,textEmpty:empty,validRevisions:valid)
}
check(accepted());check(!accepted(error("other")));check(!accepted(error("SFSpeechErrorDomain",2)))
check(!accepted(error("SFSpeechErrorDomain",1,"internal failure")));check(!accepted(error("SFSpeechErrorDomain",1,"RecogRejected ")))
check(!accepted(current:false));check(!accepted(quiet:false));check(!accepted(requested:false));check(!accepted(seconds:0));check(!accepted(hadText:true));check(!accepted(empty:false));check(!accepted(valid:false))
check(!accepted(detector:false))
for first in [true,false] {
 var b=SpeechFinalizationBarrier(generation:7);check(b.request(at:1,generation:7))
 if first {check(b.resultsEnded(confirmed:true,text:"",generation:7))} else {check(b.finalizerSucceeded(generation:7))}
 check(b.claim(generation:7)==nil)
 if first {check(b.finalizerSucceeded(generation:7))} else {check(b.resultsEnded(confirmed:true,text:"",generation:7))}
 check(b.claim(generation:7)=="");check(b.claim(generation:7)==nil)
}
for failure in [SpeechFinalizationBarrier.Failure.finalizer,.timeout] {
 var b=SpeechFinalizationBarrier(generation:7);check(b.request(at:1,generation:7));check(b.resultsEnded(confirmed:true,text:"",generation:7));b.fail(failure,generation:7);check(b.claim(generation:7)==nil)
}
print("empty rejection boundaries passed")
`);
 const build=spawnSync('xcrun',['swiftc','native/speech-endpoint.swift',path.join(dir,'main.swift'),'-o',path.join(dir,'fixture')],{encoding:'utf8',timeout:30000});assert.equal(build.status,0,build.stderr);
 const run=spawnSync(path.join(dir,'fixture'),[],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/boundaries passed/);
});
