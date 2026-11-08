'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {fixture,packFixture}=require('./support/experience-fixture.cjs');
const response=value=>async()=>({response:{text:JSON.stringify(value)}});
async function absorb(repo){
 for(let i=0;i<20;i++){
  const pending=await repo.heads({pending:true,limit:1});if(!pending.length)return;
  const result=await repo.maintain({request:async options=>{const input=JSON.parse(options.messages.at(-1).content);return {response:{text:JSON.stringify({action:'keep',ids:[input.current],instructions:'',reason:'已核对来源、适用条件与方法边界，供按情景参考'})}};}});
  if(result==='done')return;
 }
 throw Error('absorption did not converge');
}

test('folder and enclosing-folder ZIP import share checksums, exact deduplication and pinned tool resources',async t=>{
 const {dir,memory,repo}=await fixture(t),folder=path.join(dir,'pack');packFixture(folder);
 let result=await repo.import(folder);assert.equal(result.experiences,1);assert.equal(result.tools,1);
 result=await repo.import(folder);assert(result.duplicate);
 const zip=path.join(dir,'pack.zip');execFileSync('/usr/bin/zip',['-qr',zip,'pack'],{cwd:dir});assert((await repo.import(zip)).duplicate);
 assert.equal((await repo.search({query:'software:demo'})).length,0,'imports are not used before absorption');await absorb(repo);
 const rows=await repo.search({query:'software:demo'});assert.equal(rows.length,1);assert.equal(rows[0].value.status,'candidate');
 const tool=await repo.readTool(rows[0].value.toolRefs[0]);assert(fs.existsSync(tool.path));assert.equal(tool.runtime,'node');assert.equal(fs.readFileSync(tool.path,'utf8'),'process.stdout.write("fixture-only")');
 assert.equal((await memory.knowledge.list({category:'experience'})).rows.length,1);
 fs.chmodSync(tool.path,0o600);fs.writeFileSync(tool.path,'changed');await assert.rejects(repo.readTool(rows[0].value.toolRefs[0]),/校验/);
});
test('new source versions coexist until semantic absorption; invalidated content is not resurrected by reimport',async t=>{
 const {dir,repo}=await fixture(t),folder=path.join(dir,'pack');packFixture(folder,{tool:false});await repo.import(folder);await absorb(repo);
 let rows=await repo.search({query:'software:demo'});const first=rows[0];await repo.feedback(first.id,{taskId:'proof-of-failure',outcome:'failure'});
 await repo.maintain({request:response({action:'invalidate',ids:[first.id],instructions:'',reason:'已被明确证实失效'})});assert.equal((await repo.search({query:'software:demo'})).length,0);
 packFixture(folder,{version:'2.0.0',tool:false});await repo.import(folder);assert.equal((await repo.search({query:'software:demo'})).length,0);
 packFixture(folder,{version:'3.0.0',tool:false,body:'新版应重新观察目标区域，按情景决定核查节奏。'});await repo.import(folder);assert.equal((await repo.search({query:'software:demo'})).length,0);await absorb(repo);assert.equal((await repo.search({query:'software:demo'})).length,1);
});
test('Dream merges only snapshotted scoped evidence, preserves tool references and avoids source revision chains',async t=>{
 const {repo,memory}=await fixture(t);const a=await repo.put({instructions:'画面暂时不变时，考虑客观处理时间。',tags:['software:demo']},{scene:'work'}),b=await repo.put({instructions:'不要机械核查，每组操作按情景安排检查。',tags:['software:demo']},{scene:'work'});
 let reserves=0;await repo.maintain({reserveModelCall:async()=>{reserves++;return {ok:true};},request:response({action:'merge',ids:[a.row.id,b.row.id],instructions:'连续操作按情景安排检查；画面暂时不变时给客观处理留时间。',reason:'两条方法互补，均为参考'})});
 const rows=await repo.search({query:'software:demo'});assert.equal(rows.length,1);assert.equal(rows[0].value.status,'candidate');assert.equal(rows[0].value.consolidatedFrom.length,2);assert.deepEqual(rows[0].value.sources,[]);assert.equal(reserves,1);
 assert.equal(await repo.maintain({request:()=>{throw Error('no work');}}),'done');
 const heads=await Promise.all([repo.get(a.head.id),repo.get(b.head.id)]);const old=heads.find(h=>h.value.status==='superseded');assert(old);assert.equal(old.value.mergedInto,rows[0].value.headId);assert.equal(rows[0].value.revision,2);
 await memory.remove(rows[0].value.headId);assert.equal((await repo.search({query:'software:demo'})).length,0);
});
test('reflection is discarded after source change or vault generation change; private content never becomes experience',async t=>{
 const {memory,repo}=await fixture(t);await assert.rejects(repo.put({instructions:'private',tags:[]},{scene:'private'}),/私聊/);
 const a=await repo.put({instructions:'候选方法',tags:['demo']},{scene:'work'});
 const result=await repo.maintain({request:async()=>{memory.generation++;return {response:{text:JSON.stringify({action:'invalidate',ids:[a.row.id],instructions:'',reason:'stale'})}};}});assert.equal(result,'paused');assert.equal((await repo.search({query:'demo'})).length,1);
});
test('a preparing import exposes no partially installed experience or tool and resumes without duplicates',async t=>{
 const {dir,repo}=await fixture(t),folder=path.join(dir,'pack');packFixture(folder);const put=repo.put.bind(repo);let fail=true;
 repo.put=async(...args)=>{const result=await put(...args);if(fail){fail=false;throw Error('interrupted');}return result;};
 await assert.rejects(repo.import(folder),/interrupted/);assert.equal((await repo.search({query:'software:demo'})).length,0);
 assert.equal(await repo.maintain({request:()=>{throw Error('pending imports must not be reviewed');}}),'done');
 await repo.import(folder);assert.equal((await repo.search({query:'software:demo'})).length,0);await absorb(repo);assert.equal((await repo.search({query:'software:demo'})).length,1);
});
test('encrypted portable backup carries tool files and stable references across a new vault key',async t=>{
 const {dir,memory,repo}=await fixture(t),folder=path.join(dir,'pack');packFixture(folder);await repo.import(folder);await absorb(repo);
 const original=(await repo.search({query:'software:demo'}))[0],backup=await memory.export('portable-fixture-password');
 const {MemoryService}=require('../src/main/memory-service'),other=new MemoryService({dir:path.join(dir,'restored'),bin:path.resolve('bin/vault'),openKey:async()=>Buffer.alloc(32,94),getSettings:()=>({enabled:true,extract:false,scene:'life'})});await other.init();t.after(()=>other.close());await other.restore(backup,'portable-fixture-password');
 const rows=await other.experienceRepository.search({query:'software:demo'});assert.equal(rows.length,1);assert.equal(rows[0].id,original.id);assert(fs.existsSync((await other.experienceRepository.readTool(rows[0].value.toolRefs[0])).path));
 assert((await other.experienceRepository.import(folder)).duplicate);assert.equal((await other.experienceRepository.search({query:'software:demo'})).length,1);
 await other.experienceRepository.feedback(rows[0].id,{taskId:'after-restore',outcome:'failure',note:'test'});assert.equal((await other.experienceRepository.search({query:'software:demo'}))[0].value.feedback.length,1);
});
test('self-created packages use the task scope and cannot be reintroduced into their own source task',async t=>{
 const {dir,memory,repo}=await fixture(t),folder=path.join(dir,'pack');packFixture(folder);
 await memory.write([{id:'source-task',kind:'task',ts:Date.now(),domain:'life',visibilityFloor:1,value:{sources:[]}}]);await repo.import(folder,{sourceTaskId:'source-task'});await absorb(repo);
 assert.equal((await repo.search({query:'software:demo',scene:'work'})).length,0);assert.equal((await repo.search({query:'software:demo',scene:'life'})).length,1);assert.equal((await repo.search({query:'software:demo',excludeTaskId:'source-task'})).length,0);
});
test('import rejects traversal, undeclared files, symlinks and modified resources before executing anything',async t=>{
 const {dir,repo}=await fixture(t),folder=path.join(dir,'pack');let m=packFixture(folder);fs.writeFileSync(path.join(folder,'experience.md'),'modified');await assert.rejects(repo.import(folder),/校验/);
 m=packFixture(folder);fs.writeFileSync(path.join(folder,'extra.txt'),'undeclared');await assert.rejects(repo.import(folder),/未声明/);fs.unlinkSync(path.join(folder,'extra.txt'));
 fs.symlinkSync('/tmp',path.join(folder,'link'));await assert.rejects(repo.import(folder),/符号链接/);fs.unlinkSync(path.join(folder,'link'));
 m.resources[0].path='../escape.md';fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(m));await assert.rejects(repo.import(folder),/path/);
});
