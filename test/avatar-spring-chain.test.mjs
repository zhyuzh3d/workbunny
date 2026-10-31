import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AvatarSpringChains } from '../src/renderer/avatar-spring-chain.mjs';
import { validateAvatarSprings } from '../src/shared/avatar-spring-schema.mjs';

function rig(hz, maxAngle = .7) {
  const root = new THREE.Group(), bone = new THREE.Bone(); bone.name = 'joint'; root.add(bone);
  const definitions = [{ joints: [{ node: 'joint', tip: [0, 1, 0], hz, damping: .7, maxAngle }] }];
  const solver = new AvatarSpringChains(root, definitions, new Map([['joint', bone]]));
  solver.restoreBase(); solver.step(1 / 60);
  return { root, bone, solver };
}

test('a moving parent drives delayed spring bending and the spring settles', () => {
  const { root, bone, solver } = rig(2);
  root.position.x = .3; solver.restoreBase(); solver.step(1 / 60);
  const bent = Math.abs(bone.rotation.z);
  assert(bent > .01 && bent < .71);
  for (let i = 0; i < 180; i++) { solver.restoreBase(); solver.step(1 / 60); }
  assert(Math.abs(bone.rotation.z) < .01);
});

test('a stiffer joint moves less than a soft joint after the same head movement', () => {
  const stiff = rig(6), soft = rig(1.5);
  for (const model of [stiff, soft]) {
    model.root.position.x = .3; model.solver.restoreBase(); model.solver.step(1 / 60);
  }
  assert(Math.abs(stiff.bone.rotation.z) < Math.abs(soft.bone.rotation.z));
});

test('invalid joints and unsupported spring definitions are rejected', () => {
  const valid = [{ joints: [{ node: 'joint', tip: [0, 1, 0], hz: 2, damping: .7, maxAngle: .5 }] }];
  for (const mutate of [
    d => { d[0].joints[0].node = 'missing'; },
    d => { d[0].joints[0].tip = [0, 0, 0]; },
    d => { d[0].joints[0].hz = Infinity; },
    d => { d[0].joints[0].maxAngle = 10; },
    d => { d[0].joints[0].code = 'run'; },
    d => { d[0].joints.push({ ...d[0].joints[0] }); },
  ]) { const data = JSON.parse(JSON.stringify(valid)); mutate(data); assert.throws(() => validateAvatarSprings(data, new Set(['joint']))); }
});
