'use strict';
// Real application entry and renderer; isolated profile and synthetic pack.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { packageBytes } = require('./support/avatar-pack-fixture.cjs');
const { AvatarPackStore } = require('../src/main/avatar-pack-store');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-pack-app-'));
  const store = new AvatarPackStore(root), pending = await store.prepare(packageBytes()), pack = store.commit(pending.token);
  const config = require('../src/main/config'); config.setPath(path.join(root, 'config.json'));
  config.save({ avatar: pack.key, voice: { enabled: false, alwaysListen: false }, tts: { enabled: false }, memory: { extract: false } });
  fs.writeFileSync(path.join(root, '.no-restart'), '');
  fs.writeFileSync(path.join(root, 'storage-location.json'), JSON.stringify({ format: 'workbunny-location/v1', dir: path.join(root, 'unavailable', 'vault') }));
  const wait = (condition, result) => `(async()=>{for(let i=0;i<120;i++){const s=window.__pet();if(${condition})return ${result};await new Promise(r=>setTimeout(r,100));}throw Error('timeout: '+JSON.stringify(window.__pet()))})()`;
  const script = [
    wait('s.dataAvatar&&!s.loading', '({packReady:true,avatar:s.avatarKey,digest:!!s.avatarDigest})'),
    '(()=>{const r=window.__pet().hit,x=(r.x0+r.x1)/2,y=r.y0+(r.y1-r.y0)*.4,stage=document.getElementById("stage"),p={bubbles:true,button:0,pointerId:1,clientX:x,clientY:y,screenX:x,screenY:y};stage.setPointerCapture=()=>{};stage.dispatchEvent(new PointerEvent("pointerdown",p));window.dispatchEvent(new PointerEvent("pointerup",p));return {clickDispatched:true}})()',
    'window.pet.panelInit().then(s=>({actualTouch:s.body.recentActions.at(-1)?.reason,action:s.body.recentActions.at(-1)?.key}))',
    'window.pet.open("motions")',
    '@panel:motions:({packNotice:document.getElementById("motionList").textContent.includes("形象包"),toolsHidden:document.querySelector(".motionTools").hidden})',
    'window.pet.config({avatar:"AvatarSample_D.vrm"})',
    wait('s.vrm&&!s.loading', '({vrmRestored:true,avatar:s.avatarKey})'),
    `window.pet.config({avatar:${JSON.stringify(pack.key)}})`,
    wait('s.dataAvatar&&!s.loading', '({packRestored:true,avatar:s.avatarKey})'),
  ];
  fs.writeFileSync(path.join(root, 'selftest.json'), JSON.stringify({ shotDir: path.join(root, 'shots'), delay: 5000, every: 500, extra: 0, script }));
  const env = { ...process.env, BUDDY_PET_HOME: root }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.resolve('node_modules/.bin/electron'), ['.', '--dev'], { env, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 100000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const log = fs.readFileSync(path.join(root, 'buddy.log'), 'utf8');
    assert.equal(code, 0, log.slice(-9000));
    for (const marker of ['"packReady":true', '"clickDispatched":true', '"actualTouch":"touch"', '"packNotice":true', '"toolsHidden":true', '"vrmRestored":true', '"packRestored":true']) {
      assert(log.includes(marker), marker + '\n' + log.slice(-9000));
    }
    assert(!log.includes('[selftest] fail') && !log.includes('ERR:') && !/shader error|WebGLProgram: Shader Error/i.test(log), log.slice(-9000));
    console.log(JSON.stringify({ ok: true, artifacts: root }));
  } finally { clearTimeout(timer); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
