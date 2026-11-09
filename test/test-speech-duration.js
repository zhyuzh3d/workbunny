'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {durationMs}=require('../src/main/tts');
function wav(rate,channels=1,extra=false){
 const data=Buffer.alloc(rate*channels*2*4),fmt=Buffer.alloc(24);
 fmt.write('fmt ');fmt.writeUInt32LE(16,4);fmt.writeUInt16LE(1,8);fmt.writeUInt16LE(channels,10);fmt.writeUInt32LE(rate,12);fmt.writeUInt32LE(rate*channels*2,16);fmt.writeUInt16LE(channels*2,20);fmt.writeUInt16LE(16,22);
 const chunk=Buffer.alloc(8);chunk.write('data');chunk.writeUInt32LE(data.length,4);
 const junk=Buffer.alloc(12);junk.write('JUNK');junk.writeUInt32LE(4,4);
 const header=Buffer.alloc(12);header.write('RIFF');header.write('WAVE',8);
 const result=Buffer.concat([header,fmt,...(extra?[junk]:[]),chunk,data]);result.writeUInt32LE(result.length-8,4);return result;
}
test('playback deadline follows WAV rate, channels and optional chunks',()=>{
 for(const rate of [8000,16000,22050,24000,44100,48000])for(const channels of [1,2])for(const extra of [true,false])assert.equal(durationMs(wav(rate,channels,extra)),4000);
});
test('invalid or truncated audio has no invented duration',()=>{
 assert.equal(durationMs(Buffer.alloc(20)),null);assert.equal(durationMs(wav(24000).subarray(0,80)),null);
});
