'use strict';

// Local evidence of Bunny's own scheduling. This module never observes a target
// application, takes a screenshot, requests a model, or infers a cause.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const context=new AsyncLocalStorage();
const STAGES=new Set(['host-state','gui-admission','operation-intent','operation-dispatch','operation-receipt','operation-error','operation-retry',
 'native-dispatch','native-receipt','native-error','native-recovery','native-exit',
 'capture-start','capture-end','capture-error','pixel-frame','visual-recognition','visual-text-filter','visual-aux-filter','visual-location','visual-change','visual-observation','visual-error','visual-lifecycle',
 'input-intent','input-preflight','input-dispatch','input-receipt','input-error','input-cancel','incident','evidence-pending','evidence-retained','evidence-unavailable','evidence-read','diagnostic-gap']);
const IDS=new Set(['taskId','actionId','operationId','controllerId','visualSessionId','frameId','captureId','spanId','nativeClientId','nativeRequestId','incidentId','targetRef']);
const NUMBERS=new Set(['generation','attempt','timeoutMs','elapsedMs','capturedAt','width','height','sourceWidth','sourceHeight','chars','x','y','deltaX','deltaY','bytes','count','dropped','pendingBytes','capturedAgeMs','discardedChars','observedTextRows','retainedTextRows','discardedTextRows','observedItems','retainedItems','discardedItems','hidIdleMs']);
const FLAGS=new Set(['ok','verified','available','unique','active','sameIdentity','geometryChanged','identityChanged','pixelsChanged','reused','nativeAcknowledged','cancelledAfterDispatch','dispatched','mayHaveDispatched','matched','normalized','ready','leaseFree']);
const CHOICES={mode:['service','terminal','structured-ui','visual'],operation:['click','scroll','key','type'],
 admissionReason:['not-ready','gui-owned','invalid-hid-idle','recent-hid-input','admitted'],
 backend:['CGDisplayStream'],imageKind:['display','visual-region','preflight-region'],status:['intent','requested','acknowledged','confirmed','not-dispatched','uncertain','cancelled','failed','completed','started','validated','validation-failed','unavailable','reused','reset','closed'],
 kind:['capture-failed','visual-unavailable','input-failed','operation-failed','native-failed','host-change'],
 state:['startup','shutdown','screen-lock','screen-unlock','sleep','wake','suspend','resume','stop'],
 unavailableKind:['login','security','occluded','ambiguous','absent','unclear','inactive','identity'],
 reason:['queue-limit','storage-failed','storage-timeout','key-unavailable','frame-limit','retention-limit','not-retained','shutdown-timeout'],
 causality:['temporal-association-only']};
const MODIFIERS=new Set(['command','cmd','super','control','ctrl','alt','option','shift','fn']);
const KEY=/^(?:return|enter|escape|esc|tab|space|backspace|delete|forwarddelete|left|right|up|down|home|end|pageup|pagedown|f(?:[1-9]|1[0-9]|2[0-4]))$/i;
const ref=value=>typeof value==='string'&&value?crypto.createHash('sha256').update(value).digest('hex').slice(0,32):undefined;
function sanitize(value={}){
 const out={};
 for(const [key,v]of Object.entries(value)){
  if(IDS.has(key)){const id=ref(v);if(id)out[key]=id;}
  else if(NUMBERS.has(key)&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER)out[key]=v;
  else if(FLAGS.has(key)&&typeof v==='boolean')out[key]=v;
  else if(['schemaAudit','completion'].includes(key)){const safe=require('./self-repair').diagnostic({[key]:v});if(safe?.[key])out[key]=safe[key];}
  else if(CHOICES[key]?.includes(v))out[key]=v;
  else if(['tool','nativeOperation'].includes(key)&&typeof v==='string'&&/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/u.test(v))out[key]=v;
  else if(key==='code'&&typeof v==='string'&&/^(?:E_[A-Z0-9_]{1,60}|ABORT_ERR)$/u.test(v))out.code=v;
  else if(key==='pixelDigest'&&typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v))out.pixelDigest=v;
  else if(['incidentRef','captureRef'].includes(key)&&typeof v==='string'&&/^[a-f0-9]{32}$/u.test(v))out[key]=v;
  else if(key==='key'&&typeof v==='string'&&(KEY.test(v)||value.modifiers?.some(m=>MODIFIERS.has(m)&&m!=='shift')&&/^[a-z0-9]$/iu.test(v)))out.key=v.toLowerCase();
  else if(key==='modifiers'&&Array.isArray(v))out.modifiers=v.filter(m=>MODIFIERS.has(m)).slice(0,4);
  else if(['displayRect','region'].includes(key)&&v&&['x','y','width','height'].every(k=>Number.isFinite(v[k])))out[key]=Object.fromEntries(['x','y','width','height'].map(k=>[k,v[k]]));
 }
 return out;
}
class OperationDiagnostics{
 constructor({root=null,getKey=()=>null,onIncident=()=>{},clock=Date.now,monotonic=()=>process.hrtime.bigint(),maxEvents=512,maxPendingBytes=256*1024,maxFileBytes=2*1024*1024,maxFiles=8,maxFrames=4,maxFrameBytes=4*1024*1024,maxEvidenceBytes=64*1024*1024,maxEvidenceFiles=24,retentionMs=7*86400000,writeTimeoutMs=1000,io=fsp}={}){
  Object.assign(this,{root,getKey,onIncident,clock,monotonic,maxEvents,maxPendingBytes,maxFileBytes,maxFiles,maxFrames,maxFrameBytes,maxEvidenceBytes,maxEvidenceFiles,retentionMs,writeTimeoutMs,io});
  this.session=crypto.randomUUID();this.startMono=monotonic();this.events=[];this.frames=[];this.incidents=[];this.seq=0;this.dropped=0;this.pendingBytes=0;this.tail=Promise.resolve();this.file=null;this.fileBytes=0;this.closed=false;this.failure=false;
 }
 record(stage,fields={}){
  if(this.closed||!STAGES.has(stage))return null;
  const at=this.clock(),event={schema:'bunny.operation-diagnostic/v1',session:this.session,seq:++this.seq,at,utc:new Date(at).toISOString(),monoUs:Number((this.monotonic()-this.startMono)/1000n),stage,droppedBefore:this.dropped,...sanitize(fields)};
  this.events.push(event);if(this.events.length>this.maxEvents)this.events.shift();
  const data=Buffer.from(JSON.stringify(event)+'\n');
  if(this.root)this.enqueue(data.length,()=>this.append(data));
  return event;
 }
 enqueue(bytes,work){
  if(this.closed||this.failure||this.pendingBytes+bytes>this.maxPendingBytes){this.dropped++;return false;}
  this.pendingBytes+=bytes;
  this.tail=this.tail.then(async()=>{let timer;try{timer=setTimeout(()=>this.gap('storage-timeout'),this.writeTimeoutMs);timer.unref?.();await work();}finally{clearTimeout(timer);}}).catch(()=>{this.gap('storage-failed');}).finally(()=>{this.pendingBytes-=bytes;});
  return true;
 }
 gap(reason){if(this.failure)return;this.failure=true;this.dropped++;this.record('diagnostic-gap',{reason,dropped:this.dropped,pendingBytes:this.pendingBytes});try{this.onIncident({session:this.session,kind:'diagnostic-gap',reason,dropped:this.dropped,pendingBytes:this.pendingBytes});}catch{}}
 async init(){
  if(this.initialized)return;
  if(this.initializing)return this.initializing;
  this.initializing=(async()=>{await this.io.mkdir(this.root,{recursive:true,mode:0o700});const st=await this.io.lstat(this.root);
   if(!st.isDirectory()||st.isSymbolicLink()||process.getuid&&st.uid!==process.getuid()||(st.mode&0o077))throw Error('private diagnostics directory required');
   await this.prune();this.initialized=true;})();
  try{await this.initializing;}finally{this.initializing=null;}
 }
 async prune(){
  const files=[];
  for(const name of await this.io.readdir(this.root))if(/^(?:events-[a-f0-9-]+\.ndjson|evidence-[a-f0-9-]+\.bin)$/u.test(name)){
   const file=path.join(this.root,name);let st;try{st=await this.io.lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   if(!st.isFile()||st.isSymbolicLink()||process.getuid&&st.uid!==process.getuid()||(st.mode&0o077))throw Error('untrusted diagnostic file');
   files.push({name,file,size:st.size,at:st.mtimeMs,evidence:name.startsWith('evidence-')});
  }
  for(const evidence of [false,true]){
   const selected=files.filter(f=>f.evidence===evidence).sort((a,b)=>b.at-a.at);let bytes=0,count=0;
   for(const file of selected){bytes+=file.size;count++;if(this.clock()-file.at>this.retentionMs||count>(evidence?this.maxEvidenceFiles:this.maxFiles)||evidence&&bytes>this.maxEvidenceBytes)try{await this.io.unlink(file.file);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
 }
 async append(data){
  await this.init();
  if(!this.file||this.fileBytes+data.length>this.maxFileBytes){this.file=path.join(this.root,'events-'+crypto.randomUUID()+'.ndjson');this.fileBytes=0;}
  const handle=await this.io.open(this.file,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(data);this.fileBytes+=data.length;}finally{await handle.close();}
  if(this.fileBytes===data.length)await this.prune();
 }
 frame(frame,fields={}){
  if(this.closed||typeof frame?.pngBase64!=='string')return;
  const bytes=Math.floor(frame.pngBase64.length*3/4);
  if(bytes>this.maxFrameBytes){this.record('evidence-unavailable',{...fields,reason:'frame-limit',bytes});return;}
  const pixels=Buffer.from(frame.pngBase64,'base64'),entry={...fields,capturedAt:frame.capturedAt,width:frame.width,height:frame.height,pixelDigest:crypto.createHash('sha256').update(pixels).digest('hex'),bytes:pixels.length};
  const item={fields:entry,pixels,mono:this.monotonic()};this.frames=this.frames.filter(f=>this.monotonic()-f.mono<=30000000000n&&(!fields.captureId||f.fields.captureId!==fields.captureId));this.frames.push(item);while(this.frames.length>this.maxFrames)this.frames.shift();
  clearTimeout(this.frameExpiry);this.frameExpiry=setTimeout(()=>{this.frames=[];},30000);this.frameExpiry.unref?.();
  this.record('pixel-frame',entry);
  for(const incident of this.incidents)if(entry.imageKind!=='display'&&this.monotonic()-incident.mono<=10000000000n&&incident.frames<4&&this.related(incident,item))this.retain(incident,item);
 }
 related(incident,item){return incident.target?incident.target===item.fields.visualSessionId:incident.operationId?incident.operationId===item.fields.operationId:incident.controllerId?incident.controllerId===item.fields.controllerId:true;}
 incident(kind,fields={}){
  if(this.closed||!CHOICES.kind.includes(kind))return null;
  const old=this.incidents.at(-1);if(old&&old.kind===kind&&old.target===fields.visualSessionId&&old.operationId===fields.operationId&&old.controllerId===fields.controllerId&&this.monotonic()-old.mono<3000000000n){const latest=this.frames.filter(f=>this.related(old,f)).at(-1);if(latest&&old.frames<4)this.retain(old,latest);return old.id;}
  const incident={id:crypto.randomUUID(),kind,target:fields.visualSessionId,operationId:fields.operationId,controllerId:fields.controllerId,at:this.clock(),mono:this.monotonic(),frames:0,seen:new Set()};this.incidents.push(incident);if(this.incidents.length>8)this.incidents.shift();
  const event=this.record('incident',{...fields,incidentId:incident.id,kind,causality:'temporal-association-only',dropped:this.dropped,pendingBytes:this.pendingBytes});
  const frames=this.frames.filter(f=>this.monotonic()-f.mono<=30000000000n&&this.related(incident,f)).slice(-2).reverse();
  if(!frames.length)this.record('evidence-unavailable',{...fields,incidentId:incident.id,reason:'not-retained'});
  for(const frame of frames)this.retain(incident,frame);
  try{this.onIncident({session:this.session,incidentId:event?.incidentId,seq:event?.seq,kind,dropped:this.dropped,causality:'temporal-association-only'});}catch{}
  return incident.id;
 }
 retain(incident,item){
  if(!this.root)return;
  const capture=item.fields.captureId||item.fields.pixelDigest;if(incident.seen.has(capture))return;incident.seen.add(capture);
  incident.frames++;
  let key;try{const value=this.getKey();if(Buffer.isBuffer(value)&&value.length===32)key=crypto.createHmac('sha256',value).update('bunny.operation-evidence/v1').digest();}catch{}
  if(!key){this.record('evidence-unavailable',{...item.fields,incidentId:incident.id,reason:'key-unavailable'});return;}
  // Encryption and filesystem work never run on the operation's awaited path.
  // Evidence has a separate small queue allowance; metadata cannot be displaced.
  if(this.evidencePending>=2){key.fill(0);this.record('evidence-unavailable',{...item.fields,incidentId:incident.id,reason:'queue-limit'});return;}
  this.evidencePending=(this.evidencePending||0)+1;
  const fields={...item.fields,incidentId:incident.id},file='evidence-'+incident.id+'-'+crypto.randomUUID()+'.bin';this.record('evidence-pending',fields);
  void (async()=>{
   try{
    await this.init();const nonce=crypto.randomBytes(12),imported=await crypto.webcrypto.subtle.importKey('raw',key,'AES-GCM',false,['encrypt']);
    const header=Buffer.from(JSON.stringify({schema:'bunny.operation-evidence/v1',session:this.session,incidentId:ref(incident.id),captureId:ref(item.fields.captureId||''),pixelDigest:item.fields.pixelDigest,width:item.fields.width,height:item.fields.height,capturedAt:item.fields.capturedAt,imageKind:item.fields.imageKind||'display',sourceWidth:item.fields.sourceWidth||item.fields.width,sourceHeight:item.fields.sourceHeight||item.fields.height,...(item.fields.region?{region:item.fields.region}:{}),nonce:nonce.toString('base64')}));
    const encrypted=Buffer.from(await crypto.webcrypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:header},imported,item.pixels));
    const handle=await this.io.open(path.join(this.root,file),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try{await handle.writeFile(Buffer.concat([header,Buffer.from('\n'),encrypted]));}finally{await handle.close();}
    await this.prune();this.record('evidence-retained',fields);
   }catch{this.record('evidence-unavailable',{...fields,reason:'storage-failed'});}finally{key.fill(0);this.evidencePending--;}
  })();
 }
 snapshot(){return {session:this.session,events:this.events.map(e=>({...e})),dropped:this.dropped,pendingBytes:this.pendingBytes,storageFailed:this.failure,evidencePending:!!this.evidencePending,causality:'temporal-association-only'};}
 async readEvidence(request,{authorize=()=>false,timeoutMs=1500}={}){
  if(this.closed)return {available:false,code:'E_DIAGNOSTIC_CLOSED'};
  let timer,active=true;const timeout=new Promise(resolve=>{timer=setTimeout(()=>{active=false;resolve({available:false,code:'E_DIAGNOSTIC_TIMEOUT'});},Math.max(1,Math.min(3000,timeoutMs)));});
  try{const result=await Promise.race([this.readEvidenceFrame(request,authorize,()=>active&&!this.closed),timeout]);this.record('evidence-read',{incidentRef:request?.incidentId,captureRef:request?.captureId,ok:result.available===true,code:result.code});return result;}finally{active=false;clearTimeout(timer);}
 }
 async readEvidenceFrame(request,authorize,active){
  const failure=code=>({available:false,code});let key;
  try{
   if(!request||Object.keys(request).some(k=>!['session','incidentId','captureId'].includes(k))||!/^[a-f0-9-]{36}$/u.test(request.session)||!['incidentId','captureId'].every(k=>/^[a-f0-9]{32}$/u.test(request[k]||'')))return failure('E_DIAGNOSTIC_SCOPE');
   const permission=await authorize({...request});if(!active())return failure('E_DIAGNOSTIC_TIMEOUT');if(permission!==true&&typeof permission!=='function')return failure('E_DIAGNOSTIC_AUTH');const check=()=>{if(!active()||typeof permission==='function'&&permission()===false)throw Error('authority revoked');};check();
   const master=this.getKey();if(!Buffer.isBuffer(master)||master.length!==32)return failure('E_DIAGNOSTIC_LOCKED');key=crypto.createHmac('sha256',master).update('bunny.operation-evidence/v1').digest();
   const st=await this.io.lstat(this.root);if(!st.isDirectory()||st.isSymbolicLink()||st.mode&0o077||process.getuid&&st.uid!==process.getuid())return failure('E_DIAGNOSTIC_PATH');
   const names=(await this.io.readdir(this.root)).filter(n=>/^evidence-[a-f0-9-]+\.bin$/u.test(n));if(names.length>this.maxEvidenceFiles+1)return failure('E_DIAGNOSTIC_LIMIT');
   for(const name of names){
    check();const handle=await this.io.open(path.join(this.root,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let data;
    try{const stat=await handle.stat();if(!stat.isFile()||stat.mode&0o077||process.getuid&&stat.uid!==process.getuid()||stat.size>this.maxFrameBytes+4096)continue;
     const prefix=Buffer.alloc(Math.min(4096,stat.size)),read=await handle.read(prefix,0,prefix.length,0),newline=prefix.indexOf(10);if(newline<0||newline>=read.bytesRead)continue;let candidate;try{candidate=JSON.parse(prefix.subarray(0,newline));}catch{continue;}
     if(candidate.session!==request.session||candidate.incidentId!==request.incidentId||candidate.captureId!==request.captureId)continue;check();data=await handle.readFile();
    }finally{await handle.close();}
    const split=data.indexOf(10);if(split<0||split>4096)continue;let h;try{h=JSON.parse(data.subarray(0,split));}catch{continue;}
    if(h.schema!=='bunny.operation-evidence/v1'||h.session!==request.session||h.incidentId!==request.incidentId||h.captureId!==request.captureId)continue;
    check();if(!Buffer.isBuffer(this.getKey()))return failure('E_DIAGNOSTIC_LOCKED');
    const imported=await crypto.webcrypto.subtle.importKey('raw',key,'AES-GCM',false,['decrypt']);let pixels;
    try{pixels=Buffer.from(await crypto.webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(h.nonce,'base64'),additionalData:data.subarray(0,split)},imported,data.subarray(split+1)));}catch{return failure('E_DIAGNOSTIC_INTEGRITY');}
    if(pixels.length>this.maxFrameBytes||crypto.createHash('sha256').update(pixels).digest('hex')!==h.pixelDigest)return failure('E_DIAGNOSTIC_INTEGRITY');
    check();const current=this.getKey();if(!Buffer.isBuffer(current)||current.length!==32)return failure('E_DIAGNOSTIC_LOCKED');const currentKey=crypto.createHmac('sha256',current).update('bunny.operation-evidence/v1').digest(),same=crypto.timingSafeEqual(key,currentKey);currentKey.fill(0);if(!same)return failure('E_DIAGNOSTIC_LOCKED');
    return {available:true,frame:{session:h.session,incidentId:h.incidentId,captureId:h.captureId,width:h.width,height:h.height,capturedAt:h.capturedAt,imageKind:h.imageKind,sourceWidth:h.sourceWidth,sourceHeight:h.sourceHeight,...(h.region?{region:h.region}:{})},pngBase64:pixels.toString('base64')};
   }
   return failure('E_DIAGNOSTIC_MISSING');
  }catch{return failure('E_DIAGNOSTIC_AUTH_OR_STORAGE');}finally{key?.fill(0);}
 }
 link(id){return {session:this.session,incidentId:ref(id),seq:this.seq,dropped:this.dropped,pendingBytes:this.pendingBytes,causality:'temporal-association-only'};}
 clearPixels(){clearTimeout(this.frameExpiry);this.frames=[];this.incidents=[];}
 async flush(timeoutMs=500){
  const deadline=Date.now()+Math.max(1,Math.min(1000,timeoutMs));
  while(Date.now()<deadline){const tail=this.tail;let timer;const drained=await Promise.race([tail.then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),Math.max(1,deadline-Date.now()));})]);clearTimeout(timer);if(!drained)return false;if(!this.evidencePending&&this.tail===tail)return !this.failure;await new Promise(r=>setTimeout(r,5));}
  return false;
 }
 async close(timeoutMs=500){const drained=await this.flush(timeoutMs);this.closed=true;this.clearPixels();return {drained,dropped:this.dropped,pendingBytes:this.pendingBytes,storageFailed:this.failure};}
}
let defaultRecorder=null;
function configure(recorder){defaultRecorder=recorder;}
function bind(fields={},{inherit=true}={}){
 const store=context.getStore(),recorder=store?.recorder||defaultRecorder,base={...(inherit?store?.fields:{}),...fields};
 return {record:(stage,extra)=>recorder?.record(stage,{...base,...extra}),frame:(frame,extra)=>recorder?.frame(frame,{...base,...extra}),incident:(kind,extra)=>recorder?.incident(kind,{...base,...extra}),
  annotate:(error,kind,extra)=>{const id=error.operationIncidentId||recorder?.incident(kind,{...base,...extra});if(id&&recorder){error.operationIncidentId=id;error.diagnostic={...error.diagnostic,operationTrace:recorder.link(id)};}return error;},
  scope:fn=>context.run({recorder,fields:base},fn)};
}
const scope=(fields,fn)=>bind(fields).scope(fn);
const using=(recorder,fn)=>context.run({recorder,fields:{}},fn);
const record=(stage,fields)=>bind().record(stage,fields);
// A bounded metadata-only reconstruction, also usable after a process restart.
// Monotonic/sequence ordering is authoritative within a session; wall time is
// only a cross-session reference and may have been adjusted by the system.
async function readTimeline(root,{from=0,to=Number.MAX_SAFE_INTEGER,limit=200}={}){
 const st=await fsp.lstat(root);if(!st.isDirectory()||st.isSymbolicLink()||st.mode&0o077||process.getuid&&st.uid!==process.getuid())throw Error('private diagnostics directory required');
 const names=(await fsp.readdir(root)).filter(n=>/^events-[a-f0-9-]+\.ndjson$/u.test(n));
 const files=await Promise.all(names.map(async name=>({name,stat:await fsp.lstat(path.join(root,name))})));
 const events=[];let incomplete=false;
 for(const file of files.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs).slice(0,8)){
  if(!file.stat.isFile()||file.stat.isSymbolicLink()||file.stat.mode&0o077||file.stat.size>2*1024*1024+8192||process.getuid&&file.stat.uid!==process.getuid()){incomplete=true;continue;}
  const handle=await fsp.open(path.join(root,file.name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let body;try{body=await handle.readFile('utf8');}finally{await handle.close();}
  for(const line of body.split('\n')){if(!line)continue;try{
   const v=JSON.parse(line);if(v.schema!=='bunny.operation-diagnostic/v1'||!STAGES.has(v.stage)||!/^[a-f0-9-]{36}$/u.test(v.session)||!Number.isSafeInteger(v.seq)||v.seq<1||!Number.isFinite(v.at)||!Number.isFinite(v.monoUs))throw Error('invalid');
   if(v.at<from||v.at>to)continue;
   const safe=sanitize(v);for(const id of IDS)if(/^[a-f0-9]{32}$/u.test(v[id]||''))safe[id]=v[id];
   events.push({schema:v.schema,session:v.session,seq:v.seq,at:v.at,utc:new Date(v.at).toISOString(),monoUs:v.monoUs,stage:v.stage,droppedBefore:Number.isSafeInteger(v.droppedBefore)&&v.droppedBefore>=0?v.droppedBefore:0,...safe});
  }catch{incomplete=true;}}
 }
 const bounded=Math.max(1,Math.min(512,Number(limit)||200));
 const starts=new Map();for(const e of events){const old=starts.get(e.session);if(!old||e.seq<old.seq)starts.set(e.session,e);}
 events.sort((a,b)=>a.session===b.session?a.seq-b.seq:starts.get(a.session).at-starts.get(b.session).at||a.session.localeCompare(b.session));
 const truncated=events.length>bounded||files.length>8;return summarizeTimeline(events.slice(-bounded),{incomplete,truncated});
}
function summarizeTimeline(events,{incomplete=false,truncated=false}={}){
 const inputStates=new Map(),last=new Map();let gaps=0;
 for(const e of events){const previous=last.get(e.session);if(previous!==undefined&&e.seq!==previous+1)gaps++;last.set(e.session,e.seq);
  if(e.spanId&&['input-intent','input-dispatch','input-receipt','input-error','input-cancel'].includes(e.stage)){
   const key=e.session+':'+e.spanId,state=inputStates.get(key)||{session:e.session,spanId:e.spanId};
   if(e.stage==='input-cancel')inputStates.set(key,{...state,cancellationRequested:true});
   else inputStates.set(key,{...state,...e,outcome:e.stage==='input-intent'?'no-dispatch-record':e.stage==='input-receipt'&&e.nativeAcknowledged?'input-acknowledged':e.stage==='input-error'&&e.mayHaveDispatched===false?'not-dispatched':'unconfirmed'});
  }
 }
 return {schema:'bunny.operation-timeline/v1',causality:'temporal-association-only',source:'bunny-own-scheduling-and-already-captured-pixels',
  coverage:{incomplete,truncated,sequenceGaps:gaps,dropped:Math.max(0,...events.map(e=>e.droppedBefore||0)),absenceProof:false},
  recentInputs:[...inputStates.values()].slice(-12),events};
}
module.exports={OperationDiagnostics,configure,bind,scope,using,record,sanitize,ref,readTimeline,summarizeTimeline};
