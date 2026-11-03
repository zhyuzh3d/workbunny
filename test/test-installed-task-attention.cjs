'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{connect}=require('./installed-agent-driver.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms)),root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-installed-attention-'));fs.chmodSync(root,0o700);let main,desktop,settings,id;
async function tabs(){return(await(await fetch('http://127.0.0.1:9227/json')).json()).filter(t=>t.url.startsWith('file:///Users/zhyuzh/Applications/workbunny.app/'));}
async function until(fn,label,timeout=100000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await wait(500);}throw Error('Timeout: '+label);}
async function shot(c,name){const value=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,name+'.png'),Buffer.from(value.data,'base64'),{mode:0o600});}
async function run(){
 const list=await tabs();main=await connect(list.find(t=>t.url.endsWith('/index.html')));desktop=await connect(list.find(t=>t.url.includes('companion.html')&&t.url.includes('desktop')));
 const init=await main.evaluate('pet.init()');assert.equal(init.versions.app,require('../package.json').version);if(init.config.software.terminal)throw Error('Owner already enabled terminal; do not manufacture a permission blocker');
 await until(async()=>!(await desktop.evaluate('pet.agentStatus()')).restoring,'restore');const before=new Set((await desktop.evaluate('pet.agentStatus()')).tasks.map(t=>t.id));
 const command='请让Bunny自己用终端执行 /usr/bin/printf BUNNY_PERMISSION_UI_TEST，只测试非破坏性终端授权引导。如果产品终端开关尚未开启，就弹出授权指引并等待，不要自动修改开关或绕过授权。不要交给WorkBuddy。';
 await desktop.evaluate('pet.agentCommand('+JSON.stringify(command)+')');
 const task=await until(async()=>{const s=await desktop.evaluate('pet.agentStatus()'),t=s.tasks.find(t=>!before.has(t.id));if(!t)return;if(t.status==='completed')throw Error('Permission task unexpectedly completed');id=t.id;return t.status==='waiting_permission'?t:null;},'actual permission wait');
 assert.equal(task.presentation.guidance.primaryLabel,'打开授权指引');assert.equal(task.counters.writes,0);
 await main.evaluate('document.querySelector("#activity").dispatchEvent(new PointerEvent("pointerenter"))');
 await until(async()=>{const a=await main.evaluate('window.__act()');if(a.keys[a.idx]==='agent#'+id)return true;await main.evaluate('document.querySelector("#activity").dispatchEvent(new WheelEvent("wheel",{deltaY:100,cancelable:true}))');},'selected permission task',10000);
 await main.evaluate('document.querySelector("#activity").click()');await wait(350);assert.equal(await main.evaluate('document.querySelector("#activityDetails").hidden'),false);
 assert((await main.evaluate('document.querySelector("#activityTaskCard").textContent')).includes('打开授权指引'));await shot(main,'real-task-expanded');
 await main.evaluate('document.querySelector("#activityTaskCard [data-operation=resolve]").click()');
 const page=await until(async()=>(await tabs()).find(t=>t.url.includes('panel.html')&&t.url.includes('settings')),'real permission guide',15000);settings=await connect(page);await wait(400);
 assert.equal(await settings.evaluate('document.querySelector("[data-software-capability=terminal]").checked'),false);assert.equal(await settings.evaluate('getComputedStyle(document.querySelector("[data-software-capability=terminal]")).width'),'36px');await shot(settings,'real-permission-guide');
 await main.evaluate('document.querySelector("#activityTaskCard [data-operation=stop]").click()');await until(async()=>((await desktop.evaluate('pet.agentStatus()')).tasks.find(t=>t.id===id)?.status==='stopped'),'stopped test task',10000);
 await until(async()=>!(await settings.evaluate('pet.panelInit()')).taskPermission,'stopped permission guide cleared',10000);
 await main.evaluate('document.querySelector("#activityCollapse").click()');const result={passed:true,id,root,actualInstalledClient:true,actualPermissionWait:true,actualInlineAction:true,ownerTerminalSwitchPreserved:true,terminalEnabledAfter:false,terminalWasNotExecuted:true,stoppedGuideCleared:true};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
}
run().catch(error=>{fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify({error:error.message,id}),{mode:0o600});console.error(JSON.stringify({error:error.message,root,id}));process.exitCode=1;}).finally(async()=>{if(id&&desktop)await desktop.evaluate('pet.agentControl("stop",'+JSON.stringify(id)+')').catch(()=>{});main?.close();desktop?.close();settings?.close();});
