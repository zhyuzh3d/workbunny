#!/usr/bin/env node
'use strict';
// Read pixels from an existing owner; never creates a screen capture stream.
const {readDisplayPixels}=require('../src/main/shared-display-pixels');
const manifest=process.argv[2],seconds=Math.max(1,Math.min(10,Number(process.argv[3])||5));
if(!manifest){process.stderr.write('usage: node tools/probe-shared-display.cjs pixel-source.json [seconds]\n');process.exit(1);}
const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),seconds*1000+3500),began=Date.now();
async function consumer(index){let frames=0,bytes=0,maxLatencyMs=0;while(Date.now()-began<seconds*1000){const at=Date.now(),frame=await readDisplayPixels({manifest,signal:controller.signal});frames++;bytes+=Math.floor(frame.pngBase64.length*3/4);maxLatencyMs=Math.max(maxLatencyMs,Date.now()-at);await new Promise(r=>setTimeout(r,250));}return {consumer:index,frames,bytes,maxLatencyMs};}
Promise.all([consumer(1),consumer(2)]).then(results=>{console.log(JSON.stringify({ok:true,source:'one-existing-CGDisplayStream',results}));},error=>{controller.abort();console.error(JSON.stringify({ok:false,code:error.code||'E_PIXEL_SOURCE',message:error.message}));process.exitCode=1;}).finally(()=>clearTimeout(deadline));
