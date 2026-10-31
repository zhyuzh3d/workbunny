'use strict';
const {app,BrowserWindow,nativeImage}=require('electron'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-lighting-test-'));app.setPath('userData',path.join(temporary,'electron'));
let lab,win;const errors=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const run=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){throw Error(code+'\n'+error.message+'\n'+errors.join(';'));}};
async function waitFor(code){for(let i=0;i<120;i++){if(await run(code))return;await delay(100);}throw Error('Timed out: '+code+' '+errors.join(';'));}
async function main(){
  await app.whenReady();lab=await require('../tools/lighting-lab/server.cjs').createLightingServer({port:0,storageDirectory:path.join(temporary,'saved')});
  win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
  await win.loadURL(lab.url);await waitFor('window.__lightingLab?.state().ready && !window.__lightingLab.state().loading');
  assert.equal((await run('window.__lightingLab.state()')).model,'AvatarSample_D.vrm');
  assert.equal((await run('window.__lightingLab.state()')).lighting.ambient.intensity,1.55);
  const before=nativeImage.createFromDataURL(await run('window.__lightingLab.capture()')).toBitmap();
  await run('document.querySelector("[data-path=multiplier][type=range]").value="0.2";document.querySelector("[data-path=multiplier][type=range]").dispatchEvent(new Event("input",{bubbles:true}))');
  await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  assert.equal((await run('window.__lightingLab.state()')).lighting.multiplier,.2);
  const after=nativeImage.createFromDataURL(await run('window.__lightingLab.capture()')).toBitmap();let changed=0;for(let i=0;i<before.length;i+=4)if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])>20)changed++;
  assert(changed>2000,'controls must visibly change real model rendering');
  await run('document.getElementById("model").value="AvatarSample_E.vrm";document.getElementById("model").dispatchEvent(new Event("change"))');
  await waitFor('window.__lightingLab.state().model==="AvatarSample_E.vrm"&&!window.__lightingLab.state().loading');
  assert.equal((await run('window.__lightingLab.state()')).lighting.ambient.intensity,2.21);
  await run('document.getElementById("model").value="AvatarSample_D.vrm";document.getElementById("model").dispatchEvent(new Event("change"))');
  await waitFor('window.__lightingLab.state().model==="AvatarSample_D.vrm"&&!window.__lightingLab.state().loading');
  assert.equal((await run('window.__lightingLab.state()')).lighting.multiplier,.2,'per-avatar draft survives switching');
  await run('document.getElementById("compare").dispatchEvent(new KeyboardEvent("keydown",{key:" "}))');
  assert.equal((await run('window.__lightingLab.state()')).rendered.multiplier,.9);
  await run('document.getElementById("compare").dispatchEvent(new KeyboardEvent("keyup",{key:" "}))');
  assert.equal((await run('window.__lightingLab.state()')).rendered.multiplier,.2);
  await run(`{const input=document.querySelector('[data-path="lights.key.position.0"][type=number]');input.value='-2';input.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('save').click();}`);
  await waitFor('document.getElementById("status").textContent.includes("参数已保存")');
  const saved=JSON.parse(fs.readFileSync(lab.file));assert.equal(saved.profiles['AvatarSample_D.vrm'].lighting.multiplier,.2);assert.equal(saved.profiles['AvatarSample_D.vrm'].lighting.lights.key.position[0],-2);assert.equal(saved.revision,1);
  const response=await fetch(lab.url+'/api/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(saved)});assert.equal(response.status,200);
  const stale=await fetch(lab.url+'/api/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(saved)});assert.equal(stale.status,409);
  assert.equal((await fetch(lab.url+'/../../src/main/config.js')).status,404,'never serve app configuration or unrelated files');
  for(const type of ['point','spot','directional']){
    await run(`{const type=document.querySelector('[data-path="lights.key.type"]');type.value='${type}';type.dispatchEvent(new Event('change',{bubbles:true}));const shadows=document.querySelector('[data-path="shadows.enabled"]');shadows.checked=true;shadows.dispatchEvent(new Event('change',{bubbles:true}));}`);
    const result=await run('window.__lightingLab.capture()');assert(result.startsWith('data:image/png'));
    assert.equal((await run('window.__lightingLab.state()')).lighting.lights.key.type,type);
  }
  await run(`{const shadows=document.querySelector('[data-path="shadows.enabled"]');shadows.checked=false;shadows.dispatchEvent(new Event('change',{bubbles:true}));}`);
  for(const model of ['AvatarSample_F.vrm','AvatarSample_G.vrm']){
    await run(`document.getElementById('model').value='${model}';document.getElementById('model').dispatchEvent(new Event('change'))`);
    await waitFor(`window.__lightingLab.state().model==='${model}'&&!window.__lightingLab.state().loading`);
    assert((await run('window.__lightingLab.capture()')).startsWith('data:image/png'));
  }
  await run(`(async()=>{const data=await fetch('/assets/models/AvatarSample_D.vrm').then(r=>r.blob());const transfer=new DataTransfer();transfer.items.add(new File([data],'测试模型.vrm'));const input=document.getElementById('vrmFile');input.files=transfer.files;input.dispatchEvent(new Event('change'));})()`);
  await waitFor(`window.__lightingLab.state().model.startsWith('custom:')&&!window.__lightingLab.state().loading`);
  await run(`{const data={format:'workbunny-lighting/v1',profiles:{[window.__lightingLab.state().model]:{label:'测试模型',lighting:{multiplier:.75}}}};const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(data)],'settings.json'));const input=document.getElementById('settingsFile');input.files=transfer.files;input.dispatchEvent(new Event('change'));}`);
  await waitFor('window.__lightingLab.state().lighting.multiplier===.75');
  assert.equal(errors.length,0,errors.join(';'));
  await run('document.querySelector("[data-path=multiplier][type=range]").value="1";document.querySelector("[data-path=multiplier][type=range]").dispatchEvent(new Event("input",{bubbles:true}))');
  await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  fs.writeFileSync(path.resolve('.cache/lighting-lab-ui.png'),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ok:true,changedPixels:changed,scope:'four real VRMs + GPU lighting + lamp types/shadows + per-model profiles + compare + save + revision/path isolation + custom VRM/JSON import'}));
}
main().then(()=>finish(0),e=>{console.error(e.stack);finish(1);});
async function finish(code){if(win&&!win.isDestroyed())win.destroy();if(lab)await lab.close();fs.rmSync(temporary,{recursive:true,force:true});app.exit(code);}
