'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { SpeakerFilter, DIMENSION } = require('../src/main/speaker-filter');
const vector = index => Array.from({ length: DIMENSION }, (_, i) => Number(i === index));
const feature = index => ({ vector: vector(index), frames: 40, quality: .9, durationMs: 400 });
test('one guided reading creates three internal samples; enabled filtering rejects noise and other voices', async () => {
  const f = new SpeakerFilter(); f.enabled = true;
  assert.equal(f.offer(feature(0)).status, 'needs-enrollment');
  const pending = f.enroll({ quietMs: 0 });
  for (let i = 0; i < 24; i++) { f.offer(feature(0)); assert(!f.acceptsText()); }
  assert.equal(f.status().progress, 3); assert.equal(f.status().ready, false);
  await pending;
  assert.equal(f.status().ready, true); assert(f.offer(feature(0)).accepted); assert(!f.offer(feature(10)).accepted);
  assert(!f.offer({ ...feature(0), quality: 0 }).accepted); assert(!f.classify({ vector: [1] }).accepted);
  f.device = 'other mic'; f.profile.device = 'old mic'; assert.equal(f.offer(feature(0)).status, 'device-changed');
});
test('cancel, timeout and inconsistent readings preserve the previously enrolled voice', async () => {
  const f = new SpeakerFilter(); f.load({ schema: 'local-speaker/v1', samples: [vector(0),vector(0),vector(0)] });
  const old = structuredClone(f.profile);
  let pending = f.enroll(); f.offer(feature(1)); f.cancel(); await assert.rejects(pending, /取消/); assert.deepEqual(f.profile, old);
  pending = f.enroll({ timeoutMs: 5 }); await assert.rejects(pending, /重试/); assert.deepEqual(f.profile, old);
  pending = f.enroll({quietMs:0}); for (let i = 0; i < 8; i++) f.offer(feature(1)); for (let i = 0; i < 8; i++) f.offer(feature(2));
  await assert.rejects(pending, /声音变化/); assert.deepEqual(f.profile, old);
  f.device = 'first'; pending = f.enroll(); f.device = 'second'; f.offer(feature(0)); await assert.rejects(pending, /麦克风/); assert.deepEqual(f.profile, old);
});
test('enrollment ignores noise and finishes only after the reading becomes quiet', async () => {
  const f = new SpeakerFilter(); const pending = f.enroll({ quietMs: 25 });
  for (let i=0;i<24;i++) f.offer({ ...feature(0), quality: 0 }); assert.equal(f.status().progress, 0);
  for (let i=0;i<24;i++) f.offer(feature(0));
  await new Promise(r=>setTimeout(r,15)); f.offer(feature(0));
  await new Promise(r=>setTimeout(r,15)); assert(f.status().enrolling);
  await pending; assert.equal(f.profile.samples.length, 3);
});
test('filter uses bounded recent acoustic evidence before semantic text and has no model/network dependency', () => {
  let now = 0;const f = new SpeakerFilter({ clock: () => now });f.enabled = true;f.load({ schema: 'local-speaker/v1', samples: [vector(0),vector(0),vector(0)], threshold:.9 });
  assert(!f.acceptsText());f.offer(feature(0));assert(f.acceptsText());now=7000;assert(!f.acceptsText());
  f.enabled=false;assert(f.acceptsText());f.load({ schema:'local-speaker/v1', samples:[[NaN]] });assert(!f.status().ready);
});

test('a normal short reading stops automatically and emits progress, without waiting for three fixed recordings', async()=>{
  const f=new SpeakerFilter();let updates=0;
  const pending=f.enroll({quietMs:15,onProgress:()=>updates++});
  f.heard('今天我想慢慢把事情做好');
  for(let i=0;i<7;i++)f.offer({...feature(0),speech:false});
  assert.equal(f.status().phase,'recording');assert(f.status().percent>0);assert(f.status().seconds>0);
  await pending;assert(f.status().ready);assert.equal(f.status().phase,'complete');assert(updates>=3);
});
test('speech too short or an absent microphone produces a visible result and preserves the old profile',async()=>{
 const f=new SpeakerFilter();f.load({schema:'local-speaker/v1',samples:[vector(0),vector(0),vector(0)]});const old=structuredClone(f.profile);
 let pending=f.enroll({quietMs:5});f.heard('你好');f.offer(feature(0));await assert.rejects(pending,/没听清/);assert.equal(f.status().phase,'failed');assert.deepEqual(f.profile,old);
 pending=f.enroll({startTimeoutMs:5});await assert.rejects(pending,/没有听到/);assert.deepEqual(f.profile,old);
});
