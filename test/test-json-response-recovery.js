'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {checkedJSON}=require('../src/main/agent-json'),{requestVerification}=require('../src/main/verification-transport'),{responseRecovery}=require('../src/main/self-repair');
const messages=[{role:'system',content:'Return the complete JSON.'},{role:'user',content:'private-evidence-canary'}];
const failure=code=>Object.assign(Error('fixture response limit'),{code});
test('explicit output budgets survive verification transport without being floored',async()=>{
 for(const vision of [false,true])for(const maxTokens of [1024,2048]){let sent;await requestVerification({messages,vision,maxTokens},{chat:async options=>{sent=options;return {model:options.model,text:'{}'};}});assert.equal(sent.maxTokens,maxTokens);assert.equal(sent.messages,messages);}
});
test('the caller owns two total inference attempts, including the free-model alternative',async()=>{
 const calls=[],original=structuredClone(messages);
 const request=options=>requestVerification(options,{selectFree:async()=> 'hy3',chat:async options=>{calls.push(options);if(calls.length===1)throw failure('E_PAYLOAD_TOO_LARGE');return {model:options.model,text:'{"ok":true}'};}});
 const result=await checkedJSON({vision:true,maxTokens:4096,messages,extraBody:{max_tokens:4096}},value=>value,{request});
 assert.equal(result.value.ok,true);assert.deepEqual(calls.map(c=>[c.model,c.maxTokens]),[['deepseek-v4.1-flash',4096],['hy3',2048]]);assert.equal(calls[1].extraBody.max_tokens,undefined);assert.equal(calls[1].extraBody.reasoning_effort,'low');assert.deepEqual(messages,original);
});
test('opposite or repeated response caps stop after two actual model calls',async()=>{
 for(const errors of [['E_OUTPUT_LIMIT','E_PAYLOAD_TOO_LARGE'],['E_PAYLOAD_TOO_LARGE','E_OUTPUT_LIMIT'],['E_PAYLOAD_TOO_LARGE','E_PAYLOAD_TOO_LARGE']]){
  const calls=[];const request=options=>requestVerification(options,{selectFree:async()=> 'hy3',chat:async options=>{calls.push(options.maxTokens);throw failure(errors[calls.length-1]||'E_OUTPUT_LIMIT');}});
  await assert.rejects(checkedJSON({vision:true,maxTokens:4096,messages},value=>value,{request}),e=>e.code===errors[1]);assert.deepEqual(calls,[4096,errors[0]==='E_OUTPUT_LIMIT'?8192:2048]);
 }
});
test('cancellation during a size rejection prevents the alternate model request',async()=>{
 const controller=new AbortController();let calls=0;
 const request=options=>requestVerification(options,{chat:async()=>{calls++;controller.abort();throw failure('E_PAYLOAD_TOO_LARGE');},selectFree:async()=>{throw Error('must not query another model');}});
 await assert.rejects(checkedJSON({maxTokens:4096,messages,signal:controller.signal},value=>value,{request}));assert.equal(calls,1);
});
test('response adaptation changes only the next output policy and retains all evidence',()=>{
 const options={messages,maxTokens:2048,inputBudgetTokens:32768,extraBody:{max_tokens:2048,max_completion_tokens:2048,reasoning_effort:'high'}},before=structuredClone(options),repaired=responseRecovery(options,failure('E_PAYLOAD_TOO_LARGE'));
 assert.equal(repaired.maxTokens,1024);assert.equal(repaired.inputBudgetTokens,32768);assert.equal(repaired.messages,messages);assert.deepEqual(options,before);assert.equal(repaired.extraBody.max_tokens,undefined);assert.equal(repaired.extraBody.max_completion_tokens,undefined);assert.equal(responseRecovery({...options,maxTokens:512},failure('E_PAYLOAD_TOO_LARGE')),null);
});
