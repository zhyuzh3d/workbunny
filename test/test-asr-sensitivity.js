'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
test('the saved hearing sensitivity reaches native options, including the conservative zero level',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-hearing-')),config=require('../src/main/config');
 config.setPath(path.join(directory,'config.json'));
 try{
  assert.equal(config.load().asr.sensitivity,1);
  for(const invalid of [-1,3,0.5,'1',null])assert.throws(()=>config.save({asr:{sensitivity:invalid}}),/敏感度/);
  const source=fs.readFileSync('src/main/index.js','utf8'),ctx={config,speechTraceEnabled:false,require:require('node:module').createRequire(path.resolve('src/main/index.js'))};
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function asrOpts('),source.indexOf('function startListen(')),ctx);
  for(const sensitivity of [0,1,2]){config.save({asr:{sensitivity}});assert.equal(ctx.asrOpts(true).sensitivity,sensitivity);}
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('retired response-judgment settings are discarded on load, preview and save',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-hearing-legacy-')),config=require('../src/main/config'),file=path.join(directory,'config.json');
 try{
  for(const judge of [false,true]){
   fs.writeFileSync(file,JSON.stringify({asr:{judge,wakeOnly:true,sensitivity:0}}));config.setPath(file);
   assert.equal(Object.hasOwn(config.load().asr,'judge'),false);
   assert.equal(Object.hasOwn(config.publicConfig().asr,'judge'),false);
   assert.equal(Object.hasOwn(config.preview({asr:{judge}}).asr,'judge'),false);
   config.save({asr:{judge}});const stored=JSON.parse(fs.readFileSync(file,'utf8'));
   assert.equal(Object.hasOwn(stored.asr,'judge'),false);assert.equal(stored.asr.wakeOnly,true);assert.equal(stored.asr.sensitivity,0);
  }
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
