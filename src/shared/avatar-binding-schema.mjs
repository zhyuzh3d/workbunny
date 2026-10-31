const ID = /^[a-z][a-z0-9_-]{0,79}$/;
const NODE = /^[a-zA-Z0-9_-]{1,128}$/;
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

export function validateAvatarBindings(input, nodeNames) {
  if (!Array.isArray(input) || input.length > 256) throw Error('Invalid animation bindings');
  const channels = new Set(), properties = new Set();
  return input.map(binding => {
    const transform = binding?.transform;
    const morph = transform === 'morph', color = transform === 'color';
    const keys = morph ? ['channel', 'node', 'transform', 'index'] : ['channel', 'node', 'transform', 'component'];
    if (!only(binding, keys) || !ID.test(binding.channel || '') || channels.has(binding.channel) || !NODE.test(binding.node || '') ||
        !nodeNames.has(binding.node) || !['position', 'rotation', 'scale', 'morph', 'color'].includes(transform) ||
        (morph ? !Number.isInteger(binding.index) || binding.index < 0 || binding.index >= 128 :
          !(color ? ['r', 'g', 'b'] : ['x', 'y', 'z']).includes(binding.component))) throw Error('Invalid animation binding');
    const key = `${binding.node}\0${transform}\0${morph ? binding.index : binding.component}`;
    if (properties.has(key)) throw Error('Duplicate animation binding');
    channels.add(binding.channel); properties.add(key);
    return morph ? { channel: binding.channel, node: binding.node, transform, index: binding.index } :
      { channel: binding.channel, node: binding.node, transform, component: binding.component };
  });
}
