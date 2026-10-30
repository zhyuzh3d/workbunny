'use strict';

const assert = require('node:assert/strict');
const { filterMonitorView, scopedMonitorContext } = require('../src/main/work-context');

const workId = '11111111-1111-4111-8111-111111111111';
const privateId = '22222222-2222-4222-8222-222222222222';
const privateWorkId = '33333333-3333-4333-8333-333333333333';
const missingMarker = '44444444-4444-4444-8444-444444444444';
const makeSnap = (sessionId, id, userText, summary, history = []) => ({
  sessionId, cwd: '/synthetic', phase: 'done', userText, assistantText: summary,
  lastEventAt: 10, task: { bunnyTaskId: id, id: 1, userText, summary, status: 'ok', durationMs: 100, startedAt: 5, endedAt: 10 }, history,
});

const work = makeSnap('work-session', workId, 'work goal', 'work summary', [
  { bunnyTaskId: workId, userText: 'prior work goal', summary: 'prior work result' },
  { bunnyTaskId: privateId, userText: 'private historical goal', summary: 'private historical result' },
]);
const privateTask = makeSnap('private-session', privateId, 'PRIVATE_GOAL_MARKER', 'PRIVATE_RESULT_MARKER');
const privateFloorWork = makeSnap('private-floor-work-session', privateWorkId, 'PRIVATE_FLOOR_GOAL', 'PRIVATE_FLOOR_RESULT');
const unmanaged = makeSnap('unmapped-session', undefined, 'UNMAPPED_GOAL', 'UNMAPPED_RESULT');
const unknownMarker = makeSnap('unknown-marker-session', missingMarker, 'DELETED_MARKER_GOAL', 'DELETED_MARKER_RESULT');
const externalRecent = makeSnap('external-recent', undefined, 'recent external work', 'recent external result');
externalRecent.task.startedAt = 20; externalRecent.task.endedAt = 30;
const externalRunning = makeSnap('external-running', undefined, 'currently running external work', '');
externalRunning.task.status = 'running'; externalRunning.task.startedAt = 1; externalRunning.task.endedAt = 0;
const view = { primary: privateTask, running: [work, externalRunning], done: [privateTask, privateFloorWork, unmanaged, unknownMarker, externalRecent], count: 2 };
const scopes = new Map([
  [workId, { id: workId, domain: 'work', visibilityFloor: 0 }],
  [privateId, { id: privateId, domain: 'private', visibilityFloor: 2 }],
  [privateWorkId, { id: privateWorkId, domain: 'work', visibilityFloor: 2 }],
]);

const life = filterMonitorView(view, { scene: 'life', taskScopes: scopes, bootAt: 15, ready: true });
assert.deepEqual(life.running.map(s => s.sessionId), ['work-session', 'external-running']);
assert.deepEqual(life.done.map(s => s.sessionId), ['external-recent']);
assert.equal(life.primary.sessionId, 'work-session');
assert.equal(life.count, 2);
assert.deepEqual(life.running[0].history.map(h => h.bunnyTaskId), [workId]);
assert(!JSON.stringify(life).includes('PRIVATE_'));
assert(!JSON.stringify(life).includes('UNMAPPED_'));
assert(!JSON.stringify(life).includes('DELETED_MARKER_'));
assert(!life.done.some(s => s.sessionId === 'unmapped-session'), 'pre-boot external done work is not replayed');

const workOnly = filterMonitorView(view, { scene: 'work', taskScopes: scopes, bootAt: 15, ready: true });
assert.deepEqual(workOnly.done.map(s => s.sessionId), ['external-recent']);
assert.deepEqual(workOnly.running.map(s => s.sessionId), ['work-session', 'external-running']);

const privateView = filterMonitorView(view, { scene: 'private', taskScopes: scopes, ready: true });
assert.deepEqual(new Set(privateView.done.map(s => s.sessionId)), new Set(['private-session', 'private-floor-work-session', 'unmapped-session', 'external-recent']));
assert(privateView.done.some(s => s.task.userText === 'PRIVATE_GOAL_MARKER'));
assert(privateView.done.some(s => s.task.userText === 'PRIVATE_FLOOR_GOAL'));

const wrongKey = filterMonitorView({ primary: unknownMarker, running: [], done: [unknownMarker], count: 0 }, { scene: 'private', taskScopes: new Map([[missingMarker, { id: workId, domain: 'private', visibilityFloor: 2 }]]), ready: true });
assert.equal(wrongKey.done.length, 0, 'a scope record for a different task ID cannot authorize the marker');
assert.throws(() => filterMonitorView(view, { scene: 'unknown', taskScopes: scopes, ready: true }), /未知/);
const notReady = scopedMonitorContext(view, { scene: 'life', taskScopes: scopes, bootAt: 15, ready: false, now: 1000 });
assert.equal(notReady.view.count, 0);
assert(!notReady.text.includes('work goal'));
const composed = scopedMonitorContext(view, { scene: 'life', taskScopes: scopes, bootAt: 15, ready: true, now: 1000 });
assert(!composed.text.includes('PRIVATE_') && !composed.text.includes('DELETED_MARKER_'));
assert.equal(view.done.length, 5, 'filtering does not mutate Monitor-owned snapshots');

console.log('Work context scope filter checks passed');
