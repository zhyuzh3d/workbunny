'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentService } = require('../src/main/agent-service');
const { RULE } = require('../src/main/dialogue-actions');
const { AGENT_INSTRUCTION } = require('../src/main/agent-interpreter');

// Pure in-memory runtime and a stub model: this verifies intake stages and
// prompt delivery, not how a real model classifies these natural utterances.
function fixture(decide, { logThrows = false } = {}) {
  const records = new Map(), logs = [], reports = [], requests = [];
  let executions = 0;
  const desktop = { task: null, running: false, start: async () => { executions++; return { ok: true }; }, stop: async () => {} };
  const scene = { metrics: {}, native: { request: async () => ({}) }, assertHealthy: async () => {}, invalidate() {}, close() {} };
  const agent = new AgentService({ desktop, conversationDesktop: { ...desktop }, scene, autoSchedule: false,
    ready: () => true, epoch: () => 1, canOperate: async () => true,
    journal: { put: async task => records.set(task.id, structuredClone(task)), list: async () => [...records.values()], authorized: async task => records.has(task.id) },
    report: async report => reports.push(report),
    log: (...args) => { if (logThrows) throw Error('fixture logger failure'); logs.push(args); },
    request: async options => { requests.push(options); return { model: 'offline-fixture', response: { text: JSON.stringify(await decide(options)) } }; },
  });
  const actor = { role: 'owner', verified: true, channel: 'dialogue', sources: ['fixture-owner-turn'], scene: 'life' };
  return { agent, actor, records, logs, reports, requests, executions: () => executions };
}
const work = { kind: 'task', task: { skill: 'work.delegate', goal: 'Create a simple page', subjects: [{ application: 'workbuddy' }],
  workRequest: { goal: 'Create a simple page', output: 'files' }, delivery: { channel: 'speech' }, workContext: { mode: 'none' }, completion: 'goal' } };

for (const utterance of ['Bunny，这是一个新任务，之前的先放一边。', '起一个新任务之前的先放一边。']) {
  test(`a context-only input can resolve to chat without claiming a business task: ${utterance}`, async () => {
    const h = fixture(async options => {
      assert(options.messages.some(m => m.role === 'system' && m.content.includes('当前有效上下文能唯一补全')));
      return { kind: 'chat', text: '好，先换个话题。请告诉我这次需要做什么。' };
    });
    try {
      const old = await h.agent.start({ skill: 'screen.watch', goal: 'legacy-goal-sentinel', subjects: [{ application: 'workbuddy' }] }, h.actor);
      const prior = structuredClone(h.agent.runtime.tasks.get(old.id));
      const input = await h.agent.command(utterance, h.actor, { context: 'legacy-contact-sentinel /fixture/old-report.txt' });
      assert.equal(input.ok, true); assert.equal(input.stage, 'understanding'); assert.equal(input.text, '收到，我先理解你的意思。');
      assert.equal(h.requests.length, 0, 'saving an input adds no foreground model round');
      assert.equal(h.agent.runtime.tasks.get(input.id).skill, 'task.resolve');
      await h.agent.runtime.tick(input.id);
      const resolution = h.agent.runtime.tasks.get(input.id);
      assert.equal(resolution.state.resolution.kind, 'chat'); assert.equal(resolution.status, 'completed');
      assert.deepEqual(h.agent.runtime.tasks.get(old.id), prior, 'a topic change neither pauses nor rewrites an old task');
      assert.equal(h.agent.runtime.list().length, 1); assert.equal(h.executions(), 0); assert.equal(h.requests.length, 1);
      assert.deepEqual(h.logs.map(([, meta]) => meta.stage), ['input_saved', 'interpreted', 'responded']);
      assert.equal(h.logs.at(-1)[1].kind, 'chat'); assert.equal(h.logs.at(-1)[1].status, 'running', 'log the actual status, not a future commit');
      const logged = JSON.stringify(h.logs);
      for (const privateText of [utterance, 'legacy-goal-sentinel', 'legacy-contact-sentinel', '/fixture/old-report.txt', h.reports[0].text]) assert(!logged.includes(privateText));
      for (const [tag, meta] of h.logs) {
        assert.equal(tag, '[task-intake]');
        assert(Object.keys(meta).every(key => ['taskId', 'stage', 'kind', 'skill', 'status'].includes(key)));
      }
    } finally { await h.agent.close(); }
  });
}

test('a real goal is adopted once and logged only after the business skill is durable', async () => {
  const h = fixture(async () => work);
  try {
    const input = await h.agent.command('Create a simple page', h.actor);
    assert.equal(input.stage, 'understanding'); assert.equal(h.logs.some(([, meta]) => meta.stage === 'adopted'), false);
    await h.agent.runtime.tick(input.id);
    assert.equal(h.agent.runtime.tasks.get(input.id).skill, 'work.delegate');
    assert.equal(h.records.get(input.id).skill, 'work.delegate'); assert.equal(h.agent.runtime.list().length, 1);
    const adopted = h.logs.filter(([, meta]) => meta.stage === 'adopted');
    assert.equal(adopted.length, 1); assert.equal(adopted[0][1].kind, 'task'); assert.equal(adopted[0][1].skill, 'work.delegate');
    assert.equal(h.requests.length, 1); assert.equal(h.executions(), 0, 'adoption is distinct from the later execution Action');
  } finally { await h.agent.close(); }
});

test('a cancelled interpretation cannot adopt or persist a late decision', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const h = fixture(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  try {
    const input = await h.agent.command('Create a simple page', h.actor), running = h.agent.runtime.tick(input.id);
    await started; assert.equal((await h.agent.control('pause', input.id)).ok, true);
    release(work); await running;
    const task = h.agent.runtime.tasks.get(input.id);
    assert.equal(task.skill, 'task.resolve'); assert.equal(task.status, 'paused'); assert.equal(task.state.resolvedIntent, undefined);
    assert.equal(h.records.get(input.id).skill, 'task.resolve'); assert.equal(h.executions(), 0);
    assert.equal(h.logs.some(([, meta]) => meta.stage === 'adopted'), false);
    assert.equal(h.logs.at(-1)[1].stage, 'cancelled');
  } finally { await h.agent.close(); }
});

test('logging failures never change intake or adoption outcomes', async () => {
  const h = fixture(async () => work, { logThrows: true });
  try {
    const input = await h.agent.command('Create a simple page', h.actor); assert(input.ok);
    await h.agent.runtime.tick(input.id); assert.equal(h.agent.runtime.tasks.get(input.id).skill, 'work.delegate');
  } finally { await h.agent.close(); }
});

test('both intent prompts distinguish incomplete announcements from actionable contextual requests', () => {
  for (const instruction of [RULE, AGENT_INSTRUCTION]) {
    assert.match(instruction, /仅预告新任务而尚未说明实际目标/u);
    assert.match(instruction, /不能从主人已明确放一边的上下文借用旧业务目标或旧收件人/u);
    assert.match(instruction, /当前有效上下文能唯一补全的正常任务应直接处理，不机械追问/u);
  }
});
