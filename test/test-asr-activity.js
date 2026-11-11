'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {Asr,createActivityClock}=require('../src/main/asr');
test('recognition audio ranges retain capture age even when finalization and pipe delivery are delayed',()=>{
 let wall=100000,mono=1000;const clock=createActivityClock({wallNow:()=>wall,monoNow:()=>mono});
 clock({state:'active',quietSeconds:0,at:10,emittedAt:10,gen:1,seq:1},2);
 wall+=5000;mono+=5000;
 assert.deepEqual(clock.range({gen:1,audioStartAt:9,audioEndAt:10,emittedAt:12},2),{recognizer:2,sourceGen:1,audioStartAtMs:99000,audioEndAtMs:100000});
 for(const patch of [{audioStartAt:NaN},{audioStartAt:11},{audioEndAt:20},{emittedAt:9}]){
  assert.deepEqual(clock.range({gen:1,audioStartAt:9,audioEndAt:10,emittedAt:12,...patch},2),{recognizer:2,sourceGen:1});
 }
});
test('ASR text events pass only validated range metadata and retain text compatibility',()=>{
 const asr=new Asr('/offline'),events=[];for(const type of ['partial','utterance','final'])asr.on(type,(text,meta)=>events.push({type,text,meta}));
 const now=Number(process.hrtime.bigint())/1e9;
 for(const type of ['partial','utterance','final'])asr.onMessage({t:type,v:'fixture',gen:7,audioStartAt:now-2,audioEndAt:now-1,emittedAt:now,private:'canary'});
 assert.equal(events.length,3);for(const row of events){assert.equal(row.text,'fixture');assert.equal(row.meta.sourceGen,7);assert(row.meta.audioEndAtMs-row.meta.audioStartAtMs>=999);assert(!JSON.stringify(row.meta).includes('canary'));}
});
test('normal finalization diagnostics distinguish completion receipts without retaining private data or logging silent rollovers',()=>{
 const logs=[],events=[],asr=new Asr('/offline',value=>logs.push(value));asr.traceRecognizer=4;asr.on('finalization',value=>events.push(value));
 const base={t:'finalization',stage:'committed',gen:7,at:10,inputSeconds:1,textChars:3,resultsConfirmed:false,ok:true,current:true};
 asr.onMessage({...base,text:'private-canary',pcm:[1,2],deviceUID:'private-canary',reason:'private-canary',arbitrary:3});
 assert.deepEqual(events[0],{stage:'committed',gen:7,recognizer:4,ok:true,current:true,at:10,inputSeconds:1,textChars:3,resultsConfirmed:false});
 assert.equal(logs.length,1);assert(!JSON.stringify(logs).includes('private-canary'));
 for(const patch of [{stage:'requested'},{stage:'results-ended'},{stage:'finalizer-returned'},{textChars:0},{current:false}])asr.onMessage({...base,...patch});
 assert.equal(logs.length,1,'ordinary silence and intermediate receipts do not flood the application log');
 asr.onMessage({...base,stage:'failed',ok:false,reason:'timeout',textChars:0});assert.equal(logs.length,2);assert.equal(events.at(-1).reason,'timeout');
 const count=events.length;for(const patch of [{stage:'private-canary'},{gen:-1},{gen:1.5},{ok:'yes'},{current:1}])asr.onMessage({...base,...patch});
 assert.equal(events.length,count);
 asr.onMessage({...base,at:Infinity,inputSeconds:NaN,textChars:1.5});assert.equal(events.at(-1).at,undefined);assert.equal(events.at(-1).inputSeconds,undefined);assert.equal(events.at(-1).textChars,undefined);
});
test('acoustic diagnostics preserve coverage limits and rejection counts without transcript, confidence values or per-word times',()=>{
 const events=[],logs=[],asr=new Asr('/offline',value=>logs.push(value));asr.traceRecognizer=2;asr.on('acousticSupport',value=>events.push(value));
 const base={t:'acoustic-support',gen:3,at:12,current:true,accepted:false,textChars:7,timedRuns:2,supportedRuns:1,unmappedRuns:0,confidenceRuns:2,granular:true,isFinal:true};
 asr.onMessage({...base,text:'private-canary',runs:[{text:'private-canary',start:1}],confidence:.1,pcm:[1,2]});
 assert.deepEqual(events[0],{recognizer:2,gen:3,textChars:7,timedRuns:2,supportedRuns:1,unmappedRuns:0,confidenceRuns:2,current:true,accepted:false,granular:true,isFinal:true,at:12});
 assert.equal(logs.length,1);assert(!JSON.stringify(logs).includes('private-canary'));
 asr.onMessage({...base,accepted:true,granular:false,isFinal:false,unmappedRuns:1});assert.equal(events.length,2);assert.equal(events[1].granular,false);assert.equal(logs.length,1);
 for(const patch of [{gen:-1},{timedRuns:1.5},{supportedRuns:Infinity},{unmappedRuns:'0'},{accepted:'true'},{granular:1},{isFinal:null}])asr.onMessage({...base,...patch});
 assert.equal(events.length,2);asr.onMessage({...base,at:NaN});assert.equal(events.at(-1).at,undefined);
});
test('capture recovery diagnostics distinguish transport and VAD health without private text or device identities',()=>{
 const logs=[],events=[],asr=new Asr('/offline',value=>logs.push(value));asr.traceRecognizer=3;asr.on('captureHealth',value=>events.push(value));
 const base={t:'capture-health',reason:'configuration-changed',gen:7,captureEpoch:2,textChars:0,current:true,pendingText:false,at:10,captureAgeMs:4200,activityAgeMs:4300};
 asr.onMessage({...base,text:'private-canary',deviceUID:'private-canary',deviceName:'private-canary'});
 assert.deepEqual(events[0],{reason:'configuration-changed',recognizer:3,gen:7,captureEpoch:2,textChars:0,current:true,pendingText:false,at:10,captureAgeMs:4200,activityAgeMs:4300});assert(!JSON.stringify(logs).includes('private-canary'));
 for(const reason of ['transport-timeout','vad-timeout'])asr.onMessage({...base,reason});assert.equal(events.length,3);
 for(const patch of [{reason:'private-canary'},{captureEpoch:-1},{gen:1.5},{current:1},{pendingText:'false'}])asr.onMessage({...base,...patch});assert.equal(events.length,3);
 asr.onMessage({...base,at:NaN,captureAgeMs:Infinity,activityAgeMs:-1});assert.equal(events.at(-1).at,undefined);assert.equal(events.at(-1).captureAgeMs,undefined);assert.equal(events.at(-1).activityAgeMs,undefined);
});
test('a claimed capture recovery retires queued business input before exit but preserves error and recovery notifications',()=>{
 const asr=new Asr('/offline'),events=[];asr.always=true;
 for(const type of ['inputReset','captureHealth','partial','utterance','error','audioFinal'])asr.on(type,()=>events.push(type));
 const health={t:'capture-health',reason:'configuration-changed',gen:7,captureEpoch:2,textChars:0,current:true,pendingText:false};
 asr.onMessage({...health,current:false});assert.equal(asr.stopping,false);assert.deepEqual(events,['captureHealth']);events.length=0;
 asr.onMessage({t:'partial',v:'before recovery',gen:7});asr.onMessage(health);
 for(const t of ['partial','utterance','final','activity','audioFinal','voiceFeatures'])asr.onMessage({t,v:'late retired words',gen:7,coveredSeq:1});
 asr.onMessage({t:'error',v:'音频输入已变化，正在重新连接',code:22});
 assert.equal(asr.stopping,true);assert.deepEqual(events,['partial','inputReset','captureHealth','error']);
});
test('native system candidates cross the host bridge unchanged for semantic interpretation',t=>{
 if(!process.env.WORKBUNNY_ASR_TEST_BIN)return t.skip('requires the matching native test build');
 const run=require('node:child_process').spawnSync(process.env.WORKBUNNY_ASR_TEST_BIN,['--self-test-timed-acoustic-support'],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr||run.stdout);
 const asr=new Asr('/offline'),rows=[];asr.traceRecognizer=1;asr.on('partial',text=>rows.push(['partial',text]));asr.on('utterance',text=>rows.push(['final',text]));for(const line of run.stdout.trim().split('\n'))asr.onMessage(JSON.parse(line));assert.deepEqual(rows,[['partial','fixture you'],['final','fixture you']]);
});
test('native empty checkpoint coverage crosses the normal bridge and seals a previously finalized request exactly once',async t=>{
 if(!process.env.WORKBUNNY_ASR_TEST_BIN)return t.skip('requires the matching native test build');
 const run=require('node:child_process').spawnSync(process.env.WORKBUNNY_ASR_TEST_BIN,['--self-test-empty-checkpoint'],{encoding:'utf8',timeout:5000});assert.equal(run.status,0,run.stderr||run.stdout);
 let now=1000;const requests=[],checkpoints=[],asr=new Asr('/offline');asr.traceRecognizer=1;
 const turns=require('../src/main/voice-turns').createVoiceTurns({requireActivity:true,now:()=>now,onRequest:token=>requests.push(token),onRemember:()=>{},onInvalidate:()=>{},onCheckpoint:meta=>checkpoints.push(meta)});t.after(()=>turns.reset());
 const pipeline=require('../src/main/asr-input-pipeline').createAsrInputPipeline({speakerFilter:{enrollment:null,acceptsText:()=>true},state:()=>({alwaysOn:true,speaking:false,asrMode:'continuous'}),recentEcho:()=>false,bargeInReady:()=>true,nameHit:()=>false,turns:()=>turns});asr.on('audioFinal',pipeline.audioFinal);
 turns.final('confirmed owner request');turns.activity({state:'active',quietSeconds:0,at:now,seq:41,recognizer:1,sourceGen:7});now+=400;
 turns.activity({state:'quiet',quietSeconds:.4,at:now,seq:42,recognizer:1,sourceGen:7});assert.equal(checkpoints.length,1);assert.equal(requests.length,0);
 for(const line of run.stdout.trim().split('\n'))asr.onMessage(JSON.parse(line));await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(requests.length,1);assert.equal(requests[0].canCommit(),true);assert.equal(requests[0].text,'confirmed owner request');
 for(const line of run.stdout.trim().split('\n'))asr.onMessage(JSON.parse(line));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(requests.length,1);
});
test('native withdrawals carry only validated source ownership and clear the recognizer partial',()=>{
 const asr=new Asr('/offline'),events=[];asr.traceRecognizer=2;asr.on('retract',meta=>events.push(meta));asr.partial='pending';
 for(const gen of [-1,1.5,null])asr.onMessage({t:'retract',gen});assert.equal(events.length,0);
 asr.onMessage({t:'retract',gen:3,private:'canary'});assert.equal(asr.partial,'');assert.deepEqual(events,[{recognizer:2,sourceGen:3}]);
});
test('checkpoint commands require the live recognizer, exact input generation and continuous listening ownership',()=>{
 const commands=[],asr=new Asr('/offline');asr.proc={stdin:{write:value=>commands.push(value)}};asr.always=true;asr.traceRecognizer=2;
 asr.onMessage({t:'partial',v:'pending',gen:3});assert.equal(asr.checkpoint({recognizer:2,sourceGen:3}),true);assert.deepEqual(commands,['checkpoint 3\n']);
 for(const meta of [{recognizer:1,sourceGen:3},{recognizer:2,sourceGen:1},{recognizer:2,sourceGen:3.5}])assert.equal(asr.checkpoint(meta),false);
 asr.stopping=true;assert.equal(asr.checkpoint({recognizer:2,sourceGen:3}),false);asr.stopping=false;asr.always=false;assert.equal(asr.checkpoint({recognizer:2,sourceGen:3}),false);
 assert.equal(commands.length,1);
});
test('activity projection retains observation and queued delivery age using a per-process minimum offset',()=>{
 let wall=100000,mono=1000;const clock=createActivityClock({wallNow:()=>wall,monoNow:()=>mono}),message={state:'quiet',quietSeconds:1,at:9.9,emittedAt:10,gen:1,seq:1};
 let value=clock(message,3);assert.equal(value.state,'quiet');assert.equal(value.at,99900);assert.equal(value.sourceGen,1);assert.equal(value.recognizer,3);
 wall+=800;mono+=800;value=clock({...message,seq:2,at:10.1,emittedAt:10.2},3);assert.equal(value.state,'unknown');assert.equal(value.quietSeconds,0);assert.equal(value.at,100100);
});
test('future, malformed, old sequence and old source generation cannot manufacture quiet',()=>{
 const clock=createActivityClock({wallNow:()=>100000,monoNow:()=>1000}),base={state:'quiet',quietSeconds:1,at:10,emittedAt:10,gen:2,seq:1};assert.equal(clock(base,1).state,'quiet');
 for(const patch of [{seq:1},{seq:2,gen:1},{seq:3,at:11},{seq:4,quietSeconds:-1},{seq:5,state:'other'},{seq:6,at:NaN},{seq:7,emittedAt:9}])assert.equal(clock({...base,...patch},1).state,'unknown');
});
test('ASR forwards activity without transcript logging and discarded process events cannot reach replacement',t=>{
 const children=[],logs=[],events=[],asr=new Asr('/offline',x=>logs.push(x),()=>{const p=new EventEmitter();Object.assign(p,{pid:children.length+1,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill(){}});children.push(p);return p;});
 asr.on('activity',value=>events.push(value));asr.on('error',()=>{});t.after(()=>asr.kill({discard:true}));
 const send=(p,seq)=>{const now=Number(process.hrtime.bigint())/1e9;p.stdout.write(JSON.stringify({t:'activity',state:'active',quietSeconds:0,at:now,emittedAt:now,seq,gen:1,extra:'private-canary'})+'\n');};
 asr.start({always:true});send(children[0],9);assert.equal(events.length,1);assert.equal(events[0].recognizer,1);asr.kill({discard:true});asr.start({always:true});send(children[0],10);assert.equal(events.length,1);
 send(children[1],1);assert.equal(events.length,2);assert.equal(events[1].recognizer,2);assert.equal(events[1].state,'active');assert(!JSON.stringify(logs).includes('private-canary'));assert(!JSON.stringify(events).includes('private-canary'));
});
test('ASR forwards only bounded native empty-final coverage metadata from its current process',t=>{
 const children=[],events=[],asr=new Asr('/offline',()=>{},()=>{const p=new EventEmitter();Object.assign(p,{pid:children.length+1,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill(){}});children.push(p);return p;});
 asr.on('audioFinal',value=>events.push(value));asr.on('error',()=>{});t.after(()=>asr.kill({discard:true}));asr.start({always:true});
 const send=(p,patch={})=>p.stdout.write(JSON.stringify({t:'audioFinal',gen:3,coveredSeq:12,private:'canary',...patch})+'\n');
 for(const patch of [{gen:-1},{gen:1.5},{coveredSeq:0},{coveredSeq:1.5}])send(children[0],patch);assert.equal(events.length,0);
 send(children[0]);assert.deepEqual(events,[{sourceGen:3,coveredSeq:12,recognizer:1}]);asr.kill({discard:true});asr.start({always:true});
 send(children[0]);assert.equal(events.length,1);send(children[1]);assert.equal(events[1].recognizer,2);assert(!JSON.stringify(events).includes('canary'));
});
