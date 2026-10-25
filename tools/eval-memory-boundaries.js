'use strict';
// Frozen synthetic boundary set for ranking and lifecycle checks. Do not tune
// retrieval rules to this file; change it only as a versioned evaluation set.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { MemoryService } = require('../src/main/memory-service');

const root = path.resolve(__dirname, '..'), bin = path.join(root, 'bin', 'vault');
const now = Date.UTC(2026, 9, 26, 12);
const fixedRecords = [
  ['rel-linmei-cousin','memory','林梅是我的表妹，她负责社区花园的浇水系统。','fact'],
  ['rel-linmei-coworker','memory','林梅是我的同事，负责项目采购和报销。','fact'],
  ['rel-jordan-archivist','memory','柏林档案员 Jordan 保管北方仓库的钥匙。','fact'],
  ['rel-jordan-player','memory','Jordan 的公牛队球衣是23号，收藏在书房。','fact'],
  ['rel-ava-doctor','memory','我的医生 Ava 在湖景诊所工作。','fact'],
  ['rel-ava-neighbor','memory','邻居 Ava 每周帮忙照看我的花园。','fact'],
  ['task-mira-pump','memory','我和 Mira 约好在春季集市后修好社区花园的水泵。','promise'],
  ['task-mira-poster','memory','我答应 Mira 在秋季展会后把海报交给她。','promise'],
  ['task-sam-invoice','memory','Sam 说会在六月三日前发送水费发票。','promise'],
  ['task-nora-expired','memory','我答应 Nora 周五送还蓝色借书卡。','promise', { expiresAt: now - 1000 }],
  ['pref-breakfast-old','memory','我早餐喜欢甜燕麦和香蕉。','preference', { state: 'superseded', ts: now - 600000 }],
  ['pref-breakfast-new','memory','我现在早餐偏好咸味燕麦，不加水果。','preference', { ts: now - 1000 }],
  ['pref-tea','memory','我最近更喜欢喝淡乌龙茶。','preference'],
  ['studio-phrase-old','memory','2019年工作室旧门禁短语是“白帆过桥”。','fact',{ts:Date.UTC(2019,5,1)}],
  ['studio-phrase-new','memory','2025年工作室新门禁短语是“青石听雨”。','fact',{ts:Date.UTC(2025,5,1)}],
  ['key-location','memory','备用钥匙放在玄关鞋柜第二层的黄色信封里。','fact'],
  ['book-deadline','memory','我答应小周在六月十五日前寄出蓝皮手册。','promise'],
  ['irrelevant-bike','memory','周末我骑车沿湖边绕行了十二公里。','fact'],
  ['irrelevant-garden','memory','花园里的薄荷需要每周浇两次水。','fact'],
];
const fixedQueries = [
  { id:'relation-cousin', q:'林梅是我的什么亲属？', target:'rel-linmei-cousin' },
  { id:'same-name-key', q:'Which Jordan has responsibility for the north warehouse key?', target:'rel-jordan-archivist' },
  { id:'same-name-jersey', q:'Jordan 的芝加哥公牛球衣号码是多少？', target:'rel-jordan-player' },
  { id:'same-name-doctor', q:'Which Ava is my physician?', target:'rel-ava-doctor' },
  { id:'same-name-neighbor', q:'花园是谁在帮我照看？', target:'rel-ava-neighbor' },
  { id:'relationship-pump', q:'Who agreed to repair the community garden pump after the spring market?', target:'task-mira-pump' },
  { id:'relationship-poster', q:'Mira 等我在秋季活动之后交给她什么？', target:'task-mira-poster' },
  { id:'promise-invoice', q:'When was Sam supposed to send the water bill?', target:'task-sam-invoice' },
  { id:'expired-promise', q:'What do I still owe Nora?', target:null },
  { id:'replaced-preference', q:'我目前早餐喜欢什么，不要加哪种东西？', target:'pref-breakfast-new' },
  { id:'current-drink', q:'Which tea do I currently prefer?', target:'pref-tea' },
  { id:'old-date', q:'What was the studio entry phrase in 2019?', target:'studio-phrase-old' },
  { id:'new-date', q:'工作室现在的门禁短语是什么？', target:'studio-phrase-new' },
  { id:'exact-location', q:'Where did I put the spare key?', target:'key-location' },
  { id:'promise-deadline', q:'小周需要在什么时候收到蓝皮手册？', target:'book-deadline' },
  { id:'unrelated', q:'Where is the radio telescope antenna frequency chart?', target:null },
  { id:'quote-is-not-fact', q:'What city do I live in?', target:null },
];
// Fixed size stress corpus. These are synthetic unrelated notes, including
// repeated common names, to observe bounded indexed search without user data.
const scaleRecords = Array.from({length:1000},(_,i)=>{
  const n=String(i).padStart(4,'0');
  const content=i<80?`Jordan mentioned catalog item ${n} at the Berlin museum.`
    :i<160?`Mira attended unrelated community event ${n}.`
    :i<240?`Ava described unrelated clinic schedule ${n}.`
    :`Synthetic catalog bulletin ${n} records a routine office supply update.`;
  return [`scale-${n}`,'memory',content,'fact',{ts:now-100000+i}];
});

function fakeStorage() {
  const key=crypto.randomBytes(32);
  return { isEncryptionAvailable:()=>true,
    encryptString(s){const n=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,n),d=Buffer.concat([c.update(s),c.final()]);return Buffer.concat([n,c.getAuthTag(),d]);},
    decryptString(b){const d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString();},
  };
}
const percentile=(xs,p)=>xs.slice().sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor((xs.length-1)*p))];

async function main() {
  execFileSync(path.join(__dirname,'build-vault.sh'),{cwd:root,stdio:'ignore'});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-memory-boundary-'));
  const service=new MemoryService({dir:path.join(temp,'vault'),bin,safeStorage:fakeStorage(),getSettings:()=>({enabled:true,extract:false}),clock:()=>now});
  try {
    await service.init(); assert(service.db,service.error);
    for(const [recordId,kind,content,memoryKind,options={}] of fixedRecords)
      await service.write([{id:recordId,kind,ts:options.ts||now-100000,value:{content,memoryKind,status:'confirmed',importance:0.6,sources:[]},state:options.state||'active',expiresAt:options.expiresAt||null}]);
    for(let i=0;i<scaleRecords.length;i+=200) await service.write(scaleRecords.slice(i,i+200).map(([recordId,kind,content,memoryKind,options={}])=>({id:recordId,kind,ts:options.ts||now-100000,value:{content,memoryKind,status:'confirmed',importance:0.5,sources:[]},state:'active'})));

    // A user cites a false assistant statement; it must not become a memory fact.
    const user=await service.addMessage('user','助手猜我住东京，但那是错的；我没有告诉你住址。');
    await service.addMessage('assistant','你住在东京。',{sources:[user.id],delivery:'generated'});
    assert.equal((await service.search('Tokyo residence',['memory'],10)).length,0);

    // Forgetting a user fact must remove the linked assistant paraphrase too.
    const forgotten=await service.addMessage('user','请记住：应急钥匙在紫色抽屉里。');
    const derived=await service.addMessage('assistant','你把应急钥匙放在紫色抽屉里。',{sources:[forgotten.id],delivery:'generated'});
    const forgetMemory=(await service.list({kind:'memory',query:'紫色抽屉'}))[0];
    assert(forgetMemory);
    await service.remove(forgetMemory.id);
    const forgottenMatches=await service.search('紫色抽屉',['memory','message','summary'],20);
    assert.equal(forgottenMatches.length,0);
    assert.equal((await service.db.request('get',{ids:[forgotten.id,derived.id]})).rows.length,0);

    const latencies=[], counts=[], uniqueCounts=[], results=[];
    const original=service.db.request.bind(service.db);
    for(const query of fixedQueries) {
      let candidateRows=0; const candidateIds=new Set();
      service.db.request=async(op,payload)=>{const result=await original(op,payload);if(op==='search'){candidateRows+=result.rows.length;for(const row of result.rows)candidateIds.add(row.id);}return result;};
      const start=performance.now();
      const rows=await service.search(query.q,['memory'],5);
      const ms=performance.now()-start;
      service.db.request=original;
      latencies.push(ms); counts.push(candidateRows); uniqueCounts.push(candidateIds.size);
      const rank=rows.findIndex(r=>r.id===query.target);
      results.push({id:query.id,target:query.target,rank:rank<0?null:rank+1,top1:rows[0]?.id||null,expiredReturned:rows.some(r=>r.id==='task-nora-expired'),supersededReturned:rows.some(r=>r.id==='pref-breakfast-old')});
      for(let repeat=0;repeat<4;repeat++){const t=performance.now();await service.search(query.q,['memory'],5);latencies.push(performance.now()-t);}
    }
    const expected= fixedQueries.filter(x=>x.target), hits=results.filter(x=>x.target&&x.rank!==null).length;
    const top1=results.filter(x=>x.target&&x.top1===x.target).length;
    for(const r of results) if(r.id==='expired-promise') assert.equal(r.expiredReturned,false,'expired promise must not be searchable');
    for(const r of results) if(r.id==='replaced-preference') assert.equal(r.supersededReturned,false,'superseded preference must not be searchable');
    const report={sampleHash:crypto.createHash('sha256').update(JSON.stringify({fixedRecords,fixedQueries,scaleRecords})).digest('hex'),records:fixedRecords.length+scaleRecords.length,scaleDistractors:scaleRecords.length,queries:fixedQueries.length,expectedTargetQueries:expected.length,recallAt5:`${hits}/${expected.length}`,top1:`${top1}/${expected.length}`,nullTargetCases:results.filter(x=>!x.target).map(x=>({id:x.id,returned:results.length?x.top1:null})),latencyMs:{calls:latencies.length,p50:+percentile(latencies,.5).toFixed(2),p95:+percentile(latencies,.95).toFixed(2)},candidateRowsPerQuery:{mean:+(counts.reduce((a,b)=>a+b,0)/counts.length).toFixed(1),max:Math.max(...counts),meanUnique:+(uniqueCounts.reduce((a,b)=>a+b,0)/uniqueCounts.length).toFixed(1),maxUnique:Math.max(...uniqueCounts)},results,constraints:{synthetic:true,isolatedVault:true,paidModels:0,modelDownloads:0,formalDataWrites:0}};
    console.log(JSON.stringify(report,null,2));
  } finally {await service.close();fs.rmSync(temp,{recursive:true,force:true});}
}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
module.exports={fixedRecords,fixedQueries,scaleRecords};
