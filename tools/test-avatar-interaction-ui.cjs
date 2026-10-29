'use strict';
// Real VRMs, renderer, preload and production interaction IPC handler.
// Only window/voice side effects are stubbed; no real app, account or model calls.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const config = require('../src/main/config'), avatars = require('../src/main/avatars');
const { Interactions } = require('../src/main/interaction');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-avatar-ui-'));
app.setPath('userData', path.join(root, 'electron')); config.setPath(path.join(root, 'config.json'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, now = 0; const errors = [], requests = [], queue = [], hits = [];
async function evaluate(source) { return win.webContents.executeJavaScript(source, true); }
async function wait(expression, label = expression) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(expression)) return;
    if (errors.length) throw new Error(errors.join('; '));
    await delay(100);
  }
  throw new Error('Renderer timeout: ' + label);
}
async function snapshot(file) {
  if (!process.env.WORKBUNNY_AVATAR_SHOTS) return;
  fs.mkdirSync(process.env.WORKBUNNY_AVATAR_SHOTS, { recursive: true });
  await delay(120);
  fs.writeFileSync(path.join(process.env.WORKBUNNY_AVATAR_SHOTS, file + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function main() {
  await app.whenReady();
  config.save({ avatar: 'AvatarSample_E.vrm', voice: { enabled: false, alwaysListen: false }, tts: { enabled: false }, memory: { enabled: false } });
  const list = avatars.scan().filter(info => !process.env.WORKBUNNY_AVATAR || info.key === process.env.WORKBUNNY_AVATAR);
  const motions = config.MOTIONS.filter(m => ['idle', 'greet', 'shy', 'tease', 'surprise', 'refuse', 'thanks'].includes(m.slot));
  ipcMain.handle('pet:init', () => ({ config: config.publicConfig(), avatars: list, avatar: 'AvatarSample_E.vrm', motions, motionGroups: config.MOTION_GROUPS, versions: {} }));
  ipcMain.handle('pet:config', (_event, patch) => config.publicConfig(config.save(patch)));
  ipcMain.handle('pet:scale', (_event, { scale }) => ({ scale }));
  ipcMain.handle('pet:asr-status', () => ({ speech: 0, mic: false }));
  ipcMain.on('pet:hit', (_event, value) => hits.push(value));
  win = new BrowserWindow({ show: false, width: 420, height: 660, backgroundColor: '#f7f3ec', webPreferences: {
    preload: path.resolve('src/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const mainSource = fs.readFileSync(path.resolve('src/main/index.js'), 'utf8');
  const handler = mainSource.slice(mainSource.indexOf("ipcMain.handle('pet:interact'"), mainSource.indexOf("ipcMain.handle('pet:init'"));
  vm.runInNewContext(handler, { ipcMain: { handle(name, fn) { ipcMain.handle(name, (event, request) => { requests.push(request); return fn(event, request); }); } },
    win, config, Date, Set, desktop: null, busy: false, speaking: false, lastSpokeAt: -Infinity, quietUntil: 0,
    interactions: new Interactions({ clock: () => now += 8000, random: () => 0 }), presentedReplies: new Map(), publishWebSources() {},
    send: (type, payload) => win.webContents.send('pet:ev', { type, ...payload }), speechQueue: queue, pumpSpeech() {},
  });
  await win.loadFile(path.resolve('src/renderer/index.html'));
  await wait("window.__pet?.().vrm && window.__pet().clips > 0 && document.getElementById('hint').classList.contains('hidden')", 'initial VRM and motions');
  for (const info of list) {
    await evaluate(`window.__avatar(${JSON.stringify(info.key)})`);
    await wait(`window.__pet().avatarKey === ${JSON.stringify(info.key)} && document.getElementById('hint').classList.contains('hidden')`);
    await delay(350);
    assert.equal((await evaluate('window.__light()')).factor, info.light);
    if (info.key === '58.vrm') {
      assert((await evaluate('window.__pet()')).hiddenMeshes.includes('Bag.baked'), 'the separate backpack and shoulder-strap mesh is hidden');
      await evaluate('window.__freeze(true)'); await snapshot('婷婷-no-bag'); await evaluate('window.__freeze(false)');
    }
    if (['阿雅', '琪琪', '美莉'].includes(info.label)) {
      await evaluate('window.__freeze(true)');
      await snapshot(info.label + '-after');
      await evaluate(`window.__light(${info.label === '美莉' ? .76 : 1})`);
      await snapshot(info.label + '-before');
      await evaluate(`window.__light(${info.light}); window.__freeze(false)`);
    }
    for (const scale of [1, .5, 1.5]) {
      // Compare independent idle views. A greeting may deliberately crouch or
      // jump; fitting a new camera in its middle is a different interaction.
      await evaluate("window.__freeze(false); window.__play('idle_loop')"); await delay(650);
      win.setContentSize(scale === 1.5 ? 630 : 420, scale === 1.5 ? 990 : 660);
      await evaluate(`window.__scale(${scale})`); await delay(220);
      win.webContents.send('pet:ev', { type: 'scene' }); await delay(50);
      await evaluate('window.__freeze(true)');
      const frame = await evaluate('window.__frame()');
      const x = frame.head.x, y = Math.round(frame.head.y - 28 * frame.h / 660 * (frame.bust ? 1.7 : 1));
      const hit = (await evaluate('window.__pet()')).hit;
      assert(y < frame.head.y - 16, 'click is above the old head-bone padding');
      assert(y >= hit.y0 && y <= hit.y1 && x >= hit.x0 && x <= hit.x1, info.label + ': crown is interactive');
      const before = requests.length;
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      for (let i = 0; i < 50 && requests.length === before; i++) await delay(20);
      const target = await evaluate(`document.elementFromPoint(${x},${y})?.id`);
      assert.equal(requests.length, before + 1, `${info.label}@${scale}: real mouse input reaches interaction IPC ${JSON.stringify({ x, y, target, frame, hit, state: await evaluate('window.__pet()') })}`);
      assert.equal(requests.at(-1).region, 'head');
      const expected = queue.at(-1).motion;
      assert(requests.at(-1).motions.includes(expected), 'the chosen action was loaded and enabled');
      await evaluate('window.__freeze(false)');
      await wait(`window.__pet().currentMotion === ${JSON.stringify(expected)}`, 'touch animation begins');
      assert(!config.MOTIONS.find(m => m.key === expected)?.loop, 'head click plays a gesture instead of another idle');
    }
    await evaluate('window.__scale(1)'); win.setContentSize(420, 660); await delay(100);
    console.log(info.label + ': light=' + info.light + ', crown clicks animate in all 3 sizes');
  }
  assert(hits.includes(true)); assert.equal(errors.length, 0, errors.join('; '));
  console.log(`Actual VRM/preload/production IPC passed: ${list.length} avatars, ${requests.length} crown clicks, concrete enabled animation, and per-avatar lighting.`);
}
main().then(() => finish(0), error => { console.error(error, errors.join('; ')); finish(1); });
function finish(code) { if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(root, { recursive: true, force: true }); app.exit(code); }
