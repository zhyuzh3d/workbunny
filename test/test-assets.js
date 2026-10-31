'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const library = require('../src/main/asset-library'), avatars = require('../src/main/avatars'), config = require('../src/main/config');
const model = path.resolve('src/renderer/assets/models/AvatarSample_D.vrm');
test('personal model imports survive filename conflicts and reload, without modifying a shipped model', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-assets-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 config.setPath(path.join(root,'config.json'));
 assert.equal(avatars.scan().length,6);assert.deepEqual(avatars.scan().map(a=>a.label),['芭尼','可可','兰兰','阿雅','琪琪','美莉']);assert(avatars.scan().every(a=>!/[\u3040-\u30ff]/u.test(a.title+a.label+a.author)));
 const bani=avatars.scan()[0];assert.equal(bani.key,'Bani.vrm');assert.equal(bani.personal,undefined);assert(library.STOCK_MODELS.has(bani.key));assert.equal(avatars.resolve(bani.key),bani.key);
 const data=library.validateModel(path.join(avatars.MODELS_DIR,bani.file));const gltf=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString());const meta=gltf.extensions.VRMC_vrm.meta;assert.equal(meta.avatarPermission,'everyone');assert.equal(meta.commercialUsage,'corporation');assert.equal(meta.allowRedistribution,true);assert.equal(meta.modification,'allowModificationRedistribution');assert.match(meta.thirdPartyLicenses,/AvatarSample D/);
 const coco2=avatars.scan()[2];assert.equal(coco2.key,'AvatarSample_Shino.vrm');assert.equal(coco2.personal,undefined);assert.equal(avatars.readMeta(path.join(avatars.MODELS_DIR,coco2.file)).license,'CC0');assert(library.STOCK_MODELS.has(coco2.key));assert.equal(avatars.resolve(coco2.key),coco2.key);
 const key=library.importModel(model);assert.equal(library.importModel(model),key);assert.equal(fs.readFileSync(path.join(root,'avatars',key)).compare(fs.readFileSync(model)),0);
 const changed=path.join(root,'AvatarSample_D.vrm');fs.copyFileSync('src/renderer/assets/models/AvatarSample_E.vrm',changed);
 const second=library.importModel(changed);assert.notEqual(second,key);assert.equal(library.importModel(changed),second);
 config.setPath(path.join(root,'config.json'));const personal=avatars.scan().find(a=>a.key===second);
 assert(personal.personal);assert(personal.url.startsWith('file:'));assert.equal(avatars.resolve(second),second);
 const named=path.join(root,'constructor.vrm');fs.copyFileSync(model,named);const namedKey=library.importModel(named);const namedView=avatars.scan().find(a=>a.key===namedKey);assert.equal(namedView.label,'constructor');assert.equal(namedView.light,1);assert.deepEqual(namedView.hiddenMeshes,[]);
 const link=path.join(root,'linked.vrm');fs.symlinkSync(model,link);assert.throws(()=>library.importModel(link),/请选择/);
 const bad=path.join(root,'bad.vrm');fs.writeFileSync(bad,'not a model');assert.throws(()=>library.importModel(bad),/请选择/);
});
test('reviewed assets are auditable and known restricted assets cannot enter the copied application',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-assets-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const manifest=require('../resources-manifest.json');assert.equal(manifest.assets.filter(a=>a.path.endsWith('.vrm')).length,6);
 const motions=manifest.assets.filter(a=>a.path.endsWith('.vrma')); assert.equal(motions.length,235);
 for(const m of motions){assert(m.reviewedAsset);assert(m.license);assert(m.sourceMotion);if(m.redistribution==='unverified')assert.equal(m.selectedForRelease,true);else assert.equal(m.redistribution,'allowed');}
 require('child_process').execFileSync(process.execPath,['tools/copy-release-resources.js',root]);
 const {verifyBundle}=require('../tools/verify-bundle.cjs');
 assert.deepEqual({models:verifyBundle(root).models,motions:verifyBundle(root).motions},{models:6,motions:235});
 const manifestFile=path.join(root,'resources-manifest.json'),complete=fs.readFileSync(manifestFile,'utf8'),partial=JSON.parse(complete);
 partial.assets=partial.assets.filter(a=>!a.path.endsWith('.vrma')).concat(partial.assets.filter(a=>a.path.endsWith('.vrma')).slice(0,18));
 fs.writeFileSync(manifestFile,JSON.stringify(partial));assert.throws(()=>verifyBundle(root),/资源数量与当前审核清单不一致/);fs.writeFileSync(manifestFile,complete);
 for(const m of manifest.privateAssets)assert(!fs.existsSync(path.join(root,m.path)),m.key);
 assert(!fs.existsSync(path.join(root,'src/renderer/assets/models/58.vrm')));
 assert(fs.existsSync(path.join(root,'licenses/CC-BY-4.0.txt')));
 config.setPath(path.join(root,'settings/config.json'));assert.equal(config.MOTIONS.length,235);
 for(const m of config.MOTIONS)assert(fs.existsSync(path.resolve('src/renderer/assets/motions',m.key+'.vrma')));
});
