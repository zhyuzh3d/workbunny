'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {runLocalTest}=require('../src/main/boper-diagnostic');
test('synthetic scene guard rejects non-life diagnostics before any app data, window or input access',async()=>{
 for(const scene of [undefined,'private','work']){
  const options={getScene:scene?()=>scene:undefined};
  for(const name of ['boper','BrowserWindow','lease','screen'])Object.defineProperty(options,name,{get(){return name==='boper'?{status:()=>assert.fail('must not probe input before scene approval')}:undefined;}});
  await assert.rejects(runLocalTest(options),/生活场景/);
 }
});
