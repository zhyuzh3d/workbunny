'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ModelAdmission}=require('../src/main/model-admission');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('background saturation reserves physical capacity for an owner dialogue and creates no request queue',async()=>{
 const admission=new ModelAdmission(),gates=Array.from({length:3},()=>Promise.withResolvers());
 const background=gates.map(gate=>admission.run(()=>gate.promise,{priority:'background'}));await flush();
 await assert.rejects(admission.run(()=>assert.fail('must not dispatch'),{priority:'background'}),{code:'E_MODEL_BUSY'});
 assert.equal(await admission.run(async()=> 'owner reply',{priority:'foreground'}),'owner reply');assert.equal(admission.active.size,3);
 gates.forEach(gate=>gate.resolve());await Promise.all(background);assert.equal(admission.active.size,0);
});
test('cancellation releases the caller promptly but tracks an unacknowledged physical request until it settles',async()=>{
 const admission=new ModelAdmission({capacity:2,backgroundLimit:1}),gate=Promise.withResolvers(),controller=new AbortController();
 const pending=admission.run(()=>gate.promise,{signal:controller.signal});await flush();controller.abort();await assert.rejects(pending,{code:'ABORT_ERR'});assert.equal(admission.active.size,1);
 await assert.rejects(admission.run(async()=>null),{code:'E_MODEL_BUSY'});assert.equal(await admission.run(async()=> 'voice',{priority:'foreground'}),'voice');gate.resolve();await flush();assert.equal(admission.active.size,0);
});
test('a timed out transport cannot create unbounded retries and a late rejection is observed',async()=>{
 const admission=new ModelAdmission({capacity:2,backgroundLimit:1}),gate=Promise.withResolvers();
 await assert.rejects(admission.run(()=>gate.promise,{timeoutMs:10}),{code:'E_MODEL_TIMEOUT'});assert.equal(admission.active.size,1);
 await assert.rejects(admission.run(async()=>null),{code:'E_MODEL_BUSY'});gate.reject(Error('late backend failure'));await flush();assert.equal(admission.active.size,0);
});
