'use strict';
const actualReplyPolicy=()=>require('../src/main/reply-policy');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const source=fs.readFileSync(path.resolve('src/main/index.js'),'utf8'),actual=createRequire(path.resolve('src/main/index.js'));
function fixture({protocolFailure=false,sensitive=false}={}){
 const calls={model:0,remember:0,task:0,speak:0,chat:0,stop:0,aborts:0},metadata=[];
 const ctx={AbortController,Date,randomUUID:()=> 'offline-fixture',storageBusy:false,storageError:null,dialogueActions:{taskControl:()=>null,RULE:''},agent:null,desktop:null,dialogueReady:()=>true,
  config:{load:()=>({memory:{enabled:false},asr:{wakeOnly:false,judge:false}}),resolveLLM:()=>({transport:'offline-fake',apiKey:'fake',timeoutMs:100}),buildSystemPrompt:()=>''},currentScene:()=> 'life',contextEpoch:1,screenLocked:false,memory:null,
  activeThought:{abort:()=>calls.aborts++},busy:false,send:type=>{if(type==='chat')calls.chat++;},publishWebSources:()=>{},history:[],nowLine:()=>'',monitor:null,
  secretary:{contextSnapshot:()=>({text:'',sourceIds:[]}),dispatch:()=>{calls.task++;}},taskNotifications:{invalidate:()=>{}},presentedReplies:new Set(),activeAvatarPack:()=>false,
  avatarCatalog:{prompt:()=>[]},embodiment:{context:()=>({})},avatarList:()=>[],buildAvatarSnapshot:actual('./avatar-capability').buildAvatarSnapshot,lastInterruption:null,SELF_RULE:'',JUDGE_RULE:'',taskSupervision:{key:()=>'',context:()=>''},inputAdmission:{containsSecret:()=>false},log:()=>{},
  require:name=>name==='./dialogue-cognition'?{context:()=>({data:{consecutiveMisses:0},sourceIds:[]}),RULE:''}:name==='./perception'?{speech:()=>({}),keyboard:()=>({})}:name==='./sensitive-policy'?{hasProtectedContent:()=>sensitive}:actual(name),
  speak:()=>calls.speak++,llm:{},requestReply:async()=>{calls.model++;if(protocolFailure)throw Object.assign(Error('offline protocol failure'),{code:'E_REPLY_PROTOCOL',protocolStage:'json'});return {reply:{skipped:true}};},
  worthJudging:()=>true,recentEcho:()=>false,traceSpeech:()=>{},voiceMetadata:value=>metadata.push(value),speaking:false,nameHit:()=>false,turnT0:0,lastHeardAt:0,lastDialogueAt:0,quietUntil:0,autonomy:{pause:()=>{}},stopSpeaking:()=>calls.stop++};
 Object.assign(ctx,{voiceThoughts:new Map(),speechAbort:null,speechQueue:[],speechGen:0,activeAudioId:null,lastAcceptedOwnerAt:0,replyPolicy:actualReplyPolicy(),speechEcho:ctx.speechEcho||{rows:[]}});
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function committedVoice('),source.indexOf('/* ── 主动播报')),ctx);
 vm.runInContext('const QUIET_WORDS = '+source.match(/^const QUIET_WORDS = (.+);$/m)[1]+';\n'+source.slice(source.indexOf('async function handleUtterance('),source.indexOf('/** 主动要权限')),ctx);
 const token=committed=>({accepted:committed,id:1,isCurrent:()=>true,canCommit:()=>committed,waitForCommit:async()=>committed,remember:()=>calls.remember++,rememberConversation:()=>calls.remember++,skip(){}});
 return {ctx,calls,token,metadata};
}
test('unconfirmed voice cannot reach actual think model, memory, task, presentation or busy ownership',async()=>{
 const f=fixture();await f.ctx.think({userText:'未定稿的请求',voiceTurn:f.token(false)});
 assert.deepEqual(f.calls,{model:0,remember:0,task:0,speak:0,chat:0,stop:0,aborts:0});assert.equal(f.ctx.busy,false);
});
test('actual quiet branch waits for confirmed current voice before changing quiet or stopping speech',async()=>{
 const f=fixture();await f.ctx.handleUtterance('请先安静一下',f.token(false));assert.equal(f.ctx.quietUntil,0);assert.equal(f.calls.stop,0);assert.equal(f.calls.chat,0);
 await f.ctx.handleUtterance('请先安静一下',f.token(true));assert(f.ctx.quietUntil>Date.now());assert.equal(f.calls.stop,1);assert.equal(f.calls.chat,1);
});
test('a mixed stop-and-new-question utterance reaches dialogue without entering ten-minute quiet mode',async()=>{
 const f=fixture(),heard=[];f.ctx.think=async request=>{heard.push(request.userText);return {text:'fixture answer'};};
 const text='等一下先别讲故事了，你用一句话告诉我晚上吃点什么比较简单。';await f.ctx.handleUtterance(text,f.token(true));
 assert.equal(f.ctx.quietUntil,0);assert.deepEqual(heard,[text]);
});
test('actual protocol error cannot speak from uncommitted voice but confirmed failure still reports',async()=>{
 const f=fixture({protocolFailure:true});await f.ctx.think({userText:'未定稿',voiceTurn:f.token(false)});assert.equal(f.calls.model,0);assert.equal(f.calls.speak,0);assert.equal(f.calls.chat,0);
 await f.ctx.think({userText:'已定稿',voiceTurn:f.token(true)});assert.equal(f.calls.model,1);assert.equal(f.calls.speak,1);assert.equal(f.calls.chat,1);
});
test('entry commit wait is bounded, cancellable and rejects context changes without occupying busy',async()=>{
 const f=fixture(),pending={accepted:true,id:1,isCurrent:()=>true,canCommit:()=>false,waitForCommit:()=>new Promise(()=>{})};
 assert.equal(await f.ctx.committedVoice(pending,{timeoutMs:5}),false);assert.equal(f.ctx.busy,false);
 const controller=new AbortController(),cancelled=f.ctx.committedVoice(pending,{signal:controller.signal,timeoutMs:1000});controller.abort();assert.equal(await cancelled,false);
 let release;const waiting=f.ctx.committedVoice({accepted:true,id:1,isCurrent:()=>true,canCommit:()=>true,waitForCommit:()=>new Promise(resolve=>{release=resolve;})});f.ctx.contextEpoch++;release(true);assert.equal(await waiting,false);
});
function controlledToken(f){
 let current=true,ready=false;const waiters=new Set();
 const token={accepted:true,id:1,isCurrent:()=>current,canCommit:()=>current&&ready,
  waitForCommit:({signal}={})=>new Promise(resolve=>{const finish=value=>{waiters.delete(finish);signal?.removeEventListener('abort',abort);resolve(value);},abort=()=>finish(false);if(signal?.aborted||!current)return finish(false);if(ready)return finish(true);waiters.add(finish);signal?.addEventListener('abort',abort,{once:true});}),
  remember:()=>{assert(token.canCommit());f.calls.remember++;return{id:'offline-owner',value:{turnId:'offline:1'}};},skip(){},
  rememberConversation:()=>{assert(token.isCurrent());f.calls.remember++;return{id:'offline-owner',value:{turnId:'offline:1'}};},
  complete(){if(!current)return false;current=false;token.completed=true;for(const resolve of [...waiters])resolve(false);return true;},
  open(){ready=true;for(const resolve of [...waiters])resolve(true);},invalidate(){current=false;for(const resolve of [...waiters])resolve(false);f.ctx.activeThought?.abort();}};return token;
}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function completeReply(f){Object.assign(f.ctx,{llm:{extractTags:text=>({clean:text,motions:[],emos:[]})},presentConversation:text=>text,conversationText:text=>text,publishRecall:()=>{},scopePolicy:{rank:()=>0}});}
test('an ordinary accepted answer speaks while the acoustic effect gate is closed',async()=>{
 const f=fixture(),token=controlledToken(f);completeReply(f);f.ctx.requestReply=async()=>{f.calls.model++;return {reply:{text:'offline answer'}};};
 await f.ctx.think({userText:'sealed synthetic input',voiceTurn:token});assert.equal(f.calls.model,1);assert.equal(f.calls.remember,1);assert.equal(f.calls.chat,1);assert.equal(f.calls.speak,1);assert.equal(f.calls.task,0);
});
test('a semantic change or epoch replacement releases effect waiters and a late model cannot dispatch or write',async()=>{
 for(const replace of ['semantic','epoch']){
  const f=fixture(),token=controlledToken(f);completeReply(f);let finish;f.ctx.requestReply=()=>{f.calls.model++;return new Promise(resolve=>{finish=resolve;});};
  const pending=f.ctx.think({userText:'sealed synthetic input',voiceTurn:token});await flush();assert.equal(f.calls.model,1);
  if(replace==='semantic')token.invalidate();else{f.ctx.contextEpoch++;f.ctx.activeThought.abort();}finish({reply:{intent:{action:'agent'}}});await pending;
  assert.equal(f.calls.remember,0);assert.equal(f.calls.task,0);assert.equal(f.calls.chat,0);assert.equal(f.calls.speak,0);
 }
});
test('protocol failure for an admitted input reports and retires without waiting for background audio',async()=>{
 const f=fixture({protocolFailure:true}),token=controlledToken(f);await f.ctx.think({userText:'sealed synthetic input',voiceTurn:token});assert.equal(f.calls.model,1);assert.equal(f.calls.chat,1);assert.equal(f.calls.speak,1);assert.equal(token.completed,true);
});
function realTurns(f){
 const {createVoiceTurns}=require('../src/main/voice-turns');let at=0,next=0,seq=0,run;const timers=new Map(),errors=[];
 const turns=createVoiceTurns({requireActivity:true,now:()=>at,setTimer:(fn,ms)=>{const id=++next;timers.set(id,{fn,at:at+ms});return id;},clearTimer:id=>timers.delete(id),
  onRequest:token=>{run=f.ctx.think({userText:token.text,voiceTurn:token});return run;},onInvalidate:()=>f.ctx.activeThought?.abort(),
  onRemember:(_text,meta)=>{f.calls.remember++;return{id:'offline-owner',value:{turnId:meta.turnId}};},onError:(_message,metadata)=>errors.push(metadata)});
 const activity=state=>turns.activity({state,quietSeconds:state==='quiet'?3:0,at,seq:++seq,recognizer:1,sourceGen:1});
 const advance=async ms=>{const end=at+ms;for(;;){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;const[id,t]=due;at=t.at;timers.delete(id);t.fn();await flush();}at=end;};
 const admit=async()=>{activity('quiet');turns.partial('sealed synthetic request');turns.final('sealed synthetic request.');for(let i=0;i<30;i++){await advance(100);activity('quiet');}await advance(0);await flush();};
 return{turns,activity,advance,admit,errors,result:()=>run};
}
test('actual VoiceTurns unknown evidence preserves one inference and delivers its ordinary answer',async()=>{
 const f=fixture();completeReply(f);f.ctx.asrFailStreak=2;let finish,signal;f.ctx.requestReply=options=>{f.calls.model++;signal=options.request.signal;return new Promise(resolve=>{finish=resolve;});};
 const h=realTurns(f);await h.admit();assert.equal(f.calls.model,1);h.activity('unknown');finish({reply:{text:'offline recovered answer'}});await flush();
 assert.equal(signal.aborted,false);await h.result();assert.equal(f.calls.model,1);assert.equal(f.calls.remember,1);assert.equal(f.calls.chat,1);assert.equal(f.calls.speak,1);assert.equal(f.ctx.asrFailStreak,0);assert.equal(h.turns.snapshot(),null);
});
test('Task and explicit self/memory commands still wait for acoustic permission before any write or dispatch',async()=>{
 for(const action of ['agent','self_update','remember','learn_experience']){
  const f=fixture(),token=controlledToken(f);completeReply(f);f.ctx.requestReply=async()=>{f.calls.model++;return {reply:{intent:{action}}};};
  const pending=f.ctx.think({userText:'synthetic explicit operation',voiceTurn:token});await flush();
  assert.equal(f.calls.model,1);assert.equal(f.calls.remember,0);assert.equal(f.calls.task,0);assert.equal(f.calls.chat,0);assert.equal(f.calls.speak,0);
  token.invalidate();await pending;assert.equal(f.calls.remember,0);assert.equal(f.calls.task,0);
 }
});
test('sensitive spoken content retains its acoustic permission gate',async()=>{
 const f=fixture({sensitive:true}),token=controlledToken(f);completeReply(f);f.ctx.requestReply=async()=>({reply:{text:'synthetic protected answer'}});
 const pending=f.ctx.think({userText:'synthetic sensitive question',voiceTurn:token});await flush();assert.equal(f.calls.speak,0);assert.equal(f.calls.remember,0);
 token.open();await pending;assert.equal(f.calls.speak,1);assert.equal(f.calls.remember,1);assert.equal(token.completed,true);
});
test('skip, empty output and unavailable dialogue all retire the accepted input',async()=>{
 for(const mode of ['skip','empty','unavailable']){
  const f=fixture(),token=controlledToken(f);completeReply(f);
  f.ctx.requestReply=async()=>mode==='skip'?{reply:{skipped:true}}:{reply:{text:''}};
  if(mode==='unavailable'){f.ctx.storageBusy=true;f.ctx.connection={status:()=>({note:'offline unavailable'})};}
  await f.ctx.think({userText:'synthetic question',voiceTurn:token});assert.equal(token.completed,true);assert.equal(f.calls.speak,0);assert.equal(f.calls.task,0);
 }
});
test('actual new text revokes an admitted inference and an abort-ignoring late answer cannot enter effects',async()=>{
 const f=fixture();completeReply(f);let finish,signal;f.ctx.requestReply=options=>{f.calls.model++;signal=options.request.signal;return new Promise(resolve=>{finish=resolve;});};
 const h=realTurns(f);await h.admit();h.activity('active');assert.equal(signal.aborted,false);h.turns.partial('replacement synthetic instruction');assert.equal(signal.aborted,true);
 finish({reply:{intent:{action:'agent'}}});await h.result();assert.equal(f.calls.model,1);assert.equal(f.calls.remember,0);assert.equal(f.calls.task,0);assert.equal(f.calls.chat,0);assert.equal(f.calls.speak,0);h.turns.reset();
});
test('an actually submitted answer retires its token so later ambient activity cannot report an old pending effect',async()=>{
 const f=fixture();completeReply(f);f.ctx.requestReply=async()=>{f.calls.model++;return {reply:{text:'offline completed answer'}};};
 const h=realTurns(f);await h.admit();await h.result();assert.equal(f.calls.chat,1);assert.equal(f.calls.speak,1);assert.equal(h.turns.snapshot(),null);
 h.activity('active');await h.advance(9000);assert.equal(h.errors.length,0);assert.equal(h.turns.snapshot(),null);assert.equal(f.calls.model,1);
});
test('a completed control receipt uses an independent bounded fact scope after voice retirement and still checks privacy',async()=>{
 for(const changed of [false,true]){
  const f=fixture();completeReply(f);let owner,stored=0;const pendingOwner=new Promise(resolve=>{owner=resolve;});
  f.ctx.memory={generation:1,ready:true,cancelExtraction(){},scheduleExtraction(){},addMessageOnce:async()=>{stored++;}};
  f.ctx.dialogueActions.taskControl=()=>({action:'agent',request:{kind:'control',operation:'pause'}});f.ctx.secretary.dispatch=async()=>({ok:true,text:'offline paused receipt'});
  const token=controlledToken(f);token.open();token.remember=()=>pendingOwner;await f.ctx.think({userText:'synthetic pause',voiceTurn:token});assert.equal(token.completed,true);assert.equal(stored,0);
  if(changed)f.ctx.contextEpoch++;owner({id:'offline-owner',value:{turnId:'offline:1'}});await flush();assert.equal(stored,changed?0:1);
 }
});
test('Task admission metadata distinguishes a durable positive id from an unadmitted saved checkpoint',async()=>{
 for(const admitted of [false,true]){
  const f=fixture();completeReply(f);const token=controlledToken(f);token.open();f.ctx.requestReply=async()=>({reply:{intent:{action:'agent'}}});
  f.ctx.secretary.dispatch=async()=>({ok:admitted,id:'offline-task',saved:!admitted,text:'offline result'});await f.ctx.think({userText:'synthetic work',voiceTurn:token});
  assert.equal(f.metadata.find(row=>row.stage==='voice-task-admitted').taskAdmitted,admitted);assert(!JSON.stringify(f.metadata).includes('synthetic work'));
 }
});
test('the bounded control receipt cannot begin a write after its owner arrives past the deadline',async()=>{
 const f=fixture();completeReply(f);let owner,writes=0;const pendingOwner=new Promise(resolve=>{owner=resolve;});
 const originalRequire=f.ctx.require;f.ctx.require=name=>name==='./bounded-wait'?{createBoundedWait:options=>actual(name).createBoundedWait({...options,...(options.code==='E_CONTROL_RECEIPT_TIMEOUT'?{timeoutMs:5}:{})})}:originalRequire(name);
 f.ctx.memory={generation:1,ready:true,cancelExtraction(){},scheduleExtraction(){},addMessageOnce:async()=>{writes++;}};
 f.ctx.dialogueActions.taskControl=()=>({action:'agent',request:{kind:'control',operation:'pause'}});f.ctx.secretary.dispatch=async()=>({ok:true,text:'offline paused receipt'});
 const token=controlledToken(f);token.open();token.remember=()=>pendingOwner;await f.ctx.think({userText:'synthetic pause',voiceTurn:token});
 await new Promise(resolve=>setTimeout(resolve,15));owner({id:'offline-owner',value:{turnId:'offline:1'}});await flush();assert.equal(writes,0);assert.equal(token.completed,true);
});
test('a receipt deadline does not pretend to undo a write which already began',async()=>{
 const f=fixture();completeReply(f);let owner,finishWrite,started=0,finished=0;const pendingOwner=new Promise(resolve=>{owner=resolve;});
 const originalRequire=f.ctx.require;f.ctx.require=name=>name==='./bounded-wait'?{createBoundedWait:options=>actual(name).createBoundedWait({...options,...(options.code==='E_CONTROL_RECEIPT_TIMEOUT'?{timeoutMs:5}:{})})}:originalRequire(name);
 f.ctx.memory={generation:1,ready:true,cancelExtraction(){},scheduleExtraction(){},addMessageOnce:()=>{started++;return new Promise(resolve=>{finishWrite=()=>{finished++;resolve();};});}};
 f.ctx.dialogueActions.taskControl=()=>({action:'agent',request:{kind:'control',operation:'pause'}});f.ctx.secretary.dispatch=async()=>({ok:true,text:'offline paused receipt'});
 const token=controlledToken(f);token.open();token.remember=()=>pendingOwner;await f.ctx.think({userText:'synthetic pause',voiceTurn:token});owner({id:'offline-owner',value:{turnId:'offline:1'}});await flush();assert.equal(started,1);
 await new Promise(resolve=>setTimeout(resolve,15));finishWrite();await flush();assert.equal(started,1);assert.equal(finished,1);
});
test('a submitted protocol failure retires its input without claiming business success or renewing its retry budget',async()=>{
 const f=fixture({protocolFailure:true});f.ctx.asrFailStreak=2;const h=realTurns(f);await h.admit();await h.result();
 assert.equal(f.calls.chat,1);assert.equal(f.calls.speak,1);assert.equal(f.calls.task,0);assert.equal(f.ctx.asrFailStreak,2);assert.equal(h.turns.snapshot(),null);
 assert(f.metadata.some(row=>row.stage==='voice-model-end'&&row.ok===false));h.activity('active');await h.advance(9000);assert.equal(h.errors.length,0);assert.equal(f.calls.model,1);
});
test('the actual candidate interrupts old work immediately while ignore and empty decisions remain silent',async()=>{
 for(const reply of [{skipped:true},{text:''}]){
  const f=fixture();completeReply(f);f.ctx.speaking=true;f.ctx.requestReply=async options=>{f.calls.model++;const wire=JSON.parse(options.request.messages.at(-1).content);assert.equal(wire.character,'microphone-observation');assert.equal(wire.trust,'unconfirmed-speaker-and-intent');return {reply};};
  const token=controlledToken(f);let recognized=0;token.recognize=()=>{recognized++;return true;};const result=await f.ctx.think({userText:'you',voiceTurn:token,judge:true,perception:{sensor:'local.asr',channel:'microphone'}});
  assert.equal(result.ignored,true);assert.equal(f.calls.model,1);assert.equal(f.calls.aborts,1);assert.equal(f.calls.stop,1);assert.equal(f.calls.remember,0);assert.equal(f.calls.chat,0);assert.equal(f.calls.speak,0);assert.equal(recognized,0);assert.equal(f.ctx.activeThought,null);assert.equal(f.ctx.busy,false);assert.equal(token.completed,true);
 }
});

test('voice ownership still requires the same model decision after old output is interrupted',async()=>{
 const f=fixture();completeReply(f);const token=controlledToken(f);token.open();let recognized=0;token.recognize=()=>{recognized++;token.semanticAccepted=true;return true;};
 f.ctx.speechEcho.rows=[{text:'private-old-context',startedAt:1,contextEpoch:0},{text:'current-playback',startedAt:2,contextEpoch:1}];
 f.ctx.requestReply=async options=>{f.calls.model++;assert.equal(f.calls.stop,1);assert.equal(f.calls.aborts,1);assert.equal(f.calls.remember,0);assert.equal(options.request.inputExperience.revision,8);assert(options.request.messages[0].content.endsWith(options.request.inputExperience.instructions));const current=JSON.parse(options.request.messages.at(-1).content);assert.deepEqual(Array.from(current.voiceContext.recentPlayback,row=>row.text),['current-playback']);return {reply:{text:'a real reply',turnDisposition:'replace'}};};
 await f.ctx.think({userText:'a real short question',voiceTurn:token,judge:true,perception:{sensor:'local.asr',channel:'microphone'}});assert.equal(recognized,1);assert.equal(f.calls.model,1);assert.equal(f.calls.stop,1);assert.equal(f.calls.aborts,1);assert.equal(f.calls.remember,1);assert.equal(f.calls.speak,1);assert.equal(f.ctx.busy,false);
});

test('an ASR resume-shaped candidate does not enter the local Task fast path before semantic judgment',async()=>{
 const f=fixture();completeReply(f);f.ctx.dialogueActions.taskControl=()=>({action:'resume'});f.ctx.requestReply=async()=>{f.calls.model++;return {reply:{skipped:true}};};await f.ctx.think({userText:'continue',voiceTurn:controlledToken(f),judge:true});assert.equal(f.calls.model,1);assert.equal(f.calls.task,0);assert.equal(f.calls.remember,0);assert.equal(f.calls.stop,1);
});
test('an ignored successor resumes the retained voice input through a fresh response without reusing a cancelled result',async t=>{
 const f=fixture();completeReply(f);f.ctx.activeThought=null;let at=0,serial=0,seq=0;const timers=new Map(),runs=[],replies=[];
 f.ctx.requestReply=options=>{f.calls.model++;return new Promise(resolve=>replies.push({resolve,signal:options.request.signal,request:options.request}));};
 f.ctx.secretary.dispatch=async()=>{f.calls.task++;return {text:'fixture operation accepted',ok:true,id:'fixture-task'};};
 const turns=require('../src/main/voice-turns').createVoiceTurns({deferRecognition:true,requireActivity:true,now:()=>at,setTimer:(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:at+ms});return id;},clearTimer:id=>timers.delete(id),
  onRequest:token=>{const run=f.ctx.think({userText:token.text,voiceTurn:token,judge:true,perception:{sensor:'local.asr',channel:'microphone'}});runs.push(run);return run;},
  onInvalidate:token=>f.ctx.voiceThoughts.get(token)?.abort(),onRemember:()=>{f.calls.remember++;return {id:'fixture-owner',value:{turnId:'fixture'}};}});t.after(()=>turns.reset());
 const advance=async ms=>{const end=at+ms;for(;;){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;at=due[1].at;timers.delete(due[0]);due[1].fn();await flush();}at=end;};
 const activity=(state,gen)=>turns.activity({state,quietSeconds:state==='quiet'?1:0,at,seq:++seq,recognizer:1,sourceGen:gen});
 const quiet=async(ms,gen)=>{for(let i=0;i<ms;i+=100){await advance(100);activity('quiet',gen);}await advance(0);await flush();};
 activity('quiet',1);turns.final('a real requested operation',{recognizer:1,sourceGen:1});await quiet(400,1);assert.equal(replies.length,1);
 activity('active',3);f.ctx.interruptDialogue('voice');turns.partial('To',{recognizer:1,sourceGen:3});turns.final('To',{recognizer:1,sourceGen:3});await quiet(400,3);assert.equal(replies.length,2);assert.equal(replies[0].signal.aborted,true);
 const current=JSON.parse(replies[1].request.messages.at(-1).content);assert.equal(current.voiceContext.ongoingResponses.length,0);assert.deepEqual(Array.from(current.inputParts,row=>row.text),['a real requested operation','To']);assert.equal(current.inputParts[0].trust,'unconfirmed-speaker-and-intent');
 replies[0].resolve({reply:{intent:{action:'agent'}}});await flush();assert.equal(f.calls.task,0);assert.equal(f.calls.remember,0);
 replies[1].resolve({reply:{skipped:true}});await Promise.all(runs);await flush();assert.equal(replies.length,3);assert.equal(JSON.parse(replies[2].request.messages.at(-1).content).text,'a real requested operation');
 replies[2].resolve({reply:{intent:{action:'agent'}}});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.model,3);assert.equal(f.calls.task,1);assert.equal(f.calls.remember,1);assert.equal(f.ctx.voiceThoughts.size,0);assert.equal(f.ctx.busy,false);
});

test('candidate context cannot import the pending inference of another scene epoch or a revoked generation',async()=>{
 for(const state of [{epoch:0,generation:undefined},{epoch:1,generation:88}]){
  const f=fixture();completeReply(f);f.ctx.activeThought.dialogueWork={...state,phase:'interpreting',inputText:'private-pending-canary',semanticAccepted:true};
  f.ctx.requestReply=async options=>{f.calls.model++;const current=JSON.parse(options.request.messages.at(-1).content);assert.equal(current.voiceContext.ongoingResponses.length,0);assert(!JSON.stringify(options.request.messages).includes('private-pending-canary'));return {reply:{skipped:true}};};
  await f.ctx.think({userText:'synthetic candidate',judge:true,voiceTurn:controlledToken(f),perception:{sensor:'local.asr',channel:'microphone'}});assert.equal(f.calls.model,1);assert.equal(f.calls.stop,1);assert.equal(f.calls.remember,0);
 }
});
test('legacy ASR keep and missing disposition cannot keep cancelled work alive',async()=>{
 for(const disposition of ['keep',undefined]){
  const f=fixture();completeReply(f);const token=controlledToken(f);let replace;token.recognize=options=>{replace=options.replace;token.semanticAccepted=true;token.turnDisposition=replace?'replace':'keep';return true;};
  f.ctx.speaking=true;f.ctx.requestReply=async()=>{f.calls.model++;return {reply:{text:'a courtesy answer',...(disposition?{turnDisposition:disposition}:{})}};};
  await f.ctx.think({userText:'a genuine courtesy',judge:true,voiceTurn:token,perception:{sensor:'local.asr',channel:'microphone'}});assert.equal(replace,true);assert.equal(f.calls.aborts,1);assert.equal(f.calls.stop,1);assert.equal(f.calls.speak,1);assert.equal(f.calls.remember,1);assert.equal(f.ctx.busy,false);
 }
});

test('actual invalidation of a keep token by a newer partial aborts only that token and never stops the preserved response',()=>{
 const f=fixture(),invalidate=vm.runInContext('('+source.match(/^  onInvalidate: (.+),$/m)[1]+')',f.ctx);let aCancelled=0,bCancelled=0;
 const a={semanticAccepted:true,turnDisposition:'replace'},b={semanticAccepted:true,turnDisposition:'keep'};f.ctx.voiceThoughts.set(a,{abort:()=>aCancelled++});f.ctx.voiceThoughts.set(b,{abort:()=>bCancelled++});
 invalidate(b);assert.equal(bCancelled,1);assert.equal(aCancelled,0);assert.equal(f.calls.stop,0);invalidate(a);assert.equal(aCancelled,1);assert.equal(f.calls.stop,1);
});
test('accepted owner timing follows captured event time and cannot go backwards when an older kept inference records late',()=>{
 const ctx={Date:{now:()=>10000},lastAcceptedOwnerAt:0,history:[],memory:null,autonomy:null,currentScene:()=> 'life',visibleHere:()=>true,scopePolicy:{rank:()=>0},require:actual,log(){}};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function pushHistory('),source.indexOf('function publishRecall(')),ctx);
 ctx.pushHistory('user','newer voice',{occurredAt:9000,perception:{sensor:'local.asr',channel:'microphone'}});assert.equal(ctx.lastAcceptedOwnerAt,9000);
 ctx.pushHistory('user','older voice records late',{occurredAt:7000,perception:{sensor:'local.asr',channel:'microphone'}});assert.equal(ctx.lastAcceptedOwnerAt,9000);
 ctx.pushHistory('user','typed input',{perception:{sensor:'local.keyboard',channel:'keyboard'}});assert.equal(ctx.lastAcceptedOwnerAt,10000);
 ctx.pushHistory('user','stale voice',{occurredAt:9500,perception:{sensor:'local.asr',channel:'microphone'}});assert.equal(ctx.lastAcceptedOwnerAt,10000);
});
test('a legacy keep reply answers merged input once and the cancelled model can never deliver later',async t=>{
 const f=fixture();completeReply(f);f.ctx.activeThought=null;const replies=[],runs=[],spoken=[];let serial=0;const timers=new Map();const ready=async()=>{for(const [id,timer]of [...timers])if(timer.ms===0){timers.delete(id);timer.fn();}await flush();};
 f.ctx.speak=text=>{f.calls.speak++;spoken.push(text);};f.ctx.requestReply=options=>{f.calls.model++;return new Promise(resolve=>replies.push({resolve,signal:options.request.signal,request:options.request}));};
 const turns=require('../src/main/voice-turns').createVoiceTurns({deferRecognition:true,turnMs:0,pauseMs:0,now:()=>1000,setTimer:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id),
  onRequest:token=>{const run=f.ctx.think({userText:token.text,voiceTurn:token,judge:true,perception:{sensor:'local.asr',channel:'microphone'}});runs.push(run);return run;},
  onInvalidate:vm.runInContext('('+source.match(/^  onInvalidate: (.+),$/m)[1]+')',f.ctx),onRemember:(_text,meta)=>{f.calls.remember++;return{id:meta.turnId,value:{turnId:meta.turnId}};}});t.after(()=>turns.reset());
 turns.final('original story request',{recognizer:1,sourceGen:1});await ready();assert.equal(replies.length,1);
 turns.final('a genuine acknowledgement',{recognizer:1,sourceGen:3});await ready();assert.equal(replies.length,2);assert(replies[0].signal.aborted);assert.equal(JSON.parse(replies[1].request.messages.at(-1).content).text,'original story request\na genuine acknowledgement');
 replies[1].resolve({reply:{text:'one merged response',turnDisposition:'keep'}});await runs[1];assert.equal(f.ctx.busy,false);
 replies[0].resolve({reply:{text:'stale original story',turnDisposition:'keep'}});await runs[0];assert.deepEqual(spoken,['one merged response']);assert.equal(f.calls.remember,1);assert.equal(f.ctx.voiceThoughts.size,0);
});
