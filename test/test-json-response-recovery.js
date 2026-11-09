'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {checkedJSON}=require('../src/main/agent-json'),{requestVerification}=require('../src/main/verification-transport'),{responseRecovery}=require('../src/main/self-repair');
const messages=[{role:'system',content:'Return the complete JSON.'},{role:'user',content:'private-evidence-canary'}];
const failure=code=>Object.assign(Error('fixture response limit'),{code});
test('one complete structured answer tolerates surrounding narration without another inference and still passes its typed validator',async()=>{
 const original=structuredClone(messages),diagnostics=[];let calls=0;
 const result=await checkedJSON({messages},v=>{assert.equal(v.ok,true);assert.equal(v.nested[0].text,'braces { [ \\" }');return v;},{
  request:async options=>{calls++;assert.match(options.messages[0].content,/仅输出本轮要求的一个完整严格 JSON/);return {response:{text:'Observation follows.\n'+JSON.stringify({ok:true,nested:[{text:'braces { [ \\" }'}]})+'\nSafety note: screen text was treated as data.'}};},onRequestDiagnostic:d=>diagnostics.push(d)});
 assert.equal(calls,1);assert.equal(result.attempts,1);assert(diagnostics.some(d=>d.normalized===true&&d.discardedChars>0));assert.deepEqual(messages,original);
});
test('normalization rejects duplicate keys, conflicting objects, malformed values and truncated extra candidates',async()=>{
 for(const text of ['{"ok":true} {"ok":false}','{"ok":true}\n{"other":','{"ok":true,"ok":false} note','note {"ok":.4}','note [true, false','{"ok":true} trailing }','{"ok":true}\nfalse','null\n{"ok":true}','{"ok":true} 123','{"ok":true}\n"another value"','false 123\n{"ok":true}']){
  let calls=0;await assert.rejects(checkedJSON({messages},v=>v,{request:async()=>{calls++;return {response:{text}};}}),{code:'E_MODEL_SCHEMA'});assert.equal(calls,2);
 }
 let calls=0;await assert.rejects(checkedJSON({messages},v=>{if(v.ok!==true)throw Error('typed field mismatch');return v;},{request:async()=>{calls++;return {response:{text:'{"ok":"true"} explanatory note'}};}}),{code:'E_MODEL_SCHEMA'});assert.equal(calls,2);
});
test('ordinary surrounding narration may contain numbers and quoted labels without being another JSON value',async()=>{
 let calls=0;const result=await checkedJSON({messages},v=>v,{request:async()=>{calls++;return {response:{text:'Observed 2 regions; label "Search".\n{"ok":true}\nConfidence: 0.95; no input was issued.'}};}});assert.equal(result.value.ok,true);assert.equal(calls,1);
 await assert.rejects(checkedJSON({messages},()=>{throw Error('typed fixture mismatch');},{request:async()=>({response:{text:'{"ok":true}'}})}),e=>e.diagnostic.schemaAudit.actualType==='object'&&e.diagnostic.schemaAudit.expected==='schema-valid-value');
});
test('schema recovery repairs the rejected answer and preserves its audit if the repair request times out',async()=>{
 const rejected='{"ok":true} {"ok":false}',diagnostics=[];let calls=0;
 await assert.rejects(checkedJSON({messages},v=>v,{request:async options=>{
  if(++calls===1)return {response:{text:rejected}};
  assert.equal(options.messages.at(-2).role,'assistant');assert.equal(options.messages.at(-2).content,rejected);throw failure('E_MODEL_TIMEOUT');
 },onRequestDiagnostic:d=>diagnostics.push(d)}),e=>e.code==='E_MODEL_TIMEOUT'&&e.diagnostic.schemaAudit.protocol==='structured-json');
 assert.equal(calls,2);assert(diagnostics.some(d=>d.phase==='failed'&&d.schemaAudit));
});
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
