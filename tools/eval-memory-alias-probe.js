'use strict';
// Replay only synthetic aliases returned by a zero-credit hy3 probe. The
// matching fixed queries are never supplied to the generator.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {MemoryService}=require('../src/main/memory-service');
const {fixedRecords,fixedQueries,scaleRecords}=require('./eval-memory-boundaries');
const root=path.resolve(__dirname,'..'),bin=path.join(root,'bin','vault');
const modelAliases={
  'rel-linmei-cousin':['我的表妹林梅负责社区花园浇水系统','林梅作为我表妹管社区花园浇水'],
  'rel-jordan-archivist':['柏林档案员Jordan保管北方仓库钥匙','Jordan是柏林档案员且管北方仓库钥匙'],
  'rel-jordan-player':['Jordan的公牛队23号球衣收藏在书房','书房里收藏着Jordan公牛队23号球衣'],
  'rel-ava-doctor':['我的医生Ava在湖景诊所工作','Ava作为我的医生在湖景诊所上班'],
  'rel-ava-neighbor':['邻居Ava每周帮忙照看我的花园','我的花园由邻居Ava每周照看'],
  'task-mira-pump':['我和Mira约好春季集市后修社区花园水泵','春季集市后我和Mira修好社区花园水泵'],
};
function fakeStorage(){const k=crypto.randomBytes(32);return{isEncryptionAvailable:()=>true,encryptString(s){const n=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',k,n),d=Buffer.concat([c.update(s),c.final()]);return Buffer.concat([n,c.getAuthTag(),d]);},decryptString(b){const d=crypto.createDecipheriv('aes-256-gcm',k,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString();}};}
async function create(temp,label,withAliases){
  const svc=new MemoryService({dir:path.join(temp,label),bin,safeStorage:fakeStorage(),getSettings:()=>({enabled:true,extract:false}),clock:()=>Date.UTC(2026,9,26,12)});
  await svc.init();assert(svc.db,svc.error);
  for(const [rid,kind,content,memoryKind,opts={}] of fixedRecords){
    const sid=`src-${rid}`,aliases=withAliases?(modelAliases[rid]||[]):[];
    await svc.write([{id:sid,kind:'message',ts:opts.ts||Date.UTC(2026,9,26,12)-100000,value:{role:'user',content,sources:[]}}]);
    const record={id:rid,kind:'memory',ts:opts.ts||Date.UTC(2026,9,26,12)-100000,state:opts.state||'active',expiresAt:opts.expiresAt||null,
      value:{content,memoryKind,status:'confirmed',importance:0.6,sources:[sid],...(aliases.length?{searchAliases:aliases}:{})}};
    if(aliases.length)record.searchText=`${content} ${aliases.join(' ')}`;
    await svc.write([record]);
  }
  for(let i=0;i<scaleRecords.length;i+=200)await svc.write(scaleRecords.slice(i,i+200).map(([id,kind,content,memoryKind,opts={}])=>({id,kind,ts:opts.ts,value:{content,memoryKind,status:'confirmed',importance:0.5,sources:[]}})));
  return svc;
}
async function main(){
  execFileSync(path.join(__dirname,'build-vault.sh'),{cwd:root,stdio:'ignore'});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-alias-probe-'));let baseline,withAliases;
  try{
    baseline=await create(temp,'baseline',false);withAliases=await create(temp,'aliases',true);
    const results=[];
    for(const q of fixedQueries){if(!q.target)continue;
      const a=await baseline.search(q.q,['memory'],5),b=await withAliases.search(q.q,['memory'],5);
      const ar=a.findIndex(x=>x.id===q.target),br=b.findIndex(x=>x.id===q.target);
      results.push({query:q.id,baseRank:ar<0?null:ar+1,aliasRank:br<0?null:br+1,top1Before:a[0]?.id||null,top1After:b[0]?.id||null});
      const context=await withAliases.context(q.q,{budget:4000});
      const texts=Object.values(modelAliases).flat();
      assert(!texts.some(alias=>context.text.includes(alias)),'search aliases must never be inserted into model context');
    }
    const before=results.filter(x=>x.baseRank!==null).length,after=results.filter(x=>x.aliasRank!==null).length;
    const improvements=results.filter(x=>x.baseRank===null&&x.aliasRank!==null||x.baseRank!==null&&x.aliasRank!==null&&x.aliasRank<x.baseRank).map(x=>x.query);
    const regressions=results.filter(x=>x.baseRank!==null&&(x.aliasRank===null||x.aliasRank>x.baseRank)).map(x=>x.query);
    console.log(JSON.stringify({model:'hy3',reportedCredit:0,sourceFacts:Object.keys(modelAliases).length,aliasCount:Object.values(modelAliases).flat().length,records:fixedRecords.length+scaleRecords.length,queries:results.length,recallAt5:{before:`${before}/${results.length}`,after:`${after}/${results.length}`},improvements,regressions,results,constraints:{syntheticOnly:true,queryTextsNotProvidedToGenerator:true,isolatedDB:true}},null,2));
  }finally{await baseline?.close();await withAliases?.close();fs.rmSync(temp,{recursive:true,force:true});}
}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
