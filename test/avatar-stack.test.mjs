import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRequire } from 'node:module';
import { DataAvatarRuntime } from '../src/renderer/data-avatar-runtime.mjs';
const require = createRequire(import.meta.url);
const { AvatarActionCatalog } = require('../src/main/avatar-action-catalog');
const { validateInteractionMap, AvatarInteractionPicker } = require('../src/main/avatar-interactions');

test('a region hit selects a declared action and drives a generic model through the host', async () => {
  const catalog = new AvatarActionCatalog({ namespace: 'figure', defaultIdle: 'idle',
    categories: [{ id: 'idle', label: '待机', description: '平静待机' }, { id: 'greet', label: '问候', description: '友好问候' }],
    actions: [
      { id: 'idle', category: 'idle', label: '呼吸', use: '平静待机', duration: 2, idle: true, loop: true },
      { id: 'wave', category: 'greet', label: '挥动', use: '友好挥动', duration: 1 },
    ] });
  const map = validateInteractionMap({ regions: [{ id: 'wing', pool: 'wing_pool', hitVolumes: [
    { type: 'sphere', anchor: 'wing', center: [0, 0, 0], size: [.3, .3, .3] },
  ] }], pools: { wing_pool: [{ action: 'wave', weight: 1 }] } },
  { actionIds: new Set(['idle', 'wave']), anchorIds: new Set(['wing']) });
  const root = new THREE.Group(), body = new THREE.Group(), wing = new THREE.Group();
  body.name = 'body'; wing.name = 'wing'; root.add(body); body.add(wing);
  const descriptor = { namespace: 'figure', model: 'model.glb', features: ['transform-timeline-v1', 'hit-volumes-v1'], defaultIdle: 'idle',
    bindings: [{ channel: 'wing_z', node: 'wing', transform: 'rotation', component: 'z' }],
    actions: [
      { id: 'idle', loop: true, timeline: { duration: 2, tracks: [{ channel: 'wing_z', frames: [{ time: 0, value: 0 }] }] } },
      { id: 'wave', timeline: { duration: 1, tracks: [{ channel: 'wing_z', frames: [{ time: 0, value: 0 }, { time: 1, value: 1, ease: 'linear' }] }] } },
    ], anchors: [{ id: 'wing', node: 'wing' }], regions: map.regions };
  const runtime = new DataAvatarRuntime();
  const context = { loadModel: async () => ({ root, dispose() {} }) };
  await runtime.load(context, descriptor);
  const hit = runtime.hitTest(new THREE.Raycaster(new THREE.Vector3(0, 0, 3), new THREE.Vector3(0, 0, -1)));
  const selected = new AvatarInteractionPicker({ random: () => 0 }).pick(map, hit.id,
    { allowed: localId => !!catalog.select(catalog.keyFor(localId), { exact: true }) });
  const actionKey = catalog.keyFor(selected.action);
  assert.equal(actionKey, 'figure_wave');
  assert.equal(runtime.play({ key: actionKey }).ok, true);
  runtime.update(.5);
  assert.equal(wing.rotation.z, .5);
  runtime.dispose();
});
