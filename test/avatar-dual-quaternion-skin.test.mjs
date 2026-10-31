import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installDualQuaternionSkin } from '../src/renderer/avatar-dual-quaternion-skin.mjs';

test('dual quaternion skin patch uses trusted host shader and preserves the prior hook', () => {
  const material = new THREE.MeshStandardMaterial(); let previousCalls = 0;
  material.onBeforeCompile = () => { previousCalls++; };
  installDualQuaternionSkin(material);
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader };
  material.onBeforeCompile(shader, {});
  assert.equal(previousCalls, 1);
  assert(shader.vertexShader.includes('wbSkinQuat'));
  assert(shader.vertexShader.includes('transformed=wbSkinRotate'));
  assert(!shader.vertexShader.includes('#include <skinning_vertex>'));
  assert(material.customProgramCacheKey().includes('workbunny-dq-skin-v1'));
  assert.throws(() => material.onBeforeCompile({ vertexShader: '' }, {}), /Unsupported skin shader/);
  material.dispose();
});
