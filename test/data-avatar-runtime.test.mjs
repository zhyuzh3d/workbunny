import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DataAvatarRuntime } from '../src/renderer/data-avatar-runtime.mjs';

function fixture() {
  const root = new THREE.Group(), body = new THREE.Group(), ear = new THREE.Group();
  body.name = 'body'; ear.name = 'ear'; root.add(body); body.add(ear); ear.position.set(0, 1, 0);
  const descriptor = { namespace: 'example', model: 'model.glb', features: ['transform-timeline-v1', 'hit-volumes-v1'], defaultIdle: 'idle',
    bindings: [{ channel: 'body_y', node: 'body', transform: 'position', component: 'y' }],
    actions: [
      { id: 'idle', loop: true, timeline: { duration: 2, tracks: [{ channel: 'body_y', frames: [{ time: 0, value: 0 }, { time: 2, value: 0 }] }] } },
      { id: 'jump', timeline: { duration: 2, tracks: [{ channel: 'body_y', frames: [{ time: 0, value: 0 }, { time: 2, value: 0 }],
        flights: [{ from: 0, to: 2, y0: 0, y1: 0, gravity: 6 }] }] } },
    ], anchors: [{ id: 'ear', node: 'ear' }], regions: [
      { id: 'ear', priority: 0, hitVolumes: [{ type: 'sphere', anchor: 'ear', size: [.2, .2, .2], center: [0, 0, 0] }] },
    ] };
  let disposed = 0; const finished = [];
  const context = { loadModel: async () => ({ root, dispose() { disposed++; } }), onFinished: id => finished.push(id) };
  return { root, body, ear, descriptor, context, finished, get disposed() { return disposed; } };
}

test('data runtime plays a ballistic action and returns to its own idle', async () => {
  const f = fixture(), runtime = new DataAvatarRuntime();
  await runtime.load(f.context, f.descriptor);
  assert.deepEqual(runtime.getActions(), ['example_idle', 'example_jump']);
  assert.deepEqual(runtime.play({ key: 'example_jump' }), { ok: true });
  runtime.update(1); assert.equal(f.body.position.y, 3);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 4, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(runtime.hitTest(raycaster).id, 'ear');
  runtime.update(1); assert.deepEqual(f.finished, ['example_jump']);
  assert.equal(f.body.position.y, 0);
  assert.equal(runtime.current.action.id, 'idle');
  assert.equal(runtime.play({ key: 'missing' }).ok, false);
  runtime.dispose(); runtime.dispose(); assert.equal(f.disposed, 1);
});

test('unsupported features and invalid bindings fail instead of silently degrading', async () => {
  const f = fixture(), runtime = new DataAvatarRuntime();
  f.descriptor.features.push('arbitrary-shader');
  await assert.rejects(runtime.load(f.context, f.descriptor), /Unsupported/);
  assert.equal(f.disposed, 0);
  f.descriptor.features.pop();
  f.descriptor.actions[1].effects = ['unknown'];
  await assert.rejects(runtime.load(f.context, f.descriptor), /Invalid runtime action/);
  assert.equal(f.disposed, 1);
  delete f.descriptor.actions[1].effects;
  f.descriptor.bindings[0].transform = 'userData';
  await assert.rejects(runtime.load(f.context, f.descriptor), /Invalid animation binding/);
  assert.equal(f.disposed, 2);
  assert.equal(runtime.root, null);
});

test('morph shapes and material colors are driven by data without changing other nodes', async () => {
  const f = fixture(), eye = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  eye.name = 'eye'; eye.morphTargetInfluences = [0]; f.root.add(eye);
  f.descriptor.features.push('morph-target-v1', 'material-color-v1');
  f.descriptor.bindings.push({ channel: 'shape', node: 'eye', transform: 'morph', index: 0 }, { channel: 'red', node: 'eye', transform: 'color', component: 'r' });
  f.descriptor.actions[1].timeline.tracks.push(
    { channel: 'shape', frames: [{ time: 0, value: 0 }, { time: 2, value: 1, ease: 'linear' }] },
    { channel: 'red', frames: [{ time: 0, value: 1 }, { time: 2, value: 0, ease: 'linear' }] },
  );
  const runtime = new DataAvatarRuntime(); await runtime.load(f.context, f.descriptor);
  runtime.play({ key: 'example_jump' }); runtime.update(1);
  assert.equal(eye.morphTargetInfluences[0], .5);
  assert.equal(eye.material.color.r, .5);
  runtime.dispose();
});
