'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const traces = require('../src/main/task-model-trace'), crypto = require('../src/main/vault-crypto');
const { checkedJSON } = require('../src/main/agent-json');
function fixture(options = {}) {
  let scene = 'life', now = 100000,nativeEpoch=1; const rows = new Map(), key = Buffer.alloc(32, 7), gaps = [];
  const memory = { generation: 1, epoch: 1, check() {},tail:Promise.resolve(),serial:require('../src/main/memory-service').MemoryService.prototype.serial,
    removeRecord:require('../src/main/memory-service').MemoryService.prototype.removeRecord,
    decode: r => ({ ...r, value: crypto.unseal(key, r.body, r.id) }), db: { request: async (op, args) => {
      if (op === 'get') return { rows: args.ids.map(id => rows.get(id)).filter(Boolean) };
      if (op === 'remove') { assert.equal(args.epoch,nativeEpoch,'deletion must use the current native epoch');rows.delete(args.id); return {epoch:++nativeEpoch}; } throw Error('unexpected vault operation');
    } }, write: async (records, epoch, { notify, strictSources, assertCurrent }) => {
      assert.equal(notify, false); assert.equal(strictSources, true); assertCurrent();
      assert.equal(epoch,nativeEpoch,'trace cleanup must not poison subsequent vault writes');
      for (const r of records) rows.set(r.id, { ...r, value: undefined, body: crypto.seal(key, r.value, r.id) });
    } };
  const recorder = new traces.TaskModelTrace({ memory, getScene: () => scene, clock: () => now, onGap: gap => gaps.push(gap), ...options });
  const scope = { recorder, taskId: 'synthetic-task', actionId: 'synthetic-action', operationId: 'synthetic-tool-operation', generation: 3,
    scene: 'life', visibilityFloor: 1, parentGoal: '保留完整目标', knowledgeRefs: [{ sourceId: 'bundled-guide', revision: 6 }], isCurrent: () => true };
  const read = args => recorder.read({ taskId: scope.taskId, ...args }, { authorize: () => true, isCurrent: () => true, scene: 'life' });
  return { memory, rows, recorder, scope, gaps, read, setScene: value => { scene = value; }, advance: ms => { now += ms; },get nativeEpoch(){return nativeEpoch;} };
}
test('assembled, final wire, visible JSON and validation retain exact scoped evidence in encrypted records', async () => {
  const f = fixture(), operations = [], finished = [];
  const messages = [{ role: 'user', content: 'synthetic original request', reasoning_content: 'hidden-request-reasoning-canary' }];
  const result = await traces.scope({ ...f.scope, registerModelOperation: async details => { operations.push(details); return { operationId: 'model-operation' }; }, completeModelOperation: details => finished.push(details) }, () => checkedJSON({ messages, apiKey: 'credential-canary', baseURL: 'https://credential-endpoint-canary' }, v => v, {
    request: async options => {
      const wire = traces.wire({ model: 'synthetic-model', messages: [...options.messages, { role: 'system', content: 'transport-added-rule' }], max_tokens: 4096, apiKey: 'credential-canary', headers: { authorization: 'credential-canary' } });
      const response = { text: '{"ok":true}', reasoning: 'hidden-reasoning-canary', raw: 'hidden-raw-canary', model: 'synthetic-model' };
      wire.complete(response); return { response };
    },
  }));
  assert.equal(result.value.ok, true); await f.recorder.flush();
  const exported = await f.read(), raw = exported.traces[0];
  assert.equal(raw.operationId, 'model-operation'); assert.equal(raw.parentOperationId, f.scope.operationId); assert.equal(raw.actionId, f.scope.actionId);
  assert.equal(raw.parentGoal, f.scope.parentGoal); assert.equal(raw.knowledgeRefs[0].revision, 6);
  assert.equal(raw.assembled.messages.at(-1).content, messages[0].content); assert.equal(raw.assembled.hiddenReasoningOmitted,true);assert.equal(raw.wire[0].request.messages.at(-1).content, 'transport-added-rule');
  assert.equal(raw.response.text, '{"ok":true}'); assert.equal(raw.validation.ok, true); assert.equal(raw.coverage.actualWire, true); assert.equal(operations.length, 1); assert.equal(finished[0].status, 'completed');
  const serialized = JSON.stringify(exported); assert(!serialized.includes('credential-canary')); assert(!serialized.includes('credential-endpoint-canary')); assert(!serialized.includes('hidden-reasoning-canary')); assert(!serialized.includes('hidden-request-reasoning-canary'));assert(!serialized.includes('hidden-raw-canary'));
  assert(!JSON.stringify([...f.rows.values()]).includes('synthetic original request'), 'raw evidence is not stored as searchable/plaintext rows');
});
test('schema repair preserves each original visible answer and each actual transport attempt separately', async () => {
  const f = fixture(); let calls = 0;
  await traces.scope(f.scope, () => checkedJSON({ messages: [{ role: 'user', content: 'request' }] }, v => { if (v.ok !== true) throw Error('expected boolean true'); return v; }, { request: async options => {
    const first = traces.wire({ messages: options.messages, model: 'mock' }); first.failed(Object.assign(Error('transient fixture'), { code: 'E_NETWORK' }));
    const second = traces.wire({ messages: options.messages, model: 'mock' }), response = { text: ++calls === 1 ? '{"ok":"true"}' : '{"ok":true}' }; second.complete(response); return { response };
  } }));
  const result = await f.read(); assert.equal(result.traces.length, 2);
  assert.deepEqual(result.traces.map(t => t.status), ['validation-failed', 'validated']); assert.equal(result.traces[0].response.text, '{"ok":"true"}');
  assert(result.traces[1].assembled.messages.some(m => m.role === 'assistant' && m.content === '{"ok":"true"}'));
  assert.deepEqual(result.traces[0].wire.map(w => w.status), ['failed', 'completed']); assert.equal(result.traces[0].validation.ok, false);
});
test('private and elevated-floor scopes never capture and export requires fresh trusted task authorization', async () => {
  const f = fixture();
  for (const extra of [{ scene: 'private', visibilityFloor: 2 }, { scene: 'life', visibilityFloor: 2 }]) await traces.scope({ ...f.scope, ...extra }, async () => {
    const call = await traces.begin({ messages: [{ role: 'user', content: 'private-canary' }] }); await call.run(async () => { traces.wire({ messages: [{ role: 'user', content: 'private-canary' }] }).complete({ text: 'private-canary' }); return { text: 'private-canary' }; }); call.validated();
  });
  await f.recorder.flush(); assert.equal(f.rows.size, 0);
  await assert.rejects(f.recorder.read({ taskId: f.scope.taskId }), { code: 'E_TASK_TRACE_SCOPE' });
  f.setScene('private'); await assert.rejects(f.read(), { code: 'E_TASK_TRACE_SCOPE' });
});
test('stopped generations cannot initiate another call or persist old raw content after vault replacement', async () => {
  const f = fixture(); let current = true, count = 0;
  await traces.scope({ ...f.scope, isCurrent: () => current }, async () => {
    const call = await traces.begin({ messages: [{ role: 'user', content: 'old-generation-canary' }] });
    await call.run(async () => { current = false; f.memory.generation++; return { text: '{"ok":true}' }; }); call.validated();
    await assert.rejects(async()=>{const next = await traces.begin({ messages: [] }); await next.run(async () => { count++; return {}; });},{code:'ABORT_ERR'});
  });
  await f.recorder.flush(); assert(f.gaps.some(g => g.code === 'scope-or-key-stale' || g.code === 'storage-failed'));
  assert.equal(count, 0); assert(!JSON.stringify([...f.rows.values()]).includes('old-generation-canary'));
});
test('evidence size and retention are bounded, raw omissions are explicit and reconstruction survives Unicode chunks', async () => {
  const f = fixture({ maxEntries: 1 });
  for (const text of ['first', '合成原文'.repeat(70000)]) {
    await traces.scope(f.scope, async () => { const call = await traces.begin({ messages: [{ role: 'user', content: text }] }); await call.run(async () => { const wire = traces.wire({ messages: [{ role: 'user', content: text }] }); wire.complete({ text: '{"ok":true}' }); return { text: '{"ok":true}' }; }); call.validated(); });
    await f.recorder.flush(); f.advance(1);
  }
  const result = await f.read(); assert.equal(result.traces.length, 1); assert.equal(result.traces[0].assembled.messages[0].content, '合成原文'.repeat(70000)); assert(result.gaps.some(g => g.code === 'retention-limit'));
  const small = fixture({ maxEntryBytes: 2000 }); await traces.scope(small.scope, async () => { const call = await traces.begin({ messages: [{ role: 'user', content: 'x'.repeat(8000) }] }); await call.run(async () => ({ text: '{}' })); call.validated(); });
  const omitted = await small.read(); assert(omitted.traces[0].coverage.rawOmitted); assert(omitted.gaps.some(g => g.code === 'entry-limit')); assert(omitted.gaps.some(g => g.code === 'actual-wire-missing'));
});
test('a stalled encrypted evidence write never blocks a model result and exposes a bounded storage gap', async () => {
  const f = fixture({ writeTimeoutMs: 15 }); f.memory.write = () => new Promise(() => {});
  const result = await traces.scope(f.scope, () => checkedJSON({ messages: [] }, v => v, { request: async () => ({ response: { text: '{"ok":true}' } }) }));
  assert.equal(result.value.ok, true); await f.recorder.flush({ timeoutMs: 100 }); assert(f.recorder.status().gaps.some(g => g.code === 'storage-timeout')); assert.equal(f.recorder.status().unavailable, true);
});
test('shrinking and evicting encrypted trace chunks keep the canonical epoch usable by later journal writes',async()=>{
 const f=fixture({maxEntries:1});
 const entry={schema:traces.SCHEMA,traceId:'shrinking',taskId:f.scope.taskId,scene:'life',visibilityFloor:1,startedAt:100000,status:'requested',assembled:{messages:[{role:'user',content:'synthetic '.repeat(100000)}]},coverage:{assembled:true}};
 f.recorder.record(entry,f.scope);await f.recorder.flush();assert([...f.rows.keys()].some(id=>id==='shrinking:trace:2'));
 entry.assembled.messages[0].content='small final fixture';entry.status='validated';f.recorder.record(entry,f.scope);await f.recorder.flush();
 assert.equal(f.memory.epoch,f.nativeEpoch);assert(f.nativeEpoch>1);assert(!f.rows.has('shrinking:trace:2'));
 const queued=f.memory.serial(()=>f.memory.write([{id:'later-journal',kind:'task',value:{sources:[]}}],f.memory.epoch,{notify:false,strictSources:true,assertCurrent(){}}));await queued;
 f.advance(1);f.recorder.record({...entry,traceId:'replacement',startedAt:100001},f.scope);await f.recorder.flush();
 assert(!f.rows.has('shrinking:trace:0'));assert.equal(f.memory.epoch,f.nativeEpoch);assert.equal(f.gaps.filter(g=>g.code==='storage-failed').length,0);
 await f.memory.serial(()=>f.memory.write([{id:'after-eviction',kind:'task',value:{sources:[]}}],f.memory.epoch,{notify:false,strictSources:true,assertCurrent(){}}));
});
test('trace cleanup waits behind an in-flight canonical checkpoint and adopts its epoch even when the timeout guard expires after deletion',async()=>{
 const f=fixture(),release=Promise.withResolvers(),entered=Promise.withResolvers();let valid=true;
 const busy=f.memory.serial(async()=>{entered.resolve();await release.promise;assert.equal(f.memory.epoch,1);});await entered.promise;
 const removing=f.memory.removeRecord('obsolete-fixture',{assertCurrent:()=>{if(!valid)throw Error('expired guard');}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.nativeEpoch,1);release.resolve();await busy;await removing;assert.equal(f.memory.epoch,2);
 const request=f.memory.db.request;f.memory.db.request=async(...args)=>{const result=await request(...args);valid=false;return result;};
 await assert.rejects(f.memory.removeRecord('obsolete-fixture-2',{assertCurrent:()=>{if(!valid)throw Error('expired guard');}}),/expired guard/);
 assert.equal(f.memory.epoch,3,'an already committed deletion updates epoch before the late guard is checked');
});
test('a generation retired during native deletion keeps the same DB epoch receipt for the queued owner revocation',async()=>{
 const f=fixture(),entered=Promise.withResolvers(),release=Promise.withResolvers(),request=f.memory.db.request;
 f.memory.db.request=async(...args)=>{const result=await request(...args);entered.resolve();await release.promise;return result;};
 const removal=f.memory.removeRecord('expired-trace-chunk');await entered.promise;f.memory.generation++;
 const revocation=f.memory.serial(async()=>{assert.equal(f.memory.epoch,f.nativeEpoch);return f.memory.epoch;});
 release.resolve();await assert.rejects(removal,{code:'E_MEMORY_STALE'});assert.equal(await revocation,2);assert.equal(f.memory.epoch,2);
});
test('WorkBuddy transport records fitted wire messages and strips hidden reasoning from the visible response', async () => {
  const f = fixture(), wb = require('../src/main/workbuddy'); let sent;
  await traces.scope(f.scope, async () => { const call = await traces.begin({ messages: [{ role: 'user', content: 'wire fixture' }] });
    const response = await call.run(() => wb.chatWithTransport({ model: 'hy3', messages: [{ role: 'user', content: 'wire fixture' }], maxTokens: 100 }, async request => { sent = JSON.parse(Buffer.from(request.body_b64, 'base64').toString()); return { body: JSON.stringify({ choices: [{ message: { content: '{"ok":true}', reasoning_content: 'hidden-transport-reasoning-canary' }, finish_reason: 'stop' }], model: 'hy3' }) }; }));
    assert.equal(response.text, '{"ok":true}'); call.validated();
  });
  const { traces: saved } = await f.read(); assert.deepEqual(saved[0].wire[0].request.messages, sent.messages); assert(!JSON.stringify(saved).includes('hidden-transport-reasoning-canary'));
});
test('API transport stores actual outgoing messages and visible completion without URL, key or hidden reasoning',async t=>{
  const http=require('node:http'),f=fixture();let sent;
  const server=http.createServer((request,response)=>{let body='';request.on('data',chunk=>{body+=chunk;});request.on('end',()=>{sent=JSON.parse(body);response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({model:'synthetic-api',choices:[{message:{content:'{"ok":true}',reasoning_content:'hidden-api-reasoning-canary'},finish_reason:'stop'}]}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await traces.scope(f.scope,async()=>{const call=await traces.begin({messages:[{role:'user',content:'API synthetic fixture'}]});await call.run(()=>require('../src/main/llm').chat({transport:'apikey',provider:'openai',baseURL:'http://127.0.0.1:'+server.address().port,apiKey:'synthetic-api-key-canary',model:'synthetic-api',messages:[{role:'user',content:'API synthetic fixture'}],maxTokens:100,timeoutMs:1000}));call.validated();});
  const result=await f.read();assert.deepEqual(result.traces[0].wire[0].request.messages,sent.messages);const raw=JSON.stringify(result);assert(!raw.includes('synthetic-api-key-canary'));assert(!raw.includes('127.0.0.1'));assert(!raw.includes('hidden-api-reasoning-canary'));assert.equal(result.traces[0].wire[0].response.text,'{"ok":true}');
});
