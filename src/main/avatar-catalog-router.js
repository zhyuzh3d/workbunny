'use strict';

// Runtime selection is separate from the editable VRMA catalog. Config
// validation continues to use the latter so switching avatars cannot erase
// personal VRMA settings.
class AvatarCatalogRouter {
  constructor(vrmaCatalog, currentPack) {
    if (!vrmaCatalog || typeof currentPack !== 'function') throw TypeError('invalid avatar catalogs');
    this.vrma = vrmaCatalog;
    this.currentPack = currentPack;
  }
  active() { return this.currentPack()?.catalog || this.vrma; }
  catalog(...args) { return this.active().catalog(...args); }
  select(...args) { return this.active().select(...args); }
  idle(...args) { return this.active().idle(...args); }
  prompt(...args) { return this.active().prompt(...args); }
  ordinaryPrompt(posture = 'standing') {
    const { categories = [], motions = [] } = this.catalog();
    return categories.filter(group => motions.some(motion => motion.slot === group.id &&
      motion.enabled !== false && !motion.deleted && motion.autonomous !== false && !motion.requiresProp &&
      !motion.transition && !motion.postureChanging && Number(motion.weight ?? 1) > 0 &&
      (motion.posture || 'standing') === posture)).map(group => ({ category: group.id,
      meaning: group.label, use: String(group.description || '').slice(0, 60) }));
  }
  performanceSnapshot(options) { return require('./performance-catalog').buildPerformanceSnapshot(this, options); }
}

module.exports = { AvatarCatalogRouter };
