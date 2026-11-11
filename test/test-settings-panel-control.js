'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFile}=require('node:child_process');
const {SETTINGS_TABS,SETTINGS_TAB_NAMES,openSettingsPanel}=require('../src/main/settings-panel');
const {LocalControl,ownerMethods,socketPath}=require('../src/main/local-control');
function windowFixture(loading=false){const sent=[],opened=[];const webContents=new EventEmitter();webContents.isLoading=()=>loading;webContents.send=(...args)=>sent.push(args);const window={webContents,isDestroyed:()=>false};return {sent,opened,window,openPanel:kind=>{opened.push(kind);return window;}};}
test('settings tabs follow the existing UI and system selects its data page without arbitrary code',()=>{
 assert.deepEqual(SETTINGS_TABS,['look','persona','scene','ear','brain','mouth','keymouse','data']);assert(SETTINGS_TAB_NAMES.includes('system'));assert(SETTINGS_TAB_NAMES.includes('keymouse'));
 const f=windowFixture();assert.deepEqual(openSettingsPanel({...f,tab:'system'}),{opened:true,tab:'data'});assert.deepEqual(f.opened,['settings']);assert.deepEqual(f.sent,[['pet:ev',{type:'settings-tab',tab:'data'}]]);
 const before=f.opened.length;for(const tab of ['unknown','javascript:alert(1)',{},'../../private'])assert.throws(()=>openSettingsPanel({...f,tab}),{code:'E_LOCAL_PARAMS'});assert.equal(f.opened.length,before);
});
test('new panel tab delivery waits for its own page load; default opening preserves the selected page',()=>{
 const f=windowFixture(true);openSettingsPanel({...f,tab:'system'});assert.equal(f.sent.length,0);f.window.webContents.emit('did-finish-load');assert.equal(f.sent[0][1].tab,'data');const n=f.sent.length;assert.deepEqual(openSettingsPanel(f),{opened:true,tab:null});assert.equal(f.sent.length,n);
});
test('settings_open works through the same MCP CLI/registry and validates the existing tab schema',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wbsettings-')),f=windowFixture(),server=new LocalControl({userData:root,methods:ownerMethods({getScene:()=> 'life',setScene:async()=>{},boperControl:async()=>({}),settingsTabs:SETTINGS_TAB_NAMES,openSettings:tab=>openSettingsPanel({...f,tab})})});await server.start();t.after(async()=>{await server.close();await fs.rm(root,{recursive:true,force:true});});
 const result=await new Promise((resolve,reject)=>execFile(process.execPath,[path.join(__dirname,'../tools/bunnyctl.cjs'),'--socket',socketPath(root),'settings','open','--params','{"tab":"system"}'],{timeout:5000},(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve(JSON.parse(stdout))));assert.equal(result.isError,false);assert.deepEqual(result.structuredContent,{opened:true,tab:'data'});assert.deepEqual(f.sent,[['pet:ev',{type:'settings-tab',tab:'data'}]]);
 const source=await fs.readFile(path.join(__dirname,'../src/renderer/panel.js'),'utf8');assert(source.indexOf("ev.type==='settings-tab'")<source.indexOf('(async function boot()'));assert.match(source,/showTab\(requestedSettingsTab\|\|/);
});
