'use strict';
// Signed application + actual VRM switching, using isolated settings and no Vault/LLM.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-avatar-picker-'));
  const config=require('../src/main/config');config.setPath(path.join(root,'config.json'));
  config.save({avatar:'AvatarSample_D.vrm',voice:{enabled:false,alwaysListen:false},tts:{enabled:false},memory:{extract:false}});
  const assets=require('../src/main/asset-library');assets.setRoot(root);
  const personal=path.join(root,'测试定制模型.vrm');fs.copyFileSync('src/renderer/assets/models/AvatarSample_D.vrm',personal);const key=assets.importModel(personal);
  fs.writeFileSync(path.join(root,'.no-restart'),'');
  fs.writeFileSync(path.join(root,'storage-location.json'),JSON.stringify({format:'workbunny-location/v1',dir:path.join(root,'unavailable','vault')}));
  const wait=(key,result)=>`(async()=>{for(let i=0;i<150;i++){const s=window.__pet();if(s.vrm&&!s.loading&&s.avatarKey===${JSON.stringify(key)})return ${result};await new Promise(r=>setTimeout(r,80));}throw Error('avatar switch timed out')})()`;
  const choose=key=>`@panel:settings:{const select=document.getElementById('avatarSelect');select.value=${JSON.stringify(key)};select.dispatchEvent(new Event('change'));}`;
  const script=[
    wait('AvatarSample_D.vrm','({ready:true})'),
    'window.pet.open("settings")',
    '@panel:settings:({allModels:document.getElementById("avatarSelect").options.length,initialBuiltin:document.getElementById("avatarSelect").value==="AvatarSample_D.vrm"})',
    choose(key),
    wait(key,'({dropdownLoaded:true})'),
    `@panel:settings:({dropdownCardSynced:document.querySelector('.avatarPick[aria-pressed="true"]')?.dataset.key===${JSON.stringify(key)}})`,
    choose('AvatarSample_D.vrm'),
    wait('AvatarSample_D.vrm','({builtinLoaded:true})'),
    '@panel:settings:document.querySelector(".avatarPick").click()',
    wait(key,'({cardLoaded:true})'),
    `@panel:settings:({cardPickerSynced:document.getElementById('avatarSelect').value===${JSON.stringify(key)}})`,
    'window.pet.config({avatar:"AvatarSample_Shino.vrm"})',
    wait('AvatarSample_Shino.vrm','({lanlanLoaded:true})'),
    '@panel:settings:({externalSynced:document.getElementById("avatarSelect").value==="AvatarSample_Shino.vrm",noStaleCard:!document.querySelector(".avatarPick[aria-pressed=true]")})',
  ];
  fs.writeFileSync(path.join(root,'selftest.json'),JSON.stringify({shotDir:path.join(root,'shots'),delay:4500,every:350,extra:0,script}));
  const env={...process.env,BUDDY_PET_HOME:root};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.resolve('dist/workbunny.app/Contents/MacOS/workbunny'),[],{env,stdio:'ignore'}),timer=setTimeout(()=>child.kill('SIGTERM'),60000);
  try{
    const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);}),log=fs.readFileSync(path.join(root,'buddy.log'),'utf8');
    assert.equal(code,0,log.slice(-6000));
    for(const marker of ['"ready":true','"allModels":6','"initialBuiltin":true','"dropdownLoaded":true','"dropdownCardSynced":true','"builtinLoaded":true','"cardLoaded":true','"cardPickerSynced":true','"lanlanLoaded":true','"externalSynced":true','"noStaleCard":true'])assert(log.includes(marker),marker+'\n'+log.slice(-7000));
    assert(!log.includes('[selftest] fail'));console.log(JSON.stringify({ok:true,scope:'real model dropdown + card selection + external config + VRM playback',artifacts:root}));
  }finally{clearTimeout(timer);}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
