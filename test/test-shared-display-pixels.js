'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {readDisplayPixels,PROTOCOL}=require('../src/main/shared-display-pixels'),{DesktopNative}=require('../src/main/desktop-native');
async function source(t,change=()=>{},hang=false,badMAC=false){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'b-pixels-'));await fs.chmod(root,0o700);const socket=path.join(root,'s'),manifest=path.join(root,'source.json'),token='a'.repeat(64),clients=new Set();
 const server=net.createServer(client=>{clients.add(client);client.on('close',()=>clients.delete(client));client.on('data',data=>{if(hang)return;const request=JSON.parse(data),payload=Buffer.from('isolated-fake-png'),info={protocol:PROTOCOL,requestId:request.requestId,ok:true,backend:'CGDisplayStream',capturedAt:Date.now()-1,width:10,height:20,desktopRect:{x:0,y:0,width:10,height:20},format:'png',bytes:payload.length,sha256:crypto.createHash('sha256').update(payload).digest('hex')};change(info,request);const header=Buffer.from(JSON.stringify(info)),mac=Buffer.from(crypto.createHmac('sha256',token).update(header).digest('hex')),length=Buffer.alloc(4);length.writeUInt32BE(header.length);if(badMAC)mac[0]^=1;client.end(Buffer.concat([length,header,mac,payload]));});});
 await new Promise(r=>server.listen(socket,r));await fs.chmod(socket,0o600);await fs.writeFile(manifest,JSON.stringify({protocol:PROTOCOL,token,socket}),{mode:0o600});
 t.after(async()=>{for(const client of clients)client.destroy();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});return {root,socket,manifest,server};
}
test('two consumers share authenticated ordinary display pixels without target identifiers',async t=>{
 const s=await source(t,(_info,request)=>{assert.deepEqual(Object.keys(request).sort(),['format','protocol','requestId','token']);});
 const frames=await Promise.all([readDisplayPixels({manifest:s.manifest}),readDisplayPixels({manifest:s.manifest})]);assert.equal(frames.length,2);assert(frames.every(f=>f.source==='shared-display-pixels'&&f.width===10));
});
test('strict source authentication, payload digest, scope, backend and freshness are checked',async t=>{
 for(const change of [i=>{i.sha256='0'.repeat(64);},i=>{i.backend='Synthetic';},i=>{i.backend='AVCaptureScreenInput';},i=>{i.backend='ScreenCaptureKit';},i=>{i.capturedAt-=6000;},i=>{i.requestId='wrong';},i=>{i.desktopRect.width=-1;}]){const s=await source(t,change);await assert.rejects(readDisplayPixels({manifest:s.manifest}),e=>e.dispatched===false);}
 const s=await source(t);await assert.rejects(readDisplayPixels({manifest:s.manifest,payload:{windowId:1}}));await assert.rejects(readDisplayPixels({manifest:s.manifest,payload:{region:{x:0,y:0,width:1,height:1,pid:1}}}));
});
test('untrusted manifest permissions and symbolic links fail closed',async t=>{
 const s=await source(t);await fs.chmod(s.manifest,0o644);await assert.rejects(readDisplayPixels({manifest:s.manifest}));await fs.chmod(s.manifest,0o600);const link=path.join(s.root,'link');await fs.symlink(s.manifest,link);await assert.rejects(readDisplayPixels({manifest:link}));
});
test('timeouts and cancellation are bounded without touching a native capture backend',async t=>{
 const s=await source(t,()=>{},true),began=Date.now();await assert.rejects(readDisplayPixels({manifest:s.manifest,timeoutMs:30}),e=>e.code==='E_PIXEL_SOURCE_TIMEOUT');
 const cancel=new AbortController(),pending=readDisplayPixels({manifest:s.manifest,signal:cancel.signal});cancel.abort();await assert.rejects(pending,e=>e.code==='E_ABORTED');assert(Date.now()-began<500);
});
test('explicit native shared mode never spawns a second capture helper, including on source loss',async t=>{
 const s=await source(t),prior=process.env.WORKBUNNY_DISPLAY_PIXEL_SOURCE;process.env.WORKBUNNY_DISPLAY_PIXEL_SOURCE=s.manifest;t.after(()=>{if(prior===undefined)delete process.env.WORKBUNNY_DISPLAY_PIXEL_SOURCE;else process.env.WORKBUNNY_DISPLAY_PIXEL_SOURCE=prior;});let spawns=0;
 const native=new DesktopNative('/fake/native',{spawn:()=>{spawns++;throw Error('must not create capture helper');}});assert.equal((await native.request('displayCapture',{output:'base64'})).width,10);
 await assert.rejects(native.request('capture',{windowId:1}),e=>e.code==='E_PIXEL_SOURCE_MODE');await fs.unlink(s.manifest);await assert.rejects(native.request('displayCapture'),e=>e.dispatched===false);assert.equal(spawns,0);await native.close();
});
test('native cancellation aborts a queued shared frame and keeps the source independent',async t=>{
 const s=await source(t,()=>{},true),prior=process.env.WORKBUNNY_DISPLAY_PIXEL_SOURCE;process.env.WORKBUNNY_DISPLAY_PIXEL_SOURCE=s.manifest;t.after(()=>{if(prior===undefined)delete process.env.WORKBUNNY_DISPLAY_PIXEL_SOURCE;else process.env.WORKBUNNY_DISPLAY_PIXEL_SOURCE=prior;});const native=new DesktopNative('/unused',{spawn:()=>{throw Error('no helper');}}),pending=native.request('displayCapture');const rejected=assert.rejects(pending,e=>e.code==='E_ABORTED');await native.cancel();await rejected;await native.close();
});

test('a forged authentication code is rejected before its image can be used',async t=>{
 const s=await source(t,()=>{},false,true);await assert.rejects(readDisplayPixels({manifest:s.manifest}),/鉴权/);
});
