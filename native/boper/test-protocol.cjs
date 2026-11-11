'use strict';
// Exercises the real pipe reader, its independent control path and cancellation
// responses without opening an input session or dispatching any input.
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const assert=require('node:assert/strict');
const path=require('node:path');
const binary=process.argv[2]||path.join(__dirname,'../../build/native/boper-runtime');
const child=spawn(binary,[],{stdio:['pipe','pipe','pipe','pipe']});
const pending=new Map();let next=0;let error='';
child.stderr.on('data',data=>error+=data);
createInterface({input:child.stdout}).on('line',line=>{
  const response=JSON.parse(line),entry=pending.get(response.id);
  if(entry){pending.delete(response.id);clearTimeout(entry.timer);entry.resolve(response);}
});
function request(action,fields={},control=false){
  const id=++next;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Bounded protocol reply timed out: ${action} ${error}`)),2000);
    pending.set(id,{resolve,reject,timer});
    (control?child.stdio[3]:child.stdin).write(JSON.stringify({id,action,...fields})+'\n');
  });
}
(async()=>{
  const initial=await request('status');assert.equal(initial.ok,true);assert.equal(initial.result.sessionActive,false);
  const denied=await request('execute',{inputSessionId:'unowned-session',operationId:'unowned-operation',operation:{action:'key',params:{key:'enter'}}});
  assert.equal(denied.ok,false);assert.equal(denied.error.code,'E_CANCELLED');
  assert.equal(denied.result.dispatched,false);assert.equal(denied.result.reportsSubmitted,0);
  assert.equal(denied.result.clipboardChanged,false);
  const wrong=await request('execute',{},true);assert.equal(wrong.error.code,'E_CONTROL_ACTION');
  const stale=await request('renewSession',{inputSessionId:'unowned-session',leaseMs:1500},true);assert.equal(stale.ok,false);
  const stopped=await request('stop',{},true);assert.equal(stopped.ok,true);assert.equal(stopped.result.releaseConfirmed,true);
  const final=await request('status',{},true);assert.equal(final.result.sessionActive,false);assert.equal(final.result.busy,false);
  child.stdin.end();child.stdio[3].end();
  console.log(JSON.stringify({ok:true,selfTest:'private-pipe-control-and-unowned-input-rejection',inputDispatched:false}));
})().catch(error=>{console.error(error);child.kill('SIGKILL');process.exitCode=1;});
