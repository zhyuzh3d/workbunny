'use strict';
const assert = require('node:assert/strict');
const { requestVerification } = require('../src/main/verification-transport');
const FLASH = 'deepseek-v4.1-flash';
const messages = [{ role: 'user', content: '固定的待核验数据，不执行操作' }];
const failure = code => Object.assign(new Error('controlled response failure'), { code });

(async () => {
  const calls = [];
  const primary = await requestVerification({ messages }, { chat: async options => { calls.push(options); return { model: options.model, text: 'primary' }; }, selectFree: async () => { throw Error('must not query fallback'); } });
  assert.equal(primary.model, FLASH);
  assert.equal(calls[0].maxTokens, 2048);
  assert.equal(calls[0].extraBody.reasoning_effort, 'low');
  for (const code of ['E_PAYLOAD_TOO_LARGE', 'E_EMPTY_RESPONSE']) {
    const attempts = [], lookups = [];
    const result = await requestVerification({ messages, vision: true }, {
      chat: async options => { attempts.push(options); if (attempts.length === 1) throw failure(code); return { model: options.model, text: 'fallback' }; },
      selectFree: async options => { lookups.push(options); return 'hy3'; },
    });
    assert.equal(result.model, 'hy3'); assert.equal(result.fallbackReason, code);
    assert.equal(attempts.length, 2); assert.equal(attempts[1].maxTokens, 4096);
    assert.equal(attempts[1].messages, messages, 'read-only fallback uses the same evidence');
    assert.equal(lookups[0].vision, true, 'image checking needs a catalog-confirmed free visual model');
  }
  for (const code of ['E_TIMEOUT', 'E_UPSTREAM', 'E_BAD_REQUEST']) await assert.rejects(requestVerification({ messages }, {
    chat: async () => { throw failure(code); }, selectFree: async () => { throw Error('must not fall back for generic network errors'); },
  }), error => error.code === code);
  await assert.rejects(requestVerification({ messages }, { chat: async () => ({ model: 'unselected-model' }) }), /模型与所选模型不符/);
  let attempts = 0;
  await assert.rejects(requestVerification({ messages }, { chat: async () => { attempts++; throw failure('E_PAYLOAD_TOO_LARGE'); }, selectFree: async () => 'step-5-preview' }), /未确认免费 Hy3/);
  assert.equal(attempts, 1, 'another free model or paid fallback cannot be selected implicitly');
  attempts = 0;
  await assert.rejects(requestVerification({ messages }, { chat: async () => { attempts++; throw failure('E_PAYLOAD_TOO_LARGE'); }, selectFree: async () => 'hy3' }), /controlled response failure/);
  assert.equal(attempts, 2, 'a failed fallback is never retried indefinitely');
  const controller = new AbortController(); attempts = 0;
  await assert.rejects(requestVerification({ messages, signal: controller.signal }, { chat: async () => { attempts++; throw failure('E_EMPTY_RESPONSE'); }, selectFree: async () => { controller.abort(); return 'hy3'; } }), /已取消/);
  assert.equal(attempts, 1, 'a stop during model lookup prevents the fallback request');
  console.log('Verification transport fallback checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
