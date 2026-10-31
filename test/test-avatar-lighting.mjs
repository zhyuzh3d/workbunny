import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createAvatarLighting,DEFAULT_LIGHTING,modelLighting,normalizeLighting} from '../src/renderer/avatar-lighting.mjs';
import {lightingForAvatar,AVATAR_LIGHTING_PROFILES} from '../src/renderer/avatar-lighting-profiles.mjs';
test('approved model profiles retain exact values and never multiply legacy model scaling again',()=>{
  const rig=createAvatarLighting(new THREE.Scene(),{shadowMap:{}});
  for(const [id,scale]of [['AvatarSample_D.vrm',1],['AvatarSample_E.vrm',.62],['AvatarSample_F.vrm',.64],['AvatarSample_G.vrm',.56],['AvatarSample_D.vrm',1]]){
    const expected=AVATAR_LIGHTING_PROFILES[id],profile=lightingForAvatar(id,scale);assert.deepEqual(profile,expected);
    rig.apply(profile);assert.equal(rig.ambient.intensity,expected.ambient.intensity*expected.multiplier);assert.equal(rig.getLight('key').intensity,expected.lights.key.intensity*expected.multiplier);assert.deepEqual(rig.getLight('key').position.toArray(),expected.lights.key.position);
    profile.lights.key.position[0]=99;assert.deepEqual(lightingForAvatar(id).lights.key.position,expected.lights.key.position,'switching models must not retain mutated state');
  }
  assert.deepEqual(lightingForAvatar('custom:model',.8),modelLighting(.8));
  assert.equal(lightingForAvatar('AvatarSample_D.vrm').ambient.intensity,1.55);
  assert.equal(lightingForAvatar('AvatarSample_E.vrm').ambient.color,'#e1e0ff');
  assert.deepEqual(lightingForAvatar('AvatarSample_F.vrm').lights.key.position,[4.4,-5.2,5.45]);
  assert.equal(lightingForAvatar('AvatarSample_G.vrm').lights.key.intensity,1.86);rig.dispose();
});
test('shared lighting preserves every existing avatar default, without cumulative scaling',()=>{
  const renderer={shadowMap:{}},scene=new THREE.Scene(),rig=createAvatarLighting(scene,renderer);
  for(const scale of [1,.62,.64,.56,1]){
    rig.apply(DEFAULT_LIGHTING,scale);
    assert.equal(rig.ambient.intensity,1.9*scale);
    assert.equal(rig.getLight('key').intensity,2.1*scale);
    assert.deepEqual(rig.getLight('key').position.toArray(),[1.1,2.6,2.2]);
    assert.equal(rig.getLight('rim').intensity,1.15*scale);
    assert.equal(rig.getLight('fill').intensity,.5*scale);
    assert.equal(renderer.toneMapping,THREE.NoToneMapping);assert.equal(renderer.shadowMap.enabled,false);
    const profile=modelLighting(scale);rig.apply(profile);
    assert.equal(rig.ambient.intensity,1.9*scale,'exported values already include avatar scaling');
  }
  rig.dispose();assert.equal(scene.children.length,0);
});
test('light types, exposure and optional material edits roundtrip and restore original materials',()=>{
  const renderer={shadowMap:{}},rig=createAvatarLighting(new THREE.Scene(),renderer),material=new THREE.MeshStandardMaterial({emissiveIntensity:.4});
  material.shadingToonyFactor=.7;material.shadingShiftFactor=.1;material.giEqualizationFactor=.8;
  const model=new THREE.Mesh(new THREE.BoxGeometry(),material);rig.setModel(model);
  const value=modelLighting();value.lights.key.type='spot';value.lights.key.position=[2,3,4];value.lights.key.target=[0,1.3,0];value.toneMapping='aces';value.exposure=.7;value.material.emissive=.5;value.material.toony=.2;value.shadows.enabled=true;
  rig.apply(value);assert(rig.getLight('key').isSpotLight);assert.deepEqual(rig.getLight('key').target.position.toArray(),[0,1.3,0]);assert.equal(material.emissiveIntensity,.2);assert.equal(material.shadingToonyFactor,.2);assert.equal(model.castShadow,true);assert.equal(renderer.toneMapping,THREE.ACESFilmicToneMapping);
  rig.apply(DEFAULT_LIGHTING);assert(rig.getLight('key').isDirectionalLight);assert.equal(material.emissiveIntensity,.4);assert.equal(material.shadingToonyFactor,.7);assert.equal(model.castShadow,false);
  assert.equal(normalizeLighting({multiplier:Infinity}).multiplier,1);assert.equal(normalizeLighting({lights:{key:{intensity:999}}}).lights.key.intensity,200);
  rig.dispose();model.geometry.dispose();material.dispose();
});
