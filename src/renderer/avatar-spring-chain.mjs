import * as THREE from 'three';
import { validateAvatarSprings } from '../shared/avatar-spring-schema.mjs';

// Each point follows its animated bone tip in world space. Joint frequency and
// damping are per node, so a root can be firm while a tip follows later.
export class AvatarSpringChains {
  constructor(root, definitions, nodes) {
    this.root = root;
    const chains = validateAvatarSprings(definitions, new Set(nodes.keys()));
    this.joints = chains.flatMap(chain => chain.joints.map(spec => ({
      ...spec, bone: nodes.get(spec.node), tipLocal: new THREE.Vector3(...spec.tip),
      gravityWorld: new THREE.Vector3(...spec.gravity), initial: nodes.get(spec.node).quaternion.clone(),
      animated: new THREE.Quaternion(), point: new THREE.Vector3(), velocity: new THREE.Vector3(), ready: false,
    })));
    this.origin = new THREE.Vector3(); this.target = new THREE.Vector3(); this.old = new THREE.Vector3();
    this.restDirection = new THREE.Vector3(); this.direction = new THREE.Vector3(); this.side = new THREE.Vector3();
    this.worldQ = new THREE.Quaternion(); this.parentQ = new THREE.Quaternion(); this.delta = new THREE.Quaternion();
  }

  restoreBase() { for (const joint of this.joints) joint.bone.quaternion.copy(joint.initial); }
  reset() { for (const joint of this.joints) { joint.ready = false; joint.velocity.set(0, 0, 0); } }

  step(dt) {
    if (!Number.isFinite(dt) || dt <= 0 || !this.joints.length) return;
    dt = Math.min(dt, .1);
    const count = Math.max(1, Math.ceil(dt * 120)), h = dt / count;
    for (const joint of this.joints) joint.animated.copy(joint.bone.quaternion);
    for (let iteration = 0; iteration < count; iteration++) {
      // Restore the authored pose for each substep before applying spring
      // rotation, so the correction cannot accumulate frame over frame.
      for (const joint of this.joints) joint.bone.quaternion.copy(joint.animated);
      for (const joint of this.joints) {
        const bone = joint.bone;
        bone.updateWorldMatrix(true, false);
        bone.getWorldPosition(this.origin);
        this.target.copy(joint.tipLocal).applyMatrix4(bone.matrixWorld);
        const length = this.target.distanceTo(this.origin);
        if (length < 1e-7) continue;
        if (!joint.ready || joint.point.distanceTo(this.origin) > Math.max(2, length * 4)) {
          joint.point.copy(this.target); joint.velocity.set(0, 0, 0); joint.ready = true;
        }
        this.old.copy(joint.point);
        const omega = 2 * Math.PI * joint.hz;
        joint.velocity.addScaledVector(this.side.copy(this.target).sub(joint.point), omega * omega * h);
        joint.velocity.addScaledVector(joint.gravityWorld, h).multiplyScalar(Math.exp(-2 * joint.damping * omega * h));
        joint.point.addScaledVector(joint.velocity, h);
        this.restDirection.copy(this.target).sub(this.origin).normalize();
        this.direction.copy(joint.point).sub(this.origin);
        if (this.direction.lengthSq() < 1e-12) this.direction.copy(this.restDirection);
        this.direction.normalize();
        const dot = THREE.MathUtils.clamp(this.restDirection.dot(this.direction), -1, 1), limit = Math.cos(joint.maxAngle);
        if (dot < limit) {
          this.side.copy(this.direction).addScaledVector(this.restDirection, -dot);
          if (this.side.lengthSq() < 1e-12) this.side.set(Math.abs(this.restDirection.x) < .9 ? 1 : 0, Math.abs(this.restDirection.x) < .9 ? 0 : 1, 0).addScaledVector(this.restDirection, -this.side.dot(this.restDirection));
          this.direction.copy(this.side.normalize().multiplyScalar(Math.sin(joint.maxAngle))).addScaledVector(this.restDirection, limit);
        }
        joint.point.copy(this.origin).addScaledVector(this.direction, length);
        joint.velocity.copy(joint.point).sub(this.old).multiplyScalar(1 / h);
        bone.getWorldQuaternion(this.worldQ);
        this.delta.setFromUnitVectors(this.restDirection, this.direction).multiply(this.worldQ);
        if (bone.parent) bone.parent.getWorldQuaternion(this.parentQ); else this.parentQ.identity();
        bone.quaternion.copy(this.parentQ.invert()).multiply(this.delta).normalize();
        bone.updateWorldMatrix(false, true);
      }
    }
  }
}
