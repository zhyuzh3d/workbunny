'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('character menu exposes native toggles and checked scene, avatar and size submenus',async()=>{
 const code=fs.readFileSync('src/main/index.js','utf8'),start=code.indexOf('function buildCharacterMenu()'),end=code.indexOf("function rebuildTray()",start),patches=[],events=[];
 const cfg={ui:{dialogueVisible:true},avatar:'a',voice:{enabled:true,alwaysListen:true},window:{scale:.5,vrmFraming:'half'},memory:{scene:'life'}};
 const context={config:{load:()=>cfg},Menu:{buildFromTemplate:items=>items},applySettings:async p=>patches.push(p),send:(...e)=>events.push(e),openPanel:()=>{},SCALES:[.25,.5,1.5,2],activeAvatarPack:()=>null,clampScale:v=>v,SCALE_LABELS:{.25:'50%',.5:'100%',1.5:'150%',2:'200%'},currentScene:()=>cfg.memory.scene,scopePolicy:{LABELS:{private:'私聊',life:'生活',work:'工作'}},avatarList:()=>[{key:'a',label:'A'},{key:'b',label:'B'}],speaking:true,speechQueue:[],stopSpeaking:(...args)=>events.push(['stopSpeaking',...args]),systemPreferences:{getMediaAccessStatus:()=> 'granted'},requestAsrPermission:async()=>{},startListen:()=>{},textInputOpen:false,setInteractive:()=>{},win:{focus:()=>{}}};
 vm.createContext(context);vm.runInContext(code.slice(start,end)+'\nglobalThis.menu=buildCharacterMenu();',context);
 const menu=context.menu,find=label=>menu.find(i=>i.label===label);
 assert.equal(find('静音不说话').checked,false);assert.equal(find('关闭耳朵').checked,false);
 assert.equal(find('显示对话内容').checked,true);assert.equal(find('显示文字输入').checked,false);
 assert.deepEqual(Array.from(find('对话场景').submenu,i=>i.checked),[false,true,false]);
 assert.deepEqual(Array.from(find('形象').submenu,i=>i.checked),[true,false]);
 assert.deepEqual(Array.from(find('形象大小').submenu,i=>i.checked),[false,true,false,false]);
 assert.deepEqual(Array.from(find('形象取景框').submenu,i=>i.checked),[true,false]);
 find('显示对话内容').click({checked:false});find('显示文字输入').click({checked:true});find('形象').submenu[1].click();
 await Promise.resolve();assert.equal(patches[0].ui.dialogueVisible,false);assert.equal(patches[1].avatar,'b');assert.equal(events[0][0],'ask');assert.equal(events[0][1].open,true);
 find('静音不说话').click({checked:true});await find('关闭耳朵').click({checked:true});
 assert.equal(patches[2].voice.enabled,false);assert.equal(patches[3].voice.alwaysListen,false);
 find('形象取景框').submenu[1].click();assert.equal(patches[4].window.vrmFraming,'full');
 context.activeAvatarPack=()=>({});context.menu=context.buildCharacterMenu();assert.equal(context.menu.some(i=>i.label==='形象取景框'),false);
});

test('character avatar menu groups personal avatars after official avatars only when needed', () => {
 const code=fs.readFileSync('src/main/index.js','utf8'),start=code.indexOf('function buildCharacterMenu()'),end=code.indexOf('function rebuildTray()',start);
 let items=[{key:'custom',label:'自定义',personal:true},{key:'official',label:'官方'}];
 const cfg={avatar:'custom',ui:{},voice:{},window:{scale:.5}};
 const context={config:{load:()=>cfg},Menu:{buildFromTemplate:x=>x},avatarList:()=>items,applySettings:async()=>{},send:()=>{},SCALES:[.5],activeAvatarPack:()=>null,clampScale:v=>v,SCALE_LABELS:{.5:'100%'},textInputOpen:false,scopePolicy:{LABELS:{}},currentScene:()=>''};
 vm.createContext(context);vm.runInContext(code.slice(start,end),context);
 const avatars=()=>context.buildCharacterMenu().find(x=>x.label==='形象').submenu;
 assert.deepEqual(Array.from(avatars(),x=>x.type==='separator'?'|':x.label),['官方','|','自定义']);
 assert.deepEqual(Array.from(avatars().filter(x=>x.type!=='separator'),x=>x.checked),[false,true]);
 items=[items[1]];assert.deepEqual(Array.from(avatars(),x=>x.label),['官方']);
});

test('context menu uses the exact window-relative click and rejects invalid senders or coordinates', () => {
 const source=fs.readFileSync('src/main/index.js','utf8'), start=source.indexOf("ipcMain.on('pet:context-menu'"), end=source.indexOf('function trustedCompanion',start);
 const calls=[], sender={},win={webContents:sender,getContentSize:()=>[800,600]};let listener,locked=false;
 const ctx={ipcMain:{on:(_name,fn)=>listener=fn},win,get screenLocked(){return locked;},setInteractive:value=>calls.push(['interactive',value]),buildCharacterMenu:()=>({popup:options=>calls.push(['popup',options])})};
 vm.runInNewContext(source.slice(start,end),ctx);
 listener({sender},{x:420.2,y:315.6});assert.equal(calls[1][1].x,420);assert.equal(calls[1][1].y,316);assert.equal(calls[1][1].window,win);
 listener({sender},{x:799.9,y:599.9});assert.equal(calls[3][1].x,799);assert.equal(calls[3][1].y,599);
 for(const position of [undefined,{x:NaN,y:2},{x:-1,y:5},{x:800,y:3},{x:5,y:600}])listener({sender},position);
 listener({sender:{}},{x:2,y:4});locked=true;listener({sender},{x:2,y:4});assert.equal(calls.length,4);
});

test('right-click opens the same menu on the dialogue overlay, including text-only mode', () => {
 const source=fs.readFileSync('src/renderer/app.js','utf8'),start=source.indexOf("document.addEventListener('contextmenu'"),end=source.indexOf("document.addEventListener('pointerdown'",start);
 let handler,hit=false,rayCalls=0;const calls=[];
 const config={ui:{avatarHidden:false}}, ctx={document:{addEventListener:(_type,fn)=>handler=fn},cfg:config,
  dataAvatar:null,vrm:{scene:{}},renderer:{},scene:{},camera:{},stageViewport:{},
  modelContextHit:()=>{rayCalls++;return hit;},pet:{contextMenu:pos=>calls.push([pos.x,pos.y])}};
 vm.runInNewContext(source.slice(start,end),ctx);
 function click({overlay=false,hidden=false,control=false,x=25,y=48}={}) {
  let prevented=false;const target={closest:selector=>selector==='#dialogueOverlay'?(overlay?{hidden}:null):(control?{}:null)};
  handler({target,clientX:x,clientY:y,preventDefault:()=>{prevented=true;}});return prevented;
 }
 assert(click({overlay:true}));assert.deepEqual(calls.pop(),[25,48]);assert.equal(rayCalls,0);
 config.ui.avatarHidden=true;assert(click({overlay:true,x:91,y:73}));assert.deepEqual(calls.pop(),[91,73]);
 assert.equal(click(),false);assert.equal(rayCalls,0,'hidden character cannot produce a menu');
 config.ui.avatarHidden=false;assert.equal(click({control:true}),false);assert.equal(click(),false);
 hit=true;assert(click({x:500,y:400}));assert.deepEqual(calls.pop(),[500,400]);
 assert.equal(click({overlay:true,hidden:true,control:true}),false,'hidden overlay does not open a menu');
});
