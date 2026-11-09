'use strict';
// An explicitly selected, local ordinary-display pixel source. No app/window
// handles or automatic fallback to another capture connection are available.
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const PROTOCOL='bunny.display-pixels/v1',MAX_BYTES=64*1024*1024;
const failure=(message,code='E_PIXEL_SOURCE')=>Object.assign(Error(message),{code,dispatched:false});
async function sourceManifest(file){
 const absolute=path.resolve(file),st=await fs.lstat(absolute),parent=await fs.lstat(path.dirname(absolute));
 if(!st.isFile()||st.isSymbolicLink()||st.mode&0o077||st.size>4096||!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077||process.getuid&&(st.uid!==process.getuid()||parent.uid!==process.getuid()))throw failure('共享像素来源必须是本机私有资料');
 const value=JSON.parse(await fs.readFile(absolute,'utf8'));
 if(value.protocol!==PROTOCOL||typeof value.token!=='string'||!/^[a-f0-9]{64}$/u.test(value.token)||typeof value.socket!=='string'||!path.isAbsolute(value.socket)||path.dirname(value.socket)!==path.dirname(absolute))throw failure('共享像素来源配置无效');
 const socket=await fs.lstat(value.socket);if(!socket.isSocket()||socket.mode&0o077||process.getuid&&socket.uid!==process.getuid())throw failure('共享像素套接字不可信');return value;
}
function readDisplayPixels({manifest,payload={},timeoutMs=1500,signal,allowSynthetic=false}={}){
 if(!manifest||Object.keys(payload).some(k=>!['output','region'].includes(k))||payload.output!==undefined&&payload.output!=='base64')return Promise.reject(failure('共享像素只接受普通显示像素请求'));
 if(payload.region&&(!['x','y','width','height'].every(k=>Number.isFinite(payload.region[k]))||Object.keys(payload.region).some(k=>!['x','y','width','height'].includes(k))||payload.region.width<=0||payload.region.height<=0))return Promise.reject(failure('共享显示像素区域无效'));
 return new Promise((resolve,reject)=>{
  let socket,settled=false,total=0,parts=[],expected,headerBytes,info,signature;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);socket?.destroy();error?reject(error):resolve(result);};
  const cancel=()=>finish(failure('共享像素请求已取消','E_ABORTED'));
  const timer=setTimeout(()=>finish(failure('共享像素来源超时，未切换采集后端','E_PIXEL_SOURCE_TIMEOUT')),Math.max(1,Math.min(3000,timeoutMs)));
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
  void sourceManifest(manifest).then(source=>{
   if(settled)return;const requestId=crypto.randomUUID();socket=net.createConnection(source.socket);
   socket.once('error',()=>finish(failure('共享像素来源连接失败，未切换采集后端')));socket.once('end',()=>{if(!settled)finish(failure('共享像素响应不完整'));});
   socket.once('connect',()=>socket.write(JSON.stringify({protocol:PROTOCOL,token:source.token,requestId,format:'png',...(payload.region?{region:payload.region}:{})})+'\n'));
   socket.on('data',chunk=>{try{
    total+=chunk.length;if(total>MAX_BYTES+8256)throw failure('共享像素响应超限');parts.push(chunk);if(expected===undefined&&total<4||expected!==undefined&&!info&&total<4+expected+64||info&&total<4+expected+64+info.bytes)return;let data=Buffer.concat(parts);
    if(expected===undefined&&data.length>=4){expected=data.readUInt32BE();if(expected<1||expected>8192)throw failure('共享像素响应头无效');}
    if(!info&&expected&&data.length>=4+expected+64){headerBytes=data.subarray(4,4+expected);signature=data.subarray(4+expected,4+expected+64);const mac=Buffer.from(crypto.createHmac('sha256',source.token).update(headerBytes).digest('hex'));if(signature.length!==mac.length||!crypto.timingSafeEqual(signature,mac))throw failure('共享像素响应鉴权失败');info=JSON.parse(headerBytes);if(info.protocol!==PROTOCOL||info.requestId!==requestId)throw failure('共享像素响应身份不符');if(info.ok!==true)throw failure('共享像素来源暂不可用',/^E_PIXEL_[A-Z_]+$/u.test(info.code||'')?info.code:undefined);if(!Number.isSafeInteger(info.bytes)||info.bytes<1||info.bytes>MAX_BYTES)throw failure('共享像素长度无效');}
    if(info&&data.length>=4+expected+64+info.bytes){const image=data.subarray(4+expected+64);if(image.length!==info.bytes||crypto.createHash('sha256').update(image).digest('hex')!==info.sha256)throw failure('共享像素内容完整性核对失败');if(info.backend!=='CGDisplayStream'&&!(allowSynthetic&&info.backend==='Synthetic')||info.format!=='png'||!Number.isFinite(info.capturedAt)||Date.now()-info.capturedAt<0||Date.now()-info.capturedAt>3000||!Number.isSafeInteger(info.width)||!Number.isSafeInteger(info.height)||info.width<1||info.height<1||!info.desktopRect||!['x','y','width','height'].every(k=>Number.isFinite(info.desktopRect[k]))||info.desktopRect.width<=0||info.desktopRect.height<=0)throw failure('共享像素来源类型、尺寸或时效不符合要求');finish(null,{backend:info.backend,capturedAt:info.capturedAt,pixelsUpdatedAt:info.pixelsUpdatedAt,width:info.width,height:info.height,desktopRect:info.desktopRect,pngBase64:image.toString('base64'),source:'shared-display-pixels'});}
   }catch(error){finish(error.code?error:failure('共享像素响应格式无效'));}});
  }).catch(()=>finish(failure('共享像素来源配置或连接不可用，未回落到独立采集')));
 });
}
module.exports={readDisplayPixels,sourceManifest,PROTOCOL};
