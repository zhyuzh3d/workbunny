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
}

module.exports = { AvatarCatalogRouter };
