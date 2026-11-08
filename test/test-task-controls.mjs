import test from 'node:test';import assert from 'node:assert/strict';import {createTaskControls} from '../src/renderer/task-controls.mjs';
test('both surfaces get immediate progress, deduplication, slow feedback and durable failure messages',async()=>{let changed=0,calls=0,release;const c=createTaskControls({changed:()=>changed++,waitMs:10}),request=()=>{calls++;return new Promise(r=>release=r);};const first=c.run('task','stop',request),again=c.run('task','stop',request);assert.equal(first,again);assert.match(c.messages.get('task'),/停止/);assert(c.pending.has('task'));await new Promise(r=>setTimeout(r,20));assert.match(c.messages.get('task'),/尚未确认/);release({ok:false,error:'exact external target unavailable'});await first;assert.equal(calls,1);assert.equal(c.pending.size,0);assert.equal(c.messages.get('task'),'exact external target unavailable');assert(changed>=3);});
test('thrown IPC failures and local-stop success with cleanup errors remain explicit',async()=>{const c=createTaskControls();await c.run('task','stop',()=>{throw Error('service unavailable');});assert.equal(c.messages.get('task'),'service unavailable');await c.run('task','stop',async()=>({ok:true,localStopped:true,cleanupVerified:false,message:'Bunny 已停止；某进程停止未确认'}));assert.match(c.messages.get('task'),/未确认/);});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('interrupts bypass ordinary pending work and stop takes priority over pause',async()=>{
 const c=createTaskControls(),resume=deferred(),pause=deferred(),stop=deferred();let calls=[];
 const first=c.run('task','resume',()=>{calls.push('resume');return resume.promise;});
 assert.equal(c.run('task','check',()=>assert.fail('ordinary work must remain deduplicated')),first);
 const paused=c.run('task','pause',()=>{calls.push('pause');return pause.promise;});
 assert.notEqual(paused,first);assert.equal(c.run('task','pause',()=>assert.fail('duplicate pause')),paused);
 const stopped=c.run('task','stop',()=>{calls.push('stop');return stop.promise;});
 assert.notEqual(stopped,paused);assert.equal(c.run('task','stop',()=>assert.fail('duplicate stop')),stopped);
 assert.equal(c.run('task','pause',()=>assert.fail('pause cannot overtake stop')),stopped);
 resume.resolve({ok:true,message:'late resume'});await first;
 assert(c.pending.has('task'));assert.match(c.messages.get('task'),/停止/);
 pause.reject(Error('late pause failure'));await paused;
 assert(c.pending.has('task'));assert.match(c.messages.get('task'),/停止/);
 stop.resolve({ok:true,message:'stop acknowledged'});await stopped;
 assert.equal(c.pending.size,0);assert.equal(c.messages.get('task'),'stop acknowledged');assert.deepEqual(calls,['resume','pause','stop']);
});
for(const operation of ['pause','stop'])for(const lateFailure of [false,true])test('late resume '+(lateFailure?'failure':'success')+' cannot replace completed '+operation+' feedback',async()=>{
 const c=createTaskControls({waitMs:10}),resume=deferred(),interrupt=deferred(),message='exact '+operation+' refusal';
 const old=c.run('task','resume',()=>resume.promise),latest=c.run('task',operation,()=>interrupt.promise);
 interrupt.resolve({ok:false,error:message});await latest;
 assert.equal(c.pending.size,0);assert.equal(c.messages.get('task'),message);
 await new Promise(r=>setTimeout(r,20));assert.equal(c.messages.get('task'),message);
 if(lateFailure)resume.reject(Error('old resume refusal'));else resume.resolve({ok:true,message:'old resume success'});
 await old;assert.equal(c.pending.size,0);assert.equal(c.messages.get('task'),message);
 await c.run('task','check',async()=>({ok:true,message:'fresh check'}));assert.equal(c.messages.get('task'),'fresh check');
});
test('an older completion cannot clear a fresh control pending after interruption has completed',async()=>{
 const c=createTaskControls(),resume=deferred(),check=deferred();
 const old=c.run('task','resume',()=>resume.promise);await c.run('task','stop',async()=>({ok:true}));
 assert.equal(c.pending.size,0);
 const fresh=c.run('task','check',()=>check.promise);resume.resolve({ok:true});await old;
 assert(c.pending.has('task'));assert.match(c.messages.get('task'),/检查/);
 check.resolve({ok:true,message:'current check complete'});await fresh;
 assert.equal(c.pending.size,0);assert.equal(c.messages.get('task'),'current check complete');
});
test('default control acknowledgements do not imply the business task is complete',async()=>{
 const c=createTaskControls();
 await c.run('task','resolve',async()=>({ok:true}));assert.equal(c.messages.get('task'),'本次处理请求已结束，请查看任务当前状态。');
 await c.run('task','check',async()=>({ok:true}));assert.equal(c.messages.get('task'),'本次检查已结束，请查看任务当前状态。');
 await c.run('task','resolve',async()=>({ok:true,pending:true,message:'已安排核对，等待原会话回执'}));assert.equal(c.messages.get('task'),'已安排核对，等待原会话回执');
});
