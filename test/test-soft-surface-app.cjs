'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-surface-app-')),config=require('../src/main/config');config.setPath(path.join(root,'config.json'));config.save({avatar:'builtin_soft_bunny',voice:{enabled:false,alwaysListen:false},tts:{enabled:false},memory:{extract:false}});
 fs.writeFileSync(path.join(root,'.no-restart'),'');fs.writeFileSync(path.join(root,'storage-location.json'),JSON.stringify({format:'workbunny-location/v1',dir:path.join(root,'unavailable','vault')}));
 const ns='p'+crypto.createHash('sha256').update('soft_bunny\0main').digest('hex').slice(0,20), key=n=>ns+'_act_'+crypto.createHash('sha256').update(n).digest('hex').slice(0,16);
 global.window={};require('../../Workbunny-designs/bunny-3d/performances.js');
 const keys=window.BunnyPerformances.list.map(p=>key(p.name));
 const wait=(condition,result)=>`(async()=>{for(let i=0;i<150;i++){let s=window.__pet();if(${condition})return ${result};await new Promise(r=>setTimeout(r,100));}throw Error('timeout: '+JSON.stringify(window.__pet()))})()`;
 const script=[wait('s.dataAvatar&&!s.loading','({surfaceReady:true,avatar:s.avatarKey,hit:s.hit})'),
  `window.__play(${JSON.stringify(key('耳朵捂脸'))})`, wait(`s.currentMotion===${JSON.stringify(key('耳朵捂脸'))}`,'({cover:true})'),
  `window.__play(${JSON.stringify(key('耳朵拍回球'))})`, wait(`s.currentMotion===${JSON.stringify(key('耳朵拍回球'))}`,'({ball:true})'),
  `window.__play(${JSON.stringify(key('怒火冲天'))})`, wait(`s.currentMotion===${JSON.stringify(key('怒火冲天'))}`,'({fire:true})'),
  `window.__play(${JSON.stringify(key('下雪啦'))})`, wait(`s.currentMotion===${JSON.stringify(key('下雪啦'))}`,'({snow:true})'),
  `(async()=>{let count=0;for(const key of ${JSON.stringify(keys)}){window.__play(key);if(window.__pet().currentMotion!==key)throw Error('action rejected '+key);await new Promise(r=>setTimeout(r,50));count++}return {allActions:count}})()`,
  `(async()=>{window.__play(${JSON.stringify(ns+'_idle')});await new Promise(r=>setTimeout(r,1200));return {settled:true}})()`,
  '(()=>{const {x,y}=window.__regionPoint("left_ear"),stage=document.getElementById("stage"),p={bubbles:true,button:0,pointerId:1,clientX:x,clientY:y,screenX:x,screenY:y};stage.setPointerCapture=()=>{};stage.dispatchEvent(new PointerEvent("pointerdown",p));window.dispatchEvent(new PointerEvent("pointerup",p));return {earTouch:true}})()',
  '(async()=>{await new Promise(r=>setTimeout(r,400));return {reason:(await window.pet.panelInit()).body.recentActions.at(-1)?.reason}})()'];
 fs.writeFileSync(path.join(root,'selftest.json'),JSON.stringify({shotDir:path.join(root,'shots'),delay:6500,every:950,extra:0,script}));
 const bundled=process.argv.includes('--bundle'),command=path.resolve(bundled?'dist/workbunny.app/Contents/MacOS/workbunny':'node_modules/.bin/electron'),env={...process.env,BUDDY_PET_HOME:root};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(command,bundled?[]:['.','--dev'],{env,stdio:'ignore'}),timer=setTimeout(()=>child.kill('SIGTERM'),120000);
 try{const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});const log=fs.readFileSync(path.join(root,'buddy.log'),'utf8');assert.equal(code,0,log.slice(-9000));for(const mark of ['"surfaceReady":true','"cover":true','"ball":true','"fire":true','"snow":true','"allActions":100','"earTouch":true','"reason":"touch"'])assert(log.includes(mark),mark+'\n'+log.slice(-9000));assert(!log.includes('[selftest] fail')&&!log.includes('ERR:')&&!/shader error|WebGLProgram: Shader Error/i.test(log),log.slice(-9000));console.log(JSON.stringify({ok:true,bundled,artifacts:root}));}finally{clearTimeout(timer)}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
