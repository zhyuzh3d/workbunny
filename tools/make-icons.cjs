'use strict';
// SVG -> menu bar @1x/@2x, application PNG and macOS ICNS. No graphics dependencies.
// env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron tools/make-icons.cjs
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const {BRAND_ASSETS}=require('./brand-assets.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'workbunny-icons-'));
app.setPath('userData',path.join(temporary,'electron'));app.commandLine.appendSwitch('disable-gpu');
async function main(){
  await app.whenReady();
  const root=path.resolve(__dirname,'..'),asset=key=>path.join(root,BRAND_ASSETS[key]);
  const svg=fs.readFileSync(asset('master'),'utf8');
  const body=svg.slice(svg.indexOf('>')+1,svg.lastIndexOf('</svg>'));
  const product=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><title>Workbunny</title><rect x="64" y="64" width="896" height="896" rx="196" fill="#fff" stroke="#e5e5e5" stroke-width="2"/><g transform="translate(192 160) scale(5)">${body}</g></svg>\n`;
  fs.writeFileSync(asset('traySVG'),svg);fs.writeFileSync(asset('white'),svg.replace('fill="currentColor"','fill="#ffffff"'));fs.writeFileSync(asset('product'),product);
  const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  await win.loadURL('data:text/html,<meta charset="utf-8">');
  async function render(source,size){
    const uri='data:image/svg+xml;base64,'+Buffer.from(source).toString('base64');
    return Buffer.from(await win.webContents.executeJavaScript(`(async()=>{const image=new Image();image.src=${JSON.stringify(uri)};await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=${size};const context=canvas.getContext('2d');const ratio=Math.min(${size}/image.width,${size}/image.height);const w=image.width*ratio,h=image.height*ratio;context.drawImage(image,(${size}-w)/2,(${size}-h)/2,w,h);return canvas.toDataURL('image/png').split(',')[1]})()`),'base64');
  }
  for(const [key,size] of [['tray1x',22],['tray2x',44]])fs.writeFileSync(asset(key),await render(svg,size));
  fs.writeFileSync(asset('applicationPNG'),await render(product,1024));
  const iconset=path.join(temporary,'Workbunny.iconset');fs.mkdirSync(iconset);
  for(const size of [16,32,128,256,512])for(const factor of [1,2])fs.writeFileSync(path.join(iconset,`icon_${size}x${size}${factor===2?'@2x':''}.png`),await render(product,size*factor));
  execFileSync('/usr/bin/iconutil',['-c','icns','-o',asset('applicationICNS'),iconset]);
  win.destroy();console.log('Generated unified SVG, menu bar, PNG and ICNS icons.');
}
main().then(()=>finish(0),error=>{console.error(error.stack);finish(1);});
function finish(code){fs.rmSync(temporary,{recursive:true,force:true});app.exit(code);}
