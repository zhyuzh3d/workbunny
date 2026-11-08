'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'bunny-overlay-ui-'));
app.setPath('userData',path.join(tmp,'userData'));
const renderer = path.resolve('src/renderer'), out = path.resolve('.cache/ui-upgrade'); fs.mkdirSync(out,{recursive:true});
let cfg = {ui:{dialogueVisible:false,dialogueBehind:false},memory:{enabled:true,scene:'life'},buddy:{name:'Bunny',ownerName:'主人'}};
let messages = Array.from({length:450},(_,i)=>({id:String(i).padStart(4,'0'),ts:Date.UTC(2020,0,1)+Math.floor(i/2)*86400000,role:i%2?'assistant':'user',text:i===449?'这是最新的消息，消息层和底部控件保持同宽。':'历史对话 '+i+'。可以逐页向上浏览，也可以返回最新消息。',scene:i%3===0?'work':'life'}));
let delayNext=0, failNext=false, win, requests=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function event(value){win.webContents.send('fixture:event',value);}
function merge(patch){cfg={...cfg,ui:{...cfg.ui,...patch.ui},memory:{...cfg.memory,...patch.memory}};event({type:'config',config:cfg});return cfg;}
ipcMain.handle('fixture:api',async(_event,name,value)=>{
 if(name==='init')return cfg;
 if(name==='config')return merge(value);
 if(name==='page'){
  requests++;const scene=cfg.memory.scene,wait=delayNext;delayNext=0;
  const cursor=value.before||value.after,after=!!value.after;
  let visible=messages.filter(r=>scene==='life'||r.scene==='work');
  if(cursor)visible=visible.filter(r=>after?(r.ts>cursor.ts||r.ts===cursor.ts&&r.id>cursor.id):(r.ts<cursor.ts||r.ts===cursor.ts&&r.id<cursor.id));
  const rows=after?visible.slice(0,40):visible.slice(-40),key=r=>r?{ts:r.ts,id:r.id}:null;
  if(wait)await delay(wait);if(failNext){failNext=false;throw Error('fixture unavailable');}
  return {scene,rows,oldest:key(rows[0]),newest:key(rows.at(-1)),more:rows.length===40};
 }
});
fs.writeFileSync(path.join(tmp,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('pet',{init:()=>ipcRenderer.invoke('fixture:api','init'),config:v=>ipcRenderer.invoke('fixture:api','config',v),dialogueHistory:v=>ipcRenderer.invoke('fixture:api','page',v),on:cb=>ipcRenderer.on('fixture:event',(_e,v)=>cb(v))});`);
fs.writeFileSync(path.join(tmp,'boot.mjs'),`import {createDialogueOverlay} from ${JSON.stringify(pathToFileURL(path.join(renderer,'dialogue-overlay.mjs')).href)};import {createBubbleController} from ${JSON.stringify(pathToFileURL(path.join(renderer,'bubble-ui.mjs')).href)};window.testBubble=createBubbleController(document.getElementById('bubble'),document.getElementById('bubbleText'));window.overlay=createDialogueOverlay(window.pet,await pet.init());document.getElementById('fab').className='show';`);
let html=fs.readFileSync(path.join(renderer,'index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(renderer+'/').href+'">').replace('<script type="module" src="./app.js"></script>','<script type="module" src="'+pathToFileURL(path.join(tmp,'boot.mjs')).href+'"></script>');
fs.writeFileSync(path.join(tmp,'index.html'),html);
const evaluate=code=>win.webContents.executeJavaScript(code,true);
async function until(code,label){const end=Date.now()+6000;while(Date.now()<end){if(await evaluate(code))return;await delay(25);}throw Error('Timed out: '+label);}
const state=()=>evaluate('window.overlay.state');
async function snapshot(name){await delay(40);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());}
async function main(){
 await app.whenReady();win=new BrowserWindow({width:896,height:600,show:false,webPreferences:{preload:path.join(tmp,'preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=2)console.error(message);});
 await win.loadFile(path.join(tmp,'index.html'));await until('!!window.overlay','overlay initialized');assert.equal(requests,0);
 const ids = ['activity','ear','muteBtn','dialogueBtn','gearBtn','dock','sendBtn'];
 const colors = () => evaluate(`${JSON.stringify(ids)}.map(id=>getComputedStyle(document.getElementById(id)).backgroundColor)`);
 const original = await colors();
 merge({memory:{scene:'private'}}); await delay(350);
 assert.equal(await evaluate('document.body.classList.contains("private-scene")'),true);
 await evaluate('document.getElementById("ear").classList.add("on")'); await delay(350);
 (await colors()).forEach((color,i)=>{
  if(ids[i]==='sendBtn')assert.equal(color,original[i],'the primary action keeps the shared theme across scenes');
  else assert.notEqual(color,original[i],ids[i]+' has a private-scene background');
 });
 await evaluate('document.getElementById("ear").classList.remove("on")');
 merge({memory:{scene:'life'}}); await delay(350);
 assert.equal(await evaluate('document.body.classList.contains("private-scene")'),false);
 assert.deepEqual(await colors(),original);
 assert.equal(await evaluate('document.getElementById("dialogueBtn").dataset.mode'),'avatar');
 assert.equal(await evaluate('getComputedStyle(document.getElementById("stage")).visibility'),'visible');
 assert.equal(await evaluate('document.querySelector("#dialogueBtn .dialogue-mode-icon").tagName.toLowerCase()'), 'svg');

 await evaluate('document.getElementById("dialogueBtn").click()');await until('document.querySelector("[data-id=\\"0449\\"]")&&!window.overlay.state.loading','latest page');
 assert.equal(await evaluate('document.getElementById("dialogueBtn").dataset.mode'),'behind');
 await evaluate('testBubble.show("气泡正常说话",60000)');
 assert.equal(await evaluate('getComputedStyle(document.getElementById("bubble")).display!=="none"'),true,'speech bubble stays visible over behind mode');
 assert.equal(await evaluate('Number(getComputedStyle(document.getElementById("bubble")).zIndex)>Number(getComputedStyle(document.getElementById("dialogueOverlay")).zIndex)'),true);
 await evaluate('testBubble.hide()');

 await evaluate('document.getElementById("dialogueBtn").click()');await until('document.getElementById("dialogueBtn").dataset.mode==="front"','front mode');
 await evaluate('testBubble.appendDelta("正在说话")');
 assert.equal(await evaluate('getComputedStyle(document.getElementById("bubble")).display!=="none"'),true,'streaming bubble stays visible above front mode');
 assert.equal(await evaluate('Number(getComputedStyle(document.getElementById("bubble")).zIndex)>Number(getComputedStyle(document.getElementById("dialogueOverlay")).zIndex)'),true);
 await evaluate('testBubble.hide()');

 await evaluate('document.getElementById("dialogueBtn").click()');await until('document.getElementById("dialogueBtn").dataset.mode==="text"','text-only mode');
 assert.equal(await evaluate('getComputedStyle(document.getElementById("stage")).visibility'),'hidden');
 await evaluate('testBubble.finish("说完了",60000)');
 assert.equal(await evaluate('getComputedStyle(document.getElementById("bubble")).display!=="none"'),true,'speech bubble stays visible in text-only mode');
 await evaluate('testBubble.hide()');

 assert.equal(await evaluate('document.getElementById("dialogueOverlay").hidden'),false);
 await evaluate('document.getElementById("dialogueBtn").click()');await until('document.getElementById("dialogueBtn").dataset.mode==="avatar"','avatar-only mode');
 assert.equal(await evaluate('getComputedStyle(document.getElementById("stage")).visibility'),'visible');
 assert.equal(await evaluate('document.getElementById("dialogueOverlay").hidden'),true);
 await evaluate('document.getElementById("dialogueBtn").click()');await until('document.getElementById("dialogueBtn").dataset.mode==="behind" && document.querySelector("[data-id=\\"0449\\"]")&&!window.overlay.state.loading','cycle returns to behind');
 assert.equal(await evaluate('Math.abs(document.querySelector(".dialogue-message.assistant").getBoundingClientRect().left-document.getElementById("statusRow").getBoundingClientRect().left)<1'),true,'assistant text aligns to controls');
 assert.equal(await evaluate('Math.abs(document.querySelector(".dialogue-message.user .dialogue-speaker").getBoundingClientRect().right-document.getElementById("statusRow").getBoundingClientRect().right)<2'),true,'owner label aligns to right edge');
 assert.equal(await evaluate('document.getElementById("bubble").getBoundingClientRect().width'),0);
 assert.equal(await evaluate('document.getElementById("dialogueOverlay").getBoundingClientRect().width===document.getElementById("statusRow").getBoundingClientRect().width'),true);
 assert.equal(await evaluate('getComputedStyle(document.getElementById("dialogueOverlay")).backgroundColor'), 'rgba(0, 0, 0, 0)');
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".dialogue-message")).color'), 'rgb(255, 255, 255)');
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".dialogue-message")).textShadow.includes("0px 0px")'), false, 'shadow uses no blur');
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".dialogue-message.user")).textAlign'), 'left');
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".dialogue-message.user .dialogue-speaker")).textAlign'), 'right');
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".dialogue-message.user .dialogue-text")).textAlign'), 'left');
 assert((await evaluate('document.querySelector(".dialogue-message.user").getBoundingClientRect().left-document.querySelector(".dialogue-message.assistant").getBoundingClientRect().left'))>=35,'owner messages are indented as a block');
 const alignment=await evaluate(`(()=>{
   const message=document.querySelector('.dialogue-message.user'),body=message.querySelector('.dialogue-text'),old=body.textContent;
   const measure=value=>{body.textContent=value;const range=document.createRange();range.selectNodeContents(body);const lines=[...range.getClientRects()].map(r=>({left:r.left,right:r.right}));const box=message.getBoundingClientRect();return {lines,left:box.left,right:box.right};};
   const short=measure('好'),shortSentence=measure('这是一句简短的回复'),long=measure('这是一条比较长的主人消息，需要超过一行才能完整显示，换行之后也要整齐地从左边开始阅读。'.repeat(2));
   body.textContent=old;return {short,shortSentence,long};
 })()`);
 for(const result of [alignment.short,alignment.shortSentence]) {
   assert.equal(result.lines.length,1,'short messages fit on one line');
   assert(Math.abs(result.lines[0].right-result.right)<2,'single line ends at right edge');
 }
 assert(alignment.long.lines.length>1,'long message wraps');
 assert(Math.abs(alignment.long.lines[0].left-alignment.long.left)<2,'wrapped message starts at the indented left edge');
 assert(Math.abs(alignment.long.lines[1].left-alignment.long.left)<2,'wrapped lines remain left-aligned');

 await evaluate('document.getElementById("activity").classList.remove("hidden")');
 assert.equal(await evaluate('document.getElementById("dialogueOverlay").getBoundingClientRect().bottom <= document.getElementById("activity").getBoundingClientRect().top'),true,'message area clears WorkBuddy status');
 assert.equal(await evaluate('document.getElementById("dialogueOverlay").getBoundingClientRect().bottom <= document.getElementById("statusRow").getBoundingClientRect().top'),true,'message area clears microphone row');
 const withActivity=await evaluate('document.getElementById("dialogueOverlay").getBoundingClientRect().bottom');
 await evaluate('document.getElementById("activity").classList.add("hidden")');
 assert((await evaluate('document.getElementById("dialogueOverlay").getBoundingClientRect().bottom'))>withActivity,'space is reclaimed when status is hidden');
 await evaluate('document.getElementById("activity").classList.remove("hidden")');
 const closedBottom=await evaluate('document.getElementById("dialogueOverlay").getBoundingClientRect().bottom');
 await evaluate('document.getElementById("dock").classList.remove("hidden");document.body.classList.add("dialogue-input-open");dispatchEvent(new Event("dialogue-layout"))');
 assert.equal(await evaluate('document.getElementById("dialogueOverlay").getBoundingClientRect().bottom <= document.getElementById("dock").getBoundingClientRect().top'),true,'message area clears input');
 assert((await evaluate('document.getElementById("dialogueOverlay").getBoundingClientRect().bottom'))<closedBottom-30, 'input reserves space');
 assert.equal(await evaluate('(()=>{let s=document.getElementById("dialogueScroll");return s.scrollHeight-s.scrollTop-s.clientHeight<2})()'),true,'latest remains visible when input opens');
 await evaluate('document.getElementById("dock").classList.add("hidden");document.body.classList.remove("dialogue-input-open")');
 await snapshot('dialogue-latest');
 await evaluate(`document.body.style.setProperty('background','linear-gradient(120deg, #222831 0%, #4c5762 40%, #eee9e0 70%, #342c35 100%)','important')`);
 await snapshot('dialogue-mixed-background');
 await evaluate(`document.body.style.removeProperty('background')`);
 for(let i=0;i<12;i++){
  await evaluate('document.getElementById("dialogueScroll").scrollTop=0;document.getElementById("dialogueOlder").click()');await until('!window.overlay.state.loading','older page');
  assert((await state()).count<=120);
  if(!(await state()).topMore)break;
 }
 assert.equal(await evaluate('document.querySelector(".dialogue-message").dataset.id'),'0000');
 assert.equal(await evaluate('document.querySelector(".dialogue-date").textContent'),'2020年1月1日');
 assert.equal((await state()).bottomMore,true);
 event({type:'memory-changed'});await delay(250);assert.equal((await state()).pending,false,'task-only changes do not claim new messages');
 for(let i=0;i<12&&(await state()).bottomMore;i++){
  const first=await evaluate('document.querySelector(".dialogue-message").dataset.id');
  await evaluate('document.getElementById("dialogueScroll").scrollTop=999999');
  await until('!window.overlay.state.loading && (document.querySelector(".dialogue-message").dataset.id!=="'+first+'" || !window.overlay.state.bottomMore)','page newer');
 }
 assert.equal((await state()).bottomMore,false,'downward paging reaches latest');
 await evaluate('document.getElementById("dialogueScroll").scrollTop=0;document.getElementById("dialogueOlder").click()');await until('!window.overlay.state.loading','return to history');
 const oldText=await evaluate('document.getElementById("dialogueMessages").textContent');
 const add=()=>{const id=String(messages.length).padStart(4,'0');messages.push({id,ts:Date.now(),role:'assistant',text:'实时新消息 '+id,scene:'life'});event({type:'memory-changed'});return id;};
 const latest=add();await delay(250);assert.equal(await evaluate('document.getElementById("dialogueMessages").textContent'),oldText);assert.equal(await evaluate('document.getElementById("dialogueLatest").hidden'),false);
 await snapshot('dialogue-history-new');
 await evaluate('document.getElementById("dialogueLatest").click()');await until('document.querySelector("[data-id=\\"'+latest+'\\"]")&&!window.overlay.state.loading','jump latest');
 const live=add();await until('document.querySelector("[data-id=\\"'+live+'\\"]")&&!window.overlay.state.loading','live follow');
 assert.equal(await evaluate('document.getElementById("dialogueLatest").hidden'),true);
 assert.equal(await evaluate('(()=>{let s=document.getElementById("dialogueScroll");return s.scrollHeight-s.scrollTop-s.clientHeight<2})()'),true);
 delayNext=250;event({type:'memory-changed'});await delay(125);merge({memory:{scene:'work'}});await until('!window.overlay.state.loading&&!document.getElementById("dialogueMessages").textContent.includes("实时新消息")','scene swap');await delay(300);
 assert.equal(await evaluate('[...document.querySelectorAll(".dialogue-message")].every(e=>Number(e.dataset.id)%3===0)'),true);
 merge({ui:{dialogueBehind:true}});assert.equal(await evaluate('getComputedStyle(document.getElementById("dialogueOverlay")).zIndex'),'0');assert.equal(await evaluate('getComputedStyle(document.getElementById("stage")).pointerEvents'),'none');
 await snapshot('dialogue-behind');
 event({type:'dialogue-reset'});await until('!window.overlay.state.loading','reset reload');
 merge({ui:{dialogueVisible:false}});assert.equal(await evaluate('document.getElementById("dialogueOverlay").hidden'),true);assert.equal((await state()).count,0);
 console.log(JSON.stringify({passed:true,checks:['unlimited history back to 2020','bounded 120-message DOM','scene isolation with in-flight response','live follow','historical reading preserved','latest arrow','layer order','same control width','hidden overlay no reads'],requests,screenshots:out}));
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
