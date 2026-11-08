'use strict';
// Hidden production renderer/preload, isolated data and stub IPC. Never opens a
// browser URL or touches the system mouse, live app, or user's task records.
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const config=require('../src/main/config'),avatars=require('../src/main/avatars'),{taskPresentation}=require('../src/main/task-presentation');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-result-links-ui-')),url='https://example.com/game?sharecode=a%2Fb%2Bc&mode=kids#level-10',text='10关游戏已做好。\n'+url,links=[{url}],opened=[];let win;
app.setPath('userData',path.join(root,'electron'));config.setPath(path.join(root,'config.json'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),evaluate=s=>win.webContents.executeJavaScript(s,true);
async function until(check){for(let i=0;i<100;i++){if(await evaluate(check))return;await sleep(60);}throw Error('result-link UI timeout: '+check);}
async function run(){
 await app.whenReady();config.save({voice:{enabled:false,alwaysListen:false},tts:{enabled:false},memory:{enabled:true,scene:'life'},ui:{dialogueVisible:true}});
 ipcMain.handle('pet:init',()=>({config:config.publicConfig(),avatars:avatars.scan(),avatar:'AvatarSample_E.vrm',motions:[],versions:{app:'fixture'},agent:{tasks:[]},desktop:{running:false,task:null}}));
 ipcMain.handle('pet:config',(_e,p)=>config.publicConfig(config.save(p)));ipcMain.handle('pet:asr-status',()=>({speech:0,mic:false}));ipcMain.handle('pet:activity-expanded',()=>({ok:true}));
 ipcMain.handle('pet:dialogue-history',()=>({scene:'life',rows:[{id:'saved-report',ts:Date.now(),role:'assistant',text,taskId:'task',links}],more:false}));
 ipcMain.handle('pet:agent-result-link',(_e,value)=>{opened.push(value);return {ok:true};});
 win=new BrowserWindow({show:false,width:640,height:850,webPreferences:{preload:path.resolve('src/preload.js'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});await win.loadFile(path.resolve('src/renderer/index.html'));await until('!!window.__act && !!window.__pet');
 await until('!!document.querySelector("#dialogueMessages .result-link")');assert.equal(await evaluate('document.querySelector("#dialogueMessages .result-link").textContent'),url);await evaluate('document.querySelector("#dialogueMessages .result-link").click()');
 win.webContents.send('pet:ev',{type:'chat',role:'assistant',text,taskId:'task',links,final:true});await until('!!document.querySelector("#bubbleText .result-link")');assert.equal(await evaluate('document.querySelector("#bubbleText .result-link").textContent'),url);await evaluate('document.querySelector("#bubbleText .result-link").click()');
 const task={id:'task',skill:'work.delegate',goal:'制作并发布游戏',status:'completed',createdAt:Date.now(),updatedAt:Date.now(),state:{},result:{summary:'10关游戏已做好。',text,links,artifacts:[]}};task.presentation=taskPresentation(task);win.webContents.send('pet:ev',{type:'agent',tasks:[task]});await until('window.__act().keys.includes("agent#task")');await evaluate('document.getElementById("activity").click()');await until('!!document.querySelector("#activityTaskCard .task-card-links .result-link")');
 assert.equal(await evaluate('document.querySelector("#activityTaskCard [data-details-key=result]").open'),false,'the link is usable without expanding raw result text');await evaluate('document.querySelector("#activityTaskCard .task-card-links .result-link").click()');await sleep(100);assert.equal(opened.length,3);for(const call of opened)assert.deepEqual(call,{id:'task',index:0});
 const visible=await evaluate('(()=>{const b=document.querySelector("#activityTaskCard .result-link"),r=b.getBoundingClientRect();return {width:r.width,height:r.height,viewport:innerWidth};})()');assert(visible.height>0&&visible.width<=visible.viewport);fs.writeFileSync(path.join(root,'result-links.png'),(await win.webContents.capturePage()).toPNG());console.log(JSON.stringify({passed:true,hiddenProductionRenderer:true,dialogueHistory:true,completionBubble:true,taskCard:true,exactQueryPreserved:true,opensByTaskAndIndex:true,evidenceDirectory:root}));
}
run().then(()=>{win?.destroy();app.exit(0);},error=>{console.error(error.stack);console.error(JSON.stringify({root}));win?.destroy();app.exit(1);});
