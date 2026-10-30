'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const library = require('../src/main/asset-library'), avatars = require('../src/main/avatars'), config = require('../src/main/config');
const model = path.resolve('src/renderer/assets/models/AvatarSample_D.vrm');
test('personal model imports survive filename conflicts and reload, without modifying a shipped model', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-assets-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 config.setPath(path.join(root,'config.json'));
 assert.equal(avatars.scan().length,4);assert.deepEqual(avatars.scan().map(a=>a.label),['可可','阿雅','琪琪','美莉']);assert(avatars.scan().every(a=>!/[\u3040-\u30ff]/u.test(a.title+a.label+a.author)));
 const key=library.importModel(model);assert.equal(library.importModel(model),key);assert.equal(fs.readFileSync(path.join(root,'avatars',key)).compare(fs.readFileSync(model)),0);
 const changed=path.join(root,'AvatarSample_D.vrm');fs.copyFileSync('src/renderer/assets/models/AvatarSample_E.vrm',changed);
 const second=library.importModel(changed);assert.notEqual(second,key);assert.equal(library.importModel(changed),second);
 config.setPath(path.join(root,'config.json'));const personal=avatars.scan().find(a=>a.key===second);
 assert(personal.personal);assert(personal.url.startsWith('file:'));assert.equal(avatars.resolve(second),second);
 const named=path.join(root,'constructor.vrm');fs.copyFileSync(model,named);const namedKey=library.importModel(named);const namedView=avatars.scan().find(a=>a.key===namedKey);assert.equal(namedView.label,'constructor');assert.equal(namedView.light,1);assert.deepEqual(namedView.hiddenMeshes,[]);
 const link=path.join(root,'linked.vrm');fs.symlinkSync(model,link);assert.throws(()=>library.importModel(link),/请选择/);
 const bad=path.join(root,'bad.vrm');fs.writeFileSync(bad,'not a model');assert.throws(()=>library.importModel(bad),/请选择/);
});
test('public assets have proof and per-file terms; withheld bytes cannot enter the copied application',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-assets-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const manifest=require('../resources-manifest.json');assert.equal(manifest.assets.filter(a=>a.path.endsWith('.vrm')).length,4);
 assert.equal(manifest.assets.filter(a=>a.path.endsWith('.vrma')).length,18);
 for(const m of manifest.assets.filter(a=>a.path.endsWith('.vrma'))){assert(m.evidence.binEqual&&m.evidence.structuralEqual);assert(m.license);}
 require('child_process').execFileSync(process.execPath,['tools/copy-release-resources.js',root]);
 for(const m of manifest.privateAssets)assert(!fs.existsSync(path.join(root,m.path)),m.key);
 assert(!fs.existsSync(path.join(root,'src/renderer/assets/models/58.vrm')));
 assert(fs.existsSync(path.join(root,'licenses/CC-BY-4.0.txt')));
 config.setPath(path.join(root,'settings/config.json'));assert.equal(config.MOTIONS.length,18);
 for(const m of config.MOTIONS)assert(fs.existsSync(path.resolve('src/renderer/assets/motions',m.key+'.vrma')));
});
