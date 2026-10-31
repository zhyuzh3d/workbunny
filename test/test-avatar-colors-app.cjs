'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-colors-preview-')),config=require('../src/main/config');config.setPath(path.join(root,'config.json'));config.save({...(process.argv.includes('--default')?{}:{avatar:'builtin_soft_bunny'}),window:{scale:.5},voice:{enabled:false,alwaysListen:false},tts:{enabled:false},memory:{extract:false}});
 fs.writeFileSync(path.join(root,'.no-restart'),'');fs.writeFileSync(path.join(root,'storage-location.json'),JSON.stringify({format:'workbunny-location/v1',dir:path.join(root,'unavailable','vault')}));
 const wait=(condition,result)=>`(async()=>{for(let i=0;i<140;i++){const s=window.__pet();if(${condition})return ${result};await new Promise(r=>setTimeout(r,100))}throw Error('timeout '+JSON.stringify(window.__pet()))})()`;
 const script=[wait('s.dataAvatar&&!s.loading&&s.hit','({ready:true,avatar:s.avatarKey,palette:s.palette,hit:s.hit,height:innerHeight})'),
  'window.pet.open("settings")',
  '@panel:settings:(()=>{document.querySelector("[data-t=look]").click();return {name:document.querySelector("#avatarSelect option:checked").textContent,colors:[...document.querySelectorAll("#avatarPaletteChoices button")].map(x=>x.title),sizes:[...document.querySelectorAll("#sizeRow button")].filter(x=>!x.hidden).map(x=>x.textContent)}})()',
  '@panel:settings:document.querySelector("#avatarPaletteChoices button[aria-label=黑色]").click()',wait('s.palette==="black"','({black:true})'),
  '@panel:settings:document.querySelector("#avatarPaletteChoices button[aria-label=白色]").click()',wait('s.palette==="white"','({white:true})'),
  '@panel:settings:document.querySelector("#avatarPaletteChoices button[aria-label=天空蓝]").click()',wait('s.palette==="lilac"','({blue:true})'),
  '@panel:settings:document.querySelector("#avatarPaletteChoices button[aria-label=莓果粉]").click()',wait('s.palette==="rose"','({rose:true})'),
  '@panel:settings:document.querySelector("#avatarPaletteChoices button[aria-label=蜜橘黄]").click()',wait('s.palette==="cream"','({cream:true})'),
  '@panel:settings:document.querySelector("#avatarPaletteChoices button[aria-label=葡萄紫]").click()',wait('s.palette==="plum"','({plum:true})'),
  '@panel:settings:document.querySelector("#sizeRow button[data-k="+JSON.stringify("0.25")+"]").click()',wait('innerHeight<500','({halfSize:true,height:innerHeight})'),
  '@panel:settings:document.querySelector("#sizeRow button[data-k="+JSON.stringify("0.5")+"]").click()',wait('innerHeight>=700','({normalSize:true,height:innerHeight})'),
  '@panel:settings:(async()=>{try{await window.pet.config({avatarPalettes:{builtin_soft_bunny:"invalid"}});return {invalidAccepted:true}}catch{return {invalidRejected:true}}})()'];
 fs.writeFileSync(path.join(root,'selftest.json'),JSON.stringify({shotDir:path.join(root,'shots'),delay:6000,every:800,extra:0,script}));const env={...process.env,BUDDY_PET_HOME:root};delete env.ELECTRON_RUN_AS_NODE;const installed=process.argv.includes('--installed'),bundled=installed||process.argv.includes('--bundle');const binary=installed?path.join(os.homedir(),'Applications/workbunny.app/Contents/MacOS/workbunny'):path.resolve(bundled?'dist/workbunny.app/Contents/MacOS/workbunny':'node_modules/.bin/electron');const child=spawn(binary,bundled?[]:['.','--dev'],{env,stdio:'ignore'}),timer=setTimeout(()=>child.kill('SIGTERM'),100000);
 try{const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});const log=fs.readFileSync(path.join(root,'buddy.log'),'utf8');assert.equal(code,0,log.slice(-6000));for(const mark of ['"ready":true','"name":"bunny"','"葡萄紫","莓果粉","天空蓝","蜜橘黄","黑色","白色"','"sizes":["50%","100%","150%","200%"]','"black":true','"white":true','"blue":true','"rose":true','"cream":true','"plum":true','"halfSize":true','"normalSize":true','"invalidRejected":true'])assert(log.includes(mark),mark+'\n'+log.slice(-7000));assert(!log.includes('[selftest] fail')&&!log.includes('ERR:'),log.slice(-7000));console.log(JSON.stringify({ok:true,artifacts:root}));}finally{clearTimeout(timer)}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
