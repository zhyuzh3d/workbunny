// Keep the trial model's chest springs within a controlled angle. The spring
// solver's Verlet tail must follow a clamped joint to prevent a rebound impulse.
export function limitBreastSprings(joints, degrees = 12) {
  const limit = degrees * Math.PI / 180;
  let count = 0;
  for (const joint of joints || []) {
    if (!/^Breast_[LR]$/.test(joint.bone?.name || '')) continue;
    const { bone, _initialLocalRotation: rest, _initialLocalChildPosition: child,
      _currentTail: current, _prevTail: previous } = joint;
    if (!rest || !child || !current || !previous ||
        typeof joint._getMatrixWorldToCenter !== 'function') {
      throw new Error('胸部弹性保护与当前弹簧组件不兼容');
    }
    const update = joint.update.bind(joint);
    const oldTail = current.clone(), nextTail = current.clone();
    joint.update = function (delta) {
      update(delta);
      const angle = rest.angleTo(bone.quaternion);
      if (!(angle > limit)) return;
      bone.quaternion.slerp(rest, 1 - limit / angle);
      bone.updateMatrix();
      bone.matrixWorld.multiplyMatrices(joint._parentMatrixWorld, bone.matrix);
      oldTail.copy(current);
      nextTail.copy(child);
      bone.localToWorld(nextTail).applyMatrix4(joint._getMatrixWorldToCenter());
      current.copy(nextTail);
      previous.add(nextTail.sub(oldTail));
    };
    count++;
  }
  return count;
}

// Restrict the dedicated fringe spring to twisting around the head's forward
// axis. The shared side/back hair springs are deliberately left untouched.
export function limitFringeSwing(joints, degrees = 40) {
  let count = 0;
  for (const joint of joints || []) {
    if (joint.bone?.name !== 'HairFringe') continue;
    const {bone, _initialLocalRotation: rest, _initialLocalChildPosition: child,
      _currentTail: current, _prevTail: previous} = joint;
    if (!rest || !child || !current || !previous || typeof joint._getMatrixWorldToCenter !== 'function') {
      throw new Error('刘海摆动保护与当前弹簧组件不兼容');
    }
    // Model-forward in Head local coordinates, derived from this model's bind pose.
    const forward = child.clone().set(-0.007671, -0.213691, 0.976872).normalize();
    const delta = rest.clone(), twist = rest.clone(), oldTail = current.clone(), nextTail = current.clone();
    const update = joint.update.bind(joint), limit = degrees * Math.PI / 180;
    joint.update = function (dt) {
      update(dt);
      delta.copy(rest).invert().multiply(bone.quaternion).normalize();
      const projected = delta.x * forward.x + delta.y * forward.y + delta.z * forward.z;
      twist.set(forward.x * projected, forward.y * projected, forward.z * projected, delta.w);
      if (twist.lengthSq() < 1e-12) twist.identity(); else twist.normalize();
      if (twist.w < 0) twist.set(-twist.x, -twist.y, -twist.z, -twist.w);
      const angle = 2 * Math.acos(Math.min(1, Math.max(-1, twist.w)));
      if (angle > limit) twist.slerp(delta.identity(), 1 - limit / angle);
      bone.quaternion.copy(rest).multiply(twist);
      bone.updateMatrix();
      bone.matrixWorld.multiplyMatrices(joint._parentMatrixWorld, bone.matrix);
      oldTail.copy(current);
      nextTail.copy(child);
      bone.localToWorld(nextTail).applyMatrix4(joint._getMatrixWorldToCenter());
      current.copy(nextTail);
      previous.add(nextTail.sub(oldTail));
    };
    count++;
  }
  return count;
}

// Prevent the side and back hair joints folding through the head at extreme
// strength. The separately controlled fringe keeps its own directional limit.
export function limitHairSprings(joints, degrees = 40, enabled = () => true) {
  const limit = degrees * Math.PI / 180;
  let count = 0;
  for (const joint of joints || []) {
    if (!/^Hair(?:_L|_R|Tip_L|Tip_R|Back|BackTip)$/.test(joint.bone?.name || '')) continue;
    const {bone, _initialLocalRotation: rest, _initialLocalChildPosition: child,
      _currentTail: current, _prevTail: previous} = joint;
    if (!rest || !child || !current || !previous || typeof joint._getMatrixWorldToCenter !== 'function') {
      throw new Error('头发弹性保护与当前弹簧组件不兼容');
    }
    const update = joint.update.bind(joint), oldTail = current.clone(), nextTail = current.clone();
    joint.update = function (dt) {
      update(dt);
      if (!enabled()) return;
      const angle = rest.angleTo(bone.quaternion);
      if (!(angle > limit)) return;
      bone.quaternion.slerp(rest, 1 - limit / angle);
      bone.updateMatrix();
      bone.matrixWorld.multiplyMatrices(joint._parentMatrixWorld, bone.matrix);
      oldTail.copy(current);
      nextTail.copy(child);
      bone.localToWorld(nextTail).applyMatrix4(joint._getMatrixWorldToCenter());
      current.copy(nextTail);
      previous.add(nextTail.sub(oldTail));
    };
    count++;
  }
  return count;
}
