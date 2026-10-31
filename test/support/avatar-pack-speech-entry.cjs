'use strict';
// Real main and renderer, with only test-window audio muted.
if (process.env.WORKBUNNY_TEST_DETERMINISTIC === '1') Math.random = () => 0;
const { app, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path');
ipcMain.on('pet:audio-done', (_event, value) => {
  fs.appendFileSync(path.join(process.env.BUDDY_PET_HOME, 'test-audio-receipts.log'), value?.success === true ? 'ok\n' : 'failed\n');
});
app.on('browser-window-created', (_event, win) => {
  win.webContents.setAudioMuted(true);
});
require('../../src/main/entry.js');
