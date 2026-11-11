'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DialogueTurnScheduler } = require('../src/main/dialogue-turn-scheduler');
const start = (scheduler, key, text, extra = {}) => scheduler.begin({ scope: 'scene:1', input: { key, text, ...extra } });

test('new inputs synchronously cancel old work and merge every unanswered input in order', () => {
  const s = new DialogueTurnScheduler(), first = start(s, 'typed:1', 'first', { source: 'keyboard', accepted: true });
  let aborted = false; first.controller.signal.addEventListener('abort', () => { aborted = true; });
  const second = start(s, 'voice:2', 'second', { source: 'microphone', accepted: false });
  assert(aborted); assert(!first.isCurrent());
  assert.deepEqual(second.inputs.map(row => row.text), ['first', 'second']);
  const third = start(s, 'typed:3', 'third');
  assert.deepEqual(third.inputs.map(row => row.key), ['typed:1', 'voice:2', 'typed:3']);
  assert.equal(first.finish(), false); assert.equal(second.finish(), false);
  assert(third.finish());
  assert.deepEqual(start(s, 'typed:4', 'fourth').inputs.map(row => row.text), ['fourth']);
});

test('partial interruptions retain words without adding or duplicating input', () => {
  const s = new DialogueTurnScheduler(), old = start(s, 'voice:1', 'first');
  for (let i = 0; i < 10; i++) s.interrupt({ scope: 'scene:1' });
  assert(old.controller.signal.aborted);
  const next = start(s, 'voice:2', 'continued');
  assert.deepEqual(next.inputs.map(row => row.text), ['first', 'continued']);
  const revised = start(s, 'voice:2', 'continued and revised');
  assert.deepEqual(revised.inputs.map(row => row.text), ['first', 'continued and revised']);
});

test('ignoring a candidate only consumes that candidate and preserves earlier owner words', () => {
  const s = new DialogueTurnScheduler(); start(s, 'typed:1', 'owner question', { accepted: true });
  const candidate = start(s, 'voice:2', 'ambient candidate', { accepted: false });
  assert(candidate.finish({ ignored: true }));
  const next = start(s, 'typed:3', 'new words');
  assert.deepEqual(next.inputs.map(row => row.text), ['owner question', 'new words']);
  assert.equal(next.inputs[0].accepted, true);
});

test('scope changes and explicit cancellation cannot leak pending words into another context', () => {
  const s = new DialogueTurnScheduler(), old = start(s, 'typed:1', 'private old words');
  const fresh = s.begin({ scope: 'scene:2', input: { text: 'fresh words' } });
  assert(old.controller.signal.aborted); assert.deepEqual(fresh.inputs.map(row => row.text), ['fresh words']);
  s.interrupt({ scope: 'scene:2', clear: true });
  const next = s.begin({ scope: 'scene:2', input: { text: 'next' } });
  assert.deepEqual(next.inputs.map(row => row.text), ['next']);
});

test('channels cancel independently and already-started effects remain with their original input', () => {
  const s = new DialogueTurnScheduler(), local = start(s, 'local:1', 'local words');
  const remote = s.begin({ channel: 'remote', scope: 'scene:1', input: { text: 'remote words' } });
  assert(local.isCurrent()); assert(remote.isCurrent());
  local.effect({ phase: 'started', outcome: 'unknown' });
  const next = start(s, 'local:2', 'followup');
  local.effect({ phase: 'settled', taskId: 'fixture-task' });
  assert.deepEqual(next.inputs[0].effect, { phase: 'settled', taskId: 'fixture-task' });
  assert.equal(next.inputs[1].effect, undefined); assert(remote.isCurrent());
});
