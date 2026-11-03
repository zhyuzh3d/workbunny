'use strict';
// Calibration in our own disposable window. No WeChat lookup, capture or input.
const {app,BrowserWindow,nativeImage,screen}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DesktopNative}=require('../src/main/desktop-native');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-display-region-test-'));fs.chmodSync(dir,0o700);app.setPath('userData',path.join(dir,'electron'));
let window,native;
async function run(){
 await app.whenReady();
 window=new BrowserWindow({x:1200,y:150,width:320,height:240,frame:false,resizable:false,show:false,webPreferences:{sandbox:true}});
 await window.loadURL('data:text/html,'+encodeURIComponent('<style>html,body{margin:0;width:100%;height:100%}body{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}i:nth-child(1){background:rgb(220,30,40)}i:nth-child(2){background:rgb(30,210,50)}i:nth-child(3){background:rgb(35,60,220)}i:nth-child(4){background:rgb(220,200,30)}</style><i></i><i></i><i></i><i></i>'));
 window.show();window.focus();app.focus({steal:true});await new Promise(r=>setTimeout(r,900));
 native=new DesktopNative(path.resolve('bin/desktop'));
 const rect=window.getContentBounds(),scale=screen.getDisplayMatching(rect).scaleFactor;
 const samples=[];
 for(let attempt=0;attempt<3;attempt++){
  const result=await native.request('capture',{captureMode:'displayStream',region:rect,output:'base64'});
  assert.deepEqual(result.desktopRect,rect);assert.equal(result.width,rect.width*scale);assert.equal(result.height,rect.height*scale);
  const image=nativeImage.createFromBuffer(Buffer.from(result.pngBase64,'base64')),pixels=image.getBitmap();
  const expected=[[.25,.25,[220,30,40]],[.75,.25,[30,210,50]],[.25,.75,[35,60,220]],[.75,.75,[220,200,30]]];
  for(const [x,y,wanted]of expected){const offset=(Math.floor(y*result.height)*result.width+Math.floor(x*result.width))*4;
   const rgb=[pixels[offset+2],pixels[offset+1],pixels[offset]];
   assert(rgb.every((v,i)=>Math.abs(v-wanted[i])<45),JSON.stringify({x,y,rgb,wanted}));
  }
  samples.push({backend:result.backend,width:result.width,height:result.height,ageMs:Date.now()-result.capturedAt});
 }
 console.log(JSON.stringify({passed:true,regionalOutput:true,ownFixtureOnly:true,samples}));
}
run().then(()=>finish(0),error=>{console.error(error.stack);return finish(1);});
async function finish(code){await native?.close();window?.destroy();app.exit(code);}
