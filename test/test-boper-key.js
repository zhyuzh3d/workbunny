'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateKey,createKey}=require('../src/main/boper-key');
const {BoperService}=require('../src/main/boper-service');
const {BoperClient}=require('../src/main/boper-client');
test('keys use 24 base64url characters and malformed keys fail before native access',()=>{
 assert.equal(validateKey(createKey()).length,24);
 for(const key of ['',null,'a'.repeat(23),'a'.repeat(25),'汉'.repeat(24),'a'.repeat(23)+'\n','a'.repeat(24)+'\n'])assert.throws(()=>new BoperClient({key}),{code:'E_BOPER_KEY'});
});
test('Bunny persists its group key across developer process restarts without returning it in status',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boper-key-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'boper.json');fs.writeFileSync(file,JSON.stringify({enabled:false}));
 const a=new BoperService();a.configure({stateFile:file});
 const key=JSON.parse(fs.readFileSync(file)).key;validateKey(key);assert.equal(fs.statSync(file).mode&0o777,0o600);
 const b=new BoperService();b.configure({stateFile:file});assert.equal(b.key,key);assert(!JSON.stringify(b.status()).includes(key));
 await a.shutdown();await b.shutdown();
});
test('separate callers intentionally sharing a key can query and stop that group',async()=>{
 const key=createKey(),other=createKey();let active=true;
 const control={status:async p=>({ready:true,groupActive:active&&p.key===key}),revokeSession:async p=>{if(p.key!==key)throw Object.assign(Error('Other group'),{code:'E_SESSION_MISMATCH'});active=false;return {releaseConfirmed:true};}};
 const a=new BoperClient({key,control}),b=new BoperClient({key,control}),c=new BoperClient({key:other,control});
 assert.equal((await a.status()).groupActive,true);assert.equal((await c.status()).groupActive,false);
 await assert.rejects(c.stop(),{code:'E_SESSION_MISMATCH'});assert.equal((await a.status()).groupActive,true);
 await c.close();assert.equal((await b.status()).groupActive,true,'closing an observer does not stop another caller');
 assert.equal((await b.stop()).releaseConfirmed,true);assert.equal((await a.status()).groupActive,false);
 await a.close();await b.close();
});
