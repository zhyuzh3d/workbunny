'use strict';
// Read-only model diagnostic against an already captured private screenshot.
const {app,nativeImage}=require('electron'),fs=require('fs'),path=require('path');
const {DesktopNative}=require('../src/main/desktop-native'),{WeChatObserver}=require('../src/main/wechat-observer'),{prepareVisionPreview}=require('../src/main/vision-preview'),wb=require('../src/main/workbuddy');
let native,attempt=0;
app.whenReady().then(async()=>{
 const file=process.argv[2];if(!file)throw Error('private screenshot path required');
 await require('../src/main/model-catalog').refresh('workbuddy');native=new DesktopNative(path.resolve('bin/desktop'));
 const png=fs.readFileSync(file),ocr=(await native.request('recognize',{pngBase64:png.toString('base64')})).texts;
 const observer=new WeChatObserver({native,bitmap:png=>{const i=nativeImage.createFromBuffer(png);return {data:i.toBitmap(),...i.getSize()};},imageResize:buffer=>prepareVisionPreview(nativeImage.createFromBuffer(buffer)),request:async options=>{
  const started=Date.now();try{const response=await wb.chat({...options,model:'hy3',thinking:'low',maxTokens:2048,timeoutMs:25000,extraBody:{reasoning_effort:'no_think',thinking:{type:'disabled'},response_format:{type:'json_object'}}});
   fs.writeFileSync(path.join(path.dirname(file),'probe-response-'+(++attempt)+'.json'),response.text,{mode:0o600});console.log(JSON.stringify({ms:Date.now()-started,usage:response.usage,textBytes:response.text.length}));return {response};
  }catch(error){console.log(JSON.stringify({ms:Date.now()-started,code:error.code,error:error.message,usage:error.usage,hasReasoning:error.hasReasoning}));throw error;}
 }});
 const view=await observer.inspect({recipient:'Alice'},{pngBase64:png.toString('base64'),ocr});
 fs.writeFileSync(path.join(path.dirname(file),'observation-probe.json'),JSON.stringify(view),{mode:0o600});
 console.log(JSON.stringify({passed:true,messages:view.messages.length,verified:view.messages.filter(m=>m.incomingVerified).length}));await native.close();app.exit(0);
}).catch(async error=>{console.error(error.message);await native?.close();app.exit(1);});
