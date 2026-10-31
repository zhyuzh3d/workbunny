import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAvatarTimeline, sampleAvatarTimeline } from '../src/renderer/avatar-timeline.mjs';

test('authored timing retains full turns, cuts and independently eased channels', () => {
  const timeline = compileAvatarTimeline({ duration: 2, tracks: [
    { channel: 'rotation_y', frames: [{ time: 0, value: 0 }, { time: 2, value: Math.PI * 2, ease: 'linear' }] },
    { channel: 'eye', frames: [{ time: 0, value: [1, 0] }, { time: 1, value: [0, 1], ease: 'cut' }] },
    { channel: 'lean', frames: [{ time: 0, value: 0 }, { time: 2, value: 1, ease: 'wind' }] },
  ] });
  const halfway = sampleAvatarTimeline(timeline, 1);
  assert.equal(halfway.rotation_y, Math.PI);
  assert.deepEqual(halfway.eye, [0, 1]);
  assert.equal(halfway.lean, .125);
  assert.deepEqual(sampleAvatarTimeline(timeline, .9).eye, [1, 0]);
  assert.equal(sampleAvatarTimeline(timeline, 5).rotation_y, Math.PI * 2);
});

test('ballistic track rises and falls under constant gravity', () => {
  const timeline = compileAvatarTimeline({ duration: 2, tracks: [{ channel: 'height',
    frames: [{ time: 0, value: 0 }, { time: 2, value: 0 }],
    flights: [{ from: 0, to: 2, y0: 0, y1: 0, gravity: 6 }] }] });
  assert.equal(sampleAvatarTimeline(timeline, 0).height, 0);
  assert.equal(sampleAvatarTimeline(timeline, 1).height, 3);
  assert.equal(sampleAvatarTimeline(timeline, 2).height, 0);
  assert.equal(sampleAvatarTimeline(timeline, .5).height, sampleAvatarTimeline(timeline, 1.5).height);
});

test('rejects malformed tracks and data outside host-approved channels', () => {
  const make = () => ({ duration: 2, tracks: [{ channel: 'head', frames: [{ time: 0, value: 0 }, { time: 1, value: 1 }] }] });
  for (const mutate of [
    x => { x.tracks[0].channel = 'constructor'; },
    x => { x.tracks[0].frames[1].time = 0; },
    x => { x.tracks[0].frames[1].value = Infinity; },
    x => { x.tracks[0].frames[1].value = [1, 2]; },
    x => { x.tracks[0].frames[1].ease = 'eval'; },
    x => { x.tracks[0].flights = [{ from: 0, to: 3, y0: 0, y1: 0, gravity: 6 }]; },
  ]) { const x = make(); mutate(x); assert.throws(() => compileAvatarTimeline(x, { allowedChannels: new Set(['head']) })); }
});
