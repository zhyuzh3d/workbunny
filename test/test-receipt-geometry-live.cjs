'use strict';
// Recheck saved test pixels only. No input, no WeChat interface, no model call.
const {app,nativeImage}=require('electron'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {DesktopNative}=require('../src/main/desktop-native'),{refineReceipt}=require('../src/main/vision-local'),{validateWechatAction}=require('../src/main/desktop-service');
let native;app.whenReady().then(async()=>{
 const root=process.argv[2],task=JSON.parse(fs.readFileSync(path.join(root,'desktop-wechat.json'),'utf8')),bytes=fs.readFileSync(path.join(root,'latest-physical.png'));
 native=new DesktopNative(path.resolve('bin/desktop'));const ocr=(await native.request('recognize',{pngBase64:nativeImage.createFromBuffer(bytes).toPNG().toString('base64')})).texts;
 const check=(action,scope)=>{try{validateWechatAction(action,scope);return true;}catch{return false;}};const shot={at:Date.now(),ocr,preview:'data:image/png;base64,'+bytes.toString('base64')},action={action:'done',completed:true,receipt:task.lastWeChatReceipt};
 const before=check(action,{...task,hasBeforeSubmit:true,screenshot:shot});
 const refined=refineReceipt(action,shot,task.message,png=>{const image=nativeImage.createFromBuffer(png);return {data:image.toBitmap(),...image.getSize()};});
 assert(refined.receipt.localGeometryVerified);assert(check(refined,{...task,hasBeforeSubmit:true,screenshot:shot}));
 console.log(JSON.stringify({passed:true,originalGeometryPassed:before,nativeOCRAndOutgoingPixels:true,refinedBubble:refined.receipt.bubble,noInput:true}));
 await native.close();app.exit(0);
}).catch(async error=>{console.error(error.stack);await native?.close();app.exit(1);});
