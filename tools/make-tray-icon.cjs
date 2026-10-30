'use strict';
// Run with: env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron tools/make-tray-icon.cjs
const {app,BrowserWindow} = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'workbunny-tray-render-'));
app.setPath('userData',temporary);
app.commandLine.appendSwitch('disable-gpu');
async function render() {
  await app.whenReady();
  const res = path.resolve(__dirname,'../res'), svg = fs.readFileSync(path.join(res,'trayTemplate.svg'));
  const win = new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  await win.loadURL('data:text/html,<meta charset="utf-8">');
  for (const size of [22,44]) {
    const source = 'data:image/svg+xml;base64,'+svg.toString('base64');
    const data = await win.webContents.executeJavaScript(`(async()=>{const im=new Image();im.src=${JSON.stringify(source)};await im.decode();const canvas=document.createElement('canvas');canvas.width=${size};canvas.height=${size};canvas.getContext('2d').drawImage(im,0,0,${size},${size});return canvas.toDataURL('image/png').split(',')[1]})()`);
    fs.writeFileSync(path.join(res,size===22?'trayTemplate.png':'trayTemplate@2x.png'),Buffer.from(data,'base64'));
  }
  win.destroy();
}
render().then(()=>{fs.rmSync(temporary,{recursive:true,force:true});app.exit(0);},error=>{console.error(error.message);app.exit(1);});
