'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {execFile}=require('node:child_process');
const {SCHEMA,LocalControl,ownerMethods,socketPath,sendRequest,randomUUID}=require('../src/main/local-control');
async function fixture(t,options={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),'wbctl-'));let scene='life';const calls=[];const endpoint=socketPath(root),server=new LocalControl({endpoint,methods:ownerMethods({getScene:()=>scene,setScene:async value=>{calls.push(['scene',value]);await options.setScene?.(value);scene=value;},boperControl:async action=>{calls.push(['boper',action]);return {state:'ready',backend:'virtual-hid',action};}}),...options});await server.start();t.after(async()=>{await server.close();await fs.rm(root,{recursive:true,force:true});});const rpc=(method,params={})=>sendRequest(endpoint,{schema:SCHEMA,id:randomUUID(),method,params});const call=(name,args={})=>rpc('tools.call',{name,arguments:args});return {root,endpoint,server,calls,rpc,call};}
test('private host registry publishes JSON Schemas and routes only owner scene/BOPER controls',async t=>{
 const f=await fixture(t);assert.equal((await fs.stat(path.dirname(f.endpoint))).mode&0o777,0o700);assert.equal((await fs.stat(f.endpoint)).mode&0o777,0o600);
 const listed=await f.rpc('tools.list');assert.equal(listed.ok,true);assert.deepEqual(listed.result.tools.map(t=>t.name),['scene_get','scene_set','boper_status','boper_enable','boper_disable','boper_refresh','boper_settings','boper_test','boper_permissions','boper_authorize_screen']);assert(listed.result.tools.every(t=>t.inputSchema.type==='object'&&t.inputSchema.additionalProperties===false));
 assert.deepEqual((await f.call('scene_get')).result.structuredContent,{scene:'life'});assert.equal((await f.call('scene_set',{scene:'life'})).result.isError,false);assert.deepEqual(f.calls,[['scene','life']]);assert.equal((await f.call('boper_status')).result.structuredContent.action,'status');
 const unknown=await f.call('conversation_history');assert.equal(unknown.ok,false);assert.equal(unknown.error.code,'E_LOCAL_METHOD');const invalid=await f.call('scene_set',{scene:'invalid'});assert.equal(invalid.result.isError,true);assert.equal(invalid.result.structuredContent.error.code,'E_LOCAL_PARAMS');assert.equal(f.calls.length,2);
});
test('speech controls use the shared registry, validate strict bounded arguments and refuse non-life scenes',async t=>{
 let scene='life';const calls=[],root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-speech-control-'));
 const server=new LocalControl({endpoint:socketPath(root),methods:ownerMethods({getScene:()=>scene,setScene:()=>{},boperControl:()=>({}),speechControl:async(params,context)=>{calls.push({params,signal:context.signal});return {active:params.action==='diagnostic_start'};}})});
 await server.start();t.after(async()=>{await server.close();await fs.rm(root,{recursive:true,force:true});});
 const call=params=>sendRequest(server.endpoint,{schema:SCHEMA,id:randomUUID(),method:'tools.call',params:{name:'speech_control',arguments:params}});
 assert.equal((await call({action:'diagnostic_start',durationMs:20000,pcm:false})).result.structuredContent.active,true);assert(calls[0].signal instanceof AbortSignal);
 for(const args of [{action:'diagnostic_start',durationMs:20001},{action:'diagnostic_start',pcm:'true'},{action:'listen'},{action:'status',on:true},{action:'read_transcript'},{action:'diagnostic_start',directory:'/untrusted'}])assert.equal((await call(args)).result.structuredContent.error.code,'E_LOCAL_PARAMS');
 for(scene of ['private','work'])assert.equal((await call({action:'status'})).result.structuredContent.error.code,'E_LOCAL_SCENE');
 assert.equal(calls.length,1);
});
test('task inspection uses the shared registry with a single ID, cancellation and life-scene isolation',async t=>{
 let scene='life';const calls=[],root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-task-control-'));
 const server=new LocalControl({endpoint:socketPath(root),methods:ownerMethods({getScene:()=>scene,setScene:()=>{},boperControl:()=>({}),inspectTask:async(params,context)=>{calls.push({params,signal:context.signal});return {ok:true,id:params.id,artifact:{path:'/synthetic/private/task.json'}};}})});
 await server.start();t.after(async()=>{await server.close();await fs.rm(root,{recursive:true,force:true});});
 const call=args=>sendRequest(server.endpoint,{schema:SCHEMA,id:randomUUID(),method:'tools.call',params:{name:'task_inspect',arguments:args}});
 const result=await call({id:'synthetic-task'});assert.equal(result.result.structuredContent.id,'synthetic-task');assert(calls[0].signal instanceof AbortSignal);
 for(const args of [{},{id:'../other'},{id:'task',scene:'private'},{id:'task',directory:'/other'}])assert.equal((await call(args)).result.structuredContent.error.code,'E_LOCAL_PARAMS');
 for(scene of ['work','private'])assert.equal((await call({id:'synthetic-task'})).result.structuredContent.error.code,'E_LOCAL_SCENE');assert.equal(calls.length,1);
});
test('registered task tools validate exact targets and keep status available during a pending owner mutation',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),calls=[],root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-task-tools-'));
 const taskControls={list:async p=>({ok:true,tasks:[{id:'new-task',createdAt:p.since}]}),status:async p=>({ok:true,id:p.id,status:'paused'}),control:async(p,c)=>{calls.push({p,signal:c.signal});entered.resolve();await release.promise;return {ok:true};},command:async p=>({ok:true,id:'new-task'})};
 const server=new LocalControl({endpoint:socketPath(root),methods:ownerMethods({getScene:()=> 'life',setScene:()=>{},boperControl:()=>({}),taskControls})});await server.start();
 t.after(async()=>{release.resolve();await server.close();await fs.rm(root,{recursive:true,force:true});});
 const call=(name,args)=>sendRequest(server.endpoint,{schema:SCHEMA,id:randomUUID(),method:'tools.call',params:{name,arguments:args}});
 assert.deepEqual((await call('task_list',{since:100,limit:1})).result.structuredContent.tasks,[{id:'new-task',createdAt:100}]);for(const args of [{},{since:-1},{since:100,limit:21},{since:100,goal:'no-content-query'}])assert.equal((await call('task_list',args)).result.structuredContent.error.code,'E_LOCAL_PARAMS');
 const pending=call('task_control',{id:'synthetic',operation:'upgrade'});await entered.promise;assert.equal((await call('task_status',{id:'synthetic'})).result.structuredContent.status,'paused');
 assert.equal((await call('task_control',{id:'synthetic',operation:'resume'})).result.structuredContent.error.code,'E_LOCAL_BUSY');release.resolve();await pending;
 for(const args of [{id:'../private',operation:'resume'},{id:'synthetic',operation:'execute'},{id:'synthetic',operation:'resume',scene:'private'}])assert.equal((await call('task_control',args)).result.structuredContent.error.code,'E_LOCAL_PARAMS');
 assert.equal(calls.length,1);assert(calls[0].signal instanceof AbortSignal);assert.equal((await call('task_command',{text:'synthetic goal'})).result.structuredContent.id,'new-task');
});
test('mutations remain serialized while status stays available and timed-out work is never replayed',async t=>{
 const gate=Promise.withResolvers(),entered=Promise.withResolvers();const f=await fixture(t,{timeoutMs:60,setScene:async()=>{entered.resolve();await gate.promise;}});const pending=f.call('scene_set',{scene:'life'});await entered.promise;assert.equal((await f.call('scene_get')).result.structuredContent.scene,'life');assert.equal((await f.call('boper_enable')).result.isError,true);const timeout=await pending;assert.equal(timeout.error.code,'E_LOCAL_TIMEOUT');assert.equal(f.calls.filter(x=>x[0]==='scene').length,1);assert.equal((await f.call('boper_test')).result.structuredContent.error.code,'E_LOCAL_BUSY');gate.resolve();await new Promise(r=>setImmediate(r));
});
test('socket startup refuses an occupied endpoint and never replaces a regular file',async t=>{
 const f=await fixture(t),second=new LocalControl({endpoint:f.endpoint});await assert.rejects(second.start(),{code:'E_LOCAL_ALREADY_RUNNING'});const file=path.join(f.root,'regular');await fs.writeFile(file,'synthetic owner material');const bad=new LocalControl({endpoint:file});await assert.rejects(bad.start(),{code:'E_LOCAL_PATH'});assert.equal(await fs.readFile(file,'utf8'),'synthetic owner material');
});
test('oversized requests fail before dispatch',async t=>{
 const f=await fixture(t);const response=await new Promise((resolve,reject)=>{const socket=net.createConnection(f.endpoint);let line='';socket.once('error',reject);socket.once('connect',()=>socket.write('x'.repeat(17000)+'\n'));socket.on('data',chunk=>{line+=chunk;if(line.includes('\n'))resolve(JSON.parse(line));});socket.once('end',()=>socket.destroy());});assert.equal(response.error.code,'E_LOCAL_REQUEST_LIMIT');assert.equal(f.calls.length,0);
});
test('official SDK Client negotiates MCP 2025-11-25 and discovers/calls the real stdio bridge',async t=>{
 const f=await fixture(t),{Client}=require('@modelcontextprotocol/sdk/client/index.js'),{StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');const client=new Client({name:'synthetic-local-control-test',version:'1.0.0'},{capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'../tools/bunny-mcp.cjs'),'--socket',f.endpoint],stderr:'pipe',maxBufferSize:256*1024});t.after(()=>client.close());let negotiated;const original=client.request.bind(client);client.request=async(request,...rest)=>{const result=await original(request,...rest);if(request.method==='initialize')negotiated=result.protocolVersion;return result;};await client.connect(transport,{timeout:5000});assert.equal(negotiated,'2025-11-25');assert(client.getServerCapabilities().tools);const tools=await client.listTools();assert.equal(tools.tools.length,10);
 const result=await client.callTool({name:'scene_get',arguments:{}});assert.deepEqual(result.structuredContent,{scene:'life'});assert.equal(result.isError,false);assert.equal(result.content[0].text,JSON.stringify(result.structuredContent));const invalid=await client.callTool({name:'scene_set',arguments:{scene:'invalid'}});assert.equal(invalid.isError,true);await assert.rejects(client.callTool({name:'conversation_history',arguments:{}}),error=>error.code===-32602);
});
test('bunnyctl is an official MCP client with one JSON result and no native binding or conversation access',async t=>{
 const f=await fixture(t);const run=await new Promise((resolve,reject)=>execFile(process.execPath,[path.join(__dirname,'../tools/bunnyctl.cjs'),'--socket',f.endpoint,'scene','set','life'],{timeout:6000},(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr})));const lines=run.stdout.trim().split('\n');assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).structuredContent.scene,'life');assert.equal(run.stderr,'');assert.deepEqual(f.calls,[['scene','life']]);
 const source=await fs.readFile(path.join(__dirname,'../src/main/index.js'),'utf8');assert.match(source,/setScene:scene=>applySettings\(\{memory:\{scene\}\}\)/);assert.match(source,/pet:boper-control'[\s\S]{0,150}return controlBoper\(action\)/);
});
test('task_evidence is registered read-only, requires exact bounded crop arguments and refuses other scenes',async t=>{
 let scene='life';const calls=[],root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-evidence-control-'));
 const server=new LocalControl({endpoint:socketPath(root),methods:ownerMethods({getScene:()=>scene,setScene:()=>{},boperControl:()=>({}),inspectTaskEvidence:async(p,c)=>{calls.push({p,signal:c.signal});return {ok:true,id:p.id,artifact:{path:'/synthetic/private/crop.png'}};}})});await server.start();t.after(async()=>{await server.close();await fs.rm(root,{recursive:true,force:true});});
 const params={id:'synthetic-task',session:'00000000-0000-4000-8000-000000000001',incidentId:'a'.repeat(32),captureId:'b'.repeat(32),region:{x:1,y:2,width:100,height:20}},call=p=>sendRequest(server.endpoint,{schema:SCHEMA,id:randomUUID(),method:'tools.call',params:{name:'task_evidence',arguments:p}});
 assert.equal((await call(params)).result.structuredContent.ok,true);assert(calls[0].signal instanceof AbortSignal);for(const p of [{...params,region:undefined},{...params,region:{x:0,y:0,width:1000,height:1000}},{...params,path:'/other'},{...params,id:'../other'}])assert.equal((await call(p)).result.structuredContent.error.code,'E_LOCAL_PARAMS');
 scene='private';assert.equal((await call(params)).result.structuredContent.error.code,'E_LOCAL_SCENE');assert.equal(calls.length,1);
});
