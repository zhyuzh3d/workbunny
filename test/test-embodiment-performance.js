'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Embodiment } = require('../src/main/embodiment');
const { MotionLibrary } = require('../src/main/motion-library');
const { AvatarActionCatalog } = require('../src/main/avatar-action-catalog');

function fixture(t, { pack = false, timeoutMs = 500, completionTimeoutMs, persist } = {}) {
  const motions = [
    { key: 'wave', label: '挥手', slot: 'greet', enabled: true },
    { key: 'run', label: '原地跑', slot: 'greet', enabled: true, autonomous: false, loop: true },
    { key: 'sit', label: '坐着举手', slot: 'greet', enabled: true, posture: 'sitting', autonomous: false },
    { key: 'phone', label: '看手机', slot: 'greet', enabled: true, requiresProp: true }
  ];
  const catalog = pack ? new AvatarActionCatalog({ namespace: 'pet', categories: [{ id: 'greet', label: '问候', description: '问候' }],
    actions: motions.map(m => ({ id: m.key, label: m.label, category: m.slot, use: m.label, duration: 1,
      autonomous: m.autonomous, loop: m.loop, requiresExternalProp: m.requiresProp, idle: m.key === 'run' })), defaultIdle: 'run' }) :
    new MotionLibrary({ motions, groups: [{ id: 'greet', label: '问候' }], getConfig: () => ({ motions: {} }), random: () => 0 });
  const sent = []; let avatar = { key: 'test', kind: pack ? 'avatar-pack' : 'vrm' };
  const body = new Embodiment({ catalog, avatar: () => avatar, send: event => sent.push(event), clock: () => 100000, timeoutMs, completionTimeoutMs, ...(persist ? { persist } : {}) });
  t.after(() => body.close());
  return { body, sent, catalog, select: key => pack ? `pet_${key}` : key, changeAvatar: () => { avatar = { key: 'other', kind: avatar.kind }; body.avatarChanged(); } };
}
function report(f, event = f.sent.findLast(event => event.requestId), phase = 'started', extra = {}) {
  return f.body.report({ ...event, avatar: 'test', phase, ok: phase !== 'failed', ...extra });
}
function perform(f, key = 'run', performanceId = 'performance-1', extra = {}) {
  return f.body.perform(f.select(key), 'performance', { performanceId, allowPostureChange: true, holdMs: 4000, ...extra });
}

for (const pack of [false, true]) test(`explicit performance selects nonautonomous motion without pretending manual (${pack ? 'pack' : 'VRMA'})`, async t => {
  const f = fixture(t, { pack });
  const started = perform(f);
  assert.equal(f.sent[0].reason, 'performance'); assert.equal(f.sent[0].holdMs, 4000);
  assert.equal(f.body.snapshot().performance.active.phase, 'loading');
  assert.equal((await f.body.perform(f.select('wave'), 'thinking')).suppressed, true);
  assert.equal(report(f), true); assert.equal((await started).ok, true);
  assert.equal(f.body.snapshot().performance.active.phase, 'started');
  assert.equal((await f.body.perform(f.select('wave'), 'reply')).suppressed, true);
  assert.equal(f.body.recent.length, 1); assert.equal(f.body.recent[0].reason, 'performance');
  assert.equal(report(f, f.sent[0], 'finished'), true);
  assert.equal(f.body.recent.length, 1);
  assert.equal(f.body.snapshot().performance.active, null);
  assert.equal(f.body.context().lastPerformance.phase, 'finished');
  assert.equal(report(f, f.sent[0]), false);
});

test('performance preserves genuine prop and posture constraints, and exact selection never falls back to a category', async t => {
  const f = fixture(t);
  assert.equal((await perform(f, 'phone')).ok, false);
  assert.equal((await f.body.perform('sit', 'performance', { performanceId: 'wrong-posture' })).ok, false);
  assert.equal((await f.body.perform('greet', 'performance', { performanceId: 'category' })).ok, false);
  assert.equal(f.sent.length, 0);
  const pending = perform(f, 'sit'); report(f);
  assert.equal((await pending).ok, true);
  assert.equal(f.sent[0].allowPostureChange, true);
  assert.equal(f.body.posture, 'standing');
  f.body.setPosture({ avatar: 'test', posture: 'sitting' });
  assert.equal(f.body.posture, 'sitting');
});

test('cancellation during loading resolves the receipt, sends identity cancellation, and ignores every late event', async t => {
  const f = fixture(t), pending = perform(f), original = f.sent[0];
  assert.equal(f.body.cancelPerformance('new-input'), true);
  assert.equal((await pending).cancelled, true);
  assert.deepEqual(f.sent[1], { cancelPerformance: 'performance-1' });
  for (const phase of ['started', 'finished', 'failed', 'cancelled']) assert.equal(report(f, original, phase), false);
  assert.equal(f.body.recent.length, 0);
  assert.equal(f.body.snapshot().performance.lastOutcome.reason, 'new-input');
});

test('parent abort is detached after start; later explicit interruption retains actual history and cannot cancel a new performance', async t => {
  const f = fixture(t), controller = new AbortController();
  const first = perform(f, 'run', 'one', { signal: controller.signal }), oldEvent = f.sent[0]; report(f);
  assert.equal((await first).ok, true);
  controller.abort();
  assert.equal(f.body.snapshot().performance.active.performanceId, 'one');
  f.body.cancelPerformance('new-input');
  const second = perform(f, 'wave', 'two'), newEvent = f.sent.at(-1);
  assert.equal(report(f, oldEvent, 'cancelled'), false);
  assert.equal(f.body.snapshot().performance.active.performanceId, 'two');
  report(f, newEvent); assert.equal((await second).ok, true);
  assert.deepEqual(f.body.recent.map(r => r.key), ['run', 'wave']);
});

for (const reason of ['manual', 'touch']) test(`${reason} takes priority over an active performance without late takeover`, async t => {
  const f = fixture(t), pending = perform(f), oldEvent = f.sent[0];
  const direct = f.body.perform('wave', reason), newEvent = f.sent.at(-1);
  assert.equal((await pending).cancelled, true);
  assert.deepEqual(f.sent[1], { cancelPerformance: 'performance-1' });
  assert.equal(newEvent.reason, reason);
  assert.equal(report(f, oldEvent), false);
  report(f, newEvent); assert.equal((await direct).ok, true);
  assert.equal(f.body.recent[0].reason, reason);
});

test('abort, avatar switch, renderer failure and loading timeout all release pending performance ownership', async t => {
  const f = fixture(t, { timeoutMs: 15 }), controller = new AbortController();
  const aborted = perform(f, 'run', 'aborted', { signal: controller.signal }); controller.abort();
  assert.equal((await aborted).cancelled, true);
  const failed = perform(f, 'run', 'failed'); report(f, f.sent.at(-1), 'failed');
  assert.equal((await failed).ok, false); assert.equal(f.body.snapshot().performance.lastOutcome.phase, 'failed');
  const timeout = perform(f, 'run', 'timeout');
  assert.equal((await timeout).timedOut, true);
  assert.deepEqual(f.sent.at(-1), { cancelPerformance: 'timeout' });
  const switched = perform(f, 'run', 'switched'); f.changeAvatar();
  assert.equal((await switched).cancelled, true); assert.equal(f.body.snapshot().performance.active, null);
  assert.equal(f.body.recent.length, 0);
});

test('missing renderer end releases started ownership with only a body cancellation and keeps its actual history', async t => {
  const f = fixture(t, { completionTimeoutMs: 10 }), started = perform(f);
  report(f); assert.equal((await started).ok, true);
  assert.equal(f.body.performanceCompletionTimer.hasRef(), false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.body.snapshot().performance.active, null);
  assert.equal(f.body.snapshot().performance.lastOutcome.phase, 'failed');
  assert.equal(f.body.snapshot().performance.lastOutcome.timedOut, true);
  assert.deepEqual(f.sent.slice(1), [{ cancelPerformance: 'performance-1' }]);
  assert.equal(f.body.recent.length, 1);
  assert.equal(report(f, f.sent[0], 'finished'), false);
});

test('actual renderer end clears the completion watchdog and cannot send a later body cancellation', async t => {
  const f = fixture(t, { completionTimeoutMs: 10 }), started = perform(f);
  report(f); await started; report(f, f.sent[0], 'finished');
  assert.equal(f.body.performanceCompletionTimer, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.sent.length, 1);
  assert.equal(f.body.snapshot().performance.lastOutcome.phase, 'finished');
});

test('completion deadlines allow the full unknown VRMA maximum and use known pack or loop duration with grace', async t => {
  const loop = fixture(t), run = perform(loop); report(loop, loop.sent[0], 'started', { playback: { mode: 'cycle', cycles: 4, clipDurationMs: 1000, totalDurationMs: 4000 } }); await run;
  let active = loop.body.snapshot().performance.active;
  assert.equal(active.completionDeadlineAt - active.startedAt, 9000);
  const unknown = fixture(t), wave = perform(unknown, 'wave'); report(unknown); await wave;
  active = unknown.body.snapshot().performance.active;
  assert.equal(active.completionDeadlineAt - active.startedAt, 305000);
  const known = fixture(t, { pack: true }), packWave = perform(known, 'wave'); report(known); await packWave;
  active = known.body.snapshot().performance.active;
  assert.equal(active.completionDeadlineAt - active.startedAt, 6000);
});

test('the next dialogue body context distinguishes selection, actual start, and completed performance', async t => {
  const f = fixture(t), pending = perform(f);
  assert.deepEqual(f.body.context().performance, { action: '原地跑', avatarName: 'test', phase: 'loading', started: false });
  assert.deepEqual(f.body.context().recentActions, []);
  report(f); await pending;
  assert.deepEqual(f.body.context().performance, { action: '原地跑', avatarName: 'test', phase: 'started', started: true });
  assert.deepEqual(f.body.context().recentActions, [{ action: '原地跑', avatarName: 'test', cause: 'performance', secondsAgo: 0 }]);
  report(f, f.sent[0], 'finished');
  assert.equal(f.body.context().performance, undefined);
  assert.deepEqual(f.body.context().lastPerformance, { action: '原地跑', avatarName: 'test', phase: 'finished', started: true, secondsAgo: 0 });
});

for (const started of [false, true]) test(`the next dialogue knows cancellation ${started ? 'interrupted a real start' : 'prevented the selected action from playing'}`, async t => {
  const f = fixture(t), pending = perform(f);
  if (started) { report(f); await pending; }
  f.body.cancelPerformance('new-input'); await pending;
  assert.deepEqual(f.body.context().lastPerformance, { action: '原地跑', avatarName: 'test', phase: 'cancelled', started,
    error: '表演已取消', reason: 'new-input', secondsAgo: 0 });
  assert.equal(f.body.context().recentActions.some(row => row.cause === 'performance'), started);
});

for (const started of [false, true]) test(`the next dialogue distinguishes failed performance ${started ? 'after a real start' : 'without an actual start'}`, async t => {
  const f = fixture(t), pending = perform(f), event = f.sent[0];
  if (started) { report(f); await pending; }
  report(f, event, 'failed'); await pending;
  assert.deepEqual(f.body.context().lastPerformance, { action: '原地跑', avatarName: 'test', phase: 'failed', started,
    error: started ? '表演播放未正常结束' : '请求的动作未能实际播放', secondsAgo: 0 });
  assert.equal(f.body.context().recentActions.some(row => row.cause === 'performance'), started);
});

test('routine idle cannot erase the completed performance fact, including optional persistence and restore', async t => {
  const saved = [], f = fixture(t, { persist: (rows, state) => saved.push({ rows, state }) }), pending = perform(f);
  report(f); await pending; report(f, f.sent[0], 'finished');
  for (let i = 0; i < 12; i++) f.body.report({ avatar: 'test', key: i % 2 ? 'sit' : 'wave', reason: 'idle', ok: true });
  assert.equal(f.body.context().recentActions.some(row => row.cause === 'performance'), false);
  assert.deepEqual(f.body.context().lastPerformance, { action: '原地跑', avatarName: 'test', phase: 'finished', started: true, secondsAgo: 0 });
  assert.equal(saved.at(-1).state.lastPerformance.phase, 'finished');
  const nextRun = fixture(t);
  nextRun.body.restore(saved.at(-1).rows, saved.at(-1).state.lastPerformance);
  assert.deepEqual(nextRun.body.context().lastPerformance, f.body.context().lastPerformance);
  assert.equal(nextRun.body.context().performance, undefined);
  const legacy = fixture(t); legacy.body.restore(saved[0].rows);
  assert.equal(legacy.body.context().recentActions[0].cause, 'performance');
});

test('finite cycles remain one performance and record validated playback in next context, history and restored outcome', async t => {
  const saved = [], f = fixture(t, { persist: (rows, state) => saved.push({ rows, state }) }), pending = perform(f);
  const event = f.sent[0], playback = { mode: 'cycle', cycles: 6, clipDurationMs: 750, totalDurationMs: 4500 };
  assert.equal(event.performancePlayback.mode, 'cycle');
  assert.equal(event.performancePlayback.targetMs, 4000);
  assert.equal(report(f, event, 'started', { playback }), true); await pending;
  assert.deepEqual(f.body.context().performance.playback, playback);
  const active = f.body.snapshot().performance.active;
  assert.equal(active.completionDeadlineAt - active.startedAt, 9500);
  for (let i = 0; i < 6; i++) assert.equal(report(f, event, 'started', { playback }), true);
  assert.equal(f.body.recent.length, 1);
  assert.deepEqual(f.body.context().recentActions[0].playback, playback);
  assert.equal(report(f, event, 'finished'), true);
  assert.equal(f.body.recent.length, 1);
  assert.deepEqual(f.body.context().lastPerformance.playback, playback);
  playback.cycles = 99;
  assert.equal(f.body.context().lastPerformance.playback.cycles, 6);
  const restored = fixture(t);
  restored.body.restore(saved.at(-1).rows, saved.at(-1).state.lastPerformance);
  assert.equal(restored.body.context().lastPerformance.playback.cycles, 6);
  assert.equal(restored.body.context().recentActions[0].playback.cycles, 6);
});

test('complete one-shot playback is not repeated and its actual full duration controls the completion watchdog', async t => {
  const f = fixture(t), pending = perform(f, 'wave'), event = f.sent[0];
  assert.equal(event.performancePlayback.mode, 'once');
  const playback = { mode: 'once', cycles: 1, clipDurationMs: 13500, totalDurationMs: 13500 };
  report(f, event, 'started', { playback }); await pending;
  const active = f.body.snapshot().performance.active;
  assert.equal(active.completionDeadlineAt - active.startedAt, 18500);
  assert.deepEqual(f.body.context().performance.playback, playback);
  report(f, event, 'finished');
  assert.equal(f.body.context().lastPerformance.playback.cycles, 1);
  const ordinary = f.body.perform('wave', 'manual');
  assert.equal(f.sent.at(-1).performancePlayback, undefined);
  report(f, f.sent.at(-1)); await ordinary;
});

test('malformed cycle metadata cannot become a fact or change the conservative watchdog or identity cancellation', async t => {
  const base = { mode: 'cycle', cycles: 4, clipDurationMs: 1000, totalDurationMs: 4000 };
  const invalid = [null, {}, { ...base, cycles: 0 }, { ...base, cycles: 129 }, { ...base, cycles: 1.5 },
    { ...base, clipDurationMs: 0 }, { ...base, clipDurationMs: NaN }, { ...base, clipDurationMs: Infinity },
    { ...base, totalDurationMs: 4001.1 }, { ...base, totalDurationMs: 300001 },
    { ...base, mode: 'other' }, { ...base, mode: 'once', cycles: 1, totalDurationMs: 1000 }];
  for (let i = 0; i < invalid.length; i++) {
    const f = fixture(t), pending = perform(f, 'run', `bad-${i}`), event = f.sent[0];
    report(f, event, 'started', { playback: invalid[i] }); await pending;
    const active = f.body.snapshot().performance.active;
    assert.equal(active.playback, undefined);
    assert.equal(f.body.context().performance.playback, undefined);
    assert.equal(f.body.recent[0].playback, undefined);
    assert.equal(active.completionDeadlineAt - active.startedAt, 305000);
    assert.equal(f.body.cancelPerformance('new-input'), true);
    assert.deepEqual(f.sent.at(-1), { cancelPerformance: `bad-${i}` });
    assert.equal(f.body.snapshot().performance.active, null);
  }
});

test('restored playback facts reject invalid repetitions and a completion after cancellation cannot restore them', async t => {
  const f = fixture(t), pending = perform(f), event = f.sent[0];
  const playback = { mode: 'cycle', cycles: 4, clipDurationMs: 1200, totalDurationMs: 4800 };
  report(f, event, 'started', { playback }); await pending;
  f.body.cancelPerformance('new-input');
  assert.equal(report(f, event, 'finished', { playback }), false);
  assert.equal(f.body.context().lastPerformance.phase, 'cancelled');
  assert.equal(f.body.context().lastPerformance.playback.cycles, 4);
  const state = f.body.snapshot(), badPlayback = { mode: 'once', cycles: 4, clipDurationMs: 1200, totalDurationMs: 4800 };
  const restored = fixture(t);
  restored.body.restore(state.recentActions.map(row => ({ ...row, playback: badPlayback })), { ...state.performance.lastOutcome, playback: badPlayback });
  assert.equal(restored.body.context().lastPerformance.playback, undefined);
  assert.equal(restored.body.context().recentActions[0].playback, undefined);
});

test('appearance names follow the actual ready body and distinguish a pending transformation target', () => {
  let avatar = { key: 'a', name: '芭尼', description: '旧形象' };
  const body = new Embodiment({ catalog: { catalog: () => ({ motions: [] }) }, avatar: () => avatar, send: () => {} });
  assert.equal(body.context().appearance.name, null);
  assert.equal(body.context().appearance.requestedName, '芭尼');
  body.setReady({ avatar: 'a', expressions: [] });
  assert.equal(body.context().appearance.name, '芭尼');
  avatar = { key: 'b', name: '兔兔', description: '新形象' }; body.avatarChanged();
  assert.equal(body.context().appearance.name, '芭尼');
  assert.equal(body.context().appearance.requestedName, '兔兔');
  assert.equal(body.context().appearance.ready, false);
  assert.equal(body.setReady({ avatar: 'a' }), false);
  body.setReady({ avatar: 'b' });
  assert.equal(body.context().appearance.name, '兔兔');
  assert.equal(body.context().appearance.ready, true);
  assert.equal(body.context().appearance.requestedName, undefined);
});
