'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{Asr}=require('../src/main/asr');
test('audio heartbeat distinguishes a live process from actual input and recovers a stalled input',()=>{
 const oldNow=Date.now,oldInterval=global.setInterval,oldClear=global.clearInterval;let time=1000,callback,killed=0;const errors=[];
 Date.now=()=>time;global.setInterval=fn=>{callback=fn;return{unref(){}}};global.clearInterval=()=>{};
 try{const asr=new Asr('/fixture');asr.on('error',e=>errors.push(e));asr.proc={kill(){killed++}};asr.onMessage({t:'ready',captureHeartbeat:true});time=4000;asr.onMessage({t:'capture'});time=9000;callback();assert.equal(killed,0);time=11000;callback();assert.equal(killed,1);assert.match(errors[0],/输入中断/);assert.equal(asr.running,false);}finally{Date.now=oldNow;global.setInterval=oldInterval;global.clearInterval=oldClear;}
});
test('disabling continuous recognition releases the microphone without restarting a native session',()=>{
 const oldTimeout=global.setTimeout;global.setTimeout=()=>0;
 try{const commands=[],asr=new Asr('/fixture');asr.proc={stdin:{write:s=>commands.push(s)}};asr.always=true;asr.stop();assert.equal(commands[0],'quit\n');asr.always=false;asr.stop();assert.equal(commands[1],'stop\n');assert.equal(asr.ready,false);}finally{global.setTimeout=oldTimeout;}
});
