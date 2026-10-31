'use strict';
const { dialog } = require('electron');
const files = JSON.parse(process.env.WORKBUNNY_TEST_PACK_FILES || '[]');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.shift()] });
require('../../src/main/entry.js');
