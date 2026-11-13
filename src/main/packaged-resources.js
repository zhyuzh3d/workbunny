'use strict';

// Electron also sets resourcesPath when running its development shell.
module.exports = () => Boolean(process.resourcesPath) &&
  (!process.versions.electron || require('electron').app.isPackaged);
