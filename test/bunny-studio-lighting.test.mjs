import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BUNNY_STUDIO, createBunnyStudioLighting } from '../src/renderer/soft-surface/bunny-studio-lighting.mjs';
import { installOvalAreaLighting } from '../src/renderer/soft-surface/oval-area-light.mjs';

test('approved studio lights stay in scene coordinates as the bunny moves', () => {
  const scene = new THREE.Scene(), bunny = new THREE.Group();
  scene.add(bunny);
  const studio = createBunnyStudioLighting(scene);
  const lights = studio.group.children.filter(light => light.isRectAreaLight);
  assert.equal(lights.length, 2);
  assert.equal(studio.group.children.find(light => light.isHemisphereLight).intensity, 5);
  assert.deepEqual(lights.map(light => [light.position.x, light.position.y, light.position.z]), [[-8,5.5,-4.8],[8,5.5,-8]]);
  assert.deepEqual(lights.map(light => [light.width,light.height]), BUNNY_STUDIO.lights.map(({scale})=>[10.4*scale,7.8*scale]));
  bunny.position.set(3, 2, -1); bunny.rotation.y = 1; scene.updateMatrixWorld(true);
  assert.deepEqual(lights.map(light => light.getWorldPosition(new THREE.Vector3()).toArray()), [[-8,5.5,-4.8],[8,5.5,-8]]);
  studio.dispose(); assert.equal(studio.group.parent, null);
});

test('oval shader composes with existing material hooks and does not mutate shared Three shaders', () => {
  const material = new THREE.MeshPhysicalMaterial(), original = THREE.ShaderChunk.lights_physical_pars_fragment;
  let called = false;
  material.onBeforeCompile = shader => { called = true; shader.vertexShader += '\n// existing skin'; };
  material.customProgramCacheKey = () => 'skin';
  installOvalAreaLighting(material);
  const shader = { vertexShader: '', fragmentShader: '#include <lights_physical_pars_fragment>' };
  material.onBeforeCompile(shader, {});
  assert.ok(called); assert.match(shader.vertexShader, /existing skin/);
  assert.match(shader.fragmentShader, /i<=48/); assert.match(material.customProgramCacheKey(), /skin\|bunny-oval-light-v1/);
  assert.equal(THREE.ShaderChunk.lights_physical_pars_fragment, original);
});
