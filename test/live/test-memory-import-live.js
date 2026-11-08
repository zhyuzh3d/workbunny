'use strict';
// Explicit live acceptance. Synthetic example only; isolated encrypted vault;
// current zero-credit model verified via WorkBuddy's catalogue, never user data.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {MemoryService}=require('../../src/main/memory-service');
async function main(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-import-live-')),key=crypto.randomBytes(32);
 const memory=new MemoryService({dir:path.join(directory,'vault'),bin:path.resolve(__dirname,'../../bin/vault'),openKey:async()=>key,getSettings:()=>({enabled:true,extract:false,scene:'life'})});
 let calls=0;const started=Date.now();
 try{
  await memory.init();assert(memory.ready,memory.error);const model=await require('../../src/main/workbuddy-free').freeModel();
  const request=async options=>{calls++;if(options.messages.at(-1).content.startsWith('上次输出格式无效'))console.log(JSON.stringify({stage:'correction',reason:options.messages.at(-1).content}));console.log(JSON.stringify({stage:'model',call:calls,model}));return {response:await require('../../src/main/workbuddy').chat({...options,model,thinking:'low',maxTokens:4096,timeoutMs:45000,extraBody:{reasoning_effort:'low',response_format:{type:'json_object'}}}),model};};
  const first=await memory.imports.import(path.resolve(__dirname,'../../examples/memory-pack'));
  for(let i=0;i<12;i++){const result=await memory.imports.maintain({request,reserveModelCall:async()=>({ok:calls<6})});const report=(await memory.imports.list({id:first.importId}))[0];console.log(JSON.stringify({stage:'progress',status:report.status,processed:report.processed,total:report.total,counts:report.counts}));if(result==='done')break;if(['paused','budget'].includes(result))throw Error('live import paused: '+report.note);}
  const report=(await memory.imports.list({id:first.importId}))[0];assert.equal(report.status,'completed');assert(report.counts.experiences>0,'must extract a reusable method');assert(report.counts.tools>0,'safe tool should be statically registered');assert((await memory.imports.import(path.resolve(__dirname,'../../examples/memory-pack'))).duplicate);
  console.log(JSON.stringify({passed:true,syntheticOnly:true,calls,ms:Date.now()-started,counts:report.counts,ignored:report.ignored.map(x=>({file:x.file,risk:x.risk,reason:x.reason}))}));
 }finally{await memory.close();key.fill(0);fs.rmSync(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.code||error.name,error.message);process.exitCode=1;});
