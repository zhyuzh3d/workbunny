'use strict';
// Real application renderer/preload/VRMs; isolated settings, no account or voice calls.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const application=path.resolve(process.env.WORKBUNNY_LIGHTING_APP_ROOT||'.');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-lighting-app-'));
app.setPath('userData',path.join(temporary,'electron'));
const config=require(path.join(application,'src/main/config'));
config.setPath(path.join(temporary,'config.json'));
let win;const errors=[];
const evaluate=code=>win.webContents.executeJavaScript(code,true);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(key){for(let i=0;i<150;i++){const s=await evaluate('window.__pet?.()');if(s?.vrm&&!s.loading&&s.avatarKey===key&&s.clips>0)return;if(s?.bootErr)throw Error(s.bootErr);await delay(100);}throw Error('Model did not load: '+key+' '+errors.join(';'));}
async function main(){
  await app.whenReady();
  config.save({avatar:'AvatarSample_D.vrm',voice:{enabled:false,alwaysListen:false},tts:{enabled:false},memory:{enabled:false}});
  const avatars=require(path.join(application,'src/main/avatars')).scan().filter(a=>!a.personal);
  ipcMain.handle('pet:init',()=>({config:config.publicConfig(),avatars,avatar:avatars[0].key,motions:config.MOTIONS,motionGroups:config.MOTION_GROUPS,versions:{}}));
  ipcMain.handle('pet:config',(_event,patch)=>config.publicConfig(config.save(patch)));
  ipcMain.handle('pet:scale',(_event,value)=>value);
  ipcMain.handle('pet:asr-status',()=>({speech:0,mic:false}));
  win=new BrowserWindow({show:false,width:420,height:660,webPreferences:{preload:path.join(application,'src/preload.js'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadFile(path.join(application,'src/renderer/index.html'));
  const {lightingForAvatar}=await import(pathToFileURL(path.resolve('src/renderer/avatar-lighting-profiles.mjs')));
  const results=[];
  await waitFor(avatars[0].key);
  for(const model of [...avatars,avatars[0]]){
    await evaluate('window.__avatar('+JSON.stringify(model.key)+')');await waitFor(model.key);
    const light=await evaluate('window.__light()'),expected=lightingForAvatar(model.key,model.light);
    assert.deepEqual(light.profile,expected,model.label+': entire saved profile');
    assert.equal(light.ambient,Number((expected.ambient.intensity*expected.multiplier).toFixed(2)));
    assert.equal(light.key,Number((expected.lights.key.intensity*expected.multiplier).toFixed(2)));
    assert.equal((await evaluate('window.__pet()')).bootErr,null);
    if(process.env.WORKBUNNY_LIGHTING_SHOTS){fs.mkdirSync(process.env.WORKBUNNY_LIGHTING_SHOTS,{recursive:true});await delay(180);fs.writeFileSync(path.join(process.env.WORKBUNNY_LIGHTING_SHOTS,model.key+'.png'),(await win.webContents.capturePage()).toPNG());}
    results.push({model:model.label,ambient:light.ambient,key:light.key});
  }
  assert.equal(errors.length,0,errors.join(';'));console.log(JSON.stringify({ok:true,application,models:results}));
}
main().then(()=>finish(0),error=>{console.error(error.stack,errors);finish(1);});
function finish(code){if(win&&!win.isDestroyed())win.destroy();fs.rmSync(temporary,{recursive:true,force:true});app.exit(code);}
