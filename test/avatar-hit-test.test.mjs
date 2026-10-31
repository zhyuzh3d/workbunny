import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AvatarHitTest } from '../src/renderer/avatar-hit-test.mjs';

const ray = (x, y, z = 8) => new THREE.Raycaster(new THREE.Vector3(x, y, z), new THREE.Vector3(0, 0, -1));
function region(id, anchor, type, size, center = [0, 0, 0], priority = 0) {
  return { id, priority, hitVolumes: [{ anchor, type, size, center }] };
}

test('hit proxies follow current animated bone and parent transforms', () => {
  const parent = new THREE.Group(), bone = new THREE.Bone();
  parent.add(bone); bone.position.set(-1, 0, 0);
  const testTarget = new AvatarHitTest([region('ear', 'ear_bone', 'capsule', [.2, 1, .2])], new Map([['ear_bone', bone]]));
  assert.equal(testTarget.hitTest(ray(-1, 0)).id, 'ear');
  assert.equal(testTarget.hitTest(ray(1, 0)), null);
  bone.position.x = 1;
  assert.equal(testTarget.hitTest(ray(-1, 0)), null);
  assert.equal(testTarget.hitTest(ray(1, 0)).id, 'ear');
  parent.position.y = 1;
  assert.equal(testTarget.hitTest(ray(1, 0)), null);
  assert.equal(testTarget.hitTest(ray(1, 1)).id, 'ear');
  testTarget.dispose();
  assert.equal(testTarget.hitTest(ray(1, 1)), null);
});

test('nearest overlapping region wins and an occlusion distance rejects rear hits', () => {
  const front = new THREE.Object3D(), rear = new THREE.Object3D();
  front.position.z = 1;
  const targets = new AvatarHitTest([
    region('head', 'front', 'ellipsoid', [1, 1, 1]),
    region('ear', 'rear', 'box', [1, 1, 1], [0, 0, 0], 100),
  ], new Map([['front', front], ['rear', rear]]));
  assert.equal(targets.hitTest(ray(0, 0)).id, 'head');
  assert.equal(targets.hitTest(ray(0, 0), { maxDistance: 5 }), null);
  assert.equal(targets.hitTest(ray(0, 0), { maxDistance: 6.1 }).id, 'head');
  targets.dispose();
});

test('coincident volumes resolve by priority and invalid capsules fail', () => {
  const node = new THREE.Object3D(), anchors = new Map([['a', node]]);
  const targets = new AvatarHitTest([
    region('head', 'a', 'sphere', [1, 1, 1], [0, 0, 0], 0),
    region('ear', 'a', 'sphere', [1, 1, 1], [0, 0, 0], 2),
  ], anchors);
  assert.equal(targets.hitTest(ray(0, 0)).id, 'ear');
  targets.dispose();
  assert.throws(() => new AvatarHitTest([region('ear', 'a', 'capsule', [.4, .2, .4])], anchors), /Capsule/);
});
