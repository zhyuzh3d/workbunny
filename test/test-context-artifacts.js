'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {collectDeliveryEvidence}=require('../src/main/delivery-evidence');
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bunny-context-files-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('natural path-before-verb instructions authorize their actual output, while a negation does not',async t=>{
 const root=await fixture(t),file=path.join(root,'output.txt');await fs.writeFile(file,'actual');const valid=await collectDeliveryEvidence({userRequest:'请在 '+file+' 创建UTF-8文件'});assert.equal(valid.files[0].role,'artifact');assert(valid.files[0].sha256);assert.deepEqual(valid.requiredOutputs,[file]);
 const denied=await collectDeliveryEvidence({userRequest:'不要在 '+file+' 创建文件'});assert.equal(denied.files.length,0);
});
test('contextual approval retains only paths relevant to the current execution goal',async t=>{
 const root=await fixture(t),first=path.join(root,'old.txt'),second=path.join(root,'latest.txt');await fs.writeFile(first,'old');await fs.writeFile(second,'latest');
 const evidence=await collectDeliveryEvidence({userRequest:'按刚才这个方案做',authorizationContext:'先在 '+first+' 创建实验文件。\n新的方案，在 '+second+' 生成实验文件。',goal:'生成实验文件 '+second,monitorSummary:'成果：'+second});assert.equal(evidence.files.length,1);assert.equal(evidence.files[0].path,second);assert.equal(evidence.files[0].role,'artifact');
});
test('a host-owned task output directory collects reported products without treating other local files as products',async t=>{
 const root=await fixture(t),out=path.join(root,'task-output'),foreign=path.join(root,'other.txt');await fs.mkdir(out);const report=path.join(out,'report.docx');await fs.writeFile(report,Buffer.alloc(512*1024,0));await fs.writeFile(foreign,'other');
 const task={workProductionOnly:true,userRequest:'生成一份报告',authorizedArtifactRoots:[out],monitorSummary:'文件 '+report+'；另外 '+foreign};const evidence=await collectDeliveryEvidence(task);assert.equal(evidence.files.length,1);assert.equal(evidence.files[0].authorizedBy,'task-output-directory');assert.equal(evidence.files[0].role,'artifact');assert(evidence.files[0].sha256);
 assert.equal((await collectDeliveryEvidence({...task,workProductionOnly:false})).files.length,0);
});
test('read-only input evidence is not automatically attached as a produced result',()=>{
 const {workResult}=require('../src/main/task-result');const physical={artifactManifest:{files:[{path:'/input.js',role:'evidence'},{path:'/report.md',role:'artifact'}]}};assert.deepEqual(workResult(physical).artifacts.map(f=>f.path),['/report.md']);assert.equal(workResult({...physical,deliverEvidenceFiles:true}).artifacts.length,2);
});
test('task dialogue context is bounded as valid messages rather than a sliced JSON fragment',()=>{
 const {encodeContext,ownerContext}=require('../src/main/work-order');const messages=Array.from({length:12},(_,i)=>({role:'user',characterId:'owner',content:String(i)+'x'.repeat(2400)}));messages[11].content='最新的任务路径 /tmp/latest.txt';const encoded=encodeContext(messages);assert(encoded.length<=12000);assert(Array.isArray(JSON.parse(encoded)));assert(ownerContext(encoded).includes('/tmp/latest.txt'));
});
