'use strict';
// Real renderer and avatar payload in an isolated, invisible Electron window.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve('.'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-studio-test-'));
app.setPath('userData', path.join(temp, 'electron'));
const config = require('../src/main/config'); config.setPath(path.join(temp, 'config.json'));
let win; const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => win.webContents.executeJavaScript(script, true);
async function waitFor(key, kind) {
  for (let i = 0; i < 200; i++) {
    const state = await evaluate('window.__pet?.()');
    if (state?.avatarKey === key && !state.loading && state[kind] && state.renderFrame > 1) return state;
    if (state?.bootErr) throw Error(state.bootErr);
    await sleep(100);
  }
  throw Error('Avatar failed to load: ' + key + ' ' + errors.join('; '));
}
async function main() {
  await app.whenReady();
  config.save({ avatar: 'builtin_soft_bunny', voice: { enabled: false, alwaysListen: false }, tts: { enabled: false }, memory: { enabled: false } });
  const bytes = fs.readFileSync(path.join(root, 'src/renderer/assets/avatar-packs/soft-bunny.wbavatar'));
  const inspected = await require('../src/main/avatar-pack-reader').inspectAvatarPack(bytes);
  const builtin = { key: 'builtin_soft_bunny', file: 'builtin_soft_bunny', label: '兔兔', name: '兔兔', kind: 'avatar-pack' };
  const avatars = [builtin, ...require('../src/main/avatars').scan().filter(item => !item.personal)];
  ipcMain.handle('pet:init', () => ({ config: config.publicConfig(), avatars, avatar: builtin.key, motions: config.MOTIONS, motionGroups: config.MOTION_GROUPS, versions: {} }));
  ipcMain.handle('pet:avatar-pack-data', () => ({ runtime: inspected.runtime, model: inspected.files.get(inspected.metadata.model), digest: 'test' }));
  ipcMain.handle('pet:config', (_event, patch) => config.publicConfig(config.save(patch)));
  ipcMain.handle('pet:scale', (_event, value) => value);
  ipcMain.handle('pet:asr-status', () => ({ speech: 0, mic: false }));
  win = new BrowserWindow({ show: false, width: 420, height: 660, webPreferences: { preload: path.join(root, 'src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await win.loadFile(path.join(root, 'src/renderer/index.html'));
  let state = await waitFor('builtin_soft_bunny', 'dataAvatar');
  assert.equal(state.palette, 'rose');
  await sleep(1000); const nextFrame = (await evaluate('window.__pet()')).renderFrame;
  assert.ok(nextFrame - state.renderFrame >= 10, 'Bunny renderer did not advance normally');
  let lighting = await evaluate('window.__light()');
  assert.equal(lighting.ambient, 5);
  assert.deepEqual(lighting.studio.lights.map(light => light.position), [[-8, 5.5, -4.8], [8, 5.5, -8]]);
  await evaluate('window.__avatar("Bani.vrm")'); await waitFor('Bani.vrm', 'vrm');
  lighting = await evaluate('window.__light()'); assert.equal(lighting.studio, null);
  await evaluate('window.__avatar("builtin_soft_bunny")'); await waitFor('builtin_soft_bunny', 'dataAvatar');
  lighting = await evaluate('window.__light()'); assert.equal(lighting.studio.lights.length, 2);
  assert.equal(errors.length, 0, errors.join('; '));
  console.log('Bunny studio lighting loads and stays isolated across avatar switches.');
}
main().then(() => finish(0), error => { console.error(error.stack, errors); finish(1); });
function finish(code) { if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(temp, { recursive: true, force: true }); app.exit(code); }
