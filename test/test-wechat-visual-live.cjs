'use strict';
// Explicit live visual acceptance in our own Electron window. No real WeChat
// content or interface is accessed. Real screenshots, OCR, model and CGEvents
// exercise the production send/watch/reply paths against a controlled scene.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { DesktopNative } = require('../src/main/desktop-native');
const { DesktopService } = require('../src/main/desktop-service');
const { WeChatObserver } = require('../src/main/wechat-observer');
const { WatchService } = require('../src/main/watch-service');
const { createContactDirectory } = require('../src/main/contact-directory');
const { prepareVisionPreview } = require('../src/main/vision-preview');
const wb = require('../src/main/workbuddy');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-wechat-visual-'));
app.setPath('userData', tmp);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let win, raw, service, watcher, observer;
async function run() {
 await app.whenReady();
 await require('../src/main/model-catalog').refresh('workbuddy');
 raw = new DesktopNative(path.resolve('bin/desktop'));
 win = new BrowserWindow({ width: 1040, height: 830, x: 900, y: 250, title: 'Bunny 微信视觉专用验收窗口', webPreferences: { contextIsolation: true, nodeIntegration: false } });
 await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
 *{box-sizing:border-box}body{margin:0;font:20px system-ui;background:#ededed;color:#222}.sidebar{position:absolute;left:0;top:0;width:30%;height:100%;background:#dedede;padding:40px 22px}.sidebar div{margin:28px 0}.header{position:absolute;left:30%;top:0;right:0;height:75px;padding:22px 30px;border-bottom:1px solid #ccc}#messages{position:absolute;left:30%;right:0;top:75px;bottom:205px;padding:20px;display:flex;flex-direction:column;gap:18px;overflow:hidden}.row{display:flex;gap:12px;align-items:flex-start}.row.out{flex-direction:row-reverse}.avatar{width:42px;height:42px;background:#3679a6;border-radius:5px;color:white;text-align:center;line-height:42px;flex-shrink:0}.out .avatar{background:#1a9468}.bubble{white-space:pre-wrap;max-width:78%;padding:10px 14px;background:white;border-radius:6px}.out .bubble{background:#95ec69}#composer{position:absolute;left:30%;right:0;bottom:0;height:205px;background:white;border-top:1px solid #ccc;padding:12px 20px}textarea{resize:none;width:100%;height:120px;border:0;outline:none;font:21px system-ui}button{float:right;padding:7px 24px;color:#188238;border:1px solid #ccc;background:#fafafa;font:17px system-ui}</style>
 <div class="sidebar"><b>微信视觉测试</b><div>搜索</div><div id="alice" style="cursor:pointer">Alice <span id="unread" style="color:white;background:#ef4444;border-radius:12px;padding:0 6px;display:none"></span></div><div>文件传输助手</div><small>仅专用测试场景</small></div><div class="header">Alice</div><div id="messages"></div><div id="composer"><textarea id="input" placeholder="输入消息"></textarea><button id="send">发送</button></div><script>
 window.sent=[];window.addMessage=(text,direction='in')=>{const row=document.createElement('div');row.className='row '+direction;const avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=direction==='in'?'A':'我';const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=text;row.append(avatar,bubble);document.querySelector('#messages').append(row);while(document.querySelector('#messages').scrollHeight>document.querySelector('#messages').clientHeight&&document.querySelector('#messages').children.length>1)document.querySelector('#messages').firstChild.remove()};
 const input=document.querySelector('#input');function send(){if(!input.value.trim())return;window.sent.push(input.value);addMessage(input.value,'out');input.value=''}document.querySelector('#send').onclick=send;input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};addMessage('早上好。');addMessage('你好，视觉验收开始。','out');
 document.querySelector('#alice').onclick=()=>{document.querySelector('.header').textContent='Alice';document.querySelector('#unread').style.display='none'};window.markUnread=()=>{document.querySelector('.header').textContent='Bob';const e=document.querySelector('#unread');e.textContent='3';e.style.display='inline'};
 </script>`));
 win.show();win.focus();app.focus({steal:true});await sleep(800);
 let actual = (await raw.request('frontmost')).application;
 // App activation can finish after the first display frame on macOS.
 const focusDeadline=Date.now()+4000;
 while(actual.pid!==process.pid&&Date.now()<focusDeadline){win.focus();app.focus({steal:true});await sleep(300);actual=(await raw.request('frontmost')).application;}
 assert.equal(actual.pid, process.pid, 'test window must be frontmost');
 const calls = [];
 const adapter = { request: async (op, p = {}, timeout) => {
  calls.push(op);
  if (/workbuddy|wechat/i.test(op)) throw Error('fixture never calls an application interface');
  if (op === 'activate') { win.show();win.focus();app.focus({steal:true});return {activated:true}; }
  const q={...p};if(q.expected)q.expected={...q.expected,bundleId:actual.bundleId};
  const r=await raw.request(op,q,timeout);
  if(op==='frontmost'){console.log(JSON.stringify({nativeFront:r.application.pid,fixturePid:process.pid,rects:r.windows.filter(w=>w.pid===process.pid).map(w=>w.rect)}));return {...r,application:r.application.pid===process.pid?{...r.application,bundleId:'com.tencent.xinWeChat'}:r.application,
   windows:r.windows.map(w=>w.pid===process.pid?{...w,bundleId:'com.tencent.xinWeChat'}:w)};}
  return r;
 },cancel:()=>raw.cancel(),close:()=>raw.close() };
 const resize=png=>prepareVisionPreview(nativeImage.createFromBuffer(png));
 service=new DesktopService({native:adapter,imageResize:resize,
  imageCrop:(png,rect)=>nativeImage.createFromBuffer(png).crop(rect).toPNG(),
  contactDirectory:createContactDirectory({read:async()=>[{recipient:'Alice',aliases:[],scene:'life',domain:'life',visibilityFloor:1}]}),
  modelRequest:async opts=>{const r=await wb.chat({...opts,thinking:'low',timeoutMs:25000,maxTokens:opts.maxTokens,extraBody:{reasoning_effort:'low',response_format:{type:'json_object'}}});console.log(JSON.stringify({fixturePlan:r.text}));return r;},
  emit:s=>{if(run.last!==s.task?.note){run.last=s.task?.note;console.log(JSON.stringify({phase:s.task?.status,note:s.task?.note}));}}});
 const execute=async(operation,message)=>{
  const r=await service.start({target:'wechat',recipient:'Alice',operation,message,origin:'watch',inputSource:'text',
   goal:operation==='send'?`仅向Alice发送原文一次：${message}`:'打开并确认Alice会话；允许在顶部搜索框搜索Alice并标记purpose:navigation，禁止输入消息正文或发送。',criteria:operation==='send'?'本次新增右侧完整消息气泡，输入框清空。':'顶部标题精确为Alice。'});
  assert(r.ok,r.error);let until=Date.now()+125000;
  while(service.running&&Date.now()<until)await sleep(150);
  if(service.task.status!=='review'){console.log(JSON.stringify({fixtureOCR:service.screenshot?.ocr,hasBeforeSubmit:!!service.wechatBeforeSubmit,shotAt:service.screenshot?.at,submitAt:service.task.submitAttemptedAt}));throw Error(service.task.note);}
  if(operation==='send')assert.equal(service.task.sendState,'confirmed');
  await service.accept({automatic:true,report:'专用窗口真实视觉与键鼠验收'});return {ok:true,windowId:service.task.scope?.windowId};
 };
 const body='Bunny 视觉验收 A1\n中文、English 和 emoji 🙂。';
 await execute('send',body);
 assert.deepEqual(await win.webContents.executeJavaScript('window.sent'),[body]);
 console.log(JSON.stringify({sendPassed:true,multilinePreserved:true}));
 observer=new WeChatObserver({native:adapter,imageResize:resize});
 const records=new Map(),events=new Map(),reports=[],receipts=new Set();let now=Date.now(),mayOperate=true;
 watcher=new WatchService({journal:{eventId:(id,key)=>require("node:crypto").createHash("sha256").update(id+"\0"+key).digest("hex"),receipt:async(event,text)=>{const inserted=!receipts.has(event.id);receipts.add(event.id);return {inserted,text};},saveWatch:async w=>{records.set(w.id,structuredClone(w));return w;},listWatches:async()=>[],getEvent:async id=>events.get(id),saveEvent:async(w,e)=>events.set(e.id,structuredClone(e))},
  sensor:observer,inspect:async(w,f,s)=>{const v=await observer.inspect(w,f,s);console.log(JSON.stringify({fixtureObserved:v}));return v;},propose:async(w,m,s)=>{const d=await observer.propose(w,m,s);console.log(JSON.stringify({fixtureDecision:d}));return d;},
  execute:(w,a)=>execute(a.operation,a.message),report:async r=>reports.push(r),epoch:()=>1,ready:()=>true,canOperate:async()=>mayOperate,clock:()=>now,autoSchedule:false});
 const start=await watcher.start({recipient:'Alice',goal:'持续关注Alice新消息并按固定规则回复',criteria:'新消息出现后回复一次',sources:['fixture-owner'],watch:{mode:'reply',policy:'仅在收到“收到请确认A2”时回复“收到，稍后回复。”；其他消息只通知，不回复。'}});
 assert(start.ok,start.error);await watcher.tick(start.id);
 await win.webContents.executeJavaScript('window.addMessage("收到请确认A2")');await sleep(600);now+=11000;await watcher.tick(start.id);
 const sent=await win.webContents.executeJavaScript('window.sent');
 assert.deepEqual(sent,[body,'收到，稍后回复。'],JSON.stringify({sent,state:watcher.list(),reports}));
 now+=11000;await watcher.tick(start.id);
 assert.deepEqual(await win.webContents.executeJavaScript('window.sent'),sent,'unchanged screen must not repeat a reply');
 // A visible unread badge while busy must survive an unchanged next frame.
 await win.webContents.executeJavaScript('window.markUnread()');await sleep(600);mayOperate=false;now+=11000;await watcher.tick(start.id);
 assert.equal(watcher.items.get(start.id).bound,false,'busy unread state must remain pending');
 mayOperate=true;now+=11000;await watcher.tick(start.id);
 assert.equal(await win.webContents.executeJavaScript('document.querySelector(".header").textContent'),'Alice');
 await win.webContents.executeJavaScript('window.addMessage("收到请确认A2")');await sleep(600);now+=61000;await watcher.tick(start.id);
 assert.deepEqual(await win.webContents.executeJavaScript('window.sent'),[body,'收到，稍后回复。','收到，稍后回复。'],'a later same-text incoming message gets one separate reply');
 now+=11000;await watcher.tick(start.id);
 assert.equal((await win.webContents.executeJavaScript('window.sent')).length,3,'observation after repeated text never resends');
 assert(calls.includes('visualSample')&&calls.includes('recognize')&&calls.includes('type'));
 console.log(JSON.stringify({autoReplyPassed:true,noDuplicateReply:true,busyUnreadRecovered:true,repeatedIncomingRepliedOnce:true,observedEvents:events.size,reports:reports.length,actualWeChatUsed:false}));
}
run().then(()=>finish(0),e=>{console.error(e.stack);finish(1)});
async function finish(code){await watcher?.close();await service?.close();await raw?.close();win?.destroy();fs.rmSync(tmp,{recursive:true,force:true});app.exit(code)}
