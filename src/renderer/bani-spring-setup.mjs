import { createSpringTuner } from './bani-spring-tuning.mjs';
import { limitBreastSprings, limitFringeSwing, limitHairSprings } from './bani-spring-limits.mjs';

// Match the approved workbench preview for the built-in Bani model only.
// The tuner changes runtime settings; the owner's VRM bytes remain untouched.
export function configureBaniSprings(vrm) {
  const joints = vrm?.springBoneManager?.joints;
  if (!joints) throw new Error('芭尼模型缺少弹性关节');
  const chest = limitBreastSprings(joints);
  const fringe = limitFringeSwing(joints);
  const hair = limitHairSprings(joints, 40);
  const tuner = createSpringTuner(joints);
  if (chest !== 2 || fringe !== 1 || hair !== 6 || !tuner.count('hair') || !tuner.count('chest')) {
    throw new Error('芭尼模型的弹性关节与预览不一致');
  }
  tuner.set('hair', 300);
  tuner.set('chest', 200);
  return { chest, fringe, hair, hairJoints: tuner.count('hair'), chestJoints: tuner.count('chest') };
}
