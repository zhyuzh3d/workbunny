import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

// Approved in the bunny studio on 2026-11-13. Lights are fixed in scene space.
export const BUNNY_STUDIO = Object.freeze({
  hemisphere: 5,
  lights: Object.freeze([
    Object.freeze({ x: -8, z: -4.8, scale: 1.49 }),
    Object.freeze({ x: 8, z: -8, scale: 1.07 }),
  ]),
  height: 5.5, width: 10.4, depth: 7.8, intensity: 7.2, exposure: 1.15,
});

export function createBunnyStudioLighting(scene) {
  RectAreaLightUniformsLib.init();
  const group = new THREE.Group();
  group.name = 'BunnyStudioLighting';
  group.add(new THREE.HemisphereLight(0xffedf5, 0xb37daa, BUNNY_STUDIO.hemisphere));
  for (const { x, z, scale } of BUNNY_STUDIO.lights) {
    const light = new THREE.RectAreaLight(0xffeff6, BUNNY_STUDIO.intensity, BUNNY_STUDIO.width * scale, BUNNY_STUDIO.depth * scale);
    light.position.set(x, BUNNY_STUDIO.height, z); light.lookAt(x, 0, z); group.add(light);
  }
  group.visible = false;
  scene.add(group);
  return { group, dispose() { scene.remove(group); } };
}
