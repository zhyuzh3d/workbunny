'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {verifyDelivery}=require('../src/main/secretary'),{collectDeliveryEvidence}=require('../src/main/delivery-evidence');
const answer=v=>({response:{text:JSON.stringify(v)},model:'fixture'});
test('file availability is evidence for Bunny instead of a program-authored business verdict',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bunny-review-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'missing.txt');let calls=0;
 const result=await verifyDelivery({task:{userRequest:'请创建 '+file,goal:'创建实际文件',monitorSummary:'done'},request:async options=>{calls++;const input=JSON.parse(options.messages[1].content[0].text);assert(input.localDelivery.availability.missing.includes(file));return answer({verdict:'revise',report:'实际文件还没有生成。',followUp:'请继续原目标并核对实际文件。'});}});assert.equal(calls,1);assert.equal(result.verdict,'revise');
 const website=await verifyDelivery({task:{userRequest:'创建平台网页并提供实际链接。',goal:'创建平台网页',expectsArtifacts:true,monitorSummary:'真实网页交付材料'},request:async()=>answer({verdict:'pass',report:'平台网页制作已完成。'})});assert.equal(website.verdict,'pass');assert.deepEqual(website.artifactManifest.files,[],'a coarse files hint cannot overrule Bunny’s delivery judgment');
});
test('postposed Chinese write instructions produce real evidence without requiring a special wording',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bunny-paths-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'acceptance.json');await fs.writeFile(file,'{"fixture":true}');
 const result=await collectDeliveryEvidence({userRequest:`代码和验收记录只写在 ${root}/ 。最后在 ${file} 写实际结果。`,monitorSummary:'acceptance.json 已保存。'});assert.deepEqual(result.requiredOutputs,[file]);assert(result.files.some(f=>f.path===file&&f.sha256&&f.role==='artifact'));
});
test('changed evidence invalidates the observation, preserving the task for fresh autonomous review',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bunny-review-change-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'result.txt');await fs.writeFile(file,'before');
 await assert.rejects(verifyDelivery({task:{goal:'创建文件',userRequest:'请创建 '+file},request:async()=>{await fs.writeFile(file,'changed after observation');return answer({verdict:'pass',report:'fixture'});}}),e=>e.code==='E_EVIDENCE_CHANGED'&&e.dispatched===false);
});
