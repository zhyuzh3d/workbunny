'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AuthorizationService}=require('../src/main/authorization-service'),{AgentService}=require('../src/main/agent-service');
const {terminalArgs,executeTerminal}=require('../src/main/system-tools');
test('grants distinguish terminal, configuration and actual OS capabilities',async()=>{
 const notifications=[];let flags={},system={screenCaptureAllowed:false,accessibilityTrusted:true,postEventAllowed:true};
 const auth=new AuthorizationService({settings:()=>flags,permissions:async()=>system,onMissing:async e=>notifications.push(e)}),task={id:'one',goal:'test'};
 await assert.rejects(auth.check({name:'terminal.execute'},{impact:'read'},task),e=>e.code==='E_PERMISSION_REQUIRED');
 await assert.rejects(auth.check({name:'terminal.execute'},{impact:'read'},task));assert.equal(notifications.length,1);
 flags.terminal=true;await auth.check({name:'terminal.execute'},{impact:'read'},task);
 await assert.rejects(auth.check({name:'terminal.execute'},{impact:'configuration'},task),e=>e.missing.includes('systemConfiguration'));
 flags.systemConfiguration=true;await auth.check({name:'terminal.execute'},{impact:'configuration'},task);
 await assert.rejects(auth.check({name:'work.submit'},{},task),e=>e.missing.includes('screenCaptureAllowed'));system.screenCaptureAllowed=true;await auth.check({name:'work.submit'},{},task);
});
test('a permission wait persists without retries and continues the same real command after a grant',async()=>{
 const records=new Map();let enabled=false,notices=0,decisions=0;
 const authorization=new AuthorizationService({settings:()=>({terminal:enabled}),onMissing:async()=>notices++});
 const scene={metrics:{},native:{request:async()=>({})},close:async()=>{}};
 const agent=new AgentService({scene,authorization,ready:()=>true,epoch:()=>1,autoSchedule:false,journal:{put:async t=>records.set(t.id,structuredClone(t)),list:async()=>[...records.values()],authorized:async()=>true},
 request:async()=>({response:{text:JSON.stringify(decisions++<1?{done:false,tool:'terminal.execute',args:{application:'system',command:'/usr/bin/uname',args:['-s'],purpose:'只读核对内核名称',impact:'read'}}:{done:true,summary:'内核为 Darwin。'})}})});
 const started=await agent.start({skill:'system.operate',goal:'核对内核名称',subjects:[{application:'system'}]},{role:'owner',verified:true,channel:'dialogue',sources:['owner'],scene:'life'});
 await agent.runtime.tick(started.id);assert.equal(agent.runtime.tasks.get(started.id).status,'waiting_permission');assert.equal(notices,1);await agent.runtime.tick(started.id);assert.equal(decisions,1);
 await agent.restore();assert.equal(agent.runtime.tasks.get(started.id).status,'waiting_permission');enabled=true;await agent.refreshPermissions();await agent.runtime.tick(started.id);await agent.runtime.tick(started.id);
 const task=agent.runtime.tasks.get(started.id);assert.equal(task.status,'completed');assert.match(task.state.attempts[0].result.stdout,/Darwin/);assert.equal(task.counters.writes,1);await agent.close();
});
test('the process tool records actual failure output without treating it as successful business completion',async()=>{
 const args=terminalArgs({application:'system',command:'/bin/sh',args:['-c','exit 7'],impact:'read',purpose:'test failed status',timeoutSeconds:2});
 const result=await executeTerminal(args,{task:{id:'local-test'},directory:require('os').tmpdir()});assert.equal(result.exitCode,7);assert.equal(result.verified,true);
 assert.throws(()=>terminalArgs({...args,command:'/usr/bin/sudo'}),/超出/);
});
test('stopping a permission-waiting task clears its guide without granting permission or executing the command',async()=>{
 const resolved=[],authorization=new AuthorizationService({settings:()=>({terminal:false}),onResolved:async id=>resolved.push(id)});
 const agent=new AgentService({authorization,scene:{metrics:{},native:{request:async()=>({})},close:async()=>{}},ready:()=>true,epoch:()=>1,autoSchedule:false,journal:{put:async()=>{},list:async()=>[],authorized:async()=>true},request:async()=>({response:{text:JSON.stringify({done:false,tool:'terminal.execute',args:{application:'system',command:'/usr/bin/uname',args:['-s'],purpose:'只读检查',impact:'read'}})}})});
 try{const created=await agent.start({skill:'system.operate',goal:'核对内核名称',subjects:[{application:'system'}]},{role:'owner',verified:true,channel:'dialogue',sources:['owner'],scene:'life'});await agent.runtime.tick(created.id);const task=agent.runtime.tasks.get(created.id);assert.equal(task.status,'waiting_permission');assert(task.state.permissionRequest);await agent.control('stop',task.id);assert.equal(task.status,'stopped');assert.equal(task.state.permissionRequest,undefined);assert(resolved.includes(task.id));assert.equal(task.counters.writes,0);}finally{await agent.close();}
});
test('a real reversible preference keeps its type, restores absence, and preserves intervening owner edits',async()=>{
 const {ToolRegistry}=require('../src/main/agent-tools'),{registerSystemTools,readPreference}=require('../src/main/system-tools');
 const registry=new ToolRegistry();let saves=0;registerSystemTools(registry,{checkpoint:async()=>saves++});
 const domain='cn.haminn.workbunny.test.'+require('crypto').randomBytes(6).toString('hex'),task={state:{}},key='ScratchValue';
 const configure=registry.get('system.configure'),restore=registry.get('system.restore');
 try{
  const args=configure.validate({application:'system',domain,key,type:'bool',value:'true'});
  const first=await configure.execute(args,{task,operationId:'first'});assert.equal(first.receipt.observed.value,'1');assert(saves>0);
  await restore.execute({application:'system',snapshotId:'first'},{task});assert.equal(await readPreference(domain,key),null);
  await configure.execute(args,{task,operationId:'second'});
  await configure.execute({...args,type:'string',value:'owner change'},{task,operationId:'third'});
  await assert.rejects(restore.execute({application:'system',snapshotId:'second'},{task}),/另行修改/);
  assert.equal((await readPreference(domain,key)).value,'owner change');
  await restore.execute({snapshotId:'third'},{task});await restore.execute({snapshotId:'second'},{task});assert.equal(await readPreference(domain,key),null);
 }finally{require('child_process').spawnSync('/usr/bin/defaults',['delete',domain]);}
});
