'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {SpeechDiagnostic,PrivateJournal,createBundle,MAX_SESSIONS}=require('../src/main/speech-diagnostic'),{SpeakerFilter}=require('../src/main/speaker-filter'),{createVoiceTurns}=require('../src/main/voice-turns'),{Asr}=require('../src/main/asr');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t,overrides={}){
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bunny-private-speech-'))),root=path.join(directory,'diagnostics'),processes=[],calls=[],logs=[];
 const controller=new SpeechDiagnostic({root,bin:'/offline/asr',options:()=>({always:true,lang:'zh-CN',silenceMs:950,maxSeconds:45,device:'unchanged',noMicAsk:true}),speakerFilter:new SpeakerFilter(),suspendNormal:()=>calls.push('normal-killed-and-discarded'),
  createTurns:opts=>createVoiceTurns({...opts,pauseMs:1,turnMs:5,finalWaitMs:300}),createAsr:(_bin,log)=>{const p=new EventEmitter();p.running=false;p.traceRecognizer=1;let seq=0;p.activity=(state='quiet')=>p.emit('activity',{state,quietSeconds:state==='quiet'?1:0,at:Date.now(),seq:++seq,recognizer:1,sourceGen:1});p.start=opts=>{calls.push('private-spawn');p.opts=opts;p.running=true;log('private-canary');p.emit('ready');p.activity('active');};p.kill=opts=>{p.killed=opts;p.running=false;};processes.push(p);return p;},...overrides});
 t.after(async()=>{await controller.finish('fixture-cleanup');await fsp.rm(directory,{recursive:true,force:true});});return {controller,root,processes,calls,logs,directory};
}
test('diagnostic defaults produce no directory, process or ordinary log, and invalid bounds cannot start',async t=>{
 const f=fixture(t);assert.equal(f.controller.active,false);assert(!fs.existsSync(f.root));assert.equal(f.processes.length,0);
 for(const durationMs of [0,20001,NaN,'20'])await assert.rejects(f.controller.start({durationMs}),/E_DIAGNOSTIC_OPTIONS/);
 assert(!fs.existsSync(f.root));assert.deepEqual(f.calls,[]);
});
test('isolated destructive transcript can only reach private filters/turn sinks, never a business receiver',async t=>{
 const f=fixture(t),text='立即执行这句测试文字并发送消息';await f.controller.start({durationMs:500,pcm:true});const p=f.processes[0];assert.deepEqual(f.calls,['normal-killed-and-discarded','private-spawn']);
 assert.equal(p.opts.device,'unchanged');assert.equal(p.opts.silenceMs,950);assert.equal(p.opts.maxSeconds,45);assert.equal(p.opts.diagnostic.pcm,true);assert(p.opts.diagnostic.durationMs<=500);
 p.opts.diagnostic.record({t:'utterance',v:text,gen:2});p.emit('partial',text);p.emit('utterance',text);p.activity();await delay(15);await f.controller.finish();
 const directory=await f.controller.directory(),events=(await fsp.readFile(path.join(directory,'host-events.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
 assert(events.some(row=>row.event==='host-native-receipt'&&row.message.v===text));assert(events.some(row=>row.event==='host-filter'&&row.text===text));assert(events.some(row=>row.event==='host-turn-live'&&row.text===text));assert(events.some(row=>row.event==='host-request-sink'&&row.text===text&&row.businessDispatch===false));
 assert(events.filter(row=>row.event==='host-request-sink').every(row=>row.businessDispatch===false));assert.deepEqual(events.map(row=>row.seq),events.map((_,i)=>i+1));assert.deepEqual(events.filter(row=>row.event==='host-activity').map(row=>row.activitySeq),[1,2]);assert.deepEqual(f.logs,[]);assert.equal(p.running,false);assert.deepEqual(p.killed,{discard:true});assert.equal(f.controller.blocked,true);assert.equal(f.processes.length,1);
 assert.equal((await fsp.stat(directory)).mode&0o777,0o700);for(const name of await fsp.readdir(directory))assert.equal((await fsp.stat(path.join(directory,name))).mode&0o777,0o600);
 await fsp.writeFile(path.join(directory,'.DS_Store'),'finder metadata',{mode:0o644});await f.controller.clear();assert(!fs.existsSync(directory));assert.equal(f.controller.status().id,null);f.controller.release();assert.equal(f.controller.blocked,false);
});
test('deadline kills only the private recognizer and late output cannot revive private turns',async t=>{
 const f=fixture(t,{createTurns:opts=>createVoiceTurns({...opts,pauseMs:1,turnMs:5,finalWaitMs:100})});await f.controller.start({durationMs:35});const p=f.processes[0];p.emit('partial','first private words');await delay(70);assert.equal(f.controller.active,false);assert.equal(f.controller.status().reason,'deadline');assert.equal(f.controller.blocked,true);assert.equal(p.running,false);
 const directory=await f.controller.directory(),before=await fsp.readFile(path.join(directory,'host-events.ndjson'),'utf8');p.emit('partial','late-canary');p.emit('utterance','late-canary');p.emit('ready');await delay(10);assert.equal(await fsp.readFile(path.join(directory,'host-events.ndjson'),'utf8'),before);
});
test('unconfirmed private speech closes its recognizer within the turn bound and rejects all late results',async t=>{
 const f=fixture(t,{createTurns:opts=>createVoiceTurns({...opts,pauseMs:1,turnMs:5,finalWaitMs:30})});await f.controller.start({durationMs:500});const p=f.processes[0];p.emit('partial','synthetic unconfirmed prefix');p.emit('utterance','synthetic unconfirmed prefix.');p.activity('active');
 await delay(70);assert.equal(f.controller.active,false);assert.equal(f.controller.status().reason,'voice-unconfirmed');assert.deepEqual(p.killed,{discard:true});
 const directory=await f.controller.directory(),file=path.join(directory,'host-events.ndjson'),before=await fsp.readFile(file,'utf8');
 p.emit('partial','late words');p.emit('utterance','late words.');p.activity();await delay(10);assert.equal(await fsp.readFile(file,'utf8'),before);
 const rows=before.trim().split('\n').map(JSON.parse);assert.equal(rows.filter(row=>row.event==='host-turn-unconfirmed'&&row.reason==='confirmation-timeout').length,1);assert(!rows.some(row=>row.event==='host-request-sink'));
});
test('an admitted private turn has a separate bounded commit wait and records the distinct timeout',async t=>{
 const f=fixture(t);await f.controller.start({durationMs:1200});const p=f.processes[0];p.emit('partial','synthetic admitted request');p.emit('utterance','synthetic admitted request.');p.activity();await delay(15);
 const file=path.join(f.controller.session.directory,'host-events.ndjson');await f.controller.session.writer.tail;
 assert.equal(fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.event==='host-request-sink').length,1);
 p.activity('unknown');await delay(350);assert.equal(f.controller.active,false);assert.equal(f.controller.status().reason,'voice-unconfirmed');assert.deepEqual(p.killed,{discard:true});
 const before=await fsp.readFile(file,'utf8'),rows=before.trim().split('\n').map(JSON.parse);
 assert.equal(rows.filter(row=>row.event==='host-request-sink').length,1);assert(rows.some(row=>row.event==='host-turn-unconfirmed'&&row.reason==='commit-timeout'&&row.admitted===true));
 p.emit('utterance','late synthetic result');await delay(5);assert.equal(await fsp.readFile(file,'utf8'),before);
});
test('private diagnostics require both final text and fresh acoustic quiet before their request sink',async t=>{
 const f=fixture(t);await f.controller.start({durationMs:500});const p=f.processes[0];p.emit('partial','private confirmation fixture');await delay(5);p.emit('utterance','private confirmation fixture');await delay(8);
 await f.controller.session.writer.tail;const file=path.join(f.controller.session.directory,'host-events.ndjson');assert(!fs.readFileSync(file,'utf8').includes('host-request-sink'));
 p.activity();await delay(12);await f.controller.finish();const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse),requests=rows.filter(row=>row.event==='host-request-sink');assert.equal(requests.length,1);assert.equal(requests[0].businessDispatch,false);assert(rows.some(row=>row.event==='host-activity'&&row.state==='quiet'));
});
test('stop during preparation never spawns or leaves an open journal',async t=>{
 let controller;const f=fixture(t,{suspendNormal:()=>{void controller.finish('owner-stop');}});controller=f.controller;await controller.start({durationMs:100});await delay(10);assert.equal(f.processes.length,0);assert.equal(controller.active,false);assert.equal((await fsp.readdir(f.root)).length,0);
});
test('a cancelled old preparation that rejects late cannot stop a newer diagnostic',async t=>{
 let reject,entered,calls=0;const ready=new Promise(resolve=>{entered=resolve;}),f=fixture(t,{createPrivateBundle:root=>++calls===1?new Promise((_resolve,rejectOld)=>{reject=rejectOld;entered();}):createBundle(root)});
 const old=f.controller.start({durationMs:1000}).catch(error=>error);await ready;await f.controller.finish('owner-stop');await f.controller.start({durationMs:1000});const newer=f.processes[0];reject(Error('late private failure'));
 assert.equal((await old).code,'E_DIAGNOSTIC_START');assert.equal(f.controller.active,true);assert.equal(newer.running,true);assert.equal(f.controller.status().phase,'capturing');
});
test('unavailable diagnostics do not suspend listening and duplicate starts do not create extra processes',async t=>{
 const f=fixture(t,{canStart:()=>false});await assert.rejects(f.controller.start(),/E_DIAGNOSTIC_UNAVAILABLE/);assert.deepEqual(f.calls,[]);assert(!fs.existsSync(f.root));
 const g=fixture(t);await g.controller.start({durationMs:100});await assert.rejects(g.controller.start(),/E_DIAGNOSTIC_ACTIVE/);assert.equal(g.processes.length,1);
});
test('private storage refuses symlinks, public directories, overwrite and uncontrolled cleanup',async t=>{
 const f=fixture(t),target=path.join(f.directory,'target');await fsp.mkdir(target,{mode:0o700});await fsp.symlink(target,f.root);await assert.rejects(createBundle(f.root),/E_DIAGNOSTIC_PRIVATE_DIRECTORY/);await fsp.unlink(f.root);await fsp.mkdir(f.root,{mode:0o755});await fsp.chmod(f.root,0o755);await assert.rejects(createBundle(f.root),/E_DIAGNOSTIC_PRIVATE_DIRECTORY/);await fsp.chmod(f.root,0o700);
 const file=path.join(f.directory,'events');await fsp.writeFile(file,'old',{mode:0o600});await assert.rejects(new PrivateJournal(file).init(),{code:'EEXIST'});assert.equal(await fsp.readFile(file,'utf8'),'old');
 await f.controller.start({durationMs:100});await f.controller.finish();const directory=await f.controller.directory();await fsp.symlink(file,path.join(directory,'unexpected'));await assert.rejects(f.controller.clear(),/E_DIAGNOSTIC_PATH/);assert.equal(await fsp.readFile(file,'utf8'),'old');
});
test('journal event, byte and pending queues are bounded; failing I/O remains private and releases caller',async t=>{
 const f=fixture(t),failures=[],writer=new PrivateJournal(path.join(f.directory,'small'),{maxBytes:128,maxPendingBytes:128,onFailure:r=>failures.push(r)});await writer.init();assert.equal(writer.record({text:'x'.repeat(200)}),false);await writer.close();assert.deepEqual(failures,['host-storage-limit']);assert((await fsp.stat(writer.file)).size<=128);
 let release;const held=new PrivateJournal('/fake/private',{maxPendingBytes:180,onFailure:r=>failures.push(r),open:async()=>({write:()=>new Promise(resolve=>{release=()=>resolve({bytesWritten:90});}),close:async()=>{}})});await held.init();held.record({text:'a'});held.record({text:'b'});held.record({text:'c'});assert(held.failure);await held.close(5);release?.();assert.equal(held.closed,true);
});
test('journal owns sequence and clock fields even when incoming metadata has the same names',async t=>{
 const f=fixture(t),writer=new PrivateJournal(path.join(f.directory,'reserved-fields'));await writer.init();
 const before=Date.now();writer.record({event:'metadata',seq:90,wallMs:0,monoNs:'0',activitySeq:90});writer.record({event:'next'});await writer.close();
 const rows=(await fsp.readFile(writer.file,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.map(row=>row.seq),[1,2]);assert(rows.every(row=>row.wallMs>=before&&BigInt(row.monoNs)>0n));assert.equal(rows[0].activitySeq,90);
});
test('bounded archive capacity never deletes an earlier diagnostic to admit a new capture',async t=>{
 const f=fixture(t);await fsp.mkdir(f.root,{mode:0o700});for(let i=0;i<MAX_SESSIONS;i++)await fsp.mkdir(path.join(f.root,'kept-'+i),{mode:0o700});await assert.rejects(createBundle(f.root),/E_DIAGNOSTIC_STORAGE_LIMIT/);assert.equal((await fsp.readdir(f.root)).length,MAX_SESSIONS);
});
test('ASR diagnostic arguments are opt in; even private warnings/stderr cannot enter ordinary logger',t=>{
 const logs=[],children=[],asr=new Asr('/fake/asr',value=>logs.push(value),(_bin,args)=>{const p=new EventEmitter();Object.assign(p,{pid:1,args,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill(){}});children.push(p);return p;});asr.on('error',()=>{});t.after(()=>asr.kill({discard:true}));
 asr.start({always:true});assert(!children[0].args.includes('--speech-diagnostic-dir'));assert(logs.length);asr.kill({discard:true});logs.length=0;const raw=[];
 asr.start({always:true,diagnostic:{directory:'/private/offline',durationMs:20,pcm:false,record:value=>raw.push(value)}});const p=children[1];assert(p.args.includes('--speech-diagnostic-dir'));assert(!p.args.includes('--speech-diagnostic-pcm'));p.stderr.write('private-diagnostic-canary');asr.onMessage({t:'warn',v:'private-diagnostic-canary'});asr.onMessage({t:'utterance',v:'private-diagnostic-canary'});assert.deepEqual(logs,[]);assert(raw.some(row=>row.v==='private-diagnostic-canary'));
});
test('production host only exposes trusted fixed actions and blocks normal listening during isolation',()=>{
 const source=fs.readFileSync(path.resolve('src/main/index.js'),'utf8'),start=source.slice(source.indexOf('function startListen(reason)'),source.indexOf('function stopListen()'));
 assert(start.indexOf('speechDiagnostic?.blocked')<start.indexOf('asr.start('));assert(source.includes("trustedCompanion(event,'settings')"));assert(source.includes("asr?.kill({discard:true});voiceTurns.reset()"));assert(source.includes("void speechDiagnostic?.finish('screen-lock')"));assert(source.includes("speechDiagnostic?.finish('process-exit')"));
});
