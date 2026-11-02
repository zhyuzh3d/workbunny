'use strict';
// Real bundled bunny runtime in a disposable profile; no microphone or account access.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-overlay-soft-'));
 const config=require('../src/main/config');config.setPath(path.join(root,'config.json'));
 config.save({avatar:'builtin_soft_bunny',voice:{enabled:false,alwaysListen:false},tts:{enabled:false},memory:{enabled:false,extract:false},ui:{dialogueVisible:true,dialogueBehind:false,avatarHidden:false}});
 fs.writeFileSync(path.join(root,'.no-restart'),'');
 fs.writeFileSync(path.join(root,'storage-location.json'),JSON.stringify({format:'workbunny-location/v1',dir:path.join(root,'unavailable','vault')}));
 const script=[
 `(async()=>{for(let i=0;i<150;i++){let s=window.__pet();if(s.dataAvatar&&!s.loading&&!document.getElementById('dialogueOverlay').hidden&&document.getElementById('hint').classList.contains('hidden'))return {ready:true};await new Promise(r=>setTimeout(r,100));}throw Error('bunny not ready')})()`,
 `(async()=>{let point=window.__regionPoint('head'),el=document.elementFromPoint(point.x,point.y);if(!el?.closest('#dialogueOverlay')){const r=document.getElementById('dialogueOverlay').getBoundingClientRect();return {wrongTarget:true,point,target:el?.id,rect:{x:r.x,y:r.y,w:r.width,h:r.height},mode:document.getElementById('dialogueBtn').dataset.mode}};el.setPointerCapture=()=>{};let p={bubbles:true,cancelable:true,button:0,pointerId:1,clientX:point.x,clientY:point.y,screenX:point.x,screenY:point.y};el.dispatchEvent(new PointerEvent('pointerdown',p));window.dispatchEvent(new PointerEvent('pointerup',p));await new Promise(r=>setTimeout(r,500));let s=await pet.panelInit();return {throughDialogue:s.body.recentActions.at(-1)?.reason==='touch',target:el.id}})()`,
 ];
 fs.writeFileSync(path.join(root,'selftest.json'),JSON.stringify({shotDir:path.join(root,'shots'),delay:5000,every:500,extra:0,script}));
 const env={...process.env,BUDDY_PET_HOME:root};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(path.resolve('node_modules/.bin/electron'),['.','--dev'],{env,stdio:'ignore'}),timer=setTimeout(()=>child.kill('SIGTERM'),60000);
 try{
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
  const log=fs.readFileSync(path.join(root,'buddy.log'),'utf8');assert.equal(code,0,log.slice(-6000));
  assert(log.includes('"ready":true'),log.slice(-6000));assert(log.includes('"throughDialogue":true'),log.slice(-6000));
  assert(!log.includes('[selftest] fail'),log.slice(-6000));console.log('Built-in animated bunny receives a touch through the front dialogue layer.');
 }finally{clearTimeout(timer);fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1});
