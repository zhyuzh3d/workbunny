'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {AgentService}=require('../src/main/agent-service');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const actor={role:'owner',verified:true,channel:'dialogue',sources:['fixture-owner-turn'],scene:'life'};
const spec={skill:'screen.watch',goal:'Observe fixture window',subjects:[{application:'workbuddy'}]};
const decision={kind:'task',task:{skill:'work.delegate',goal:'Create a fixture page',subjects:[{application:'workbuddy'}],workRequest:{goal:'Create a fixture page',output:'files'},workContext:{mode:'none'},delivery:{channel:'speech'}}};
function gate(){let open=true,current=true;const pending=new Set();return {accepted:true,isCurrent:()=>current,canCommit:()=>current&&open,
 waitForCommit({signal}={}){if(current&&open)return Promise.resolve(true);return new Promise(resolve=>{const done=value=>{pending.delete(done);signal?.removeEventListener('abort',abort);resolve(value);};const abort=()=>done(false);pending.add(done);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});},
 close(){open=false;},open(){open=true;for(const done of [...pending])done(current);},cancel(){current=false;for(const done of [...pending])done(false);},waiting:()=>pending.size};}
function fixture({put=async()=>{},interpret=async()=>decision}={}){
 const records=new Map(),writes=[],reports=[];let executions=0;
 const desktop={task:null,running:false,start:async()=>{executions++;return {ok:true};},stop:async()=>{}};
 const scene={metrics:{},native:{request:async()=>({})},assertHealthy:async()=>{},invalidate(){},close(){}};
 const journal={put:async task=>{const snapshot=structuredClone(task);await put(snapshot,writes.length);writes.push(snapshot);records.set(task.id,snapshot);},list:async()=>[...records.values()].map(row=>structuredClone(row)),authorized:async()=>true};
 const agent=new AgentService({desktop,conversationDesktop:{...desktop},scene,autoSchedule:false,ready:()=>true,epoch:()=>1,canOperate:async()=>true,journal,report:async r=>reports.push(r),request:async options=>({model:'offline-fixture',response:{text:JSON.stringify(await interpret(options))}})});
 return {agent,records,writes,journal,reports,executions:()=>executions};
}
test('actual voice Task admission waits outside the shared lane and commits once after fresh evidence',async()=>{
 const h=fixture(),g=gate();g.close();try{
  const pending=h.agent.start(spec,actor,{commitGate:g});await flush();assert.equal(h.writes.length,0);assert.equal(g.waiting(),1);
  const other=await h.agent.start({...spec,goal:'Independent text task'},actor);assert(other.ok,'a closed voice seal cannot monopolize Task admission');
  g.open();const result=await pending;assert(result.ok);assert.equal(h.agent.runtime.tasks.get(result.id).status,'ready');assert.equal(h.records.get(result.id).state.admissionPending,undefined);assert.equal(h.executions(),0);
 }finally{await h.agent.close();}
});
test('cancellation and semantic replacement during gate wait never write a Task',async()=>{
 for(const kind of ['abort','replacement']){const h=fixture(),g=gate(),controller=new AbortController();g.close();try{
  const pending=h.agent.start(spec,actor,{commitGate:g,signal:controller.signal});await flush();kind==='abort'?controller.abort():g.cancel();
  assert.equal((await pending).ok,false);assert.equal(h.writes.length,0);assert.equal(h.agent.runtime.tasks.size,0);
 }finally{await h.agent.close();}}
});
for(const kind of ['quiet-lost','new-text'])test(`journal completion after ${kind} preserves saved paused input and never restores runnable`,async()=>{
 const entered=deferred(),release=deferred();let held=false;
 const h=fixture({put:async snapshot=>{if(!held){held=true;assert.equal(snapshot.state.admissionPending,true);entered.resolve();await release.promise;}}}),g=gate();
 try{
  const pending=h.agent.start(spec,actor,{commitGate:g});await entered.promise;kind==='quiet-lost'?g.close():g.cancel();release.resolve();
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.saved,true);assert.equal(result.paused,true);assert.equal(h.records.get(result.id).status,'paused');assert.equal(h.records.get(result.id).state.admissionPending,true);assert.equal(h.executions(),0);
  await h.agent.runtime.restore();assert.equal(h.agent.runtime.tasks.get(result.id).status,'paused');await h.agent.runtime.tick(result.id);assert.equal(h.executions(),0);
 }finally{await h.agent.close();}
});
test('failed pause compensation leaves a durable admission marker which restore treats as paused',async()=>{
 const entered=deferred(),release=deferred();let count=0;
 const h=fixture({put:async()=>{if(++count===1){entered.resolve();await release.promise;}else throw Error('fixture write unavailable');}}),g=gate();
 try{const pending=h.agent.start(spec,actor,{commitGate:g});await entered.promise;g.close();release.resolve();assert.equal((await pending).ok,false);const stored=[...h.records.values()][0];assert.equal(stored.state.admissionPending,true);
  const restored=structuredClone(stored);h.agent.runtime.restoreTask(restored);assert.equal(restored.status,'paused');assert.equal(h.executions(),0);
 }finally{await h.agent.close();}
});
test('an admitted Task owns later interpretation even after its originating voice token retires',async()=>{
 const entered=deferred(),release=deferred(),h=fixture({interpret:async()=>{entered.resolve();await release.promise;return decision;}}),g=gate();
 try{const input=await h.agent.command('Create fixture page',actor,{commitGate:g});assert(input.ok);g.cancel();const task=h.agent.runtime.tasks.get(input.id),running=h.agent.runtime.tick(input.id);await entered.promise;release.resolve();await running;
  assert.equal(task.skill,'work.delegate');assert.equal(h.records.get(task.id).skill,'work.delegate');assert.equal(h.agent.runtime.tasks.size,1);assert.equal(g.waiting(),0);assert.equal(h.executions(),0);
 }finally{await h.agent.close();}
});
test('adoption journal race preserves the original resolving Task and prior effect ledger',async()=>{
 const entered=deferred(),release=deferred();let hold=false;
 const h=fixture({put:async snapshot=>{if(hold&&snapshot.skill==='work.delegate'){hold=false;entered.resolve();await release.promise;}}}),g=gate();
 try{const input=await h.agent.command('Create fixture page',actor,{commitGate:g});const task=h.agent.runtime.tasks.get(input.id);task.operations.fixture={status:'intent',effect:'write',tool:'fixture.unrelated'};hold=true;
  const pending=h.agent.runtime.adopt(input.id,decision.task,actor,{commitGate:g,live:()=>h.agent.runtime.tasks.get(input.id)===task});await entered.promise;g.close();release.resolve();await assert.rejects(pending,{code:'E_VOICE_COMMIT_UNCONFIRMED'});
  assert.equal(task.skill,'task.resolve');assert.equal(task.status,'paused');assert.equal(task.operations.fixture.status,'intent');assert.equal(h.records.get(task.id).skill,'task.resolve');assert.equal(h.records.get(task.id).status,'paused');assert.equal(h.executions(),0);
 }finally{await h.agent.close();}
});
test('late preparation after privacy epoch change cannot persist or launch a Task',async()=>{
 const h=fixture(),g=gate(),entered=deferred(),release=deferred();let epoch=1;
 h.agent.runtime.epoch=()=>epoch;const prepare=h.agent.runtime.prepare;h.agent.runtime.prepare=async task=>{await prepare(task);entered.resolve();await release.promise;};
 try{const pending=h.agent.start(spec,actor,{commitGate:g});await entered.promise;epoch=2;release.resolve();assert.equal((await pending).ok,false);assert.equal(h.writes.length,0);assert.equal(h.executions(),0);}
 finally{await h.agent.close();}
});
test('a stop arriving during adoption persistence stays terminal and retains the submission barrier',async()=>{
 const entered=deferred(),release=deferred();let hold=false;
 const h=fixture({put:async snapshot=>{if(hold&&snapshot.skill==='work.delegate'){hold=false;entered.resolve();await release.promise;}}}),g=gate();
 try{const input=await h.agent.command('Create fixture page',actor,{commitGate:g});const original=h.agent.runtime.tasks.get(input.id);original.operations.fixture={status:'intent',effect:'write',tool:'fixture.unrelated'};hold=true;
  const adoption=h.agent.runtime.adopt(input.id,decision.task,actor,{commitGate:g,live:()=>h.agent.runtime.tasks.get(input.id)===original&&!original.state.stopRequest});const rejected=assert.rejects(adoption);await entered.promise;
  const stopped=h.agent.runtime.control('stop',input.id);release.resolve();await Promise.all([rejected,stopped]);const task=h.agent.runtime.tasks.get(input.id);assert.equal(task.status,'stopped');assert.equal(h.records.get(task.id).status,'stopped');assert.equal(task.operations.fixture.status,'intent');assert.equal(h.executions(),0);
 }finally{await h.agent.close();}
});
test('a fabricated unaccepted voice token cannot authorize actual Task admission',async()=>{
 const h=fixture(),g=gate();g.accepted=false;try{assert.equal((await h.agent.start(spec,actor,{commitGate:g})).ok,false);assert.equal(h.writes.length,0);}finally{await h.agent.close();}
});
test('a saved pending request key is never returned as a positively admitted duplicate',async()=>{
 let first=true;const g=gate(),h=fixture({put:async()=>{if(first){first=false;g.close();}}});
 try{const initial=await h.agent.command('Create fixture page',actor,{commitGate:g,requestKey:'fixture-pending-key'});assert.equal(initial.ok,false);g.open();
  const duplicate=await h.agent.command('Create fixture page',actor,{commitGate:g,requestKey:'fixture-pending-key'});assert.equal(duplicate.ok,false);assert.equal(duplicate.id,initial.id);assert.equal(duplicate.stage,undefined);assert.equal(duplicate.paused,true);assert.equal(h.agent.runtime.tasks.size,1);assert.equal(h.executions(),0);
 }finally{await h.agent.close();}
});
test('only explicit successful owner resume clears pending admission and unknown writes still block it',async()=>{
 let first=true;const g=gate(),h=fixture({put:async()=>{if(first){first=false;g.close();}}});
 try{const initial=await h.agent.command('Create fixture page',actor,{commitGate:g});const task=h.agent.runtime.tasks.get(initial.id);assert(task.state.admissionPending);
  task.operations.fixture={status:'intent',effect:'write',tool:'fixture.unrelated'};assert.equal((await h.agent.runtime.control('resume',task.id)).ok,false);assert(task.state.admissionPending);
  task.operations.fixture.status='not_dispatched';assert.equal((await h.agent.runtime.control('resume',task.id)).ok,true);assert.equal(task.state.admissionPending,undefined);assert.equal(h.records.get(task.id).state.admissionPending,undefined);
  await h.agent.runtime.restore();assert.notEqual(h.agent.runtime.tasks.get(task.id).status,'paused');
 }finally{await h.agent.close();}
});
for(const kind of ['new-text','unknown'])test(`actual dispatch resume rechecks ${kind} after a deferred skill hook without holding admission`,async()=>{
 const h=fixture(),g=gate(),entered=deferred(),release=deferred();
 try{const initial=await h.agent.start(spec,actor);await h.agent.control('pause',initial.id);const task=h.agent.runtime.tasks.get(initial.id);
  h.agent.skills.skills.set(task.skill,{...h.agent.skills.get(task.skill),resume:async()=>{entered.resolve();await release.promise;}});
  const pending=h.agent.dispatch({kind:'control',operation:'resume',id:task.id},actor,{commitGate:g,isCurrent:g.isCurrent});await entered.promise;
  const independent=await h.agent.start({...spec,goal:'Independent preparation fixture'},actor);assert(independent.ok,'voice resume preparation must not hold admission');
  kind==='new-text'?g.cancel():g.close();release.resolve();await flush();assert.equal(task.status,'paused');
  if(kind==='unknown'){assert.equal(g.waiting(),1);g.open();}
  const result=await pending;assert.equal(result.ok,kind==='unknown');assert.equal(task.status,kind==='unknown'?'waiting':'paused');assert.equal(h.records.get(task.id).status,task.status);
 }finally{await h.agent.close();}
});
