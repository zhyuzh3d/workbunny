'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { SpeakerFilter, DIMENSION } = require('../src/main/speaker-filter');
const vector = index => Array.from({ length: DIMENSION }, (_, i) => Number(i === index));
const feature = index => ({ vector: vector(index), frames: 40, quality: .9, durationMs: 400 });
test('speaker profiles require three explicit samples and uncertain/noisy audio never passes an enabled filter', async () => {
  const f = new SpeakerFilter();f.enabled = true;
  assert.equal(f.offer(feature(0)).status, 'needs-enrollment');
  for (let i = 0; i < 3; i++) { const pending = f.enroll();for (let j = 0; j < 7; j++) f.offer(feature(0));await pending; }
  assert.equal(f.status().ready, true);assert(f.offer(feature(0)).accepted);assert(!f.offer(feature(10)).accepted);
  assert(!f.offer({ ...feature(0), quality: 0 }).accepted);assert(!f.classify({ vector: [1] }).accepted);
  f.device = 'other mic';f.profile.device = 'old mic';assert.equal(f.offer(feature(0)).status, 'device-changed');
});
test('filter uses bounded recent acoustic evidence before semantic text and has no model/network dependency', () => {
  let now = 0;const f = new SpeakerFilter({ clock: () => now });f.enabled = true;f.load({ schema: 'local-speaker/v1', samples: [vector(0),vector(0),vector(0)], threshold:.9 });
  assert(!f.acceptsText());f.offer(feature(0));assert(f.acceptsText());now=7000;assert(!f.acceptsText());
  f.enabled=false;assert(f.acceptsText());f.load({ schema:'local-speaker/v1', samples:[[NaN]] });assert(!f.status().ready);
});
