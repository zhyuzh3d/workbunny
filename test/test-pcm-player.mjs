import {test} from 'node:test';import assert from 'node:assert/strict';
import {createPCMPlayer} from '../src/renderer/pcm-player.mjs';
function fixture(){const sources=[];let starts=0,done=0,under=0;const context={currentTime:0,createBuffer:(_c,n,rate)=>({length:n,rate,copyToChannel(){}}),createBufferSource:()=>{const s={connect(){},start(at){s.at=at;},stop(){s.stopped=true;}};sources.push(s);return s;}};
const player=createPCMPlayer({context,destination:{},onStart:()=>starts++,onDone:()=>done++,onUnderrun:()=>under++});return{player,context,sources,counts:()=>({starts,done,under})};}
const chunk=()=>new Uint8Array(3840); // 80ms at 24kHz.
test('prebuffer schedules contiguous chunks and completion waits for the last playback',()=>{
const f=fixture();f.player.begin('one');for(let i=0;i<3;i++)f.player.push('one',chunk());assert.equal(f.sources.length,0);f.player.push('one',chunk());assert.equal(f.sources.length,4);
for(let i=1;i<4;i++)assert.ok(Math.abs(f.sources[i].at-f.sources[i-1].at-.08)<1e-8);
f.player.end('one');assert.equal(f.counts().done,0);f.sources.slice(0,3).forEach(s=>s.onended());assert.equal(f.counts().done,0);f.sources[3].onended();assert.deepEqual(f.counts(),{starts:1,done:1,under:0});});
test('cancel stops scheduled sound, ignores stale chunks and handles a short final buffer',()=>{
const f=fixture();f.player.begin('old');for(let i=0;i<4;i++)f.player.push('old',chunk());f.player.stop('old');assert.ok(f.sources.every(s=>s.stopped&&s.onended===null));
f.player.begin('new');f.player.push('old',chunk());f.player.end('old');assert.equal(f.sources.length,4);f.player.push('new',chunk());f.player.end('new');assert.equal(f.sources.length,5);f.sources[4].onended();assert.equal(f.counts().done,1);});
