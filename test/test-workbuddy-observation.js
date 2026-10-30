'use strict';

const assert = require('node:assert/strict');
const { observeWorkBuddy } = require('../src/main/workbuddy-observation');
const { Monitor } = require('../src/main/monitor');

const uuid = 'a1b2c3d4-e5f6-4789-8abc-1234567890ab';
const submittedAt = 1_700_000_000_000;
const task = { id: uuid, submittedAt, monitorSessionId: 'session-exact', monitorTaskId: 'task-exact' };
function row(patch = {}) {
  return { id: 'task-exact', bunnyTaskId: uuid, startedAt: submittedAt + 10, endedAt: submittedAt + 5000,
    updatedAt: submittedAt + 5000, status: 'ok', summary: '完成摘要', model: 'claude', ...patch };
}
function monitor(entries) { return { sessions: new Map(entries.map(([key, snap]) => [key, { snap }])) }; }
function snap(sessionId, current, history = []) { return { sessionId, task: current, history, lastEventAt: submittedAt + 5000 }; }

const exact = observeWorkBuddy(monitor([['a', snap('session-exact', row())]]), task);
assert.deepEqual(exact, { sessionId: 'session-exact', taskId: 'task-exact', status: 'ok', summary: '完成摘要',
  startedAt: submittedAt + 10, updatedAt: submittedAt + 5000, model: 'claude' });

assert.equal(observeWorkBuddy(null, task), null);
assert.equal(observeWorkBuddy({ sessions: new Map() }, task), null);
assert.equal(observeWorkBuddy(monitor([['wrong-id', snap('session-exact', row({ bunnyTaskId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }))]]), task), null,
  'another Bunny task UUID is never evidence');
assert.equal(observeWorkBuddy(monitor([['wrong-session', snap('other-session', row())]]), task), null,
  'a result in a different WorkBuddy session is ignored');
assert.equal(observeWorkBuddy(monitor([['wrong-monitor-task', snap('session-exact', row({ id: 'older-task' }))]]), task), null,
  'the bound monitor task id is exact');
assert.equal(observeWorkBuddy(monitor([['too-old', snap('session-exact', row({ startedAt: submittedAt - 3000 }))]]), task), null,
  'a task starting before the submission window is rejected');
assert.equal(observeWorkBuddy(monitor([['no-time', snap('session-exact', row({ startedAt: NaN }))]]), task), null);

const marker = `[workbunny:${uuid}]`;
const longOutbound = `${'用户原文'.repeat(1500)}\n\n验收条件\n\n${marker}`;
const markerMonitor = new Monitor();
const markerSnap = markerMonitor.blank();
markerMonitor.handleEvent({ type: 'message', role: 'user', content: longOutbound, timestamp: submittedAt }, { snap: markerSnap, priming: false });
assert.equal(markerSnap.task.bunnyTaskId, uuid, 'Monitor extracts the unique UUID marker after a long outbound request');
assert.equal(observeWorkBuddy(monitor([['long-marker', snap('session-exact', row({ bunnyTaskId: markerSnap.task.bunnyTaskId }))]]), task).taskId, 'task-exact');

const anotherUuid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ambiguousMarkerSnap = markerMonitor.blank();
markerMonitor.handleEvent({ type: 'message', role: 'user', content: `${marker} [workbunny:${anotherUuid}]`, timestamp: submittedAt }, { snap: ambiguousMarkerSnap, priming: false });
assert.equal(ambiguousMarkerSnap.task.bunnyTaskId, undefined, 'multiple distinct markers on one request are ambiguous');
assert.equal(observeWorkBuddy(monitor([['ambiguous-markers', snap('session-exact', row({ bunnyTaskId: ambiguousMarkerSnap.task.bunnyTaskId }))]]), task), null);

const duplicated = monitor([
  ['one', snap('session-exact', row({ id: 'task-one' }))],
  ['two', snap('session-exact', row({ id: 'task-two' }))],
]);
assert.equal(observeWorkBuddy(duplicated, { ...task, monitorTaskId: null }), null,
  'duplicate UUID markers across multiple monitor tasks are ambiguous and rejected');

const superseded = observeWorkBuddy(monitor([['superseded', snap('session-exact', row({ status: 'ok', endReason: 'superseded' }))]]), task);
assert.equal(superseded.status, 'abandoned', 'a superseded unfinished task is not reported as success');

const historical = observeWorkBuddy(monitor([['replaced', snap('session-exact', row({ id: 'new-task', bunnyTaskId: 'other' }), [row()])]]), task);
assert.equal(historical?.taskId, 'task-exact', 'the exact marked task remains observable after a newer task replaces the current row');
assert.equal(observeWorkBuddy(monitor([['old-followup', snap('session-exact', row())]]), { ...task, previousMonitorTaskId: 'task-exact', monitorTaskId: null }), null,
  'a previous follow-up task id cannot satisfy the new follow-up');

for (const status of ['running', 'ok', 'failed', 'abandoned']) {
  const result = observeWorkBuddy(monitor([[status, snap('session-exact', row({ status }))]]), task);
  assert.equal(result?.status, status);
}
assert.equal(observeWorkBuddy(monitor([['unknown', snap('session-exact', row({ status: 'pending' }))]]), task), null);

console.log('WorkBuddy observation correlation checks passed');
