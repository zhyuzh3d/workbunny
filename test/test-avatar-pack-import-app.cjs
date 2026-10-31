'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { packageBytes } = require('./support/avatar-pack-fixture.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-pack-import-'));
  const files = [path.join(root, 'first.wbavatar'), path.join(root, 'next.wbavatar'), path.join(root, 'bad.wbavatar')];
  fs.writeFileSync(files[0], packageBytes('1.0.0')); fs.writeFileSync(files[1], packageBytes('2.0.0')); fs.writeFileSync(files[2], 'not a package');
  const config = require('../src/main/config'); config.setPath(path.join(root, 'config.json'));
  config.save({ avatar: 'AvatarSample_D.vrm', voice: { enabled: false, alwaysListen: false }, tts: { enabled: false }, memory: { extract: false } });
  fs.writeFileSync(path.join(root, '.no-restart'), '');
  fs.writeFileSync(path.join(root, 'storage-location.json'), JSON.stringify({ format: 'workbunny-location/v1', dir: path.join(root, 'unavailable', 'vault') }));
  const wait = (condition, result) => `(async()=>{for(let i=0;i<120;i++){const s=window.__pet();if(${condition})return ${result};await new Promise(r=>setTimeout(r,100));}throw Error('timeout: '+JSON.stringify(window.__pet()))})()`;
  const script = [
    wait('s.vrm&&!s.loading', '({vrmReady:true})'),
    'window.pet.open("settings")',
    '@panel:settings:(async()=>{const r=await window.pet.avatarImport();window.__importKey=r.key;await window.pet.config({avatar:r.key});return {imported:!!r.key}})()',
    wait('s.dataAvatar&&!s.loading', '({packReady:true})'),
    '@panel:settings:(async()=>{const r=await window.pet.avatarImport({targetKey:window.__importKey});return {upgraded:r.avatars.find(a=>a.key===r.key)?.version}})()',
    '@panel:settings:(async()=>{try{await window.pet.avatarImport({targetKey:window.__importKey});return {badAccepted:true}}catch(e){const s=await window.pet.panelInit();return {badRejected:true,version:s.avatars.find(a=>a.key===window.__importKey)?.version}}})()',
    '@panel:settings:(async()=>{const r=await window.pet.avatarDelete(window.__importKey);return {deleted:!r.avatars.some(a=>a.key===window.__importKey),fallback:r.avatar}})()',
    wait('s.vrm&&!s.loading', '({vrmRestored:true})'),
  ];
  fs.writeFileSync(path.join(root, 'selftest.json'), JSON.stringify({ shotDir: path.join(root, 'shots'), delay: 5000, every: 500, extra: 0, script }));
  const env = { ...process.env, BUDDY_PET_HOME: root, WORKBUNNY_TEST_PACK_FILES: JSON.stringify(files) }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.resolve('node_modules/.bin/electron'), ['test/support/avatar-pack-app-entry.cjs'], { env, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 100000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const log = fs.readFileSync(path.join(root, 'buddy.log'), 'utf8');
    assert.equal(code, 0, log.slice(-9000));
    for (const marker of ['"vrmReady":true', '"imported":true', '"packReady":true', '"upgraded":"2.0.0"', '"badRejected":true', '"version":"2.0.0"', '"deleted":true', '"vrmRestored":true']) {
      assert(log.includes(marker), marker + '\n' + log.slice(-9000));
    }
    assert(!log.includes('[selftest] fail') && !log.includes('ERR:'), log.slice(-9000));
    console.log(JSON.stringify({ ok: true, artifacts: root }));
  } finally { clearTimeout(timer); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
