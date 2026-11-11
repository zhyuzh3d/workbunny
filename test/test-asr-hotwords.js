'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),{spawnSync}=require('node:child_process');
const {Asr}=require('../src/main/asr'),words=require('../src/main/hearing-hotwords');
const file=path.resolve('src/main/index.js'),source=fs.readFileSync(file,'utf8'),localRequire=require('node:module').createRequire(file);

test('production ASR options and launch keep real vocabulary separate from phonetic wake matching',t=>{
 const settings={buddy:{name:'芭尼'},asr:{wakeAliases:['小芭'],hotwords:['WorkBunny','Workbuddy','芭尼'],sensitivity:1}};
 const context={config:{load:()=>settings},speechTraceEnabled:false,require:localRequire};
 vm.runInNewContext(source.slice(source.indexOf('function asrOpts('),source.indexOf('function startListen(')),context);
 const options=context.asrOpts(true),children=[];
 const asr=new Asr('/fixture/asr',()=>{},(_bin,args)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};child.args=args;children.push(child);return child;
 });
 t.after(()=>asr.kill({discard:true}));asr.start(options);
 const args=children[0].args,value=flag=>JSON.parse(args[args.indexOf(flag)+1]);
 assert.deepEqual(value('--wake-names'),['芭尼','小芭']);
 assert.deepEqual(value('--context-strings'),['芭尼','小芭','WorkBunny','Workbuddy']);
 assert(!value('--context-strings').includes('把你'));
 settings.asr.hotwords = Array.from({length:510},(_,index)=>'术语'+index);
 const large = context.asrOpts(true);
 assert.equal(words.effective(settings).length, 512);
 assert.equal(large.contextualStrings.length, 100);
 assert.deepEqual(large.contextualStrings.slice(0,2), ['芭尼','小芭']);
});

test('updating vocabulary queues the exact list without discarding partials or restarting capture',t=>{
 let child,written='',kills=0,resets=0;
 const asr=new Asr('/fixture/asr',()=>{},()=>{
  child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.stdin.on('data',chunk=>written+=chunk);child.kill=()=>kills++;return child;
 });
 t.after(()=>asr.kill({discard:true}));asr.on('inputReset',()=>resets++);asr.start({always:true,contextualStrings:['芭尼']});
 asr.onMessage({t:'partial',v:'我还在说'});const before=asr.proc;
 assert.deepEqual(asr.updateContext(['芭尼','WorkBunny']),{queued:true,nextSegment:true});
 assert.equal(asr.proc,before);assert.equal(asr.partial,'我还在说');assert.equal(resets,0);assert.equal(kills,0);
 assert.equal(written,'context ["芭尼","WorkBunny"]\n');
 asr.onMessage({t:'context',stage:'queued',revision:1,count:2});assert.equal(asr.contextReceipt.stage,'queued');
 asr.onMessage({t:'context',stage:'submitted',revision:1,count:2,gen:3});assert.equal(asr.contextReceipt.sourceGen,3);
 const receipt=asr.contextReceipt;asr.onMessage({t:'context',stage:'submitted',revision:1,count:101});assert.equal(asr.contextReceipt,receipt);
 asr.onMessage({t:'context',stage:'submitted',revision:0,count:1,gen:1});assert.equal(asr.contextReceipt,receipt,'a late old context receipt cannot overwrite a newer update');
 asr.kill({discard:true});assert.deepEqual(asr.updateContext(['芭尼']),{queued:false,nextStart:true});
});

test('the main hotword service checks cancellation and broadcasts only actual saves',()=>{
 let settings={buddy:{name:'芭尼'},asr:{wakeAliases:[],hotwords:['WorkBunny','Workbuddy']}},saved=0,broadcasts=0,updates=[];
 const config={load:()=>settings,save:patch=>{saved++;settings={...settings,asr:{...settings.asr,...patch.asr}};return settings;}};
 const context={config,require:localRequire,storageBusy:false,asr:{updateContext:value=>{updates.push(value);return {queued:true,nextSegment:true};}},sendConfig:()=>broadcasts++};
 vm.runInNewContext(source.slice(source.indexOf('function hearingHotwordService('),source.indexOf('function asrOpts(')),context);
 const service=context.hearingHotwordService(),request={expectedRevision:service.read().revision,ops:[{op:'add',word:'停止'}]};
 assert.throws(()=>service.update(request,{isCurrent:()=>false}),{dispatched:false});assert.equal(saved,0);
 const result=service.update(request);assert.equal(result.saved,true);assert.equal(result.runtime.nextSegment,true);assert.equal(saved,1);assert.equal(broadcasts,1);
 assert.deepEqual(updates[0],['芭尼','WorkBunny','Workbuddy','停止']);
 assert.throws(()=>service.update(request),/最新版本/);assert.equal(saved,1);
 const same=service.update({...request,expectedRevision:service.read().revision});assert.equal(same.changed,false);assert.equal(broadcasts,1);
 settings.asr.hotwords=Array.from({length:510},(_,index)=>'术语'+index);
 const expanded=service.update({expectedRevision:service.read().revision,ops:[{op:'add',word:'罕见专有词'}]});
 assert.equal(expanded.snapshot.effective.length,512);
 assert.equal(updates.at(-1).length,100);
});

test('native vocabulary changes leave the current snapshot intact and apply to the next snapshot',t=>{
 if(process.platform!=='darwin')return t.skip('requires Swift');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-speech-context-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const fixture=path.join(directory,'main.swift'),binary=path.join(directory,'context');
 fs.writeFileSync(fixture,`import Foundation
let context=SpeechContextStrings(arguments:["probe","--wake-names","[\\"Bunny\\"]"])
let first=context.snapshot()
precondition(first.strings == ["Bunny"] && !first.strings.contains("把你"))
let second=context.replace(json:"[\\"芭尼\\",\\"WorkBunny\\",\\"workbunny\\"]")!
precondition(second.strings == ["芭尼","WorkBunny"] && second.revision == 1)
precondition(first.strings == ["Bunny"])
precondition(context.replace(json:"[]")!.strings.isEmpty)
precondition(context.replace(json:"[1]") == nil)
precondition(context.replace(json:"[\\"a\\\\nb\\"]") == nil)
precondition(context.snapshot().strings.isEmpty)
let explicit=SpeechContextStrings(arguments:["probe","--wake-names","[\\"Bunny\\"]","--context-strings","[]"])
precondition(explicit.snapshot().strings.isEmpty)
print("native context passed")
`);
 const build=spawnSync('xcrun',['swiftc','native/speech-context.swift',fixture,'-o',binary],{encoding:'utf8',timeout:30000});assert.equal(build.status,0,build.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/context passed/);
});
