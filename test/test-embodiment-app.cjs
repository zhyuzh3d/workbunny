'use strict';
// Actual application entry, preload, renderer, motion/settings panels and files.
// A deliberately unavailable Vault prevents Keychain access and background LLM.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process'), assert = require('node:assert/strict');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-embodiment-'));
  const assets = require('../src/main/asset-library'); assets.setRoot(root);
  const config = require('../src/main/config'); config.setPath(path.join(root, 'config.json'));
  config.save({ window: { w: 520, h: 1000, x: 150, y: -180, scale: .5, canvasWidthVersion: 1, canvasExpansionVersion: 2 },
    avatar: 'AvatarSample_D.vrm', voice: { enabled: false, alwaysListen: false }, tts: { enabled: false }, memory: { extract: false } });
  const { MotionLibrary } = require('../src/main/motion-library');
  const library = new MotionLibrary({ motions: config.MOTIONS, groups: config.MOTION_GROUPS, getConfig: config.load, saveConfig: config.save });
  const imported = library.import(path.resolve('src/renderer/assets/motions/greet_sachi.vrma'), { slot: 'greet', label: '测试个人动作' });
  const modelSource = path.join(root, '测试个人模型.vrm'); fs.copyFileSync('src/renderer/assets/models/AvatarSample_D.vrm', modelSource);
  const model = assets.importModel(modelSource);
  fs.writeFileSync(path.join(root, '.no-restart'), '');
  fs.writeFileSync(path.join(root, 'storage-location.json'), JSON.stringify({ format: 'workbunny-location/v1', dir: path.join(root, 'unavailable', 'vault') }));
  const script = [
    'window.pet.panelInit().then(s=>({stock:s.avatars.filter(a=>!a.personal).length,described:s.avatars.filter(a=>!a.personal).every(a=>a.description.length>20),recent:s.body.recentActions.length}))',
    '({overflow:window.__frame().viewport.offsetY<0,ready:window.__pet().vrm,clips:window.__pet().clips})',
    'Promise.all([window.pet.config({avatar:"AvatarSample_E.vrm"}),window.pet.config({avatar:"AvatarSample_F.vrm"})])',
    '(async()=>{for(let i=0;i<100;i++){const s=window.__pet();if(s.avatarKey==="AvatarSample_F.vrm"&&s.vrm&&!s.loading)return {rapidAvatarConsistent:(await window.pet.panelInit()).avatar===s.avatarKey};await new Promise(r=>setTimeout(r,100));}throw Error("rapid switch did not converge")})()',
    'window.pet.config({avatar:"AvatarSample_D.vrm"})',
    'window.pet.open("motions")',
    '@panel:motions:(async()=>{document.getElementById("mNewCategory").value="测试开心";await document.getElementById("mAddCategory").onclick();return {categoryCreated:document.getElementById("motionList").textContent.includes("测试开心")}})()',
    `@panel:motions:(async()=>{const lib=await window.pet.motionLibrary(),g=lib.categories.find(g=>g.label==="测试开心");await window.pet.motionEdit({type:"motion-update",key:${JSON.stringify(imported.key)},slot:g.id,weight:0});window.pet.panelMotion(${JSON.stringify(imported.key)});return {manualZeroWeight:true}})()`,
    `window.pet.panelInit().then(s=>({actualPersonalMotion:s.body.recentActions.at(-1)?.key===${JSON.stringify(imported.key)},why:s.body.recentActions.at(-1)?.reason}))`,
    ...['greet_sachi','praise_sachi','sign_sachi','cheer_clap_vr','surprise_scratch','greet_sachi'].map(key => `@panel:motions:window.pet.panelMotion(${JSON.stringify(key)})`),
    'window.pet.panelInit().then(s=>({fiveActual:s.body.recentActions.length===5,last:s.body.recentActions.at(-1)?.key}))',
    '@panel:motions:(async()=>{await window.pet.config({motions:{disabled:["greet_sachi"]}});window.pet.panelMotion("greet_sachi");return true})()',
    '@panel:motions:({disabledRejected:document.getElementById("mStatus").textContent.includes("已禁用")})',
    `@panel:motions:(async()=>{await window.pet.motionEdit({type:"motion-delete",key:${JSON.stringify(imported.key)}});return {personalMotionRemoved:!(await window.pet.motionLibrary()).motions.some(m=>m.key===${JSON.stringify(imported.key)})}})()`,
    'window.pet.open("settings")',
    '@panel:settings:(async()=>{try{await window.pet.avatarDelete("AvatarSample_D.vrm");return {stockProtected:false}}catch(e){return {stockProtected:e.message.includes("不能删除")}}})()',
    `window.pet.config({avatar:${JSON.stringify(model)},avatarDescriptions:{[${JSON.stringify(model)}]:"深蓝短发，白色衬衫，深色背心。"}})`,
    `({personalLoaded:window.__pet().avatarKey===${JSON.stringify(model)}&&window.__pet().vrm})`,
    `@panel:settings:(async()=>{const r=await window.pet.avatarDelete(${JSON.stringify(model)});return {personalDeleted:r.avatars.length===4,defaultAfterDelete:r.avatar==="AvatarSample_D.vrm",descriptionRemoved:!(await window.pet.panelInit()).config.avatarDescriptions[${JSON.stringify(model)}]}})()`,
    '@panel:settings:window.pet.speakerStatus().then(s=>({voiceOptIn:!s.enabled&&s.samples===0}))',
  ];
  fs.writeFileSync(path.join(root, 'selftest.json'), JSON.stringify({ shotDir: path.join(root, 'shots'), delay: 5000, every: 650, extra: 0, script }));
  const source = process.argv.includes('--source');
  const command = path.resolve(source ? 'node_modules/.bin/electron' : 'dist/workbunny.app/Contents/MacOS/workbunny');
  const env = { ...process.env, BUDDY_PET_HOME: root }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, source ? ['.', '--dev'] : [], { env, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 65000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const log = fs.readFileSync(path.join(root, 'buddy.log'), 'utf8'); assert.equal(code, 0, log.slice(-3000));
    for (const marker of ['"stock":4', '"described":true', '"overflow":true', '"categoryCreated":true', '"actualPersonalMotion":true', '"why":"manual"',
      '"fiveActual":true', '"disabledRejected":true', '"personalMotionRemoved":true', '"stockProtected":true', '"rapidAvatarConsistent":true', '"personalLoaded":true',
      '"personalDeleted":true', '"defaultAfterDelete":true', '"descriptionRemoved":true', '"voiceOptIn":true']) assert(log.includes(marker), marker + '\n' + log.slice(-9000));
    assert(!fs.existsSync(assets.personalFile('model', model) || path.join(root, 'avatars', model)));
    assert(!fs.existsSync(path.join(root, 'motions', imported.key + '.vrma')));
    assert(!log.includes('[brain] 完成'), 'UI operations do not use an LLM');
    console.log(JSON.stringify({ ok: true, source, scope: 'real entry + panels + execution ACK + VRMA CRUD + protected avatar deletion + virtual canvas', artifacts: root }));
  } finally { clearTimeout(timer); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
