'use strict';
// Isolated, hidden renderer windows; no user data or desktop capture.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve('.'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-view-settings-'));
app.setPath('userData', path.join(temp, 'electron'));
const config = require('../src/main/config'); config.setPath(path.join(temp, 'config.json'));
let petWindow, panel; const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evalIn = (win, js) => win.webContents.executeJavaScript(js, true);
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(50); }
  throw Error('Timed out: ' + label + ' ' + errors.join('; '));
}
async function main() {
  await app.whenReady();
  config.save({ avatar: 'AvatarSample_D.vrm', window: { scale: .5, vrmFraming: 'half' }, voice: { enabled: false, alwaysListen: false }, tts: { enabled: false }, memory: { enabled: false } });
  const bytes = fs.readFileSync(path.join(root, 'src/renderer/assets/avatar-packs/soft-bunny.wbavatar'));
  const inspected = await require('../src/main/avatar-pack-reader').inspectAvatarPack(bytes);
  const bunny = { key: 'builtin_soft_bunny', file: 'builtin_soft_bunny', label: '兔兔', kind: 'avatar-pack', defaultPalette: 'rose', palettes: inspected.runtime.palettes };
  const avatars = [bunny, ...require('../src/main/avatars').scan().filter(a => !a.personal)];
  const init = () => ({ config: config.publicConfig(), avatars, avatar: config.load().avatar, motions: config.MOTIONS, motionGroups: config.MOTION_GROUPS, versions: {}, connection: { ready: true }, storage: { ok: true } });
  const send = event => { for (const win of [petWindow, panel]) if (win && !win.isDestroyed()) win.webContents.send('pet:ev', event); };
  ipcMain.handle('pet:init', init); ipcMain.handle('pet:panel-init', init);
  ipcMain.handle('pet:avatar-pack-data', () => ({ runtime: inspected.runtime, model: inspected.files.get(inspected.metadata.model), digest: 'test' }));
  ipcMain.handle('pet:config', (_e, patch) => { const previous = config.load().avatar; const next = config.publicConfig(config.save(patch)); if (next.avatar !== previous) send({ type: 'avatar', key: next.avatar }); send({ type: 'config', config: next }); return next; });
  ipcMain.handle('pet:scale', (_e, { scale }) => { const next = config.publicConfig(config.save({ window: { scale } })); send({ type: 'scale', scale }); send({ type: 'config', config: next }); return { scale, config: next }; });
  ipcMain.handle('pet:portability', () => ({ storage: { ok: true, dir: temp }, connection: { ready: true, note: '' } }));
  ipcMain.handle('pet:tts-http-template', () => ({}));
  ipcMain.handle('pet:brain-info', () => ({ providers: [], thinkingLevels: [], workbuddyModels: [] }));
  ipcMain.handle('pet:tts-info', () => ({ engines: [], systemVoices: [], qwen: {}, dl: {} }));
  ipcMain.handle('pet:speaker-status', () => ({}));
  ipcMain.handle('pet:asr-status', () => ({ speech: 0, mic: false }));
  const makeWindow = () => { const win = new BrowserWindow({ show: false, width: 520, height: 800, webPreferences: { preload: path.join(root, 'src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } }); win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); }); return win; };
  petWindow = makeWindow(); panel = makeWindow();
  await petWindow.loadFile(path.join(root, 'src/renderer/index.html'));
  await panel.loadFile(path.join(root, 'src/renderer/panel.html'));
  await until(async () => (await evalIn(petWindow, 'window.__pet?.().vrm && !window.__pet().loading')) && (await evalIn(panel, 'document.querySelector("#framingRow button")?.onclick || document.querySelector("#sizeRow .on")')), 'VRM and panel');
  assert.equal(await evalIn(petWindow, 'window.__frame().bust'), true);
  assert.deepEqual(await evalIn(panel, '[...document.querySelectorAll("#sizeRow button")].map(x=>x.textContent)'), ['50%', '100%', '150%', '200%']);
  assert.equal(await evalIn(panel, 'document.querySelector("#framingSection").hidden'), false);
  await evalIn(panel, 'document.querySelector("#framingRow [data-framing=full]").click()');
  await until(async () => !(await evalIn(petWindow, 'window.__frame().bust')), 'full framing');
  assert.equal(config.load().window.scale, .5);
  await evalIn(panel, 'document.querySelector("#sizeRow [data-k="+JSON.stringify("1.5")+"]").click()');
  await until(async () => (await evalIn(petWindow, 'window.__frame().scale')) === 1.5, '150%');
  assert.equal(await evalIn(petWindow, 'window.__frame().bust'), false);
  await evalIn(panel, 'document.querySelector("#framingRow [data-framing=half]").click()');
  await until(async () => await evalIn(petWindow, 'window.__frame().bust'), 'half at 150%');
  assert.equal(config.load().window.scale, 1.5);
  for (const size of [.25, .5, 1.5, 2]) for (const framing of ['half', 'full']) {
    await evalIn(panel, `document.querySelector('#sizeRow [data-k="${size}"]').click()`);
    await until(async () => (await evalIn(petWindow, 'window.__frame().scale')) === size, 'size ' + size);
    await evalIn(panel, `document.querySelector('#framingRow [data-framing="${framing}"]').click()`);
    await until(async () => (await evalIn(petWindow, 'window.__frame().bust')) === (framing === 'half'), framing + ' at ' + size);
    assert.equal(config.load().window.scale, size);
  }
  await evalIn(panel, 'document.querySelector("#framingRow [data-framing=half]").click()');
  await until(async () => await evalIn(petWindow, 'window.__frame().bust'), 'restore half');
  await evalIn(panel, 'document.querySelector("#avatarSelect").value="builtin_soft_bunny";document.querySelector("#avatarSelect").dispatchEvent(new Event("change"))');
  await until(async () => (await evalIn(petWindow, 'window.__pet().dataAvatar && !window.__pet().loading')) && (await evalIn(panel, 'document.querySelector("#framingSection").hidden')), 'bunny hides framing');
  assert.equal(config.load().window.scale, 2);
  await evalIn(panel, 'document.querySelector("#avatarSelect").value="AvatarSample_D.vrm";document.querySelector("#avatarSelect").dispatchEvent(new Event("change"))');
  await until(async () => (await evalIn(petWindow, 'window.__pet().vrm && !window.__pet().loading')) && !(await evalIn(panel, 'document.querySelector("#framingSection").hidden')), 'VRM restores framing');
  assert.equal(await evalIn(petWindow, 'window.__frame().bust'), true);
  assert.equal(errors.length, 0, errors.join('; '));
  console.log('Independent VRM framing and shared sizes passed in hidden Electron windows.');
}
main().then(() => finish(0), error => { console.error(error.stack, errors); finish(1); });
function finish(code) { for (const win of [petWindow, panel]) if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(temp, { recursive: true, force: true }); app.exit(code); }
