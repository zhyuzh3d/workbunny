import * as THREE from 'three';

// Hit proxies use their anchors' current world transforms, including animated
// bones. They are not added to the rendered scene or included in its bounds.
export class AvatarHitTest {
  constructor(regions, anchors) {
    this.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    this.items = [];
    this.hits = [];
    this.identity = new THREE.Quaternion();
    try {
      for (const region of regions) for (const volume of region.hitVolumes) {
      const anchor = anchors.get(volume.anchor);
      if (!anchor?.isObject3D) throw new Error(`Missing interaction anchor: ${volume.anchor}`);
      const [x, y, z] = volume.size;
      let geometry, scale;
      switch (volume.type) {
        case 'sphere':
        case 'ellipsoid':
          geometry = new THREE.SphereGeometry(1, 20, 12); scale = new THREE.Vector3(x, y, z); break;
        case 'box':
          geometry = new THREE.BoxGeometry(2, 2, 2); scale = new THREE.Vector3(x, y, z); break;
        case 'capsule':
          if (Math.abs(x - z) > 1e-6 || y < 2 * x) throw new Error('Capsule requires equal radii and a height of at least twice the radius');
          geometry = new THREE.CapsuleGeometry(x, Math.max(0, y - 2 * x), 6, 12); scale = new THREE.Vector3(1, 1, 1); break;
        default: throw new Error(`Unsupported interaction volume: ${volume.type}`);
      }
      const object = new THREE.Mesh(geometry, this.material);
      object.matrixAutoUpdate = false;
      const local = new THREE.Matrix4().compose(new THREE.Vector3(...volume.center), this.identity, scale);
        this.items.push({ id: region.id, priority: region.priority, anchor, object, local });
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  // `raycaster` must already be configured in world coordinates. Return the
  // closest visible region, resolving coincident hits deterministically.
  hitTest(raycaster, { maxDistance = Infinity } = {}) {
    this.hits.length = 0;
    for (const item of this.items) {
      item.anchor.updateWorldMatrix(true, false);
      item.object.matrixWorld.multiplyMatrices(item.anchor.matrixWorld, item.local);
      const hits = [];
      item.object.raycast(raycaster, hits);
      for (const hit of hits) if (hit.distance <= maxDistance) this.hits.push({ id: item.id, distance: hit.distance, priority: item.priority });
    }
    this.hits.sort((a, b) => a.distance - b.distance || b.priority - a.priority || a.id.localeCompare(b.id));
    return this.hits[0] || null;
  }

  worldBounds(target = new THREE.Box3()) {
    target.makeEmpty();
    const box = new THREE.Box3();
    for (const item of this.items) {
      item.anchor.updateWorldMatrix(true, false);
      item.object.matrixWorld.multiplyMatrices(item.anchor.matrixWorld, item.local);
      if (!item.object.geometry.boundingBox) item.object.geometry.computeBoundingBox();
      box.copy(item.object.geometry.boundingBox).applyMatrix4(item.object.matrixWorld);
      target.union(box);
    }
    return target;
  }

  dispose() {
    for (const item of this.items) item.object.geometry.dispose();
    this.material.dispose();
    this.items.length = 0;
    this.hits.length = 0;
  }
}
