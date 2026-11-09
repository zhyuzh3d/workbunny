'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Asr}=require('../src/main/asr'),{sanitizeSpeechTrace}=require('../src/main/speech-trace');
test('AEC3 reports actual reference health without forwarding private native fields',()=>{
 const asr=new Asr('/unused'),events=[];asr.on('aec',(on,state)=>events.push({on,...state}));
 asr.onMessage({t:'aec',on:true,engine:'webrtc-aec3',state:'active',referenceCode:0,systemDucking:false,transcript:'private-canary'});
 assert(asr.aec);assert.deepEqual(events[0],{on:true,engine:'webrtc-aec3',state:'active',referenceCode:0,systemDucking:false});
 asr.onMessage({t:'aec',on:false,engine:'webrtc-aec3',state:'degraded',referenceCode:-5,systemDucking:false});
 assert(!asr.aec);assert.equal(events[1].state,'degraded');assert.equal(events[1].referenceCode,-5);assert(!JSON.stringify(events).includes('private-canary'));
});
test('degraded AEC cannot be advertised as active even with a contradictory flag',()=>{
 const asr=new Asr('/unused');asr.onMessage({t:'aec',on:true,engine:'webrtc-aec3',state:'degraded'});assert(!asr.aec);
 asr.onMessage({t:'aec',on:true});assert(asr.aec);assert.equal(asr.echoState.engine,'legacy');
});
test('raw microphone and post-AEC trace stages remain numeric-only',()=>{
 for(const stage of ['tap-capture','echo-output'])assert.deepEqual(sanitizeSpeechTrace({stage,rms:[.1],aec:true,pcm:'private',deviceUID:'private'}),{stage,rms:[.1],aec:true});
});
