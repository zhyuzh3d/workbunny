'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performancePlayback, TARGET_MS } = require('../src/main/performance-playback-policy');
const overrides = require('../src/main/performance-loop-overrides.json');
const motions = require('../src/main/reviewed-motions');
const { audit } = require('../tools/audit-performance-loops.cjs');

test('reviewed locomotion repeats without changing the original asset loop processing', () => {
  const run = motions.find(m => m.key === 'motion_run');
  const original = structuredClone(run);
  assert.equal(run.loop, false);
  assert.deepEqual(performancePlayback(run), { mode: 'cycle', targetMs: 4000 });
  assert.deepEqual(run, original);
  assert.equal(Object.keys(overrides).length, 11);
  for (const [key, entry] of Object.entries(overrides)) {
    const motion = motions.find(m => m.key === key);
    assert.equal(motion.sourceId, entry.sourceId);
    assert.equal(performancePlayback(motion).mode, 'cycle');
  }
});

test('unknown and replacement assets are not promoted based on name or short duration', () => {
  const run = motions.find(m => m.key === 'motion_run');
  assert.equal(performancePlayback({ key: 'unknown_run', duration: .1 }).mode, 'once');
  assert.equal(performancePlayback({ ...run, sourceId: 'new-source' }).mode, 'once');
  assert.equal(performancePlayback({ ...run, personal: true }).mode, 'once');
  assert.equal(performancePlayback({ loop: true }).mode, 'cycle');
});

test('explicit configuration is available but transitions and full sequences settle once', () => {
  assert.equal(performancePlayback({ loop: true, performanceMode: 'once' }).mode, 'once');
  assert.equal(performancePlayback({ personal: true, performanceMode: 'cycle' }).mode, 'cycle');
  for (const restriction of [{ transition: true }, { postureChanging: true }, { sourceId: 'sequence__story' }]) {
    assert.equal(performancePlayback({ loop: true, performanceMode: 'cycle', ...restriction }).mode, 'once');
  }
  assert.equal(TARGET_MS, 4000);
});

test('actual shipped VRMA audit resolves duration and rotation seams for all reviewed cycles', () => {
  const rows = audit();
  assert.equal(rows.length, motions.length);
  assert(rows.every(r => r.durationSeconds > 0 && /^[a-f0-9]{64}$/.test(r.sha256)));
  assert.equal(rows.filter(r => r.policy.mode === 'cycle').length, 62);
  for (const row of rows.filter(r => overrides[r.key])) {
    assert(row.activeRotationTracks > 0);
    assert(row.seamMaxDegrees < .11, row.key + ' changed: review cycle seam');
    assert(row.durationSeconds < 1.3, row.key + ' changed: review source');
  }
  assert(Math.abs(rows.find(r => r.key === 'motion_run').durationSeconds - .5) < .0001);
});
