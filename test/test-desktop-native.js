'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');
const { PassThrough, Writable } = require('stream');
const { DesktopNative, defaultBinary } = require('../src/main/desktop-native');
const nativeTestBinary = () => process.env.WORKBUNNY_NATIVE_TEST_BINARY || defaultBinary();
test('display ownership excludes another process and is released automatically after a crash',async t=>{
 const binary=nativeTestBinary();if(!fs.existsSync(binary))return t.skip('native bridge is not built');
 const directory=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'bunny-display-lease-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const env={...process.env,WORKBUNNY_TEST_DISPLAY_LEASE_DIR:directory};
 const owner=spawn(binary,['--self-test-display-lease'],{env,stdio:['pipe','pipe','pipe']});t.after(()=>owner.kill('SIGKILL'));
 const first=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('capture lease probe timed out')),5000);owner.stdout.on('data',b=>{text+=b;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.trim().split('\n')[0]));}});owner.once('error',reject);});
 assert.equal(first.held,true);const blocked=spawnSync(binary,['--self-test-display-lease'],{env,input:'\n',encoding:'utf8',timeout:5000});assert.equal(blocked.status,1);assert.equal(JSON.parse(blocked.stdout.trim()).code,'E_CAPTURE_BUSY');
 const exited=new Promise(r=>owner.once('close',r));owner.kill('SIGKILL');await exited;
 const recovered=spawnSync(binary,['--self-test-display-lease'],{env,input:'\n',encoding:'utf8',timeout:5000});assert.equal(recovered.status,0);assert.equal(JSON.parse(recovered.stdout.trim()).held,true);
});

function fixture(options = {}) {
  const children = [];
  const client = new DesktopNative('/fixture/desktop', { ...options, spawn: (bin, args, opts) => {
    assert.equal(bin, '/fixture/desktop'); assert.deepEqual(args, []); assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) { child.lines.push(String(chunk)); callback(); } });
    child.lines = []; child.kill = () => {}; children.push(child); return child;
  } });
  return { client, children };
}
test('pure display native entry points contain no application or window discovery',()=>{
 const source=fs.readFileSync(require.resolve('../native/desktop.swift'),'utf8');
 const capture=source.slice(source.indexOf('func captureDisplayPixels('),source.indexOf('func capture(_ request:'));
 const input=source.slice(source.indexOf('func displayInput('),source.indexOf('func perform('));
 for(const body of [capture,input])assert.doesNotMatch(body,/windowEntries\(|currentFrontmost\(|targetWindow\(|AXUIElement|NSRunningApplication|postToPid/);
 assert.match(capture,/Set\(request.keys\).isSubset/);assert.match(input,/Set\(request.keys\).isSubset/);
});
test('new native pixel entry points reject target metadata before capturing or dispatching',t=>{
 const binary=process.env.WORKBUNNY_NATIVE_TEST_BINARY;if(!binary)return t.skip('requires the coordinated temporary native build');
 for(const op of ['displayCapture','displayInput'])for(const forbidden of [{windowId:1},{pid:1},{bundleId:'fixture.target'},{expected:{bundleId:'fixture.target',pid:1}}]){
  const request={id:'forbidden',op,...(op==='displayCapture'?{output:'base64'}:{action:'click',visualEvidence:{}}),...forbidden,sentAtMs:Date.now(),timeoutMs:1000},run=spawnSync(binary,[],{encoding:'utf8',timeout:3000,input:JSON.stringify(request)+'\n'});assert.equal(run.status,0,run.stderr);const response=JSON.parse(run.stdout.trim());assert.equal(response.ok,false);assert.match(response.error,/不接受应用、窗口或界面参数/);assert.equal(response.dispatched,false);
 }
});

test('JSONL client correlates concurrent requests and resolves native responses', async () => {
  const { client, children } = fixture();
  const first = client.request('permissions');
  const second = client.request('frontmost');
  const child = children[0];
  const messages = child.lines.map(line => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].op, 'permissions');
  assert.ok(Number.isFinite(messages[0].sentAtMs));
  child.stdout.write(`${JSON.stringify({ id: messages[1].id, ok: true, result: { pid: 11 } })}\n`);
  child.stdout.write(`${JSON.stringify({ id: messages[0].id, ok: true, result: { accessibilityTrusted: false } })}\n`);
  assert.deepEqual(await second, { pid: 11 });
  assert.deepEqual(await first, { accessibilityTrusted: false });
});
test('capture clients share one serialized display bridge, and closing one leaves the other usable',async()=>{
 const a=fixture({sharedDisplay:true}),b=fixture({sharedDisplay:true});
 const first=a.client.request('capture'),second=b.client.request('visualSample');await new Promise(r=>setImmediate(r));
 assert.equal(a.children.length,1);assert.equal(b.children.length,0);const child=a.children[0];
 let message=JSON.parse(child.lines[0]);child.stdout.write(JSON.stringify({id:message.id,ok:true,result:{frame:1}})+'\n');assert.deepEqual(await first,{frame:1});
 await new Promise(r=>setImmediate(r));message=JSON.parse(child.lines[1]);child.stdout.write(JSON.stringify({id:message.id,ok:true,result:{frame:2}})+'\n');assert.deepEqual(await second,{frame:2});
 await a.client.close();const third=b.client.request('visualCommit');await new Promise(r=>setImmediate(r));
 message=JSON.parse(child.lines[2]);child.stdout.write(JSON.stringify({id:message.id,ok:true,result:{committed:true}})+'\n');assert((await third).committed);
 child.kill=()=>{queueMicrotask(()=>child.emit('close',0));};await b.client.close();
});

test('a new capture client waits until the old helper releases its display lease', async () => {
  const a = fixture({ sharedDisplay: true }), b = fixture({ sharedDisplay: true });
  const first = a.client.request('capture');
  await new Promise(resolve => setImmediate(resolve));
  const old = a.children[0];
  old.stdout.write(JSON.stringify({ id: JSON.parse(old.lines[0]).id, ok: true, result: {} }) + '\n');
  await first;
  const closing = a.client.close();
  await new Promise(resolve => setImmediate(resolve));
  const next = b.client.request('capture');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.children.length, 0);
  old.emit('close', 0);
  await closing;
  await new Promise(resolve => setImmediate(resolve));
  const current = b.children[0];
  current.stdout.write(JSON.stringify({ id: JSON.parse(current.lines[0]).id, ok: true, result: { frame: 2 } }) + '\n');
  assert.deepEqual(await next, { frame: 2 });
  current.kill = () => queueMicrotask(() => current.emit('close', 0));
  await b.client.close();
});

test('fragmented native replies preserve UTF-8, and malformed frames settle pending requests', async () => {
  const { client, children } = fixture();
  const first = client.request('permissions'), second = client.request('frontmost');
  const [child] = children;
  const [a, b] = child.lines.map(JSON.parse);
  const bytes = Buffer.from(JSON.stringify({ id: a.id, ok: true, result: '窗口' }) + '\n' +
    JSON.stringify({ id: b.id, ok: true, result: 123 }) + '\n');
  const split = bytes.indexOf(Buffer.from('窗口')) + 1;
  child.stdout.write(bytes.subarray(0, split));
  child.stdout.write(bytes.subarray(split));
  assert.equal(await first, '窗口');
  assert.equal(await second, 123);

  const pending = client.request('permissions');
  child.kill = () => queueMicrotask(() => child.emit('close', 0));
  child.stdout.write('null\n');
  await assert.rejects(pending, /无效响应/);
  assert.equal(client.pending.size, 0);
  await client.close();
});

test('native failures reject and invalid timeout is refused before spawning', async () => {
  const { client, children } = fixture();
  await assert.rejects(client.request('capture', {}, 0), /timeoutMs/);
  assert.equal(children.length, 0);
  const pending = client.request('capture');
  const request = JSON.parse(children[0].lines[0]);
  children[0].stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: '缺少屏幕录制权限' })}\n`);
  await assert.rejects(pending, /缺少屏幕录制权限/);
});

test('client resolves a stable packaged or development executable path', () => {
  assert.equal(defaultBinary().endsWith('/bin/desktop'), true);
});

test('private desktop intents use trusted host context and retain BOPER effects before native completion',async()=>{
 const calls=[],messages=[],replies=[];let child;
 const boper={assertAvailable:()=>({backend:'virtual-hid'}),execute:async(operation,context,scope)=>{calls.push({operation,context,scope});context.validate();return {dispatched:true,reportsSubmitted:4,clipboardChanged:true,clipboardChangeCount:9,completion:'local-submitted'};},endScope:async(owner,scope)=>{calls.push({cleanup:true,owner,scope});return {releaseConfirmed:true};},cancelOwner:async()=>({releaseConfirmed:true})};
 const client=new DesktopNative('/fixture/desktop',{boper,inputContext:()=>({ownerId:'trusted-owner',application:'wechat',validate:()=>true}),spawn:()=>{
  child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new Writable({write(chunk,_enc,done){messages.push(JSON.parse(chunk));done();}});child.stdio=[child.stdin,child.stdout,child.stderr,new PassThrough(),new Writable({write(chunk,_enc,done){replies.push(JSON.parse(chunk));done();}})];child.kill=()=>queueMicrotask(()=>child.emit('close',0));return child;
 }});
 const proof={frameId:'fixture-frame',capturedAt:Date.now(),displayRect:{x:0,y:0,width:100,height:100},region:{x:0,y:0,width:100,height:100}};
 const pending=client.request('displayInput',{action:'type',text:'fixture',visualEvidence:proof},1000,{application:'wechat',visual:true});const request=messages[0];
 assert(!('application' in request));assert(!('ownerId' in request));
 child.stdio[3].write(JSON.stringify({id:1,requestId:request.id,operation:{action:'typeText',params:{text:'fixture'}}})+'\n');await new Promise(r=>setImmediate(r));
 assert.equal(calls[0].context.application,'wechat');assert.equal(calls[0].context.ownerId,'trusted-owner');assert.deepEqual(calls[0].operation.params.visualEvidence,proof);assert.equal(replies[0].ok,true);
 child.stdout.write(JSON.stringify({id:request.id,ok:true,result:{performed:true}})+'\n');const result=await pending;assert.equal(result.inputOutcome.clipboardChanged,true);assert.equal(result.inputOutcome.reportsSubmitted,4);assert.equal(result.inputOutcome.releaseConfirmed,true);assert.equal(calls[1].cleanup,true);await client.close();
});

test('a later native failure cannot erase earlier BOPER input or clipboard effects',async()=>{
 const boper={assertAvailable:()=>({backend:'cg-event'}),execute:async()=>({dispatched:true,reportsSubmitted:2,clipboardChanged:true,completion:'local-submitted'}),endScope:async()=>({releaseConfirmed:true}),cancelOwner:async()=>({releaseConfirmed:true})};
 let child;const client=new DesktopNative('/fixture/desktop',{boper,inputContext:()=>({ownerId:'owner',validate:()=>true}),spawn:()=>{
  child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.lines=[];child.stdin=new Writable({write(c,_e,done){child.lines.push(JSON.parse(c));done();}});child.stdio=[child.stdin,child.stdout,child.stderr,new PassThrough(),new Writable({write(_c,_e,done){done();}})];child.kill=()=>queueMicrotask(()=>child.emit('close',0));return child;
 }});
 const pending=client.request('workbuddyFill',{text:'fixture'},1000);const request=child.lines[0];child.stdio[3].write(JSON.stringify({id:1,requestId:request.id,operation:{action:'typeText',params:{text:'fixture'}},displayBounds:[{x:0,y:0,width:100,height:100}]})+'\n');await new Promise(r=>setImmediate(r));child.stdout.write(JSON.stringify({id:request.id,ok:false,error:'draft changed after input',dispatched:false})+'\n');await assert.rejects(pending,error=>error.dispatched===true&&error.inputOutcome.clipboardChanged===true);await client.close();
});

function inputLifecycleFixture(options={}) {
 const children=[],stops=[];let finishInput,releaseInput;
 const release=new Promise(resolve=>{releaseInput=resolve;});
 const boper={assertAvailable:()=>({backend:'virtual-hid'}),execute:()=>new Promise(resolve=>{finishInput=resolve;}),
  endScope:async(ownerId,scopeId)=>{stops.push({ownerId,scopeId});await release;return {releaseConfirmed:true};},
  cancelOwner:async()=>{throw Error('cleanup must identify the exact input scope');}};
 const client=new DesktopNative('/fixture/input-lifecycle',{...options,boper,inputContext:()=>({ownerId:'fixture-owner',validate:()=>true}),spawn:()=>{
  const child=new EventEmitter();child.lines=[];child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdin=new Writable({write(chunk,_encoding,done){child.lines.push(JSON.parse(chunk));if(options.delayedWrite)child.failWrite=()=>done(Error('synthetic write failure'));else done();}});
  child.stdio=[child.stdin,child.stdout,child.stderr,new PassThrough(),new Writable({write(_chunk,_encoding,done){done();}})];
  child.kill=()=>queueMicrotask(()=>child.emit('close',0));children.push(child);return child;
 }});
 const start=()=>{const request=client.request('type',{text:'synthetic'},1000),child=children.at(-1),message=child.lines.at(-1);
  child.stdio[3].write(JSON.stringify({id:1,requestId:message.id,operation:{action:'typeText',params:{text:'synthetic'}},displayBounds:[{x:0,y:0,width:100,height:100}]})+'\n');
  return {request,child,message};};
 return {client,children,stops,start,finish:value=>finishInput(value),release:()=>releaseInput()};
}

for(const cause of ['close','break','write-error'])test('input lifecycle '+cause+' stops its exact scope before rejecting an in-flight request',async()=>{
 const f=inputLifecycleFixture({delayedWrite:cause==='write-error'}),operation={id:'fixture-operation'};let current;
 const pending=require('../src/main/boper-outcome').collect(operation,()=>{current=f.start();return current.request;});
 let settled=false;const result=pending.then(value=>{settled=true;return value;},error=>{settled=true;return error;});
 try{
  await new Promise(resolve=>setImmediate(resolve));
  if(cause==='close')current.child.emit('close',1);else if(cause==='write-error')current.child.failWrite();else{current.child.kill=()=>{};current.child.stdin.emit('error',Error('synthetic broken pipe'));current.child.emit('close',1);}
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false,'request must retain GUI ownership until input release settles');
  assert.deepEqual(f.stops,[{ownerId:'fixture-owner',scopeId:f.client.diagnosticId+':'+current.message.id}]);
  f.release();const error=await result;assert(error instanceof Error);assert.equal(error.inputOutcome.completion,'unknown');assert.equal(error.inputOutcome.releaseConfirmed,true);await f.client.stopPromise;
  f.finish({dispatched:true,reportsSubmitted:4,clipboardChanged:true,completion:'local-submitted'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(operation.inputOutcome.completion,'unknown');assert.equal(operation.inputOutcome.dispatched,true);assert.equal(operation.inputOutcome.reportsSubmitted,4);assert.equal(operation.inputOutcome.clipboardChanged,true);
  assert.equal(f.stops.length,1,'late input receipt must not start another cleanup or replay');
 }finally{f.release();f.finish({dispatched:false,completion:'not-dispatched'});await f.client.close().catch(()=>{});await result;}
});

test('input lifecycle keeps response cleanup registered through process exit and isolates a later child',async()=>{
 const f=inputLifecycleFixture(),first=f.start();const firstResult=first.request.catch(error=>error);
 try{
  f.finish({dispatched:true,reportsSubmitted:4,clipboardChanged:true,completion:'local-submitted'});await new Promise(resolve=>setImmediate(resolve));
  first.child.stdout.write(JSON.stringify({id:first.message.id,ok:true,result:{performed:true}})+'\n');await new Promise(resolve=>setImmediate(resolve));
  first.child.emit('close',1);await new Promise(resolve=>setImmediate(resolve));
  const restart=f.client.request('frontmost');restart.catch(()=>{});assert.equal(f.children.length,1,'restart must wait for old input cleanup');await assert.rejects(restart,/正在停止/);
  assert.equal(f.stops.length,1);f.release();const receipt=await firstResult;assert.equal(receipt.performed,true);assert.equal(receipt.inputOutcome.dispatched,true);
  await f.client.stopPromise;
  const next=f.start(),nextResult=next.request.catch(error=>error);await new Promise(resolve=>setImmediate(resolve));
  first.child.emit('close',1);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.stops.length,1,'an old close cannot stop a new same-owner scope');
  f.finish({dispatched:true,reportsSubmitted:2,completion:'local-submitted'});await new Promise(resolve=>setImmediate(resolve));
  next.child.stdout.write(JSON.stringify({id:next.message.id,ok:true,result:{performed:true}})+'\n');assert.equal((await nextResult).performed,true);assert.equal(f.stops.length,2);
 }finally{f.release();await f.client.close().catch(()=>{});await firstResult;}
});

test('input lifecycle bounds missing release receipts and preserves an unknown outcome',async()=>{
 const f=inputLifecycleFixture({inputStopTimeoutMs:20}),current=f.start();const pending=current.request.catch(error=>error);
 try{
  await new Promise(resolve=>setImmediate(resolve));const before=Date.now();current.child.emit('close',1);const error=await pending;
  assert.equal(error.inputOutcome.completion,'unknown');assert.equal(error.inputOutcome.releaseConfirmed,false);assert(Date.now()-before<1000);
 }finally{f.release();f.finish({dispatched:false,completion:'not-dispatched'});await f.client.close().catch(()=>{});await pending;}
});

test('native key map explicitly covers ANSI letters, digits, editing keys, and F1-F12', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  const keyMap = source.slice(source.indexOf('func keyCode('), source.indexOf('func modifiers('));
  const modifierMap = source.slice(source.indexOf('func modifiers('), source.indexOf('func validateActionContext('));
  for (const key of 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) assert.match(keyMap, new RegExp(`\\"${key}\\"\\s*:`));
  for (const key of ['backspace', 'forwarddelete', 'f1', 'f12']) assert.match(keyMap, new RegExp(`\\"${key}\\"\\s*:`));
  assert.match(modifierMap, /case "command", "cmd": flags\.insert\(\.maskCommand\)/);
});

test('text validation preserves scalar values and delegates whole text after a fresh target check', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /for scalar in value\.unicodeScalars/);
  assert.match(source, /current\.count \+ units\.count > limit/);
  assert.match(source, /let \(currentId, _\) = try validateActionContext\(request\)[\s\S]{0,240}boperInput\("typeText"/);
});

test('environment screenshots exclusively use CG display pixels and retain private screenshot files', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /CGDisplayStream.showCursor: false/);
  assert.doesNotMatch(source, /ScreenCaptureKit|SCScreenshotManager|SCShareableContent|SCStream|AVCaptureScreenInput|AVCaptureSession/);
  assert.match(source, /E_CG_CAPTURE_UNAVAILABLE/);
  assert.match(source, /E_CG_CAPTURE_TIMEOUT/);
  assert.match(source, /defer \{ stream.stop\(\)/);
  assert.match(source, /open\(\$0, O_RDONLY \| O_DIRECTORY \| O_NOFOLLOW\)/);
  assert.match(source, /O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW, 0o600/);
});

test('locked-session guard covers capture, activate, and all input actions; permissions reports lock state', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /session\["CGSSessionScreenIsLocked"\]/);
  assert.match(source, /result\["sessionLocked"\] = checks\.contains\("sessionLocked"\) \? try checkedSessionLockState/);
  assert.match(source.slice(source.indexOf('func capture(_ request:'), source.indexOf('struct VisualROI:')), /guard !sessionLocked\(\)/);
  assert.match(source, /DispatchQueue\.global\(qos: \.userInitiated\)\.async/);
  assert.match(source, /RunLoop\.main\.run\(mode: \.default, before: Date\(timeIntervalSinceNow: 0\.1\)\)/);
});

test('type plans reject implicit newlines and controls, emit explicit soft breaks, and preserve surrogate pairs', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /func makeInputPlan\(_ value: String, lineBreak: Any\? = nil\)/);
  assert.match(source, /value\.replacingOccurrences\(of: "\\r\\n", with: "\\n"\)/);
  assert.match(source, /scalar\.value <= 0x1f && scalar\.value != 0x0a/);
  assert.match(source, /func postShiftReturn[\s\S]{0,240}"modifiers": \["shift"\][\s\S]{0,180}boperInput\("key"/);
  assert.match(source, /guard !sessionLocked\(\) else \{ throw DesktopError\(message: "电脑已锁屏，请解锁后重试"\) \}/);
  const run = spawnSync(nativeTestBinary(), ['--self-test-native'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.selfTest, 'native');
  assert.deepEqual(result.capturePixelSize, [840, 630]);
  assert.equal(result.captureBackend, 'CGDisplayStream');
  assert.deepEqual(result.rectCases, ['CGWindowBounds', 'lowercase']);
  assert.equal(result.invalidRectsRejected, 5);
  assert.deepEqual(result.multilineEvents, ['text:A', 'shiftEnter', 'text:B', 'shiftEnter', 'text:C']);
  assert.deepEqual(result.surrogateChunkSizes, [19, 3]);
});

test('legacy window sampling is disabled while bounded pixel comparison helpers remain available', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  const visual = source.slice(source.indexOf('func captureVisualFrame('), source.indexOf('func recognizePNG('));
  assert.match(source, /func normalizedVisualRegions\(_ value: Any\?, defaultMinChangedRatio: Double = 0\.001\)/);
  assert.match(source, /\(1\.\.\.4\)\.contains\(rows\.count\)/);
  assert.match(source, /let visualRegionMaxSide = 320/);
  assert.match(source, /let visualSampleCapacity = 8/);
  assert.match(source, /func compareVisualRegion\(_ baseline: VisualRegionFrame, _ current: VisualRegionFrame, threshold: Int\)/);
  assert.match(source, /func visualChangedMask\(_ baseline: VisualRegionFrame, _ current: VisualRegionFrame, threshold: Int\)/);
  assert.match(source, /stableChangedPixels/);
  assert.match(source, /func visualCommit\(_ request: \[String: Any\]\)/);
  assert.match(source, /func resetVisualBaseline\(_ id: String\)/);
  assert.match(source, /func visualForget\(_ request: \[String: Any\]\)/);
  assert.match(source, /if shouldIncludeVisualImage\(changed: changed, reset: reset/);
  assert.match(source, /shouldIncludeVisualImage\(changed: changed, reset: reset, geometryChanged: geometryChanged,[\s\S]{0,120}hasBaseline: hasBaseline/);
  assert.match(source, /NSRunningApplication\(processIdentifier: pid_t\(pid\)\)\?\.bundleIdentifier/);
  assert.match(source, /case "visualSample": throw DesktopError\(message:[^\n]+E_LEGACY_CAPTURE_DISABLED/);
  assert.doesNotMatch(visual, /AXUIElement|AppleScript|NSWorkspace\.shared\.frontmostApplication/);
  assert.match(source, /CGEventSource\.secondsSinceLastEventType\(\.hidSystemState, eventType: anyInput\)/);
  assert.match(source, /CGEventSource\.secondsSinceLastEventType\(\.combinedSessionState, eventType: anyInput\)/);
  const run = spawnSync(nativeTestBinary(), ['--self-test-visual'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.legacyVisualSampleDisabled, true);
  assert.equal(result.visualCapacity, 8);
  assert.equal(result.inputIdleReadOnly, true);
  assert.deepEqual(result.syntheticSidebarBadgePixels, [4, 12, 18]);
  assert.equal(result.syntheticStableOverlap, 4);
});

test('rectFrom accepts CGWindowBounds casing and preserves dimension validation', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /v\["x"\] \?\? v\["X"\]/);
  assert.match(source, /v\["y"\] \?\? v\["Y"\]/);
  assert.match(source, /v\["width"\] \?\? v\["Width"\]/);
  assert.match(source, /v\["height"\] \?\? v\["Height"\]/);
  assert.match(source, /\[x, y, w, h\]\.allSatisfy\(\{ \$0\.isFinite \}\)/);
  assert.match(source, /w < 100_000, h < 100_000/);
});

test('WorkBuddy semantic path retains exact identity and draft guards with bounded foreground fallbacks', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  const context = source.slice(source.indexOf('func workBuddyControls('), source.indexOf('func workBuddyInspect('));
  assert.ok(context.indexOf('validateWorkBuddyContext(request)') < context.indexOf('AXUIElementCreateApplication'));
  assert.match(source, /workBuddyBundleAllowed\(front\.bundleIdentifier\)/);
  assert.match(source, /let workBuddyBundleID = "com\.tencent\.workbuddy\.mac"/);
  assert.match(source, /func workBuddyMarkerAllowed\(_ marker: String\?\)/);
  assert.match(source, /func workBuddyTargetReady\(mode: String, homeReady: Bool, conversationMarkerPresent: Bool\)/);
  assert.match(source, /mode == "conversation" && workBuddyMarkerAllowed\(marker\)/);
  assert.match(source, /if !insideEditor && !isEditor, let associationMarker/);
  assert.match(source, /let frame = axWindowRect\(element\)[\s\S]{0,180}rectIntersects\(frame, targetRect\)/);
  assert.match(source, /"conversationReady": controls\.associationMarkerPresent/);
  assert.match(source, /abs\(lhs\.minX-rhs\.minX\) <= 2/);
  assert.match(source, /AXUIElementSetMessagingTimeout\(element, 0\.2\)/);
  assert.match(source, /visited >= 2000/);
  assert.match(source, /let workBuddyMaxAXDepth = 48/);
  assert.match(source, /func workBuddyCanDescend\(depth: Int, childCount: Int/);
  assert.match(source, /depthCutoff = true/);
  assert.match(source, /"visitedNodes": controls\.visitedNodes/);
  assert.match(source, /"markerFrameMissing": controls\.markerFrameMissing/);
  assert.match(source, /"markerFrameOutsideTarget": controls\.markerFrameOutsideTarget/);
  assert.match(source, /2_000_000_000/);
  assert.match(source, /role == kAXTextAreaRole/);
  assert.match(source, /description\.hasPrefix\("Select model:"\)/);
  assert.match(source, /role == kAXHeadingRole[\s\S]{0,420}workBuddyHeadingHomeReady\(value: value, title: title, description: description\)/);
  assert.match(source, /== "发送"/);
  assert.match(source, /description == "发送"/);
  assert.match(source, /workBuddyReadbackFlags\(actual: finalReadback, expected: expectedText\)\.matches/);
  assert.match(source, /func workBuddyDraftIsEmpty\(_ raw: String\?/);
  assert.match(source, /raw == "\\u\{FEFF\}"/);
  assert.match(source, /if !expected\.hasPrefix\("\\u\{FEFF\}"\) && comparable\.hasPrefix\("\\u\{FEFF\}"\) \{ comparable\.removeFirst\(\) \}/);
  assert.match(source, /workBuddyDraftIsEmpty\(controls\.draft, sendButtonCount:/);
  assert.match(source, /workBuddyTextMatches\(controls\.draft, expected: text\)/);
  assert.match(source, /raw == workBuddyRTEEmptyValue && sendButtonCount == 1 && !sendEnabled/);
  assert.match(source, /workBuddyDraftPlan\(current: workBuddyRTEEmptyValue, requested: "task text", sendButtonCount: 1, sendEnabled: false\)/);
  assert.match(source, /draftMatchesRequest = available && workBuddyTargetReady\(mode: mode, homeReady: controls\.homeReady, conversationMarkerPresent: controls\.associationMarkerPresent\) && workBuddyModelLabelAllowed\(controls\.selectedModel\)/);
  assert.match(source, /components\(separatedBy: "\\n"\)/);
  assert.match(source, /expectedLine\.isEmpty && actualLine == "\\u\{FEFF\}"/);
  const textMatch = source.slice(source.indexOf('func workBuddyTextMatches('), source.indexOf('func workBuddyDraftPlan('));
  assert.doesNotMatch(textMatch, /trimmingCharacters/);
  assert.doesNotMatch(source, /func canonicalWorkBuddyText/);
  assert.match(source, /makeInputPlan\(text, lineBreak: "shiftEnter"\)/);
  assert.match(source, /func postUnicodeText\(_ units: \[UInt16\], targetPID: pid_t\? = nil\)/);
  assert.match(source, /func postShiftReturn\(targetPID: pid_t\? = nil\)/);
  assert.doesNotMatch(source, /\.post\(|postToPid\(|CGEvent\(/);
  assert.match(source, /boperInput\("typeText", inputParams\)/);
  assert.match(source, /AXUIElementSetAttributeValue\(editor, kAXFocusedAttribute/);
  assert.match(source, /kAXFocusedUIElementAttribute/);
  assert.match(source, /waitDeadline = DispatchTime\.now\(\)\.uptimeNanoseconds \+ 800_000_000/);
  assert.doesNotMatch(source, /AXUIElementSetAttributeValue\(editor, kAXValueAttribute[^\n]*text/);
  const send = source.slice(source.indexOf('func workBuddySend('), source.indexOf('func unicodeChunks('));
  assert.match(send, /if background \{\s+let result = AXUIElementPerformAction\(button/);
  assert.ok(send.indexOf('workBuddyTextMatches(controls.draft, expected: text)') < send.indexOf('AXUIElementPerformAction'));
  assert.match(send, /approvedWorkBuddySendPoint\(request, buttonRect: buttonRect, windowRect: context\.rect\)/);
  assert.match(send, /approvedWorkBuddySendPoint\(request, buttonRect: currentButtonRect, windowRect: context\.rect\)/);
  assert.match(send, /kAXFocusedWindowAttribute/);
  assert.match(send, /rectsMatch\(focusedRect, context\.rect\)/);
  assert.doesNotMatch(send, /CGPreflightPostEventAccess\(\)/);
  assert.match(send, /workBuddyTextMatches\(axAttribute\(editor/);
  assert.match(send, /try postClick\(clickPoint\)/);
  assert.equal((send.match(/try postClick/g) || []).length, 1);
  assert.match(source, /case "workbuddyInspect"/);
  assert.match(source, /case "workbuddyFill"/);
  assert.match(source, /case "workbuddySend"/);
  const run = spawnSync(nativeTestBinary(), ['--self-test-workbuddy'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout.trim()).workBuddyGuards, true);
  assert.equal(JSON.parse(run.stdout.trim()).workBuddyConversationGuard, true);
  assert.equal(JSON.parse(run.stdout.trim()).workBuddyReadbackGuards, true);
  assert.equal(JSON.parse(run.stdout.trim()).workBuddySerializedMatch, true);
  const rejected = spawnSync(nativeTestBinary(), [], {
    encoding: 'utf8', timeout: 5000,
    input: `${JSON.stringify({ id: 'wrong-bundle', op: 'workbuddyInspect', windowId: 1,
      expected: { pid: 1, bundleId: 'com.tencent.wechat' }, sentAtMs: Date.now(), timeoutMs: 1000 })}\n`,
  });
  assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
  const response = JSON.parse(rejected.stdout.trim());
  assert.equal(response.ok, false);
  assert.match(response.error, /仅允许目标应用 com\.tencent\.workbuddy\.mac/);
  const invalidMarker = spawnSync(nativeTestBinary(), [], {
    encoding: 'utf8', timeout: 5000,
    input: `${JSON.stringify({ id: 'invalid-marker', op: 'workbuddyInspect', mode: 'conversation', marker: '[workbunny:invalid]', windowId: 1,
      expected: { pid: 1, bundleId: 'com.tencent.workbuddy.mac' }, sentAtMs: Date.now(), timeoutMs: 1000 })}\n`,
  });
  assert.equal(invalidMarker.status, 0, invalidMarker.stderr || invalidMarker.stdout);
  assert.match(JSON.parse(invalidMarker.stdout.trim()).error, /模式或会话关联标记无效/);
});

test('close kills and waits; cancel kills, waits, and permits a later restart', async () => {
  const { client, children } = fixture();
  const pending = client.request('frontmost');
  const first = children[0]; const signals = [];
  first.kill = signal => { signals.push(signal); process.nextTick(() => first.emit('close', null, signal)); return true; };
  const closing = client.close();
  await assert.rejects(pending, /已取消/);
  await closing;
  assert.deepEqual(signals, ['SIGTERM']);
  await assert.rejects(client.request('permissions'), /已关闭/);

  const restart = fixture();
  const inFlight = restart.client.request('frontmost');
  const current = restart.children[0]; const cancelSignals = [];
  current.kill = signal => { cancelSignals.push(signal); process.nextTick(() => current.emit('close', null, signal)); return true; };
  const cancelling = restart.client.cancel();
  await assert.rejects(inFlight, /已取消/);
  await cancelling;
  assert.deepEqual(cancelSignals, ['SIGTERM']);
  const next = restart.client.request('permissions');
  assert.equal(restart.children.length, 2);
  const request = JSON.parse(restart.children[1].lines[0]);
  restart.children[1].stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { ok: true } })}\n`);
  assert.deepEqual(await next, { ok: true });
});

test('stdin errors reject pending requests and response lines have a byte limit', async () => {
  const { client, children } = fixture({ maxResponseLineBytes: 8 });
  const pending = client.request('frontmost');
  children[0].stdin.emit('error', new Error('pipe broke'));
  await assert.rejects(pending, /stdin 错误/);

  const other = fixture({ maxResponseLineBytes: 8 });
  const tooLarge = other.client.request('permissions');
  other.children[0].stdout.write(Buffer.from('123456789'));
  await assert.rejects(tooLarge, /超过 64 MiB/);
});

test('capture timeout reaps bridge and retries once; input is never replayed', async () => {
  const { client, children } = fixture();
  const result = client.request('capture', { output: 'base64', region: {x: 0, y: 0, width: 20, height: 20} }, 1000);
  const first = children[0];
  first.kill = () => { process.nextTick(() => first.emit('close', null, 'SIGTERM')); return true; };
  const firstRequest = JSON.parse(first.lines[0]);
  first.stdout.write(JSON.stringify({ id: firstRequest.id, ok: false, error: '截图请求超时：图像采集' }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 2);
  const second = children[1];
  const secondRequest = JSON.parse(second.lines[0]);
  assert.equal(secondRequest.op, 'capture');
  assert.equal(Object.hasOwn(secondRequest, 'captureMode'), false);
  assert.deepEqual(secondRequest.region, {x: 0, y: 0, width: 20, height: 20});
  second.stdout.write(JSON.stringify({ id: secondRequest.id, ok: true, result: { width: 20 } }) + '\n');
  assert.deepEqual(await result, { width: 20 });
  const write = client.request('type', { text: 'x' }, 1000);
  const writeRequest = JSON.parse(second.lines.at(-1));
  second.stdout.write(JSON.stringify({ id: writeRequest.id, ok: false, error: '截图请求超时：图像采集' }) + '\n');
  await assert.rejects(write, /截图请求超时/);
  assert.equal(children.length, 2);
  second.kill = () => { process.nextTick(() => second.emit('close', null, 'SIGTERM')); return true; };
  await client.close();
});
test('display pixel timeout retries the same display-only request and never replays input or falls back to a window API',async()=>{
 const {client,children}=fixture(),result=client.request('displayCapture',{output:'base64'},1000),first=children[0];first.kill=()=>process.nextTick(()=>first.emit('close',null,'SIGTERM'));
 first.stdout.write(JSON.stringify({id:JSON.parse(first.lines[0]).id,ok:false,error:'截图请求超时：显示像素'})+'\n');await new Promise(resolve=>setImmediate(resolve));assert.equal(children.length,2);
 const second=children[1],request=JSON.parse(second.lines[0]);assert.equal(request.op,'displayCapture');assert.equal(request.output,'base64');for(const key of ['windowId','expected','bundleId','pid','captureMode'])assert.equal(Object.hasOwn(request,key),false);
 second.stdout.write(JSON.stringify({id:request.id,ok:true,result:{frame:2}})+'\n');assert.deepEqual(await result,{frame:2});const input=client.request('displayInput',{action:'key'},1000),write=JSON.parse(second.lines.at(-1));second.stdout.write(JSON.stringify({id:write.id,ok:false,error:'截图请求超时：输入回执缺失'})+'\n');await assert.rejects(input,/输入回执缺失/);assert.equal(children.length,2);second.kill=()=>process.nextTick(()=>second.emit('close',0));await client.close();
});

test('second capture timeout reaps bridge without a third attempt', async () => {
  const { client, children } = fixture();
  const result = client.request('capture', { output: 'base64', region: {x: 0, y: 0, width: 20, height: 20} }, 1000);
  const fail = child => {
    child.kill = () => { process.nextTick(() => child.emit('close', null, 'SIGTERM')); return true; };
    const request = JSON.parse(child.lines[0]);
    child.stdout.write(JSON.stringify({ id: request.id, ok: false, error: '截图请求超时：窗口枚举' }) + '\n');
  };
  fail(children[0]);
  await new Promise(resolve => setImmediate(resolve));
  fail(children[1]);
  await assert.rejects(result, /窗口枚举/);
  assert.equal(children.length, 2);
  assert.equal(client.proc, null);
});

test('captureUnavailable is propagated and does not retry or emit input', async () => {
  const { client, children } = fixture();
  const pending = client.request('capture', { output: 'base64', region: {x: 0, y: 0, width: 20, height: 20} }, 1000);
  const child = children[0];
  const request = JSON.parse(child.lines[0]);
  child.stdout.write(JSON.stringify({ id: request.id, ok: false, code: 'captureUnavailable', error: '当前窗口截图不可用或受到系统截图限制；已停止视觉操作' }) + '\n');
  await assert.rejects(pending, error => error.code === 'captureUnavailable' && /截图不可用/.test(error.message));
  assert.equal(children.length, 1);
  assert.equal(child.lines.length, 1);
  child.kill = () => { process.nextTick(() => child.emit('close', null, 'SIGTERM')); return true; };
  await client.close();
});


test('legacy native screenshot requests fail before any permission or target discovery', t => {
  const binary = process.env.WORKBUNNY_NATIVE_TEST_BINARY;
  if (!binary) return t.skip('requires the coordinated temporary native build');
  for (const body of [{op:'capture',windowId:1},{op:'capture',pid:1},{op:'capture',captureMode:'displayCrop'},{op:'visualSample',windowId:1,sampleId:'legacy'}]) {
    const run = spawnSync(binary, [], {encoding:'utf8',timeout:3000,input:JSON.stringify({id:'legacy',sentAtMs:Date.now(),timeoutMs:1000,...body})+'\n'});
    assert.equal(run.status, 0, run.stderr);
    const response=JSON.parse(run.stdout.trim());
    assert.equal(response.ok, false);
    assert.equal(response.code, 'E_LEGACY_CAPTURE_DISABLED');
    assert.equal(response.dispatched, false);
  }
});
