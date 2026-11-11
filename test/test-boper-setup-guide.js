'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {setupGuide,publicGuide}=require('../src/main/boper-setup-guide');
const {BoperService}=require('../src/main/boper-service');
test('driver authorization guidance follows the macOS version while preserving one fixed destination per version',()=>{
 for(const version of ['13.6','14.7.3']){const g=setupGuide(version);assert.match(g.approvalPath,/隐私与安全性/);assert.equal(g.settingsURL,'x-apple.systempreferences:com.apple.preference.security?General');}
 for(const version of ['15.0','26.5.1']){const g=setupGuide(version);assert.match(g.approvalPath,/登录项与扩展/);assert.equal(g.settingsURL,'x-apple.systempreferences:com.apple.LoginItems-Settings.extension');}
 const g=publicGuide(setupGuide('26.5.1'));assert.equal(g.settingsURL,undefined);assert.equal(g.publisher,'Fumihiko Takayama');
});
test('setup guidance remains available before enable and opening it does not load or authorize an input addon',async()=>{
 let opened=0;const g=publicGuide(setupGuide('26.5.1'));const service=new BoperService({setupGuide:g,openSettings:async()=>{opened++;return {opened:true};},control:{status:()=>assert.fail('input addon must not be called')}});
 assert.equal(service.status().enabled,false);assert.deepEqual(service.status().setupGuide,g);await service.openSettings();assert.equal(opened,1);assert.equal(service.proc,null);await service.shutdown();
});
