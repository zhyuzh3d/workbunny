'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const config=require('../src/main/config');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workbunny-settings-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');config.setPath(file);return file;}
test('role settings reach the real dialogue prompt and survive reload without losing private provider fields',t=>{
 const file=fixture(t);assert.equal(config.load().buddy.ownerName,'主人');assert.ok(config.load().buddy.profile.includes('WorkBuddy'));
 config.save({brain:{profiles:{deepseek:{apiKey:'test-deep-key'},grok:{apiKey:'test-grok-key'}}},tts:{apiKey:'test-chp-key',qwen:{modelKind:'customvoice',dir:'/models/custom',voice:'vivian',streaming:true}}});
 config.save({buddy:{name:'果果$&',ownerName:'阿明',profile:'陪我学习法语，回答要简短。'}});config.setPath(file);
 const c=config.load(),prompt=config.buildSystemPrompt('主人说的原始任务内容');assert.equal(c.buddy.name,'果果$&');assert.ok(prompt.includes('你叫「果果$&」'));assert.ok(prompt.includes('陪我学习法语'));assert.ok(prompt.includes('请称呼用户为「阿明」'));assert.ok(prompt.includes('主人说的原始任务内容'));
 assert.equal(c.brain.profiles.deepseek.apiKey,'test-deep-key');assert.equal(c.brain.profiles.grok.apiKey,'test-grok-key');assert.equal(c.tts.apiKey,'test-chp-key');assert.equal(c.tts.qwen.dir,'/models/custom');assert.equal(c.tts.qwen.voice,'vivian');assert.equal(c.tts.qwen.streaming,true);assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.ok(!JSON.stringify(config.publicConfig()).includes('test-chp-key'));
});
test('an unsuccessful atomic replacement leaves both persisted and live settings unchanged',t=>{
 const file=fixture(t);config.save({buddy:{name:'原名'}});const before=fs.readFileSync(file),revision=config.load().settingsRevision,rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===file)throw new Error('fixture rename failure');return rename(from,to)};
 try{assert.throws(()=>config.save({buddy:{name:'不能写入'}}),/设置保存失败/);}finally{fs.renameSync=rename;}
 assert.deepEqual(fs.readFileSync(file),before);assert.equal(config.load().buddy.name,'原名');assert.equal(config.load().settingsRevision,revision);assert.equal(fs.readdirSync(path.dirname(file)).filter(n=>n.endsWith('.tmp')).length,0);
});
