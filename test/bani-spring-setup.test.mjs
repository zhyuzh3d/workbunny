import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { configureBaniSprings } from '../src/renderer/bani-spring-setup.mjs';

test('built-in Bani receives the same spring strengths and guards as the reviewed preview', async () => {
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'TextureStub', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  loader.register(p => new VRMLoaderPlugin(p));
  const b = fs.readFileSync(new URL('../src/renderer/assets/models/Bani.vrm', import.meta.url));
  const vrm = (await loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset+b.byteLength), '')).userData.vrm;
  const joints = [...vrm.springBoneManager.joints];
  const hair = joints.find(j => j.bone.name === 'Hair_L');
  const chest = joints.find(j => j.bone.name === 'Breast_L');
  const ear = joints.find(j => /^Ear/.test(j.bone.name));
  const original = [hair.settings.stiffness, hair.settings.dragForce, chest.settings.stiffness, chest.settings.dragForce, ear.settings.stiffness, ear.settings.dragForce];
  const counts = configureBaniSprings(vrm);
  assert.equal(counts.fringe, 1); assert.equal(counts.hair, 6); assert.equal(counts.chest, 2);
  assert.ok(Math.abs(hair.settings.stiffness-original[0]/3)<1e-6);
  assert.ok(Math.abs(hair.settings.dragForce-original[1]/3)<1e-6);
  assert.ok(Math.abs(chest.settings.stiffness-original[2]/2)<1e-6);
  assert.ok(Math.abs(chest.settings.dragForce-original[3]/2)<1e-6);
  assert.equal(ear.settings.stiffness,original[4]); assert.equal(ear.settings.dragForce,original[5]);
  for(let i=0;i<30;i++) { vrm.update(1/60); vrm.scene.updateMatrixWorld(true); }
  assert.ok(joints.every(j=>[j.bone.quaternion.x,j.bone.quaternion.y,j.bone.quaternion.z,j.bone.quaternion.w].every(Number.isFinite)));
});
