#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { CompanionAffect, MAX_EVENTS, MAX_TOTAL_EVENTS, MAX_EVENT_AGE_MS, RATE_BUDGET } = require('../src/main/companion-affect');

function scope(id, domain = 'private', visibilityFloor = 2, ts = 1_800_000_000_000) {
  return { id, domain, visibilityFloor, ts };
}

function testInertiaAndRecovery() {
  let now = 1_800_000_000_000;
  const affect = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  assert.equal(affect.observeMessage('谢谢，今天进展很顺利。', scope('msg-positive', 'life', 1, now)), true);
  const first = affect.snapshot(now);
  assert(first.valence > 0 && first.energy > 0, 'positive expression cue creates a small state change');
  now += 5 * 60_000;
  const afterFiveMinutes = affect.snapshot(now);
  assert(afterFiveMinutes.valence > 0, 'state has short-term inertia');
  assert(afterFiveMinutes.valence < first.valence, 'state starts returning toward baseline');
  now += MAX_EVENT_AGE_MS + 1;
  assert.deepEqual(affect.snapshot(now), { valence: 0, arousal: 0, energy: 0 }, 'old influences expire back to baseline');
}

function testRateLimitAndBoundedHistory() {
  let now = 1_800_000_000_000;
  const affect = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  for (let index = 0; index < MAX_EVENTS + 8; index++) {
    const eventScope = scope(`positive-${index}`, 'private', 2, now);
    assert.equal(affect.observeMessage('今天很开心，谢谢。', eventScope), true);
  }
  assert.equal(affect.events.length, MAX_EVENTS, 'only the newest 32 events in this visibility floor remain');
  assert(affect.rateByFloor[2].used <= RATE_BUDGET, 'a burst within one minute has a hard accumulated intensity budget');
  assert(affect.snapshot(now).valence <= 0.1, 'high-frequency messages cannot force an unbounded affect swing');
  const duplicate = scope('positive-39', 'private', 2, now);
  const count = affect.events.length;
  assert.equal(affect.observeMessage('今天很开心，谢谢。', duplicate), false, 'the same source event is deduplicated');
  assert.equal(affect.events.length, count);
  now += 60_001;
  assert.equal(affect.observeMessage('今天很开心，谢谢。', scope('positive-next-minute', 'private', 2, now)), true,
    'the rate budget replenishes after one minute');
}

function testVisibilityFloorBudgetsAndRings() {
  const now = Date.UTC(2026, 9, 26, 13, 30, 0);
  const noisy = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  const baseline = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  for (let index = 0; index < MAX_EVENTS + 20; index++) {
    noisy.observeMessage('我有些累了。', scope(`private-burst-${index}`, 'private', 2, now));
  }
  assert.equal(noisy.events.filter(event => event.visibilityFloor === 2).length, MAX_EVENTS);
  assert.equal(noisy.rateByFloor[2].used, RATE_BUDGET);
  assert.equal(noisy.rateByFloor[0].used, 0);
  assert.equal(noisy.rateByFloor[1].used, 0);

  noisy.observeMessage('谢谢，工作进展顺利。', scope('visible-work-event', 'work', 0, now));
  baseline.observeMessage('谢谢，工作进展顺利。', scope('visible-work-event', 'work', 0, now));
  assert.equal(noisy.rateByFloor[0].used, baseline.rateByFloor[0].used, 'private rate usage does not spend the work bucket');
  assert.equal(noisy.project('work', now).prompt, baseline.project('work', now).prompt,
    'many private events cannot alter work projection or evict the shared visible work event');
  assert.equal(noisy.project('life', now).prompt, baseline.project('life', now).prompt,
    'floor-2 events cannot influence life even when the private ring is full');
  assert(noisy.events.length <= MAX_TOTAL_EVENTS, 'all three independently bounded rings remain globally bounded');
}

function testSceneProjectionAndPrivacy() {
  let now = Date.UTC(2026, 9, 26, 13, 30, 0);
  const clean = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  const affected = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  affected.observeMessage('我今天很累了，事情有些不顺。', scope('private-event', 'private', 2, now));
  assert.equal(affected.project('work', now).prompt, clean.project('work', now).prompt,
    'private events cannot affect the work scene projection');
  assert.equal(affected.project('life', now).prompt, clean.project('life', now).prompt,
    'private events cannot affect the life scene projection');
  assert.notEqual(affected.project('private', now).prompt, clean.project('private', now).prompt,
    'the source scene can use its visible event as a modest expression cue');

  now += 60_001;
  affected.project('life', now); clean.project('life', now);
  affected.observeMessage('谢谢，太好了。', scope('life-event', 'life', 1, now));
  assert.equal(affected.project('work', now).prompt, clean.project('work', now).prompt,
    'life-only events are excluded from work');
  assert.notEqual(affected.project('life', now).prompt, clean.project('life', now).prompt,
    'life events can shape life-scene expression');
  const projected = affected.project('private', now);
  assert.deepEqual(Object.keys(projected), ['prompt'], 'projection exposes only short text, never internal numbers or event counts');
  assert(!projected.prompt.includes('private-event') && !projected.prompt.includes('life-event'));
  const noValidatedSources = affected.project('private', now, { sourceIds: [] });
  assert.equal(noValidatedSources.prompt, clean.project('private', now).prompt,
    'AEAD-validated source filtering can suppress an event whose source was deleted');
  assert(affected.events.some(event => event.sourceId === 'private-event'), 'projection filtering does not erase hidden-scope internal state');
  assert.notEqual(affected.snapshot(now).valence, clean.snapshot(now).valence,
    'omitting sourceIds retains the pure-module default internal aggregate');
  const onlyLife = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  onlyLife.observeMessage('谢谢，太好了。', scope('life-event', 'life', 1, now));
  assert.equal(affected.project('private', now, { sourceIds: new Set(['life-event']) }).prompt, onlyLife.project('private', now).prompt,
    'source allowlists include only currently verified source records');

  const workScoped = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  workScoped.observeMessage('谢谢，进展顺利。', scope('work-event', 'work', 0, now));
  assert.equal(workScoped.project('work', now).prompt, workScoped.project('private', now).prompt,
    'a work-scoped influence remains part of the same visible timeline in wider scenes');
}

function testForgetAndColdRestart() {
  let now = Date.UTC(2026, 9, 26, 10, 0, 0);
  const original = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  original.observeMessage('谢谢，真的很开心。', scope('forget-me', 'life', 1, now));
  original.observeTask({ verified: true, verdict: 'pass' }, scope('verified-task', 'work', 0, now));
  const serialized = original.serialize(now);
  const restored = new CompanionAffect({ clock: () => now, timezone: 'UTC', state: serialized });
  const initial = restored.snapshot(now);
  assert.deepEqual(initial, original.snapshot(now), 'encrypted-state payload restores the same bounded affect');
  const initialProjection = restored.project('life', now).prompt;
  now += 15 * 60_000;
  const decayedProjection = restored.project('life', now).prompt;
  assert.equal(decayedProjection, initialProjection, 'public language remains calm while numerical influence decays smoothly');
  assert(restored.snapshot(now).valence < initial.valence, 'the restored state decays by elapsed time');
  const beforeForget = restored.events.length;
  assert.equal(restored.forget(['forget-me']), 1);
  assert.equal(restored.events.length, beforeForget - 1);
  assert(!restored.events.some(event => event.sourceId === 'forget-me'), 'forget removes all event detail tied to the source');
}

function testClockRollbackAndTaskVerificationBoundary() {
  let now = Date.UTC(2026, 9, 26, 9, 0, 0);
  const affect = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  affect.observeMessage('今天很开心。', scope('clock-source', 'private', 2, now));
  const before = affect.snapshot(now);
  const serialized = affect.serialize(now);
  now -= 7 * 24 * 60 * 60_000;
  const restored = new CompanionAffect({ clock: () => now, timezone: 'UTC', state: serialized });
  assert.deepEqual(restored.snapshot(now), before, 'clock rollback cannot make restored affect stronger');
  assert.deepEqual(restored.snapshot(now - 1000), before, 'repeated backward timestamps do not increase state');

  const taskAffect = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  const taskScope = scope('task-verified-1', 'work', 0, now);
  assert.equal(taskAffect.observeTask({ verified: false, verdict: 'pass' }, taskScope), false);
  assert.equal(taskAffect.observeTask({ verified: true, verdict: 'revise' }, taskScope), false);
  assert.equal(taskAffect.events.length, 0, 'unverified and nonterminal task states add no event');
  const taskPolicy = Object.freeze({ priority: 1, model: 'deepseek-v4.1-flash', criteria: Object.freeze(['source-backed']) });
  const beforePolicy = JSON.stringify(taskPolicy);
  assert.equal(taskAffect.observeTask({ verified: true, verdict: 'pass' }, taskScope), true);
  assert.equal(taskAffect.observeTask({ verified: true, verdict: 'fail' }, taskScope), false,
    'one verified result per task is deduplicated even if a later duplicate conflicts');
  assert.equal(JSON.stringify(taskPolicy), beforePolicy, 'affect observation cannot change task policy or acceptance criteria');
  assert.equal(taskAffect.project('work', now).taskPolicy, undefined, 'projection has no task-control fields');
  assert.match(taskAffect.project('work', now).prompt, /明快/);
  const failedTaskAffect = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  assert.equal(failedTaskAffect.observeTask({ verified: true, verdict: 'fail' }, scope('verified-failure', 'work', 0, now)), true);
  assert(failedTaskAffect.snapshot(now).valence < 0, 'only a verified failure adds a small subdued expression signal');
  assert.match(failedTaskAffect.project('work', now).prompt, /继续把眼前事情做好/);
}

function testSharedLocalClockHints() {
  const midnight = Date.UTC(2026, 9, 31, 23, 0, 0); // Saturday in UTC.
  const affect = new CompanionAffect({ clock: () => midnight, timezone: 'UTC' });
  const prompt = affect.project('work', midnight).prompt;
  assert.match(prompt, /夜间/);
  assert.match(prompt, /周末/);
  assert.match(prompt, /不推断是否休息/);

  const holiday = Date.UTC(2026, 9, 1, 12, 0, 0); // Calendar date, not a promise of time off.
  const holidayPrompt = new CompanionAffect({ clock: () => holiday, timezone: 'UTC' }).project('life', holiday).prompt;
  assert.match(holidayPrompt, /国庆节/);
  assert.match(holidayPrompt, /不推断是否放假或庆祝/);
}

function testRejectsMalformedHydration() {
  const affect = new CompanionAffect({ clock: () => 1000, timezone: 'UTC' });
  assert.throws(() => affect.hydrate({ version: 3, events: [] }), /状态格式/);
  assert.throws(() => affect.hydrate({ version: 1, events: [{ id: 'x', sourceId: 'x', domain: 'private', visibilityFloor: 2, ts: 1000, kind: 'diagnosis', intensity: 1 }] }), /事件格式/);
  assert.throws(() => affect.hydrate({ version: 2, lastNow: 1000, rateByFloor: { 0: { windowStart: 1000, used: 1 } }, events: [] }), /限幅数据/);
}

function testV1HydrationMigration() {
  let now = 1_800_000_000_000;
  const v2 = new CompanionAffect({ clock: () => now, timezone: 'UTC' });
  for (let i = 0; i < 4; i++) v2.observeMessage('我有些累。', scope(`legacy-private-${i}`, 'private', 2, now));
  const current = v2.serialize(now);
  const v1 = { version: 1, lastNow: now, rateWindowStart: now, rateUsed: RATE_BUDGET, events: current.events.slice(-MAX_EVENTS) };
  const migrated = new CompanionAffect({ clock: () => now, timezone: 'UTC', state: v1 });
  assert.equal(migrated.serialize(now).version, 2, 'legacy v1 state reserializes as v2');
  assert(migrated.rateByFloor[2].used > 0, 'legacy shared rate use is conservatively assigned to private floor');
  assert.equal(migrated.rateByFloor[0].used, 0, 'legacy private activity cannot block the work budget');
  assert.equal(migrated.observeMessage('谢谢，工作完成。', scope('new-work-after-v1', 'work', 0, now)), true);
  assert(migrated.rateByFloor[0].used > 0, 'the migrated v1 state leaves independent work budget available');
}

function main() {
  testInertiaAndRecovery();
  testRateLimitAndBoundedHistory();
  testVisibilityFloorBudgetsAndRings();
  testSceneProjectionAndPrivacy();
  testForgetAndColdRestart();
  testClockRollbackAndTaskVerificationBoundary();
  testSharedLocalClockHints();
  testRejectsMalformedHydration();
  testV1HydrationMigration();
  console.log('companion-affect deterministic fixtures passed (no model, database, or user data)');
}

main();
