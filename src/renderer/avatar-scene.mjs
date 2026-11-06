// Each loaded scene owns its geometry, materials, skeletons and images.
// Several meshes or materials can reference the same underlying resource.
export function disposeAvatarScene(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const skeletons = new Set(), images = new Set();
  const addTexture = value => { if (value?.isTexture) textures.add(value); };
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.skeleton) skeletons.add(object.skeleton);
    const attached = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of attached) {
      if (!material || materials.has(material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) addTexture(value);
      for (const uniform of Object.values(material.uniforms || {})) addTexture(uniform?.value);
    }
  });
  for (const skeleton of skeletons) skeleton.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    const image = texture.source?.data;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) images.add(image);
    texture.dispose();
  }
  for (const image of images) image.close();
}
