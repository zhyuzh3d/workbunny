'use strict';
// Exercise the actual Electron renderer and panel in an isolated profile.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process'), assert = require('node:assert/strict');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-posture-'));
  const config = require('../src/main/config'); config.setPath(path.join(root, 'config.json'));
  config.save({ avatar:'AvatarSample_D.vrm', voice:{enabled:false,alwaysListen:false}, tts:{enabled:false}, memory:{extract:false} });
  fs.writeFileSync(path.join(root, '.no-restart'), '');
  fs.writeFileSync(path.join(root, 'storage-location.json'), JSON.stringify({ format:'workbunny-location/v1', dir:path.join(root,'unavailable','vault') }));
  const wait = (condition, result) => `(async()=>{for(let i=0;i<120;i++){const s=window.__pet();if(${condition})return ${result};await new Promise(r=>setTimeout(r,100));}throw Error('timeout: '+JSON.stringify(window.__pet()))})()`;
  const script = [
    wait('s.vrm&&!s.loading', '({ready:true,startupClips:s.clips,standing:s.bodyPosture})'),
    'window.pet.open("motions")',
    '@panel:motions:(async()=>{const lib=await window.pet.motionLibrary();return {reviewed:lib.motions.length,hasRejected:lib.motions.some(m=>m.key==="idle_loop"),sliders:document.querySelectorAll("#motionList input[type=range]").length}})()',
    '@panel:motions:window.pet.panelMotion("hq_world_sit_enter")',
    wait('s.bodyPosture==="sitting"&&!s.transition', '({sat:true,idle:s.currentMotion})'),
    '@panel:motions:window.pet.panelMotion("ov_world_sit_clap")',
    wait('s.currentMotion==="ov_world_sit_clap"', '({seatedGesture:true,stillSeated:s.bodyPosture})'),
    '@panel:motions:window.pet.panelMotion("greet_sachi")',
    wait('s.bodyPosture==="standing"&&!s.transition&&s.currentMotion==="greet_sachi"', '({bridgeStanding:true})'),
    '@panel:motions:window.pet.panelMotion("hq_world_sit_enter")',
    '@panel:motions:window.pet.panelMotion("greet_sachi")',
    wait('s.bodyPosture==="standing"&&!s.transition&&s.currentMotion==="greet_sachi"', '({interruptedBridge:true})'),
    '@panel:motions:window.pet.panelMotion("q_swim_idle_loop")',
    wait('s.currentMotion==="q_swim_idle_loop"', '({swimLoaded:true,posture:s.bodyPosture})'),
  ];
  fs.writeFileSync(path.join(root,'selftest.json'),JSON.stringify({shotDir:path.join(root,'shots'),delay:5000,every:650,extra:0,script}));
  const bundled = process.argv.includes('--bundle');
  const command = path.resolve(bundled ? 'dist/workbunny.app/Contents/MacOS/workbunny' : 'node_modules/.bin/electron');
  const env = {...process.env,BUDDY_PET_HOME:root}; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command,bundled?[]:['.','--dev'],{env,stdio:'ignore'});
  const timer = setTimeout(()=>child.kill('SIGTERM'),100000);
  try {
    const code = await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
    const log = fs.readFileSync(path.join(root,'buddy.log'),'utf8'); assert.equal(code,0,log.slice(-6000));
    for (const marker of ['"ready":true','"standing":"standing"','"reviewed":235','"hasRejected":false','"sliders":0','"sat":true','"seatedGesture":true','"stillSeated":"sitting"','"bridgeStanding":true','"interruptedBridge":true','"swimLoaded":true']) assert(log.includes(marker),marker+'\n'+log.slice(-7000));
    const clips = Number(log.match(/"startupClips":(\d+)/)?.[1]); assert(clips>0&&clips<20,`startup loaded ${clips} clips`);
    assert(!log.includes('[selftest] fail'),log.slice(-7000));
    console.log(JSON.stringify({ok:true,bundled,startupClips:clips,artifacts:root}));
  } finally {clearTimeout(timer)}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
