'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SelfSystem } = require('../src/main/self-system');
const { experienceContext } = require('../src/main/context-assembler');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = (extra = {}) => ({ text: JSON.stringify({ type: 'replan', rationaleSummary: '旧解释与新材料矛盾，先在原授权内核查。',
  sourceRefs: ['memory-1', 'summary-1', 'experience-1'], guidance: { objective: '完成原目标', hypotheses: ['先前条件判断可能错误'],
    verificationIdeas: ['只读观察当前状态，比较预期与结果'], alternativeStrategies: ['从可信检查点换一条路径，结果不符时停止'], requiredEvidenceRefs: ['memory-1'] }, ...extra }) });
function fixture(overrides = {}) {
  let scene = 'work', epoch = 7;
  const history = [{ id: 'recent-1', role: 'user', content: '新澄清：优先保留已有成果。', domain: 'work', visibilityFloor: 0, time: 100 }];
  const role = { revision: 4, locked: true, entries: [{ entryId: 'self-entry', revision: 2, locked: true, text: '稳定自我' }], text: '[固定] 稳定自我与长期取向' };
  const summary = { text: '此前共同理解的 Summary，不是新的授权。', sourceIds: ['summary-1'], recordId: 'summary-1', version: 3, scene: 'work' };
  const context = { text: '长期记忆：已完成部分成果，仍可接受反例修正。', sourceIds: ['memory-1'], messages: [], externalMessages: [], epoch: 2, scene: 'work' };
  const model = { provider: 'mock', transport: 'apikey', model: 'actual-owner-model', apiKey: 'test', contextWindow: 131072, maxInputTokens: 131072,
    thinking: 'high', extraBody: { reasoning_effort: 'high' }, timeoutMs: 200, maxTokens: 4096 };
  const calls = [], reads = [];
  const config = { load: () => ({ memory: { enabled: true } }), resolveLLM: () => structuredClone(model),
    buildSystemPrompt: (extra, options) => { assert.equal(extra, ''); return 'EXISTING-PRINCIPLES\nROLE:' + options.roleView.revision + ':' + options.roleView.text + '\nSCENE:' + options.scene + '\nMOTION:' + JSON.stringify(options.motionView); } };
  const memory = { ready: true, generation: 2, sceneEpoch: 1, cognition: { loadRoleView: async options => { assert.deepEqual(options, { repair: false }); return role; } },
    context: async (query, options) => { reads.push({ query, options }); return context; }, compression: { snapshot: async requested => { assert.equal(requested, 'work'); return summary; } },
    query: async () => [] };
  const task = { id: 'task-1', goal: '保留成果并完成目标', criteria: '根据回执自主验收', policy: '只在原授权内操作', scene: 'work', domain: 'work', visibilityFloor: 0,
    subjects: [{ application: 'demo' }], sources: ['owner-source'], authority: { capabilities: ['read'], recipient: 'original-target' },
    state: { operatingKnowledge: [{ sourceId: 'experience-1', origin: 'innate', status: 'bundled', revision: 5, application: 'demo', instructions: '先核对已有成果，再换路径。' },
      { sourceId: 'wrong-app', status: 'validated', application: 'another', instructions: '无关软件经验' }] }, operations: { 'op-1': { id: 'op-1', actionId: 'action-1', status: 'uncertain', effect: 'write' } } };
  const getExperience = async snapshot => ({ knowledge: experienceContext(snapshot, { maxTokens: 1800 }), sourceIds: ['experience-1'], availability: 'current', isCurrent: async () => true });
  const self = new SelfSystem({ config, memory, getScene: () => scene, getEpoch: () => epoch, getRecent: () => history,
    getExperience, llm: { chat: async request => { calls.push(request); return result(); } }, ...overrides });
  return { self, config, memory, history, role, summary, context, model, task, calls, reads, setScene: value => { scene = value; }, setEpoch: value => { epoch = value; } };
}

test('dialogue preparation preserves role, exact prompt options and MemoryService character-budget semantics', async () => {
  const f = fixture(), before = structuredClone(f.history), motionView = { motions: [] };
  f.memory.context = async (query, options) => { f.reads.push({ query, options }); options.recent[0].content = 'mutated private copy'; return f.context; };
  const prepared = await f.self.prepareContext({ userText: '原对话', internal: false, recent: f.history, scene: 'work', motionView, local: async invoke => invoke() });
  assert.equal(prepared.systemPrompt, f.config.buildSystemPrompt('', { scene: 'work', roleView: f.role, motionView }));
  assert.deepEqual(f.reads[0].options, { internal: false, recent: [{ ...before[0], content: 'mutated private copy' }], scene: 'work', budget: 20000, allowSensitive: true });
  prepared.role.entries[0].text = 'output copy'; prepared.memoryContext.sourceIds.push('copy-only');
  assert.equal(f.role.entries[0].text, '稳定自我'); assert.deepEqual(f.context.sourceIds, ['memory-1']); assert.deepEqual(f.history, before); assert.equal(f.calls.length, 0);
  await f.self.prepareContext({ userText: '内部观察', internal: true }); assert.equal(f.reads[1].options.internal, true); assert.equal(f.reads[1].options.allowSensitive, false);
});

test('memory-disabled dialogue uses the same fallback role and caller supplied time text', async () => {
  const f = fixture(); f.self.memory = null; f.self.getTimeText = () => '原 nowLine';
  const prepared = await f.self.prepareContext({ userText: '你好' });
  assert.equal(prepared.role, null); assert(prepared.systemPrompt.includes('我温和、诚实、好奇，有自己的判断。'));
  assert.equal(prepared.memoryContext.text, '原 nowLine'); assert.deepEqual(prepared.memoryContext.messages, f.history);
  prepared.memoryContext.messages[0].content = 'copy'; assert.notEqual(f.history[0].content, 'copy');
});

test('review shares stable cognition, explicit Summary and applicable experience with real model thinking', async () => {
  const f = fixture(), before = structuredClone({ task: f.task, history: f.history, role: f.role });
  const review = await f.self.reviewTask({ task: f.task, run: { id: 'action-1', status: 'running' }, event: { id: 'event-1', reason: '结果与预期矛盾' }, reviewId: 'review-1', basis: { controlRevision: 2 } });
  assert.equal(f.reads[0].options.internal, false); assert.equal(f.reads[0].options.allowSensitive, false);
  const request = f.calls[0], input = JSON.parse(request.messages[1].content), stable = input.stableCognition;
  assert(request.messages[0].content.startsWith('EXISTING-PRINCIPLES\nROLE:4:')); assert.equal(request.thinking, 'low'); assert.equal(request.extraBody.reasoning_effort, 'low');assert.deepEqual(request.extraBody.response_format,{type:'json_object'});
  assert.equal(request.priority, 'background'); assert.equal(request.model, 'actual-owner-model'); assert.equal(request.webSearch, false); assert.equal(request.contextSession, undefined);
  assert.equal(request.onDelta, undefined); assert.equal(request.onSentence, undefined);
  assert.equal(stable.roleRevision, 4); assert(stable.memory.includes('长期记忆')); assert.equal(stable.summary.text, f.summary.text);
  assert.deepEqual(stable.experience.knowledge.map(item => item.sourceId), ['experience-1']); assert.equal(stable.experience.knowledge[0].revision, 5);
  assert.deepEqual(input.task.task.authority, f.task.authority); assert.equal(input.task.operations[0].status, 'uncertain');
  assert(input.sourceRefs.includes('op-1'));
  assert.equal(input.trust, 'scoped-state-and-history-not-new-authorization'); assert.equal(review.context.summaryVersion, 3);
  assert.equal(review.context.assembly.purpose, 'task.main-review'); assert.equal(review.type, 'replan'); assert.deepEqual(review.basis, { controlRevision: 2 });
  assert.deepEqual({ task: f.task, history: f.history, role: f.role }, before);
});

test('review output recovery changes only response budgets and keeps complete goal, authority and evidence', async () => {
  const f=fixture(), before=structuredClone(f.model), requests=[];
  f.model.extraBody.max_tokens=4096;
  f.self.llm=async request=>{requests.push(request);if(requests.length<3)throw Object.assign(Error('synthetic output size limit'),{code:'E_PAYLOAD_TOO_LARGE'});return result();};
  let responseProfile;
  for(let attempt=0;attempt<2;attempt++){
    await assert.rejects(f.self.reviewTask({task:f.task,responseProfile}),failure=>{assert.equal(failure.code,'E_PAYLOAD_TOO_LARGE');responseProfile=failure.reviewResponseProfile;return true;});
    assert.deepEqual(responseProfile,{maxTokens:attempt===0?2048:1024,thinking:'low',reasoningEffort:'low'});
  }
  assert.equal((await f.self.reviewTask({task:f.task,responseProfile})).type,'replan');
  assert.deepEqual(requests.map(request=>[request.maxTokens,request.thinking,request.extraBody.reasoning_effort]),[[4096,'low','low'],[2048,'low','low'],[1024,'low','low']]);
  const original=JSON.parse(requests[0].messages[1].content);
  for(const request of requests.slice(1)){
    const input=JSON.parse(request.messages[1].content);
    assert(input.task.taskTiming.now>=original.task.taskTiming.now);const comparable=structuredClone(input.task),previous=structuredClone(original.task);delete comparable.taskTiming.now;delete previous.taskTiming.now;assert.deepEqual(comparable,previous);assert.deepEqual(input.sourceRefs,original.sourceRefs);assert.deepEqual(input.stableCognition,original.stableCognition);
    assert.equal(request.extraBody.max_tokens,undefined);assert.equal(request.model,before.model);
  }
  assert.deepEqual(f.model,{...before,extraBody:{...before.extraBody,max_tokens:4096}});
});

test('review recovery reuses effective output limits and rejects malformed budget profiles', async () => {
  const f=fixture();f.self.llm=async()=>{throw Object.assign(Error('synthetic output truncated'),{code:'E_OUTPUT_LIMIT',diagnostic:{completion:{maxOutputTokens:4096}}});};
  await assert.rejects(f.self.reviewTask({task:f.task}),failure=>{assert.deepEqual(failure.reviewResponseProfile,{maxTokens:8192,thinking:'low',reasoningEffort:'low'});return true;});
  f.self.llm=async request=>{f.calls.push(request);return result();};
  await f.self.reviewTask({task:f.task,responseProfile:{maxTokens:999999,thinking:'low',reasoningEffort:'low',messages:[]}});
  assert.equal(f.calls[0].maxTokens,4096);assert.equal(f.calls[0].thinking,'low');
});
test('nonempty truncated review completions retain their output-limit diagnosis and use shared response recovery',async()=>{
 const f=fixture();f.self.llm=async request=>{f.calls.push(request);return {text:'{"type":"accept","rationaleSummary":"incomplete',model:'actual-owner-model',finishReason:'length',usage:{completion_tokens:1024},contextBudget:{output:1024}};};
 await assert.rejects(f.self.reviewTask({task:f.task,responseProfile:{maxTokens:1024,thinking:'low',reasoningEffort:'low'}}),failure=>{assert.equal(failure.code,'E_OUTPUT_LIMIT');assert.equal(failure.diagnostic.completion.maxOutputTokens,1024);assert.equal(failure.diagnostic.completion.finishReason,'length');assert.deepEqual(failure.reviewResponseProfile,{maxTokens:8192,thinking:'low',reasoningEffort:'low'});return true;});
 assert.equal(f.calls.length,1,'the existing review scheduler owns further attempts');
});

test('recent accepted changes refresh after stable reads and private related material remains excluded', async () => {
  const reading = deferred(), release = deferred(), f = fixture({ getExperience: async () => { reading.resolve(); await release.promise; return { knowledge: [], sourceIds: [] }; } });
  f.self.llm = async request => { f.calls.push(request); return result({ sourceRefs: ['memory-1', 'summary-1'] }); };
  const pending = f.self.reviewTask({ task: f.task, relatedTasks: [
    { id: 'peer-ok', goal: '关联任务结果', scene: 'work', domain: 'work', visibilityFloor: 0, status: 'completed', sources: ['peer-receipt'] },
    { id: 'peer-private', goal: '不应进入', scene: 'private', domain: 'private', visibilityFloor: 2 },
  ] });
  await reading.promise;
  f.history.push({ id: 'new-owner-message', role: 'user', content: '新信息：原材料已经可用。', domain: 'work', visibilityFloor: 0 });
  f.history.push({ id: 'private-message', role: 'user', content: '私聊材料', domain: 'private', visibilityFloor: 2 });
  release.resolve(); await pending;
  const input = JSON.parse(f.calls[0].messages[1].content);
  assert(input.recentSituation.some(row => row.id === 'new-owner-message')); assert(!JSON.stringify(input).includes('私聊材料'));
  assert.deepEqual(input.relatedTasks.map(row => row.id), ['peer-ok']); assert(!input.sourceRefs.includes('peer-private'));
});

test('only the current success proposal permits accept and includes the original goal, result and effect history', async () => {
  const f=fixture();f.self.llm=async request=>{f.calls.push(request);return result({type:'accept',rationaleSummary:'实际结果满足原目标',guidance:{}});};
  await assert.rejects(f.self.reviewTask({task:f.task}),{code:'E_SELF_PROTOCOL'});
  const proposal={id:'proposal-1',status:'pending',summary:'任务脑已完成',resultRevision:2};
  f.task.state.completionProposal=proposal;f.task.state.result={revision:2,summary:'当前实际成果'};
  await assert.rejects(f.self.reviewTask({task:f.task,completionProposal:{...proposal,id:'old-proposal'}}),{code:'E_SELF_PROTOCOL'});
  const reviewed=await f.self.reviewTask({task:f.task,completionProposal:proposal});
  const request=f.calls.at(-1),input=JSON.parse(request.messages[1].content);
  assert.equal(reviewed.type,'accept');assert.equal(reviewed.context.assembly.purpose,'task.completion-review');
  assert.equal(input.task.completion.proposal.id,'proposal-1');assert(JSON.stringify(input.task.completion.result).includes('当前实际成果'));
  assert.equal(input.task.task.goal,f.task.goal);assert.deepEqual(input.task.task.authority,f.task.authority);
  assert(input.task.operations.some(op=>op.id==='op-1'&&op.status==='uncertain'));
  assert(request.messages[0].content.includes('整改后由任务脑重新提交'));
});

test('review preserves original owner constraints and the actual registered result norms alongside native false facts',async()=>{
 const tools=new(require('../src/main/agent-tools').ToolRegistry)();require('../src/main/conversation-tools').registerConversationTools(tools,{scene:{},execute:async()=>assert.fail('review cannot execute a tool')});
 const f=fixture({getToolContract:name=>{try{const tool=tools.get(name);return {description:tool.description,resultContract:tool.resultContract};}catch{return null;}}});
 f.task.state.ownerRequest='Send the supplied body once using the existing host output conventions.';f.task.context='Only the authorized target is in scope.';
 f.task.operations['op-1']={id:'op-1',tool:'conversation.send',effect:'write',status:'confirmed',inputOutcome:{targetVerified:false,dispatched:true,reportsSubmitted:42},result:{ok:true,verified:true,receipt:{recipient:'Synthetic Contact',sentText:require('../src/shared/external-message').MARK+' body'},visualFeedback:{advisory:true,identityChanged:true}}};
 await f.self.reviewTask({task:f.task});const payload=JSON.parse(f.calls[0].messages[1].content),core=payload.task.task;
 assert.equal(core.ownerRequest,f.task.state.ownerRequest);assert.equal(core.context,f.task.context);assert.deepEqual(core.toolContracts[0].resultContract,tools.get('conversation.send').resultContract);assert(core.toolContracts[0].resultContract.sourceMark.includes(require('../src/shared/external-message').MARK));
 assert(core.receiptSemantics.inputOutcome.includes('false不能单独推导'));assert(core.receiptSemantics.visualFeedback.includes('不是业务验收失败'));assert.equal(payload.task.operations[0].inputOutcome.targetVerified,false);assert.equal(f.task.operations['op-1'].inputOutcome.targetVerified,false);
});
test('confirmed effects and resolved failures survive a flood of newer reads and historical contrary guidance',async()=>{
 const f=fixture();f.task.operations={sent:{id:'sent',tool:'fixture.send',effect:'write',status:'confirmed',at:10,finishedAt:30,inputOutcome:{dispatched:true,targetVerified:false,reportsSubmitted:2,inputKinds:['key'],inputKindsComplete:true},result:{ok:true,verified:true,receipt:{desiredTextRef:'scoped-ref',observedText:'Actual observed body',deliveryAssessment:{completed:true,evidence:'Actual visual result with a minor variation',receipt:{observedText:'Actual observed body'},checkedAt:30}},preview:'data:image/png;base64,AAAA'}}};
 for(let i=0;i<16;i++)f.task.operations['read-'+i]={id:'read-'+i,tool:i%2?'model.request':'fixture.observe',effect:'read',status:'confirmed',at:40+i,result:{ok:true}};
 f.task.state.lastFailure={message:'A long historical error '.repeat(200),code:'E_UPSTREAM',operationId:'sent',at:15,resolvedAt:31,resolution:'operation-confirmed'};f.task.state.recoveryGuidance={at:16,nextStep:'Old sent operation was not_dispatched; try again'};
 await f.self.reviewTask({task:f.task});const input=JSON.parse(f.calls[0].messages[1].content).task;
 assert(!input.operations.some(op=>op.id==='sent'));assert.equal(input.effectFacts[0].status,'confirmed');assert.equal(input.effectFacts[0].inputOutcome.targetVerified,false);assert.equal(input.effectFacts[0].resultFacts.receipt.observedText,'Actual observed body');assert.equal(input.effectFacts[0].resultFacts.receipt.deliveryAssessment.completed,true);
 assert.equal(input.state.lastFailure.resolvedAt,31);assert.equal(input.state.lastFailure.current,false);assert.equal(input.state.recoveryGuidance.historical,true);assert.equal(input.state.recoveryGuidance.at,16);assert(JSON.parse(f.calls[0].messages[1].content).sourceRefs.includes('sent'));assert(!JSON.stringify(input.effectFacts).includes('data:image'));
});
test('default review allowance accounts for dense required authorization, effect and stable-source metadata without exceeding the provider',async()=>{
 const f=fixture(),refs=Array.from({length:47},(_,i)=>'source-'+String(i).padStart(64,'0'));
 f.task.sources=refs;f.task.authority.sources=refs;f.task.state.ownerRequest='Preserve the original goal and the confirmed observed result.';
 f.task.context='Required business constraints and their authorization source. '.repeat(120);
 f.context.sourceIds=['memory-1',...Array.from({length:63},(_,i)=>'memory-source-'+String(i).padStart(64,'0'))];
 f.task.operations={sent:{id:'sent',tool:'fixture.send',effect:'write',status:'confirmed',inputOutcome:{dispatched:true,inputKinds:['key'],inputKindsComplete:true,reportsSubmitted:2},result:{ok:true,verified:true,receipt:{desiredText:'Requested synthetic body',observedText:'Actual observed synthetic body',deliveryAssessment:{completed:true,evidence:'Fresh visible outcome '.repeat(100),receipt:{observedText:'Actual observed synthetic body'},checkedAt:1000}}}}};
 const before=structuredClone(f.task);await assert.rejects(f.self.reviewTask({task:f.task,maxTokens:16000}),{code:'E_SELF_CONTEXT_BUDGET'});assert.equal(f.calls.length,0);
 const review=await f.self.reviewTask({task:f.task}),input=JSON.parse(f.calls[0].messages[1].content),tokens=require('../src/main/context-budget');
 assert(review.context.assembly.budget>16000);assert.deepEqual(input.task.task.authority,f.task.authority);assert.equal(input.task.task.ownerRequest,f.task.state.ownerRequest);assert.equal(input.task.task.context,f.task.context);assert.equal(input.task.effectFacts[0].resultFacts.receipt.observedText,'Actual observed synthetic body');assert.equal(input.stableCognition.memorySources.length,64);
 assert(tokens.cost(f.calls[0].messages,f.calls[0].extraBody)<=f.calls[0].contextBudget.inputBudget);assert.deepEqual(f.task,before);
});

test('review cannot elevate the task scene or inject executable tool hooks', async () => {
  const f = fixture();
  await assert.rejects(f.self.reviewTask({ task: f.task, scene: 'private' }), { code: 'E_SELF_SCOPE' });
  assert.equal(f.calls.length, 0);
  f.model.extraBody.tools = [{ type: 'function', function: { name: 'write' } }];
  await f.self.reviewTask({ task: f.task }); assert.equal(f.calls[0].extraBody.tools, undefined);
});

test('cancellation during a stuck local read is bounded and cannot start a late model call', async () => {
  const entered = deferred(), late = deferred(), f = fixture(), controller = new AbortController();
  f.memory.context = () => { entered.resolve(); return late.promise; };
  const pending = f.self.reviewTask({ task: f.task, signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); late.resolve(f.context); await pause(10); assert.equal(f.calls.length, 0);
});

test('local preparation timeout releases the invocation even when storage ignores cancellation', async () => {
  const f = fixture({ localTimeoutMs: 15 }); f.memory.cognition.loadRoleView = () => new Promise(() => {});
  await assert.rejects(f.self.reviewTask({ task: f.task }), { code: 'E_SELF_LOCAL_TIMEOUT' }); assert.equal(f.calls.length, 0);
});

test('model timeout and late result cannot alter a later review or original dialogue history', async () => {
  const late = deferred(), f = fixture({ reviewTimeoutMs: 30 }); let first = true;
  const before = structuredClone(f.history);
  f.self.llm = async request => { f.calls.push(request); if (first) { first = false; return late.promise; } return result({ type: 'continue' }); };
  await assert.rejects(f.self.reviewTask({ task: f.task, reviewId: 'retired' }), failure => ['E_SELF_TIMEOUT','E_SELF_MODEL_TIMEOUT'].includes(failure.code));
  const current = await f.self.reviewTask({ task: f.task, reviewId: 'current' });
  late.resolve(result({ type: 'fail' })); await pause(10);
  assert.equal(current.type, 'continue'); assert.equal(current.reviewId, 'current'); assert.deepEqual(f.history, before); assert(f.calls[0].signal.aborted);
});

test('cancelled model late rejection is observed and does not touch a dialogue invocation', async () => {
  const entered = deferred(), late = deferred(), f = fixture(), controller = new AbortController();
  f.self.llm = request => { entered.resolve(request); return late.promise; };
  const pending = f.self.reviewTask({ task: f.task, signal: controller.signal }); const request = await entered.promise;
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert(request.signal.aborted);
  const dialogue = await f.self.prepareContext({ userText: '主人插话' }); assert.equal(dialogue.role.revision, 4);
  late.reject(Error('late network failure')); await pause(10); assert.deepEqual(f.context.sourceIds, ['memory-1']);
});

test('scene, privacy epoch and caller baseline changes reject stale model output', async () => {
  for (const change of [f => f.setScene('life'), f => f.setEpoch(8), f => { f.memory.generation++; }, f => { f.memory.sceneEpoch++; }]) {
    const entered = deferred(), late = deferred(), f = fixture();
    f.self.llm = () => { entered.resolve(); return late.promise; };
    const pending = f.self.reviewTask({ task: f.task }); await entered.promise; change(f); late.resolve(result());
    await assert.rejects(pending, { code: 'E_SELF_STALE' });
  }
  const f = fixture(); await assert.rejects(f.self.reviewTask({ task: f.task, isCurrent: () => false }), { code: 'E_SELF_STALE' }); assert.equal(f.calls.length, 0);
});

test('role, Summary and experience revisions are rechecked after model return', async () => {
  for (const changed of ['role', 'summary', 'experience']) {
    const entered = deferred(), late = deferred(); let experienceCurrent = true;
    const f = fixture({ getExperience: async () => ({ knowledge: [], sourceIds: [], availability: 'current', isCurrent: async () => experienceCurrent }) });
    f.self.llm = () => { entered.resolve(); return late.promise; };
    const pending = f.self.reviewTask({ task: f.task }); await entered.promise;
    if (changed === 'role') f.role.revision++; else if (changed === 'summary') f.summary.version++; else experienceCurrent = false;
    late.resolve(result({ sourceRefs: ['memory-1', 'summary-1'] })); await assert.rejects(pending, { code: 'E_SELF_STALE' });
  }
});

test('runtime deadline is enforced before preparation and bounds the actual model timeout', async () => {
  const f = fixture();
  await assert.rejects(f.self.reviewTask({ task: f.task, deadlineAt: Date.now() - 1 }), { code: 'E_SELF_TIMEOUT' }); assert.equal(f.calls.length, 0);
  const deadlineAt = Date.now() + 90; await f.self.reviewTask({ task: f.task, deadlineAt }); assert(f.calls[0].timeoutMs <= 90);
});

test('malformed decisions, unknown references, tool calls and unbounded waits are rejected', async () => {
  const responses = [
    { text: '{"type":"continue","type":"fail"}' }, result({ type: 'self_suspended' }), result({ sourceRefs: ['invented-source'] }),
    result({ guidance: { execute: 'write' } }), result({ type: 'wait', guidance: { waitCondition: '未来某时' } }),
    { ...result(), toolCalls: [{ name: 'write' }] }, result({ status: 'completed' }),
  ];
  for (const response of responses) { const f = fixture({ llm: async () => response }); await assert.rejects(f.self.reviewTask({ task: f.task }), { code: 'E_SELF_PROTOCOL' }); }
  const f = fixture({ llm: async () => result({ type: 'wait', nextCheckAt: Date.now() + 10000, guidance: { waitCondition: '等待原材料准备完成后只读核对' } }) });
  const review = await f.self.reviewTask({ task: f.task }); assert.equal(review.type, 'wait'); assert.equal(f.task.status, undefined);
});

test('missing stable sources remain explicit and model failure never becomes a business failure decision', async () => {
  const f = fixture({ getExperience: async () => ({ knowledge: [], sourceIds: [], availability: 'unavailable' }), llm: async () => { throw Error('network unavailable'); } });
  f.memory.compression.snapshot = async () => ({ text: '', sourceIds: [], version: 0 });
  await assert.rejects(f.self.reviewTask({ task: f.task }), /network unavailable/);
  assert.equal(f.task.state.disposition, undefined); assert.equal(f.task.state.selfSuspension, undefined);
});

test('required stable cognition and original boundaries are never silently trimmed to fit', async () => {
  const f = fixture(); f.task.goal = '原始目标不可删除'.repeat(5000);
  await assert.rejects(f.self.reviewTask({ task: f.task, maxTokens: 512 }), { code: 'E_SELF_CONTEXT_BUDGET' }); assert.equal(f.calls.length, 0);
});

test('default experience reader reuses repository snapshots and rejects changes without writing memory', async () => {
  const entered = deferred(), late = deferred(), f = fixture({ getExperience: undefined });
  const lesson = { id: 'experience-1', kind: 'state', state: 'active', ts: 1, domain: 'work', visibilityFloor: 0,
    value: { origin: 'owner-teaching', status: 'validated', revision: 3, instructions: '核对前序成果，选择新的路径。', tags: ['software:demo'], sources: ['lesson-source'] } };
  const parent = { id: 'lesson-source', kind: 'message', state: 'active', ts: 0, domain: 'work', visibilityFloor: 0, value: { role: 'user', content: '经验来源', sources: [] } };
  const records = new Map([[lesson.id, lesson], [parent.id, parent]]), searches = [];
  f.memory.experienceRepository = { search: async options => { searches.push(options); return [structuredClone(lesson)]; } };
  f.memory.innateExperiences = { enabled: () => false };
  f.memory.db = { request: async (method, { ids }) => { assert.equal(method, 'get'); return { rows: ids.flatMap(id => records.has(id) ? [structuredClone(records.get(id))] : []) }; } };
  f.memory.decode = row => row;
  f.self.llm = request => { f.calls.push(request); entered.resolve(); return late.promise; };
  const pending = f.self.reviewTask({ task: f.task }); await entered.promise;
  const stable = JSON.parse(f.calls[0].messages[1].content).stableCognition;
  assert.equal(stable.experience.availability, 'current'); assert.equal(stable.experience.knowledge[0].revision, 3);
  assert(searches.every(options => options.scene === 'work' && options.excludeTaskId === 'task-1'));
  lesson.value.revision++; late.resolve(result());
  await assert.rejects(pending, { code: 'E_SELF_STALE' }); assert.equal(f.task.state.operatingKnowledge[0].revision, 5);
});

test('task historical attempts stay bounded while original receipts and unknown effects remain visible', async () => {
  const f = fixture(); f.task.state.attempts = Array.from({ length: 30 }, (_, step) => ({ step, tool: 'read', result: { outcome: 'unconfirmed' } }));
  f.task.state.recoveryState = { episodeId: 'same-episode', obstacleConfirmed: false, localAttempts: 3 };
  f.task.state.unknownEffects = ['op-1'];
  await f.self.reviewTask({ task: f.task }); const input = JSON.parse(f.calls[0].messages[1].content);
  assert.equal(input.task.state.attempts.length, 8); assert.equal(input.task.state.attempts[0].step, 22);
  assert.equal(input.task.state.recoveryState.episodeId, 'same-episode'); assert.deepEqual(input.task.state.unknownEffects, ['op-1']);
  assert.equal(f.task.state.attempts.length, 30);
});

test('large image receipts stay recoverable by ID without becoming mandatory base64 text', async () => {
  const f = fixture(), preview = 'data:image/jpeg;base64,' + 'A'.repeat(900000);
  f.task.operations = Object.fromEntries(Array.from({ length: 12 }, (_, index) => ['op-' + index, { id: 'op-' + index, actionId: 'action-1', tool: 'screen.observe',
    effect: index === 0 ? 'write' : 'read', status: index === 0 ? 'intent' : 'confirmed', result: { available: true, changed: false, frameId: 'frame-' + index, preview } }]));
  f.task.state.attempts = Array.from({ length: 12 }, (_, step) => ({ step, tool: 'screen.observe', result: { available: true, frameId: 'frame-' + step, preview } }));
  const run = { id: 'action-1', status: 'running', progress: { observations: Array.from({ length: 4 }, () => ({ preview, frameId: 'frame' })) },
    recoveryState: { episodeId: 'episode-1', assessment: { summary: '观察未解释旧假设', preview } } };
  const review = await f.self.reviewTask({ task: f.task, run, event: { key: 'event-1', type: 'observed', preview } });
  const raw = f.calls[0].messages[1].content, input = JSON.parse(raw);
  assert.equal(review.type, 'replan'); assert(!raw.includes('data:image')); assert(!raw.includes('A'.repeat(1000))); assert(raw.length < 80000);
  assert.equal(input.task.operationDetailsOmitted, 4); assert.equal(input.task.unknownWrites[0].id, 'op-0');
  assert.equal(input.task.unknownWrites[0].status, 'intent'); assert.equal(input.task.operations[0].resultFacts.available, true);
  assert.equal(input.task.operations[0].resultFacts.frameId, 'frame-4'); assert.equal(input.task.action.recoveryState.episodeId, 'episode-1');
  assert.equal(f.task.operations['op-0'].result.preview, preview); assert.equal(run.progress.observations.length, 4);
});

test('default review selects complete CJK memory passages within measured token budgets and reports omissions', async () => {
  const f = fixture();
  f.context.text = Array.from({ length: 12 }, (_, index) => `[memory-${index}] ` + '已取得的稳定成果与可修正的长期认识。'.repeat(50)).join('\n');
  const review = await f.self.reviewTask({ task: f.task }); const input = JSON.parse(f.calls[0].messages[1].content), stable = input.stableCognition;
  assert.equal(review.type, 'replan'); assert.equal(stable.memorySelection.partial, true); assert(stable.memorySelection.omittedPassages > 0);
  assert(stable.memory.includes('[memory-0]')); assert(stable.memory.endsWith('。')); assert.equal(stable.summary.text, f.summary.text);
  assert.equal(stable.experience.knowledge[0].sourceId, 'experience-1'); assert.equal(input.task.task.goal, f.task.goal);
  const tokenBudget = require('../src/main/context-budget');
  assert(tokenBudget.textTokens(input.stableCognition) + tokenBudget.textTokens(input.task) <= review.context.assembly.budget);
  assert(tokenBudget.cost(f.calls[0].messages, f.calls[0].extraBody) <= f.calls[0].contextBudget.inputBudget);
});
test('optional recovery details yield to original boundaries and stable cognition within the default review allowance',async()=>{
 const f=fixture(),detail='Synthetic diagnostic history with repeated observations. '.repeat(1000);
 f.task.parameters={retrieval:'original-task-operation-or-source-id',text:'Original task restriction must remain exact'};
 f.context.sourceIds=['memory-1',...Array.from({length:63},(_,i)=>'memory-source-'+String(i).padStart(24,'0'))];
 f.task.state.progress={facts:Array.from({length:20},()=>detail)};
 f.task.state.softwareMethods=Array.from({length:24},(_,i)=>({tool:'generic.inspect',at:i,evidence:detail}));
 f.task.state.attempts=Array.from({length:8},(_,step)=>({step,tool:'generic.inspect',result:{evidence:detail}}));
 f.task.operations=Object.fromEntries(Array.from({length:8},(_,i)=>['op-'+i,{id:'op-'+i,actionId:'action-1',tool:'generic.inspect',effect:i===0?'write':'read',status:i===0?'uncertain':'not_dispatched',error:detail,result:{available:true,evidence:detail}}]));
 const before=structuredClone(f.task),run={id:'action-1',status:'running',progress:{facts:[detail]},recoveryState:{episodeId:'episode-1',assessment:{summary:detail}}};
 const review=await f.self.reviewTask({task:f.task,run});
 const request=f.calls[0],input=JSON.parse(request.messages[1].content),tokenBudget=require('../src/main/context-budget');
 assert.equal(review.type,'replan');assert.deepEqual(input.task.task.authority,f.task.authority);assert.equal(input.task.task.goal,f.task.goal);assert.equal(input.task.task.policy,f.task.policy);
 assert.equal(input.task.unknownWrites[0].id,'op-0');assert.equal(input.task.unknownWrites[0].status,'uncertain');assert(input.stableCognition.memory.includes('长期记忆'));
 assert(input.task.state.progress.partial);assert(input.task.state.softwareMethods.partial);assert(tokenBudget.cost(request.messages,request.extraBody)<=request.contextBudget.inputBudget);
 assert.deepEqual(f.task,before);
 const smaller=await f.self.reviewTask({task:f.task,run,maxTokens:8000}),compact=JSON.parse(f.calls[1].messages[1].content);
 assert.equal(smaller.type,'replan');assert.deepEqual(compact.task.task.authority,f.task.authority);assert.equal(compact.task.task.policy,f.task.policy);
 assert.deepEqual(compact.task.task.parameters,f.task.parameters);
 assert(compact.task.operations[0].result.text.length<input.task.operations[0].result.text.length,'only optional excerpts shrink further for a smaller review allowance');
});
test('recovery sees unknown native input on a declared read without shrinking away its receipt facts',async()=>{
 const f=fixture();f.task.operations={'read-with-input':{id:'read-with-input',actionId:'action-1',tool:'generic.navigation',effect:'read',status:'intent',inputOutcome:{dispatched:true,completion:'unknown',inputKinds:['click'],inputKindsComplete:true,reportsSubmitted:4}}};
 await f.self.reviewTask({task:f.task,run:{id:'action-1'}});const material=JSON.parse(f.calls[0].messages[1].content).task;
 assert.equal(material.unknownWrites[0].id,'read-with-input');assert.equal(material.unknownWrites[0].effect,'read');assert.equal(material.unknownWrites[0].inputOutcome.completion,'unknown');assert.deepEqual(material.operations[0].inputOutcome.inputKinds,['click']);
});
