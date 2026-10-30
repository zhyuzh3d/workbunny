'use strict';
// Signed bundle, isolated settings and inaccessible-storage recovery. No live
// memory is opened, no Keychain/permission requests, and no LLM is called.
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),assert=require('assert/strict'),{spawn}=require('child_process');
const {wav}=require('../src/main/qwen-runtime'),P=require('../src/main/tts-http-profile');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-packaged-')),shots=path.join(root,'shots');
 const library=require('../src/main/asset-library');library.setRoot(root);
 const personalSource=path.join(root,'我的伙伴.vrm');fs.copyFileSync('src/renderer/assets/models/AvatarSample_D.vrm',personalSource);
 const personalKey=library.importModel(personalSource);
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('Content-Type','audio/wav');res.end(wav(Buffer.alloc(4800)));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=P.template('binary');profile.url=`http://127.0.0.1:${server.address().port}/tts`;
 const cfg={voice:{alwaysListen:false},memory:{extract:false},tts:{enabled:true,engine:'system',http:{profile,secrets:{authorization:'Bearer synthetic-test'},params:{model:'fixture-model',voice:'fixture-voice'}}}};
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(cfg));fs.writeFileSync(path.join(root,'.no-restart'),'');
 fs.writeFileSync(path.join(root,'storage-location.json'),JSON.stringify({format:'workbunny-location/v1',dir:path.join(root,'missing-disk','vault')}));
 fs.writeFileSync(path.join(root,'selftest.json'),JSON.stringify({shotDir:shots,delay:5000,every:1400,extra:0,script:[
  'window.pet.panelInit().then(s=>({defaultHalfBody:s.config.window.scale===0.5,stockNames:s.avatars.filter(a=>!a.personal).map(a=>a.label)}))',
  'window.pet.portability().then(s=>({storageBlocked:!s.storage.ok,asr:s.asrMode,connected:s.connection.ready}))',
  'window.pet.open("settings")',
  '@panel:settings:document.querySelector("[data-t=mouth]").click()',
  '@panel:settings:(()=>{const s=document.querySelector("[data-secret=authorization]");s.value="Bearer draft-test";const j=document.getElementById("httpProfile");j.value=JSON.stringify({...JSON.parse(j.value),body:{...JSON.parse(j.value).body,fixture:"safe"}});j.dispatchEvent(new Event("change"));return {draftSecretPreserved:document.querySelector("[data-secret=authorization]").value==="Bearer draft-test"}})()',
  '@panel:settings:document.getElementById("httpCatalog").click()',
  '@panel:settings:window.pet.panelInit().then(s=>({catalogKeptSystem:s.config.tts.engine==="system"}))',
  '@panel:settings:document.getElementById("httpSave").click()',
  '@panel:settings:window.pet.ttsTest().then(s=>({ok:s.ok,played:s.played,engine:s.engine}))',
  '({roles:window.__avatars(),clips:window.__pet().clips})',
  ...['D','E','F','G'].flatMap(role=>[`window.__avatar("AvatarSample_${role}.vrm")`, '({avatar:window.__pet().avatarKey,loaded:window.__pet().vrm,clips:window.__pet().clips})']),
  `window.pet.config({avatar:${JSON.stringify(personalKey)}})`, '({personalAvatar:window.__pet().avatarKey,personalLoaded:window.__pet().vrm&&document.getElementById("hint").classList.contains("hidden")})'
 ]}));
 const app=path.resolve('dist/workbunny.app/Contents/MacOS/workbunny'),env={...process.env,BUDDY_PET_HOME:root};delete env.ELECTRON_RUN_AS_NODE;
 let stderr='';const child=spawn(app,[],{env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>{stderr+=b.toString().slice(0,4000);});
 const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
 try{
  const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});clearTimeout(timer);
  const log=fs.readFileSync(path.join(root,'buddy.log'),'utf8');
  assert.equal(code,0,stderr);assert(log.includes('"defaultHalfBody":true'));assert(log.includes('["可可","阿雅","琪琪","美莉"]'));assert(log.includes('"storageBlocked":true'),log.slice(-4000));
  assert(log.includes('"draftSecretPreserved":true')&&log.includes('"catalogKeptSystem":true'),log.slice(-6000));
  assert(log.includes('"played":true')&&log.includes('"engine":"http"'),log.slice(-5000));
  assert(!log.includes('synthetic-test'));assert(!fs.existsSync(path.join(root,'vault','companion.db')));
  for (const role of ['D','E','F','G']) assert(log.includes(`"avatar":"AvatarSample_${role}.vrm","loaded":true`), 'role did not load: ' + role);
  assert(log.includes('"clips":18'), 'all motion resources should load');
  assert(log.includes('"personalLoaded":true')&&log.includes(personalKey),'personal file URL should load');
  assert(fs.readdirSync(shots).some(n=>n.endsWith('.png')));
  const restoredScript=`(async()=>{for(let i=0;i<75;i++){if(window.__pet?.().avatarKey===${JSON.stringify(personalKey)}&&window.__pet().vrm&&document.getElementById("hint").classList.contains("hidden"))return {personalRestored:true};await new Promise(r=>setTimeout(r,200));}throw new Error("personal avatar did not restore")})()`;
  fs.writeFileSync(path.join(root,'selftest.json'),JSON.stringify({shotDir:path.join(shots,'restart'),delay:3500,every:1000,extra:0,script:[restoredScript]}));
  const again=spawn(app,[],{env,stdio:'ignore'}),againTimer=setTimeout(()=>again.kill('SIGTERM'),25000);
  const againCode=await new Promise((r,j)=>{again.once('exit',r);again.once('error',j);});clearTimeout(againTimer);
  assert.equal(againCode,0);assert(fs.readFileSync(path.join(root,'buddy.log'),'utf8').includes('"personalRestored":true'),'personal avatar must survive a new process');
  console.log(JSON.stringify({ok:true,scope:'signed packaged entry + preload + HTTP synthesis + WebAudio completion + missing disk recovery',artifacts:root}));
 }finally{clearTimeout(timer);server.closeAllConnections();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
