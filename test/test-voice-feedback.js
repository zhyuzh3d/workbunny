'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('final ASR for an uncalled name never publishes pending feedback',()=>{
 const source=fs.readFileSync('src/main/index.js','utf8'),events=[];
 const ctx={config:{load:()=>({asr:{wakeOnly:true}})},nameHit:t=>t.startsWith('Bunny'),send:(type,value)=>events.push({type,...value})};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function publishVoiceLive('),source.indexOf('/** 每听到一句')),ctx);
 ctx.publishVoiceLive('旁边的说话',{final:true,pending:true,turn:1,turnId:'fixture:1',phase:'pending'});assert.deepEqual({...events[0]},{type:'heard',text:'旁边的说话',replied:false,reason:'not-addressed',turn:1,turnId:'fixture:1',phase:'pending'});
 ctx.publishVoiceLive('旁边的说话。',{final:true,pending:true});assert(events.every(e=>e.replied===false));
 ctx.publishVoiceLive('Bunny看看',{final:true,pending:true});assert.equal(events.at(-1).replied,undefined);
});
test('ignored speech has explicit feedback, expires, and does not replace a newer semantic reply',()=>{
 const source=fs.readFileSync('src/renderer/app.js','utf8');let clear;
 const ctx={asrStat:{note:''},listening:true,liveText:'旁边的说话',shownHeard:'',shownState:'',speakingNow:false,pendingHeard:'',pendingAt:0,heardTimer:null,Date,
 clearTimeout(){},setTimeout(fn){clear=fn;return 1;},paintEar(){},heardTurn:0,heardTurnClosed:false};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function earLabel()'),source.indexOf('/* 文字超出可用宽度')),ctx);
 vm.runInContext(source.slice(source.indexOf('function clearHeard()'),source.indexOf('function asrHealthy()')),ctx);
 vm.runInContext(source.slice(source.indexOf('function paintHeard('),source.indexOf('/* ═══════════ 权限')),ctx);
 ctx.paintHeard('旁边的说话',false,'not-addressed');assert.equal(ctx.earLabel(),'你说 · 旁边的说话 · 没叫我，飘过～');assert.equal(ctx.pendingHeard,'');
 ctx.paintHeard('旁边的说话。',false,'not-addressed');assert(!ctx.earLabel().includes('正在回应'));
 clear();assert.equal(ctx.earLabel(),'在听');
 ctx.paintHeard('Bunny你好');ctx.paintHeard('旧的语义判断',false);assert.equal(ctx.shownState,'pending');
});
test('authoritative turn reset, completion and new speech clear old words and reject stale results',()=>{
 const source=fs.readFileSync('src/renderer/app.js','utf8'),timers=[];
 const ctx={asrStat:{note:''},listening:true,liveText:'',shownHeard:'',shownState:'',speakingNow:false,pendingHeard:'',pendingAt:0,heardTimer:null,Date,
  clearTimeout(){},setTimeout(fn){timers.push(fn);return timers.length;},paintEar(){},heardTurn:0,heardTurnClosed:false};
 vm.createContext(ctx);
 for(const[start,end]of [['function clearHeard()','function asrHealthy()'],['function paintLive(','function openDock()'],['function paintHeard(','/* ═══════════ 权限']])vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end)),ctx);
 ctx.paintLive('old words',{turn:1,phase:'partial'});ctx.paintHeard('old words',undefined,undefined,1);
 ctx.paintLive('',{turn:1,phase:'reset'});assert.equal(ctx.shownHeard,'');assert.equal(ctx.pendingHeard,'');assert.equal(ctx.liveText,'');
 ctx.paintLive('new words',{turn:2,phase:'partial'});assert.equal(ctx.liveText,'new words');ctx.paintHeard('new words',undefined,undefined,2);
 ctx.paintHeard('old words',true,undefined,1);ctx.paintHeard('old background',false,'not-addressed',1);assert.equal(ctx.shownHeard,'new words');assert.equal(ctx.shownState,'pending');
 ctx.paintHeard('new words',true,undefined,2);ctx.paintLive('',{turn:2,phase:'completed'});assert.equal(ctx.pendingHeard,'');assert.equal(ctx.shownState,'done');
 ctx.paintHeard('new words',undefined,undefined,2);assert.equal(ctx.shownState,'done','a duplicate pending result cannot reopen a retired turn');
 const expire=timers.at(-1);ctx.paintLive('third words',{turn:3,phase:'partial'});expire();assert.equal(ctx.liveText,'third words');
 ctx.paintLive('',{turn:2,phase:'reset'});assert.equal(ctx.liveText,'third words');
});
