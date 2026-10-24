import test from 'node:test';
import assert from 'node:assert/strict';
import { AnimationClip, AnimationMixer, Object3D, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
import { crossFadeMotionAction, processMotionClip } from '../src/renderer/motion-quality.mjs';

function track(name, width, times, rows) {
  return { name, times: Float32Array.from(times), values: Float32Array.from(rows.flat()), getValueSize: () => width,
    createInterpolant() {
      const self = this;
      return { evaluate(time) {
        let i = 0; while (i + 1 < self.times.length && self.times[i + 1] < time) i++;
        const j = Math.min(i + 1, self.times.length - 1), span = self.times[j] - self.times[i];
        const t = span > 0 ? Math.max(0, Math.min(1, (time - self.times[i]) / span)) : 0;
        return Float32Array.from({ length: width }, (_, k) => self.values[i * width + k] * (1 - t) + self.values[j * width + k] * t);
      } };
    } };
}
function clip(...tracks) { return { tracks }; }

test('normalizes quaternion keys and keeps adjacent quaternion signs consistent', () => {
  const q = track('Bone.quaternion', 4, [0, 1, 2], [[0, 0, 0, 2], [0, 0, 0, -1], [0, 0, 0, 1]]);
  const result = processMotionClip(clip(q));
  assert.equal(result.quaternionKeysNormalized, 1);
  assert.equal(result.quaternionSignFlips, 1);
  assert.deepEqual(Array.from(q.values).map((v) => Math.abs(v) < 1e-7 ? 0 : v), [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('repairs an isolated rotation spike and preserves a deliberate fast turn', () => {
  const spike = track('Spine.quaternion', 4, [0, 0.1, 0.2], [[0, 0, 0, 1], [0, 1, 0, 0], [0, 0, 0, 1]]);
  const fast = track('Arm.quaternion', 4, [0, 0.1, 0.2], [[0, 0, 0, 1], [0, 0.7071068, 0, 0.7071068], [0, 1, 0, 0]]);
  const result = processMotionClip(clip(spike, fast));
  assert.equal(result.isolatedSpikesRepaired, 1);
  assert.deepEqual(Array.from(spike.values), [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.notDeepEqual(Array.from(fast.values), [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('repairs only an isolated translation spike above the conservative threshold', () => {
  const position = track('Hips.position', 3, [0, 0.1, 0.2], [[0, 0, 0], [0.5, 0, 0], [0, 0, 0]]);
  const small = track('Hand.position', 3, [0, 0.1, 0.2], [[0, 0, 0], [0.04, 0, 0], [0, 0, 0]]);
  const result = processMotionClip(clip(position, small));
  assert.equal(result.isolatedSpikesRepaired, 1);
  assert.deepEqual(Array.from(position.values), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(Math.abs(small.values[3] - 0.04) < 1e-6);
});

test('closes a small declared loop seam with an eased tail while preserving its first pose', () => {
  const small = track('Hips.position', 3, [0, 1, 2], [[0, 0, 0], [0, 0, 0], [0.06, 0, 0]]);
  const large = track('Root.position', 3, [0, 1, 2], [[0, 0, 0], [0.1, 0, 0], [0.8, 0, 0]]);
  const result = processMotionClip(clip(small, large), { loop: true });
  assert.equal(result.loopSeamsSmoothed, 1);
  assert.equal(small.values[0], 0, 'the loop start pose must not be modified');
  assert.ok(Math.abs(small.values.at(-3) - small.values[0]) < 1e-6);
  assert.ok(Math.abs(large.values[6] - 0.8) < 1e-6);
});

test('closes a large rotation seam over an eased tail without touching non-loop clips', () => {
  const q = new QuaternionKeyframeTrack('Spine.quaternion', [0, 1, 2], [
    0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, 1, 0, 0,
  ]);
  const first = Array.from(q.values.slice(0, 4));
  const loopClip = new AnimationClip('loop', 2, [q]);
  const changed = processMotionClip(loopClip, { loop: true });
  assert.equal(changed.loopSeamsSmoothed, 1);
  assert.ok(q.times.length > 3, 'tail keys are added');
  assert.deepEqual(Array.from(q.values.slice(0, 4)), first, 'loop start remains unchanged');
  const last = Array.from(q.values.slice(-4));
  assert.ok(Math.abs(Math.abs(last.reduce((sum, value, i) => sum + value * first[i], 0)) - 1) < 1e-5, 'loop end reaches start orientation');
  const oneShot = new QuaternionKeyframeTrack('Arm.quaternion', [0, 1, 2], [0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, 1, 0, 0]);
  processMotionClip(new AnimationClip('one-shot', 2, [oneShot]), { loop: false });
  assert.equal(oneShot.times.length, 3, 'one-shot jump/turn remains unchanged');
});

test('does not repair zero quaternions by guessing an orientation', () => {
  const q = track('Bone.quaternion', 4, [0, 1], [[0, 0, 0, 1], [0, 0, 0, 0]]);
  const result = processMotionClip(clip(q));
  assert.ok(result.findings.some((f) => f.issue === 'zero-or-nonfinite-quaternion'));
  assert.deepEqual(Array.from(q.values.slice(4)), [0, 0, 0, 0]);
});

test('interrupted crossfades fade from current action weights instead of resetting to full weight', () => {
  const root = new Object3D(); root.name = 'Root';
  const mixer = new AnimationMixer(root);
  const action = (name, x) => mixer.clipAction(new AnimationClip(name, 1, [
    new VectorKeyframeTrack('Root.position', [0, 1], [x, 0, 0, x, 0, 0]),
  ]));
  const a = action('a', 0), b = action('b', 1), c = action('c', 2);
  a.play();
  crossFadeMotionAction(b, a, 1, [a]);
  mixer.update(0.2);
  assert.ok(Math.abs(b.getEffectiveWeight() - 0.2) < 0.02);
  crossFadeMotionAction(c, b, 1, [a, b]);
  mixer.update(0.01);
  assert.ok(b.getEffectiveWeight() < 0.21, `interrupted action jumped to ${b.getEffectiveWeight()}`);
  assert.ok(b.getEffectiveWeight() > 0.15, 'fade-out should remain continuous after interruption');
});
