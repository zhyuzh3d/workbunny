'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('final ASR for an uncalled name never publishes pending feedback',()=>{
 const source=fs.readFileSync('src/main/index.js','utf8'),events=[];
 const ctx={config:{load:()=>({asr:{wakeOnly:true}})},nameHit:t=>t.startsWith('Bunny'),send:(type,value)=>events.push({type,...value})};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function publishVoiceLive('),source.indexOf('/** 每听到一句')),ctx);
 ctx.publishVoiceLive('旁边的说话',{final:true,pending:true});assert.deepEqual({...events[0]},{type:'heard',text:'旁边的说话',replied:false,reason:'not-addressed'});
 ctx.publishVoiceLive('旁边的说话。',{final:true,pending:true});assert(events.every(e=>e.replied===false));
 ctx.publishVoiceLive('Bunny看看',{final:true,pending:true});assert.equal(events.at(-1).replied,undefined);
});
test('ignored speech has explicit feedback, expires, and does not replace a newer semantic reply',()=>{
 const source=fs.readFileSync('src/renderer/app.js','utf8');let clear;
 const ctx={asrStat:{note:''},listening:true,liveText:'旁边的说话',shownHeard:'',shownState:'',speakingNow:false,pendingHeard:'',pendingAt:0,heardTimer:null,Date,
 clearTimeout(){},setTimeout(fn){clear=fn;return 1;},paintEar(){}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function earLabel()'),source.indexOf('/* 文字超出可用宽度')),ctx);
 vm.runInContext(source.slice(source.indexOf('function paintHeard('),source.indexOf('/* ═══════════ 权限')),ctx);
 ctx.paintHeard('旁边的说话',false,'not-addressed');assert.equal(ctx.earLabel(),'你说 · 旁边的说话 · 没叫我，飘过～');assert.equal(ctx.pendingHeard,'');
 ctx.paintHeard('旁边的说话。',false,'not-addressed');assert(!ctx.earLabel().includes('正在回应'));
 clear();assert.equal(ctx.earLabel(),'在听');
 ctx.paintHeard('Bunny你好');ctx.paintHeard('旧的语义判断',false);assert.equal(ctx.shownState,'pending');
});
