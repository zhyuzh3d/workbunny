'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve('src/main/index.js'),'utf8'),expression=source.match(/^const QUIET_WORDS = (.+);$/m)[1];
const quiet=vm.runInNewContext(expression);
test('immediate quiet controls match only a complete standalone owner command',()=>{
 for(const value of ['请先安静一下','别说了','不要说话。','先别说','闭嘴！','别烦我','别打扰我'])assert.equal(quiet.test(value),true,value);
 for(const value of ['等一下先别讲故事了，你用一句话告诉我晚上吃点什么比较简单。','别说了，换个话题','我刚才说了不要说话是什么意思？','如果我说安静一下呢','你先别说答案，问我一个问题'])assert.equal(quiet.test(value),false,value);
});
test('the typed entry uses the same complete-command rule and preserves mixed requests for the model',async()=>{
 let handler;const requests=[],context={ipcMain:{handle:(_name,fn)=>{handler=fn;}},Date,storageBusy:false,storageError:null,dialogueActions:{taskControl:()=>null},agent:null,desktop:null,
  dialogueReady:()=>true,screenLocked:false,config:{load:()=>({memory:{enabled:false}})},memory:{addMessage:async()=>{}},composing:false,stopSpeaking(){},voiceTurns:{reset(){}},lastHeardAt:0,autonomy:null,
  pushHistory:async()=>({id:'fixture-owner'}),send(){},QUIET_WORDS:quiet,quietUntil:0,presentedReplies:new Set(),think:request=>requests.push(request.userText),
  dialogueScheduler:()=>({interrupt(){}}),dialogueScope:()=> 'fixture',require:require('node:module').createRequire(path.resolve('src/main/index.js'))};
 vm.runInNewContext(source.slice(source.indexOf('async function submitTypedDialogue('),source.indexOf('async function applySettings(')),context);
 const mixed='先别讲故事了，告诉我晚饭吃什么。';await handler({}, {text:mixed});assert.deepEqual(requests,[mixed]);assert.equal(context.quietUntil,0);
 await handler({}, {text:'请先安静一下'});assert(context.quietUntil>Date.now());assert.deepEqual(requests,[mixed]);
});
