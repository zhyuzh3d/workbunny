'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('the actual typed dialogue IPC admits an exact local stop while the model is offline',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/main/index.js'),'utf8');
 const start=source.indexOf('async function submitTypedDialogue('),end=source.indexOf('\nasync function applySettings',start);
 let handler,thoughts=0;
 const context={ipcMain:{handle:(name,fn)=>{assert.equal(name,'pet:say');handler=fn;}},inputAdmission:{containsSecret:()=>false},storageBusy:false,storageError:null,dialogueReady:()=>false,
  dialogueActions:require('../src/main/dialogue-actions'),agent:{currentTask:()=>({id:'active',schema:require('../src/main/agent-contract').TASK_SCHEMA,status:'waiting'})},desktop:null,
  config:{load:()=>({brain:{source:'workbuddy'},memory:{enabled:false}})},connection:{status:()=>({note:'model offline'})},screenLocked:false,
  composing:false,stopSpeaking:()=>{},voiceTurns:{reset:()=>{}},autonomy:null,pushHistory:async()=>({id:'owner'}),send:()=>{},QUIET_WORDS:/^quiet$/,think:()=>{thoughts++;},require:require('node:module').createRequire(path.join(__dirname,'../src/main/index.js')),Date};
 vm.runInNewContext(source.slice(start,end),context);
 assert.equal((await handler(null,{text:'普通聊天'})).ok,false);assert.equal(thoughts,0);
 assert.equal((await handler(null,{text:'停止当前代办'})).ok,true);assert.equal(thoughts,1);
 context.screenLocked=true;assert.equal((await handler(null,{text:'停止当前代办'})).ok,false);assert.equal(thoughts,1);
});
