'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadSoftwarePackages}=require('../src/main/software-skill-package');
test('both bundled software packages have verified resources and distinct methods',()=>{
 const packages=loadSoftwarePackages();assert.deepEqual(packages.map(p=>p.id),['workbuddy','wechat']);assert(packages[0].methods.includes('workbuddy-ax'));assert(!packages[1].methods.includes('workbuddy-ax'));assert.match(packages[1].instructions,/500/);
});
test('changing a packaged method invalidates its content identity',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-package-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.cpSync(path.resolve('src/software-skills'),root,{recursive:true});fs.appendFileSync(path.join(root,'wechat/guide.md'),'changed');assert.throws(()=>loadSoftwarePackages(root),/内容发生变化/);
});
test('only actual owner dialogue contributes historical path authorization',()=>{
 const {ownerContext}=require('../src/main/work-order');const context=JSON.stringify([{role:'user',characterId:'Alice',text:'读取 /tmp/alice'},{role:'assistant',content:'读取 /tmp/proposal'},{role:'user',characterId:'owner',content:'在 /tmp/owner 创建结果'}]);assert.equal(ownerContext(context),'在 /tmp/owner 创建结果');assert.equal(ownerContext('raw unstructured context'),'');
});
