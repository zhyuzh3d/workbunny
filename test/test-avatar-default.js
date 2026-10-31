'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const config=require('../src/main/config');
test('new profiles start with bunny and existing explicit avatar choices are preserved',t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-default-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const file=path.join(root,'config.json');config.setPath(file);assert.equal(config.load().avatar,'builtin_soft_bunny');config.save({avatar:'AvatarSample_E.vrm'});config.setPath(file);assert.equal(config.load().avatar,'AvatarSample_E.vrm');});
