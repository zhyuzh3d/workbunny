import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createBodyAvoidance} from '../src/renderer/body-avoidance.mjs';
function mockRig({inside=true}={}) {
 const hips=new THREE.Object3D();hips.position.y=1;
 const chest=new THREE.Object3D();chest.position.y=.25;hips.add(chest);
 const upper=new THREE.Object3D();upper.position.set(.17,0,0);chest.add(upper);
 const lower=new THREE.Object3D();lower.position.set(-.04,-.10,.04);upper.add(lower);
 const hand=new THREE.Object3D();hand.position.set(inside?-.06:.25,0,.08);lower.add(hand);
 const tip=new THREE.Object3D();tip.name='LeftHand_end';tip.position.set(-.09,0,-.08);hand.add(tip);
 const bones={hips,upperChest:chest,leftUpperArm:upper,leftLowerArm:lower,leftHand:hand};
 hips.updateWorldMatrix(true,true);
 return {vrm:{humanoid:{getNormalizedBoneNode:n=>bones[n]||null,getRawBoneNode:n=>bones[n]||null,update(){hips.updateWorldMatrix(true,true)}}},bones,tip};
}
test('wrist approaching torso is moved forward and restore returns the authored pose',()=>{
 const {vrm,bones}=mockRig();const avoidance=createBodyAvoidance(vrm);
 const initial=bones.leftUpperArm.quaternion.clone();const before=bones.upperChest.worldToLocal(bones.leftHand.getWorldPosition(new THREE.Vector3())).z;
 assert.equal(avoidance.apply(),1);bones.leftHand.updateWorldMatrix(true,false);
 const after=bones.upperChest.worldToLocal(bones.leftHand.getWorldPosition(new THREE.Vector3())).z;
 assert.ok(after>before+.015,`${before} → ${after}`);assert.ok(Number.isFinite(after));
 avoidance.restore();assert.ok(bones.leftUpperArm.quaternion.angleTo(initial)<1e-7);
});
test('hand clearly outside the torso is not moved',()=>{
 const {vrm,bones}=mockRig({inside:false});const initial=bones.leftUpperArm.quaternion.clone();
 assert.equal(createBodyAvoidance(vrm).apply(),0);assert.ok(bones.leftUpperArm.quaternion.angleTo(initial)<1e-7);
});
test('approaching and leaving the torso does not create a rotation jump',()=>{
 const {vrm,bones}=mockRig();const avoidance=createBodyAvoidance(vrm);let previous;
 for(let z=.04;z<=.24;z+=.005){
  avoidance.restore();bones.leftHand.position.z=z;bones.hips.updateWorldMatrix(true,true);avoidance.apply();
  const q=bones.leftUpperArm.quaternion.clone();
  if(previous)assert.ok(q.angleTo(previous)<Math.PI/6,'upper-arm correction jumped');
  previous=q;
 }
});
test('missing chest returns no correction',()=>assert.equal(createBodyAvoidance({humanoid:{getNormalizedBoneNode:()=>null}}),null));
