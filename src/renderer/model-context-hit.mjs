// Inspect the rendered character's alpha at the pointer. This also follows
// animated skinning, morphs and texture cutouts, unlike bounding boxes or rays.
const pixel = new Uint8Array(4);
export function modelContextHit(root, renderer, scene, camera, viewport, x, y) {
  if (!root || !root.visible || !viewport?.width || !viewport?.height || x < 0 || x >= viewport.width || y < viewport.offsetY || y >= viewport.offsetY + viewport.height) return false;
  const gl = renderer.getContext();
  const px = Math.floor(x * gl.drawingBufferWidth / viewport.width);
  const py = gl.drawingBufferHeight - 1 - Math.floor((y - viewport.offsetY) * gl.drawingBufferHeight / viewport.height);
  renderer.render(scene, camera);
  gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  return pixel[3] > 16;
}
