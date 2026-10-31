const NODE = /^[a-zA-Z0-9_-]{1,128}$/;
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const finite = n => typeof n === 'number' && Number.isFinite(n);
function vector(value, max) {
  return Array.isArray(value) && value.length === 3 && value.every(n => finite(n) && Math.abs(n) <= max);
}

export function validateAvatarSprings(input, nodeNames) {
  if (!Array.isArray(input) || input.length > 16) throw Error('Invalid spring chains');
  const used = new Set();
  return input.map(chain => {
    if (!only(chain, ['joints']) || !Array.isArray(chain.joints) || !chain.joints.length || chain.joints.length > 16) throw Error('Invalid spring chain');
    return { joints: chain.joints.map(joint => {
      if (!only(joint, ['node', 'tip', 'hz', 'damping', 'maxAngle', 'gravity']) || !NODE.test(joint.node || '') ||
          !nodeNames.has(joint.node) || used.has(joint.node) || !vector(joint.tip, 10) || Math.hypot(...joint.tip) < .001 ||
          !finite(joint.hz) || joint.hz <= 0 || joint.hz > 20 || !finite(joint.damping) || joint.damping < .05 || joint.damping > 2 ||
          !finite(joint.maxAngle) || joint.maxAngle < 0 || joint.maxAngle > 1.4 ||
          (joint.gravity !== undefined && !vector(joint.gravity, 50))) throw Error('Invalid spring joint');
      used.add(joint.node);
      return { node: joint.node, tip: joint.tip.slice(), hz: joint.hz, damping: joint.damping,
        maxAngle: joint.maxAngle, gravity: (joint.gravity || [0, 0, 0]).slice() };
    }) };
  });
}
