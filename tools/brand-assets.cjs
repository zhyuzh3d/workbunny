'use strict';
// Application artwork and monochrome UI branding have independent sources.
const BRAND_ASSETS = Object.freeze({
  master: 'res/logo.svg',
  applicationSource: 'res/app-icon-source.png',
  white: 'res/logo-white.svg',
  product: 'res/icon.svg',
  applicationPNG: 'res/icon.png',
  applicationICNS: 'res/icon.icns',
  windowPNG: 'res/window-icon.png',
  traySVG: 'res/trayTemplate.svg',
  tray1x: 'res/trayTemplate.png',
  tray2x: 'res/trayTemplate@2x.png',
});
module.exports = { BRAND_ASSETS, BRAND_FILES: Object.freeze(Object.values(BRAND_ASSETS)) };
