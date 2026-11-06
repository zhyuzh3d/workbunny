'use strict';
// Actual main renderer/preload/CSS with controlled activity events. No external
// software is operated; these are view acceptance scenarios, not live watches.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const config=require('../src/main/config'),avatars=require('../src/main/avatars'),{taskPresentation}=require('../src/main/task-presentation');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-activity-ui-'));app.setPath('userData',path.join(root,'electron'));config.setPath(path.join(root,'config.json'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let win;const errors=[],opened=[],stops=[],controls=[],expansions=[];
const evaluate=s=>win.webContents.executeJavaScript(s,true);
async function until(s){for(let i=0;i<100;i++){if(await evaluate(s))return;await sleep(100);}throw Error('UI timeout: '+s);}
async function send(type,data){win.webContents.send('pet:ev',{type,...data});await sleep(120);}
async function run(){
 await app.whenReady();config.save({voice:{enabled:false,alwaysListen:false},tts:{enabled:false},memory:{enabled:false}});
 ipcMain.handle('pet:init',()=>({config:config.publicConfig(),avatars:avatars.scan(),avatar:'AvatarSample_E.vrm',motions:[],versions:{app:'0.18.0'},agent:{tasks:[]},desktop:{running:false,task:null}}));
 ipcMain.handle('pet:config',(_e,p)=>config.publicConfig(config.save(p)));ipcMain.handle('pet:asr-status',()=>({speech:0,mic:false}));ipcMain.handle('pet:dialogue-history',()=>({rows:[]}));
 ipcMain.handle('pet:activity-control',(_e,{operation,ref})=>{if(operation==='stop')stops.push(ref);else controls.push({operation,ref});return {ok:true};});
 ipcMain.handle('pet:activity-expanded',(_e,open)=>{expansions.push(open);return {ok:true};});
 ipcMain.on('pet:open',(_e,page)=>opened.push(page));
 win=new BrowserWindow({show:false,width:600,height:800,webPreferences:{preload:path.resolve('src/preload.js'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 win.webContents.on('console-message',entry=>{if(entry.level==='error')errors.push(entry.message);});
 await win.loadFile(path.resolve('src/renderer/index.html'));await until('!!window.__act && !!window.__pet');await sleep(350);
 const task=(id,skill,goal,extra={})=>{const t={id,skill,goal,status:'waiting',createdAt:Date.now(),state:{},...extra};return {...t,presentation:taskPresentation(t)};};
 const monitor=task('monitor','screen.watch','监看微信',{subjects:[{application:'wechat'}]});
 const delegated=task('delegated','work.delegate','制作周报',{workJobId:'physical',state:{job:{}}});
 const tasks=[monitor,delegated,...Array.from({length:3},(_,i)=>task('other'+i,'screen.watch','观察项目'+i,{subjects:[{application:'workbuddy'}]}))];
 await send('agent',{tasks});await send('desktop',{running:true,task:{id:'physical',target:'workbuddy',status:'monitoring',sources:['delegated']}});
 await send('monitor',{tasks:[{sessionId:'session',taskId:1,bunnyTaskId:'physical',status:'running',name:'制作周报'}]});
 assert.equal((await evaluate('window.__act()')).keys.length,5);assert.equal(await evaluate('document.querySelector("#actDone").textContent'),'×');
 const activityIcon='document.querySelector("#activity img")';
 await until(`${activityIcon}.src.endsWith("/res/trayTemplate.svg") && ${activityIcon}.complete && ${activityIcon}.naturalWidth > 0`);
 await evaluate('document.querySelector("#actDone").click()');await sleep(50);assert.deepEqual(stops,[{source:'agent',id:'monitor'}]);assert.deepEqual(opened,[]);
 await evaluate('document.querySelector("#activity").dispatchEvent(new PointerEvent("pointerenter"))');
 const before=await evaluate('window.__act().idx');await sleep(4200);assert.equal(await evaluate('window.__act().idx'),before);
 await evaluate('document.querySelector("#activity").dispatchEvent(new WheelEvent("wheel",{deltaY:100,cancelable:true}))');assert.equal(await evaluate('window.__act().idx'),1);assert.match(await evaluate('window.__act().text'),/^2\/5/u);
 await until(`${activityIcon}.src.endsWith("/assets/icons/workbuddy-logo.png") && ${activityIcon}.complete && ${activityIcon}.naturalWidth > 0`);
 await evaluate('document.querySelector("#activity").click()');assert.deepEqual(opened,[]);assert.equal(await evaluate('document.querySelector("#activityDetails").hidden'),false);const selected=await evaluate('window.__act().keys[window.__act().idx]');await evaluate('document.querySelector("#activity").dispatchEvent(new PointerEvent("pointerleave"))');await sleep(4200);assert.equal(await evaluate('window.__act().keys[window.__act().idx]'),selected);await evaluate('document.querySelector("#activityNext").click()');assert.equal(await evaluate('window.__act().idx'),2);await evaluate('document.querySelector("#activityPrevious").click()');assert.equal(await evaluate('window.__act().idx'),1);await evaluate('document.querySelector("#activityTaskCard [data-operation=pause]").click()');await sleep(100);assert.equal(controls.at(-1).operation,'pause');assert.equal(controls.at(-1).ref.id,'delegated');fs.writeFileSync(path.join(root,'expanded-task.png'),(await win.webContents.capturePage()).toPNG(),{mode:0o600});await evaluate('document.querySelector("#activityCollapse").click()');assert.equal(await evaluate('document.querySelector("#activityDetails").hidden'),true);assert.deepEqual(expansions,[true,false]);
 await evaluate('document.querySelector("#activity").dispatchEvent(new PointerEvent("pointerleave"))');await sleep(4200);assert.equal(await evaluate('window.__act().idx'),2);
 fs.writeFileSync(path.join(root,'rolling-tasks.png'),(await win.webContents.capturePage()).toPNG(),{mode:0o600});
 await send('desktop',{running:false,task:null});await send('monitor',{tasks:[]});
 const done=task('finished','work.delegate','生成总结',{status:'completed',updatedAt:Date.now(),state:{result:{summary:'完成'}}});await send('agent',{tasks:[done]});
 assert.equal(await evaluate('getComputedStyle(document.querySelector("#actDone")).display'),'grid');assert.equal(await evaluate('document.querySelector("#actDone").textContent'),'✓');
 await evaluate('document.querySelector("#actDone").click()');assert.equal(await evaluate('window.__act().keys.length'),0);await send('agent',{tasks:[{...done,id:'expiry'}]});
 await until('window.__act().text === "空闲中"');assert.equal(await evaluate('getComputedStyle(document.querySelector("#actDone")).display'),'none');
 await until(`${activityIcon}.src.endsWith("/res/trayTemplate.svg") && getComputedStyle(${activityIcon}).filter === "grayscale(1)" && Number(getComputedStyle(${activityIcon}).opacity) < 0.6`);
 const blocked=task('attention','conversation.manage','持续照看Alice的来信并结合上下文回复',{status:'needs_attention',subjects:[{application:'wechat',recipient:'Alice'}],note:'发送后暂未看清完整气泡。',operations:{send:{effect:'write',status:'intent',tool:'conversation.send'}},state:{conversationProgress:{phase:'submitted'}}});await send('agent',{tasks:[blocked]});await evaluate('document.querySelector("#activity").click()');assert.equal(await evaluate('document.querySelector("#activityDetails").hidden'),false);assert((await evaluate('document.querySelector("#activityTaskCard").textContent')).includes('核对并继续'));await evaluate('document.querySelector("#activityTaskCard [data-operation=resolve]").click()');await sleep(100);assert.equal(controls.at(-1).operation,'resolve');assert.equal(controls.at(-1).ref.id,'attention');await sleep(400);fs.writeFileSync(path.join(root,'attention-task.png'),(await win.webContents.capturePage()).toPNG(),{mode:0o600});await evaluate('document.querySelector("#activityCollapse").click()');
 await send('agent',{tasks:[delegated]});
 await until(`${activityIcon}.src.endsWith("/assets/icons/workbuddy-logo.png")`);
 await send('toast',{text:'临时提示'});
 await until(`${activityIcon}.src.endsWith("/res/trayTemplate.svg")`);
 assert.equal(errors.length,0,errors.join('\n'));console.log(JSON.stringify({passed:true,realRenderer:true,fixtureOnly:true,fiveTasks:true,deduplicated:true,wheel:true,hoverPause:true,automaticRotation:true,completionExpires:true,expandedCard:true,manualPreviousNext:true,rollPausedWhileExpanded:true,inlinePause:true,evidenceDirectory:root}));
}
run().then(()=>app.exit(0),e=>{console.error(e.stack);console.error(JSON.stringify({root,errors}));app.exit(1);});
