'use strict';
// An opt-in, local-only receiver. No dialogue, task, history or model module is
// reachable from this receiver. The ordinary recognizer is suspended first.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {Asr}=require('./asr');
const {createVoiceTurns,meaningful}=require('./voice-turns');
const MAX_MS=20000,MAX_HOST_BYTES=2*1024*1024,MAX_PENDING_BYTES=256*1024,MAX_SESSIONS=8;
const SESSION=/^speech-[0-9a-f-]{36}$/;
const safeError=code=>Object.assign(Error(code),{code});
async function bounded(invoke,timeoutMs=500){let timer;try{return await Promise.race([Promise.resolve().then(invoke).then(()=>true,()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);}finally{clearTimeout(timer);}}
async function privateDirectory(directory){
 const stat=await fsp.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw safeError('E_DIAGNOSTIC_PRIVATE_DIRECTORY');
 return stat;
}
async function createBundle(root){
 try{await fsp.mkdir(root,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 await privateDirectory(root);let count=0;
 const entries=await fsp.opendir(root);try{for await(const entry of entries){if(++count>=MAX_SESSIONS)throw safeError('E_DIAGNOSTIC_STORAGE_LIMIT');}}finally{try{await entries.close();}catch{}}
 const id='speech-'+crypto.randomUUID(),directory=path.join(await fsp.realpath(root),id);await fsp.mkdir(directory,{mode:0o700});await privateDirectory(directory);return {id,directory};
}
class PrivateJournal{
 constructor(file,{maxBytes=MAX_HOST_BYTES,maxPendingBytes=MAX_PENDING_BYTES,onFailure=()=>{},open=fsp.open}={}){Object.assign(this,{file,maxBytes,maxPendingBytes,onFailure,open});this.bytes=0;this.pending=0;this.sequence=0;this.closed=false;this.tail=Promise.resolve();this.failure=null;}
 async init(){const handle=await this.open(this.file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);if(this.closed){await handle.close();return false;}this.handle=handle;return true;}
 fail(reason){if(this.failure)return;this.failure=reason;try{this.onFailure(reason);}catch{}}
 record(event){
  if(this.closed||this.failure)return false;
  let data;try{data=Buffer.from(JSON.stringify({...event,seq:++this.sequence,wallMs:Date.now(),monoNs:process.hrtime.bigint().toString()})+'\n');}catch{this.fail('host-invalid-event');return false;}
  if(data.length>64*1024||this.bytes+data.length>this.maxBytes||this.pending+data.length>this.maxPendingBytes){this.fail('host-storage-limit');return false;}
  this.bytes+=data.length;this.pending+=data.length;
  this.tail=this.tail.then(async()=>{if(!this.handle)return;let offset=0;while(offset<data.length){const result=await this.handle.write(data,offset,data.length-offset);if(!result.bytesWritten)throw Error('short write');offset+=result.bytesWritten;}}).catch(()=>this.fail('host-write-failed')).finally(()=>{this.pending-=data.length;});
  return true;
 }
 async close(timeoutMs=500){
  this.closed=true;let timer,drained=false;
  await Promise.race([this.tail.then(()=>{drained=true;}),new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);})]);clearTimeout(timer);
  if(!drained)this.fail('host-drain-timeout');
  const handle=this.handle;this.handle=null;if(handle){const closing=handle.close().catch(()=>{});let closeTimer;await Promise.race([closing,new Promise(resolve=>{closeTimer=setTimeout(resolve,timeoutMs);})]);clearTimeout(closeTimer);}
  return {drained,bytes:this.bytes,events:this.sequence,failure:this.failure};
 }
}
class SpeechDiagnostic{
 constructor({root,bin,options,speakerFilter,state=()=>({}),recentEcho=()=>false,bargeInReady=()=>true,nameHit=()=>false,canStart=()=>true,suspendNormal=()=>{},onStatus=()=>{},createAsr=(...args)=>new Asr(...args),createPipeline,createTurns=createVoiceTurns,createPrivateBundle=createBundle,clock=Date.now}={}){
  Object.assign(this,{root,bin,options,speakerFilter,state,recentEcho,bargeInReady,nameHit,canStart,suspendNormal,onStatus,createAsr,createTurns,createPrivateBundle,clock});this.createPipeline=createPipeline||require('./asr-input-pipeline').createAsrInputPipeline;this.blocked=false;this.session=null;this.last=null;
 }
 get active(){return !!this.session;}
 status(){const s=this.session||this.last;return {active:this.active,blocked:this.blocked,id:s?.id||null,phase:s?.phase||'idle',reason:s?.reason||null,incomplete:!!s?.reason&&(s.reason!=='native-exit'||s.nativeExitCode!==0||!!s.writer?.failure),pcm:s?.pcm||false,remainingMs:this.session?Math.max(0,this.session.deadline-this.clock()):0};}
 publish(){try{this.onStatus(this.status());}catch{}}
 release(){if(this.active)throw safeError('E_DIAGNOSTIC_ACTIVE');this.blocked=false;this.publish();}
 async start({durationMs=MAX_MS,pcm=false}={}){
  if(this.active||this.clearing)throw safeError('E_DIAGNOSTIC_ACTIVE');
  if(!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>MAX_MS||typeof pcm!=='boolean')throw safeError('E_DIAGNOSTIC_OPTIONS');
  if(!this.canStart())throw safeError('E_DIAGNOSTIC_UNAVAILABLE');
  const s={phase:'preparing',pcm,durationMs,startedAt:this.clock(),deadline:this.clock()+durationMs,reason:null};this.session=s;this.blocked=true;
  const alive=()=>this.session===s&&!s.ending&&this.clock()<s.deadline;
  s.timer=setTimeout(()=>{void this.finish('deadline');},durationMs);this.publish();
  const removePrepared=async()=>{if(s.writer)await s.writer.close();if(s.directory){if(s.writer)try{await fsp.unlink(path.join(s.directory,'host-events.ndjson'));}catch{}try{await fsp.rmdir(s.directory);}catch{}}if(this.last===s){this.last=null;this.publish();}};
  try{
   // No test audio can reach the ordinary ASR listeners, including old chunks.
   this.suspendNormal();
   Object.assign(s,await this.createPrivateBundle(this.root));if(!alive()){await removePrepared();return this.status();}
   s.writer=new PrivateJournal(path.join(s.directory,'host-events.ndjson'),{onFailure:reason=>{queueMicrotask(()=>{void this.finish(reason);});}});await s.writer.init();
   if(!alive()){await removePrepared();return this.status();}
   const record=(event,fields={})=>{if(alive())s.writer.record({event,recognizer:s.asr?.traceRecognizer||1,nativeGen:s.nativeGen??null,...fields});};
   const opts=this.options();s.opts=opts;record('host-clock-start',{durationMs,pcm,options:opts});
   const wakeHit=text=>s.asr?.wakeHit?.(text)===true||this.nameHit(text);
   const turns=this.createTurns({requireActivity:true,onCheckpoint:metadata=>s.asr?.checkpoint?.(metadata),onTrace:value=>record('host-turn-trace',value),
    onLive:(text,value)=>record('host-turn-live',{text,...value,reason:value.final&&this.state().wakeOnly&&!wakeHit(text)?'not-addressed':'live'}),
    onInvalidate:()=>record('host-turn-invalidated'),onError:(_message,metadata)=>{record('host-turn-unconfirmed',{reason:metadata?.reason||'unconfirmed',admitted:metadata?.admitted===true});if(['confirmation-timeout','acoustic-timeout','commit-timeout'].includes(metadata?.reason))queueMicrotask(()=>{if(this.session===s)void this.finish('voice-unconfirmed');});},
    onRemember:(text,value)=>{record('host-remember-sink',{text,...value});return {id:'diagnostic-only'};},
    onRequest:token=>{const value=this.state(),reason=!meaningful(token.text)?'empty':value.wakeOnly&&!wakeHit(token.text)?'wake':'candidate';if(reason==='wake')token.skip();record('host-request-sink',{text:token.text,turn:token.id,reason,playbackTextMatch:this.recentEcho(token.text,token),semanticAccepted:false,businessDispatch:false});}
   });s.turns=turns;
   const stoppedTurns={activity(){return false;},audioFinal(){return false;},partial(){},final(){},reset(){},snapshot:()=>null};
   const pipeline=this.createPipeline({speakerFilter:this.speakerFilter,state:()=>({...this.state(),alwaysOn:true,asrMode:'continuous',suppressEnrollmentFinal:false}),recentEcho:this.recentEcho,bargeInReady:this.bargeInReady,nameHit:wakeHit,turns:()=>alive()?turns:stoppedTurns,
    trace:value=>record('host-filter-trace',value),onFilter:(stage,text)=>record('host-filter',{stage,text}),onPartial:text=>record('host-partial-sink',{text}),onAcceptedPartial:()=>{},onUtteranceConfirmed:()=>{},setLastLiveText:()=>{},setSuppressEnrollmentFinal:()=>{},onFeatures:()=>{}});
   const asr=this.createAsr(this.bin,()=>{});s.asr=asr;
   asr.on('error',()=>{void this.finish('native-error');});
   asr.on('ready',()=>{if(!alive())return;s.phase='capturing';record('host-ready');this.publish();});
   asr.on('partial',(text,meta)=>{if(alive())pipeline.partial(text,meta);});
   asr.on('retract',meta=>{if(alive())pipeline.retract(meta);});
   asr.on('inputReset',()=>pipeline.reset());
   asr.on('utterance',(text,meta)=>{if(alive())pipeline.utterance(text,meta);});
   asr.on('audioFinal',value=>{if(alive()){record('host-audio-final',value);pipeline.audioFinal(value);}});
   asr.on('final',(text,meta)=>{if(alive())pipeline.final(text,meta);});
   asr.on('voiceFeatures',value=>{if(alive())pipeline.voiceFeatures(value);});
   asr.on('activity',value=>{if(alive()){const {seq:activitySeq,...metadata}=value;record('host-activity',{...metadata,activitySeq});pipeline.activity(value);}});
   asr.on('micDevice',value=>{if(!alive())return;this.speakerFilter.device=value.identity||opts.device||(value.on&&value.name)||this.speakerFilter.device||'default';});
   asr.on('exit',code=>{s.nativeExitCode=code;if(this.session===s)void this.finish('native-exit');});
   if(!alive()){await this.finish('deadline');return this.status();}
   asr.start({...opts,diagnostic:{directory:s.directory,durationMs:Math.max(1,s.deadline-this.clock()),pcm,record:message=>{if(Number.isSafeInteger(message.diagnosticGen))s.nativeGen=message.diagnosticGen;record('host-native-receipt',{message,recognizer:asr.traceRecognizer});}}});
   if(!alive())return this.status();
   s.guard=setInterval(()=>{let current=false;try{current=this.canStart();}catch{}if(!current)void this.finish('context-change');},100);s.guard.unref?.();
   if(!asr.running)void this.finish('native-start-failed');
   return this.status();
  }catch(error){if(this.session===s)await this.finish('start-failed');else await removePrepared();throw safeError(error.code?.startsWith('E_DIAGNOSTIC_')?error.code:'E_DIAGNOSTIC_START');}
 }
 finish(reason='owner-stop'){
  const s=this.session;if(!s)return Promise.resolve(this.status());if(s.ending)return s.finishing||Promise.resolve(this.status());s.ending=true;
  s.reason=reason;s.phase='finalizing';clearTimeout(s.timer);clearInterval(s.guard);
  // SIGKILL/discard precedes any filesystem await. No restart or business
  // listener is attached to this recognizer, even during finalization failure.
  s.asr?.kill({discard:true});s.writer?.record({event:'host-clock-end',reason,turn:s.turns?.snapshot()||null,businessDispatch:false});s.turns?.reset();this.publish();
  s.finishing=(async()=>{
   const journal=s.writer?await s.writer.close():null;
   const manifest={schema:'bunny.speech-diagnostic/v1',id:s.id,startedAt:s.startedAt,endedAt:this.clock(),durationLimitMs:s.durationMs,pcm:s.pcm,reason,nativeExitCode:s.nativeExitCode??null,journal,options:s.opts||null,businessSink:'isolated-no-dialogue-history-or-task-listeners',bounds:{hostBytes:MAX_HOST_BYTES,pendingHostBytes:MAX_PENDING_BYTES,nativePcmBytes:32*1024*1024,nativeEventsBytes:2*1024*1024},nativeEvidence:'native-events.ndjson',pcmEvidence:s.pcm?'processed-audio.pcm':null};
   if(s.directory){s.manifestSettled=false;const saved=await bounded(async()=>{try{await privateDirectory(s.directory);await fsp.writeFile(path.join(s.directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode:0o600});}finally{s.manifestSettled=true;}});if(!saved)s.reason='manifest-write-failed';}
   this.speakerFilter.latest=null;s.phase='finished';this.last=s;if(this.session===s)this.session=null;this.publish();return this.status();
  })();return s.finishing;
 }
 async directory(){const s=this.last;if(!s?.id||!SESSION.test(s.id)||this.active)throw safeError('E_DIAGNOSTIC_NOT_FINISHED');await privateDirectory(this.root);await privateDirectory(s.directory);if(path.dirname(s.directory)!==await fsp.realpath(this.root))throw safeError('E_DIAGNOSTIC_PATH');return s.directory;}
 async clear(){if(this.clearing)throw safeError('E_DIAGNOSTIC_ACTIVE');this.clearing=true;const previous=this.last;try{if(previous?.manifestSettled===false||previous?.writer?.pending)throw safeError('E_DIAGNOSTIC_DRAIN');const directory=await this.directory(),names=await fsp.readdir(directory);const allowed=new Set(['host-events.ndjson','native-events.ndjson','processed-audio.pcm','manifest.json','.DS_Store']);
  for(const name of names){const stat=await fsp.lstat(path.join(directory,name));if(!allowed.has(name)||!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||name!=='.DS_Store'&&(stat.mode&0o077)||name==='.DS_Store'&&stat.size>65536)throw safeError('E_DIAGNOSTIC_PATH');}
  for(const name of names)await fsp.unlink(path.join(directory,name));await fsp.rmdir(directory);if(this.last===previous)this.last=null;this.publish();return this.status();
  }finally{this.clearing=false;}
 }
}
module.exports={SpeechDiagnostic,PrivateJournal,createBundle,privateDirectory,MAX_MS,MAX_HOST_BYTES,MAX_PENDING_BYTES,MAX_SESSIONS};
