'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalize,SPEAKERS}=require('../src/main/qwen-voices');
test('legacy Base configuration cannot activate Base weights or file-clone mode',()=>{
 const tracks=[{file:'/private/reference.wav'}];
 const q=normalize({dir:'/old/base',ready:true,voice:'file',activeTrack:0,tracks});
 assert.equal(q.modelKind,'customvoice');assert.equal(q.dir,'');assert.equal(q.ready,false);
 assert.equal(q.voice,'serena');assert.equal(q.activeTrack,null);assert.equal(q.streaming,false);
 assert.deepEqual(q.tracks,tracks);
});
test('CustomVoice exposes nine unique named speakers and keeps a valid selection',()=>{
 assert.equal(SPEAKERS.length,9);assert.equal(new Set(SPEAKERS.map(v=>v.id)).size,9);
 for(const speaker of SPEAKERS){const q=normalize({modelKind:'customvoice',dir:'/custom',ready:true,voice:speaker.id,streaming:true});assert.equal(q.voice,speaker.id);assert.equal(q.dir,'/custom');assert.equal(q.ready,true);assert.equal(q.streaming,true);}
 assert.equal(normalize({modelKind:'customvoice',voice:'unknown'}).voice,'serena');
});
