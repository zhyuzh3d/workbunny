import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// The renderer is browser ESM while this project uses CommonJS for .js files.
const groundSource = fs.readFileSync(new URL('../src/renderer/ground.js', import.meta.url), 'utf8')
  .replace("from 'three'", `from '${new URL('../node_modules/three/build/three.module.js', import.meta.url).href}'`);
const { makeRig, groundClip, soleHeight } = await import(`data:text/javascript;base64,${Buffer.from(groundSource).toString('base64')}`);
const bytes = (url) => { const b = fs.readFileSync(url); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const modelLoader = new GLTFLoader();
modelLoader.register(() => ({ name: 'TextureStub', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
modelLoader.register((p) => new VRMLoaderPlugin(p));
const vrm = (await modelLoader.parseAsync(bytes(new URL('../src/renderer/assets/models/Bani.vrm', import.meta.url)), '')).userData.vrm;
const rig = makeRig(vrm);
const motionLoader = new GLTFLoader();
motionLoader.register((p) => new VRMAnimationLoaderPlugin(p));
async function load(name) {
  const url = new URL(`../src/renderer/assets/motions/${name}.vrma`, import.meta.url);
  return createVRMAnimationClip((await motionLoader.parseAsync(bytes(url), '')).userData.vrmAnimations[0], vrm);
}
const reference = soleHeight(await load('idle_loop'), rig);
const track = (clip, bone) => clip.tracks.find(t => t.name === `${vrm.humanoid.getNormalizedBoneNode(bone).name}.quaternion`);

test('catwalk rejects lock-induced snapping on each affected leg and retains original tracks', async () => {
  const original = await load('tease_catwalk');
  const fixed = original.clone();
  const result = groundClip(fixed, rig, reference);
  assert.deepEqual(result.ik.discardedLegs, ['left', 'right']);
  for (const bone of ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'spine']) {
    const a = track(original, bone), b = track(fixed, bone);
    assert.deepEqual(Array.from(b.values), Array.from(a.values), `${bone} must retain source animation`);
    assert.deepEqual(Array.from(b.times), Array.from(a.times));
  }
});

test('ordinary motions retain foot locking when no snap is introduced', async () => {
  for (const name of ['idle_loop', 'greet_wave', 'dance_macarena']) {
    const clip = await load(name);
    const result = groundClip(clip, rig, reference);
    assert.ok(result.ik.contacts > 0, `${name} should detect contacts`);
    assert.deepEqual(result.ik.discardedLegs, [], `${name} should keep stable correction`);
  }
});

test('a continuous footplant crossing a loop uses one anchor without a leg snap', async () => {
  const raw = await load('ov_world_turn_right');
  const nonLoop = raw.clone(), loop = raw.clone();
  groundClip(nonLoop, rig, reference);
  const result = groundClip(loop, rig, reference, { loop: true });
  assert.deepEqual(result.ik.discardedLegs, [], 'retain the foot lock');
  const distance = (clip, bone) => {
    const tr = track(clip, bone), it = tr.createInterpolant();
    const q = (t) => new THREE.Quaternion().fromArray(it.evaluate(t)).normalize();
    return q(0).angleTo(q(clip.duration));
  };
  assert.ok(distance(nonLoop, 'leftUpperLeg') > 0.04, 'fixture exposes the unjoined anchor');
  assert.ok(distance(loop, 'leftUpperLeg') < 0.001, 'looped thigh must meet at the seam');
  assert.ok(distance(loop, 'leftLowerLeg') < 0.001, 'looped knee must meet at the seam');
  const { sampleFeet } = await import(`data:text/javascript;base64,${Buffer.from(groundSource).toString('base64')}`);
  const before = sampleFeet(nonLoop, rig), after = sampleFeet(loop, rig), last = after.n - 1;
  const gap = (s) => Math.hypot(s.lx[0] - s.lx[last], s.lz[0] - s.lz[last]);
  assert.ok(gap(before) > 0.04, 'fixture exposes a visible discontinuity');
  assert.ok(gap(after) < 0.001, 'foot remains planted at the loop seam');
});
