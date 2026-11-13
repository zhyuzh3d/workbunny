'use strict';
const assert = require('node:assert/strict');
const { requestVerification } = require('../src/main/verification-transport');
const FREE = 'hy3';
const messages = [{ role: 'user', content: '固定的待核验数据，不执行操作' }];
const failure = code => Object.assign(new Error('controlled response failure'), { code });

(async () => {
  const calls = [];
  const primary = await requestVerification({ messages }, { chat: async options => { calls.push(options); return { model: options.model, text: 'primary' }; }, selectFree: async () => FREE });
  assert.equal(primary.model, FREE);
  assert.equal(calls[0].maxTokens, 2048);assert.equal(calls[0].timeoutMs,25000,'non-Task default remains unchanged');
  assert.equal(calls[0].extraBody.reasoning_effort, 'low');
  const longer=[];await requestVerification({messages,timeoutMs:90000},{chat:async o=>{longer.push(o.timeoutMs);return {model:o.model,text:'bounded task response'};},selectFree:async()=>FREE});assert.deepEqual(longer,[90000]);
  let timedAttempts=0;await assert.rejects(requestVerification({messages,timeoutMs:180000},{chat:async()=>{timedAttempts++;throw failure('E_MODEL_TIMEOUT');},selectFree:async()=>FREE}),e=>e.code==='E_MODEL_TIMEOUT'&&e.diagnostic.modelRequest.timeoutMs===180000&&e.diagnostic.modelRequest.requestStarted===true&&e.diagnostic.modelRequest.externalAction===false);assert.equal(timedAttempts,1,'transport must not introduce a nested timeout retry');
  for (const code of ['E_PAYLOAD_TOO_LARGE', 'E_EMPTY_RESPONSE', 'E_OUTPUT_LIMIT']) {
    const attempts = [], lookups = [];
    const result = await requestVerification({ messages, vision: true }, {
      chat: async options => { attempts.push(options); if (attempts.length === 1) throw failure(code); return { model: options.model, text: 'fallback' }; },
      selectFree: async options => { lookups.push(options); return 'hy3'; },
    });
    assert.equal(result.model, 'hy3'); assert.equal(result.fallbackReason, code);
    assert.equal(attempts.length, 2); assert.equal(attempts[1].maxTokens, code==='E_PAYLOAD_TOO_LARGE'?2048:code==='E_OUTPUT_LIMIT'?8192:4096);
    assert.equal(attempts[1].messages, messages, 'read-only fallback uses the same evidence');
    assert.equal(lookups[0].vision, true, 'image checking needs a catalog-confirmed free visual model');
  }
  for (const code of ['E_TIMEOUT', 'E_UPSTREAM', 'E_BAD_REQUEST']) await assert.rejects(requestVerification({ messages }, {
    chat: async () => { throw failure(code); }, selectFree: async () => FREE,
  }), error => error.code === code);
  await assert.rejects(requestVerification({ messages }, { chat: async () => ({ model: 'unselected-model' }),selectFree:async()=>FREE }), /模型与所选模型不符/);
  let attempts = 0;
  await assert.rejects(requestVerification({ messages }, { chat: async () => { attempts++; return {}; }, selectFree: async () => {throw failure('E_FREE_MODEL_CATALOG');} }), {code:'E_FREE_MODEL_CATALOG'});
  assert.equal(attempts, 0, 'an unavailable price/capability catalog never falls through to a hardcoded paid model');
  const future=await requestVerification({messages,vision:true},{chat:async o=>({model:o.model,text:'confirmed future free model'}),selectFree:async()=> 'catalog-confirmed-future-free'});assert.equal(future.model,'catalog-confirmed-future-free');
  attempts = 0;
  await assert.rejects(requestVerification({ messages }, { chat: async () => { attempts++; throw failure('E_PAYLOAD_TOO_LARGE'); }, selectFree: async () => 'hy3' }), /controlled response failure/);
  assert.equal(attempts, 2, 'a failed fallback is never retried indefinitely');
  const controller = new AbortController(); attempts = 0;let selections=0;
  await assert.rejects(requestVerification({ messages, signal: controller.signal }, { chat: async () => { attempts++; throw failure('E_EMPTY_RESPONSE'); }, selectFree: async () => { if(++selections===2)controller.abort(); return 'hy3'; } }), /已取消/);
  assert.equal(attempts, 1, 'a stop during model lookup prevents the fallback request');
  console.log('Verification transport fallback checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
