'use strict';
// Real product renderer + preload; controlled task data, no WeChat interaction.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-agent-ui-'));fs.chmodSync(root,0o700);app.setPath('userData',path.join(root,'electron'));
let win;const errors=[],calls=[];const status={tasks:[],skills:[{id:'conversation.manage',title:'会话代管',description:'按上下文交流，持续跟进主人目标。',version:1}]};
const{taskPresentation}=require('../src/main/task-presentation');const publicStatus=()=>({...status,tasks:status.tasks.map(t=>({...t,presentation:taskPresentation(t)}))});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){
 await app.whenReady();
 ipcMain.handle('pet:init',()=>({config:{buddy:{name:'Bunny'}},monitor:{running:[],done:[]},agent:publicStatus()}));
 ipcMain.handle('pet:task-status',()=>({running:false,permissions:{screenCaptureAllowed:true},task:null}));
 ipcMain.handle('pet:autonomy-status',()=>({paused:true,note:'校准测试',history:[]}));
 ipcMain.handle('pet:agent-status',()=>publicStatus());
 ipcMain.handle('pet:agent-artifact',(_e,value)=>{calls.push({type:'artifact',...value});return {ok:true};});
 ipcMain.handle('pet:agent-command',(_e,text)=>{calls.push({type:'command',text});status.tasks.push({id:'test-1',goal:'照看 Alice 的消息',subjects:[{application:'wechat',recipient:'Alice'}],status:'waiting',note:'等待新动态，保留已有上下文',schedule:{intervalSeconds:60},queuedEvents:0});return {ok:true,text:'已接到任务。'};});
 ipcMain.handle('pet:agent-control',(_e,value)=>{calls.push(value);const task=status.tasks.find(t=>t.id===value.id);if(task&&value.operation==='resolve'){task.state.recoveryRequestedAt=Date.now();return {ok:true,pending:true,message:'已安排核对，电脑空闲后自动处理。'};}if(task)task.status=value.operation==='pause'?'paused':value.operation==='stop'?'stopped':'waiting';return {ok:true};});
 win=new BrowserWindow({show:false,width:1020,height:900,webPreferences:{preload:path.resolve('src/preload.js'),contextIsolation:true,sandbox:false}});
 win.webContents.on('console-message',entry=>{if(entry.level==='error')errors.push(entry.message);});
 await win.loadFile(path.resolve('src/renderer/companion.html'),{query:{p:'desktop'}});await sleep(900);
 assert.equal(await win.webContents.executeJavaScript('document.querySelector("#desktopPage").hidden'),false);
 await win.webContents.executeJavaScript('document.querySelector("#agentCommand").value="帮我照看 Alice 的消息，按前文回复，广告忽略。";document.querySelector("#agentSubmit").click()');await sleep(200);
 assert.equal(calls.filter(c=>c.type==='command').length,1);assert((await win.webContents.executeJavaScript('document.querySelector("#agentTaskList").textContent')).includes('Alice'));
 await win.webContents.executeJavaScript('[...document.querySelectorAll("#agentTaskList button")].find(b=>b.textContent==="暂停").click()');await sleep(100);
 assert((await win.webContents.executeJavaScript('document.querySelector("#agentTaskList").textContent')).includes('已暂停'));
 await win.webContents.executeJavaScript('[...document.querySelectorAll("#agentTaskList button")].find(b=>b.textContent==="继续任务").click()');await sleep(100);
 assert.equal(status.tasks[0].status,'waiting');
 await win.webContents.executeJavaScript('document.querySelector("[data-desktop-tab=skills]").click()');
 assert((await win.webContents.executeJavaScript('document.querySelector("#agentSkillList").textContent')).includes('会话代管'));
 await win.webContents.executeJavaScript('document.querySelector("[data-desktop-tab=current]").click()');
 fs.writeFileSync(path.join(root,'tasks.png'),(await win.webContents.capturePage()).toPNG(),{mode:0o600});
 await win.webContents.executeJavaScript('[...document.querySelectorAll("#agentTaskList button")].find(b=>b.textContent==="停止任务").click()');await sleep(100);
 assert.equal(status.tasks[0].status,'stopped');status.tasks[0].result={summary:'已生成清单',text:'实际完整答复，三项清单。',artifacts:[{path:'/tmp/result.txt'}]};status.tasks[0].delivery={channel:'wechat',recipient:'Alice',status:'delivered'};
 win.webContents.send('pet:ev',{type:'agent',...publicStatus()});await sleep(100);
 assert((await win.webContents.executeJavaScript('document.querySelector("#agentTaskList").textContent')).includes('已交付 · 微信 Alice'));
 await win.webContents.executeJavaScript('[...document.querySelectorAll("#agentTaskList button")].find(b=>b.textContent==="result.txt").click()');await sleep(50);assert.equal(calls.filter(c=>c.type==='artifact').length,1);
 assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.querySelector("#agentTaskList")).maxHeight'),'none');assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.querySelector("#agentSkillList")).overflowY'),'visible');assert.equal(await win.webContents.executeJavaScript('document.querySelector("#agentRefresh").closest(".tracking-heading")!==null'),true);assert.equal(await win.webContents.executeJavaScript('document.querySelector("#desktopPage h1").textContent'),'任务与工作');assert.equal(await win.webContents.executeJavaScript('document.querySelector("label[for=agentCommand]")'),null);
 status.capacity={limit:5,active:5,queued:1};for(let i=0;i<4;i++)status.tasks.push({id:'watch-'+i,skill:'screen.watch',goal:'检查项目页面 '+i,subjects:[{application:'workbuddy'}],status:'waiting',note:'保持观察，画面变化后判断条件。',schedule:{intervalSeconds:5},state:{}});
 const attention={id:'attention',skill:'conversation.manage',title:'照看Alice的微信消息',goal:'持续照看Alice的新消息，结合上下文简短回复，忽略广告。',subjects:[{application:'wechat',recipient:'Alice'}],status:'needs_attention',note:'截图暂未确认发送后的完整气泡。',queuedEvents:1,schedule:{intervalSeconds:5},state:{conversationProgress:{phase:'submitted'}},operations:{send:{effect:'write',status:'intent',tool:'conversation.send'}}};status.tasks.push(attention,{id:'queued',skill:'screen.watch',goal:'观察另一项目页面',subjects:[{application:'workbuddy'}],status:'queued',note:'任务额度已满，等待手动启动',schedule:{intervalSeconds:5},state:{}});
 win.webContents.send('pet:ev',{type:'agent',...publicStatus()});await sleep(100);await win.webContents.executeJavaScript('document.querySelector("[data-desktop-tab=current]").click()');
 assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.querySelector("#agentTaskList")).overflowY'),'visible');assert(await win.webContents.executeJavaScript('document.querySelector(".desktop-main").scrollHeight>document.querySelector(".desktop-main").clientHeight'));
 const blockedText=await win.webContents.executeJavaScript('document.querySelector("[data-task-id=attention]").textContent');assert(blockedText.includes('发送结果待确认'));assert(blockedText.includes('核对并继续'));assert(!blockedText.includes('只读核对'));
 await win.webContents.executeJavaScript('document.querySelector("[data-task-id=attention] [data-operation=resolve]").click()');await sleep(100);assert.equal(calls.at(-1).operation,'resolve');assert.equal(calls.at(-1).id,'attention');assert((await win.webContents.executeJavaScript('document.querySelector("[data-task-id=attention]").textContent')).includes('等待空闲后核对'));
 fs.writeFileSync(path.join(root,'task-panel-immersive.png'),(await win.webContents.capturePage()).toPNG(),{mode:0o600});
 assert.equal(errors.length,0,errors.join('\n'));
 console.log(JSON.stringify({passed:true,naturalLanguageEntry:true,pauseResumeStop:true,skillCatalog:true,rendererErrors:errors,evidenceDirectory:root,actualWeChatUsed:false}));
}
run().then(()=>finish(0),error=>{console.error(error.stack);return finish(1);});
async function finish(code){win?.destroy();app.exit(code);}
