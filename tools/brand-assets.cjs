'use strict';
// Single source and generated outputs, shared by icon generation and release copying.
const BRAND_ASSETS = Object.freeze({
  master: 'res/logo.svg',
  white: 'res/logo-white.svg',
  product: 'res/icon.svg',
  applicationPNG: 'res/icon.png',
  applicationICNS: 'res/icon.icns',
  traySVG: 'res/trayTemplate.svg',
  tray1x: 'res/trayTemplate.png',
  tray2x: 'res/trayTemplate@2x.png',
});
module.exports = { BRAND_ASSETS, BRAND_FILES: Object.freeze(Object.values(BRAND_ASSETS)) };
