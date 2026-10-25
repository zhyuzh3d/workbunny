'use strict';
// Independent, synthetic paraphrase evaluation for the memory-side query expander.
// No model requests or user data. Run: node tools/eval-memory-retrieval.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MemoryService } = require('../src/main/memory-service');
const { tokenKeys } = require('../src/main/vault-crypto');

const root = path.resolve(__dirname, '..'), bin = path.join(root, 'bin', 'vault');
const cases = [
  { id:'zh_recipe', lang:'zh', kind:'fact', memory:'家传汤方抄本在松木盒的底面。', query:'老一辈留下的烹饪配方放在什么容器的哪一面？' },
  { id:'zh_archive', lang:'zh', kind:'fact', memory:'野外录音备份放在卑尔根的防潮柜。', query:'户外声音资料长期保存在挪威哪座城市？' },
  { id:'zh_map', lang:'zh', kind:'fact', memory:'手绘旧城步行图底稿在港口博物馆档案柜三号。', query:'那份旧城区徒步路线草稿由哪家机构收藏？' },
  { id:'zh_music', lang:'zh', kind:'preference', memory:'工作时偏好轻声播放的纯器乐钢琴。', query:'写程序需要什么声音让我集中注意力？' },
  { id:'zh_train', lang:'zh', kind:'preference', memory:'长途夜车更喜欢窗边下铺和自带热水。', query:'坐夜间火车过夜时我选哪种床位？' },
  { id:'zh_promise', lang:'zh', kind:'promise', memory:'承诺和林梅在春季市集结束后修社区菜园水泵。', query:'春天集会之后，我答应谁一起修灌溉设备？' },
  { id:'zh_breakfast', lang:'zh', kind:'preference', memory:'早饭偏好无蜂蜜的燕麦粥和酸苹果。', query:'早餐我喜欢怎样搭配，且不要加什么？' },
  { id:'zh_item', lang:'zh', kind:'promise', memory:'承诺六月旅行前将儿童安全座椅送给阿杰。', query:'出发去度假之前要给阿杰带什么东西？' },
  { id:'en_recipe', lang:'en', kind:'fact', memory:'The family soup recipe is on the underside of the cedar box lid.', query:'Where are grandma’s cooking directions tucked away?' },
  { id:'en_archive', lang:'en', kind:'fact', memory:'The field-audio archive is kept in Bergen in a moisture-safe cabinet.', query:'Which Norwegian city preserves the outdoor sound recordings?' },
  { id:'en_map', lang:'en', kind:'fact', memory:'The old-town walking route original is in drawer three of the maritime museum archive.', query:'Which institution has my pedestrian path sketch?' },
  { id:'en_music', lang:'en', kind:'preference', memory:'My coding preference is low-volume instrumental piano.', query:'What kind of sound helps me concentrate while programming?' },
  { id:'en_train', lang:'en', kind:'preference', memory:'For long rail trips I prefer the lower window bunk and bring hot tea.', query:'Where do I sleep on an overnight railway journey?' },
  { id:'en_promise', lang:'en', kind:'promise', memory:'I promised Mira we would fix the shared garden water pump after the spring fair.', query:'Who did I agree to mend the irrigation system with after the seasonal event?' },
  { id:'en_breakfast', lang:'en', kind:'preference', memory:'I prefer unsweetened oats with sour apple in the morning.', query:'What first meal do I enjoy without adding a sweetener?' },
  { id:'en_item', lang:'en', kind:'promise', memory:'I agreed to deliver the car seat to Alex before the June trip.', query:'What should Alex receive before our departure?' },
  { id:'same_jordan', lang:'en', kind:'fact', memory:'Berlin archivist Jordan holds the key for the north storage site.', query:'Which Jordan is responsible for access to the northern warehouse?' },
  { id:'same_jordan_jersey', lang:'zh', kind:'fact', memory:'收藏的Jordan球衣属于芝加哥公牛，号码23。', query:'篮球球星那件球衣背后印的是几号？' },
  { id:'old_budget', lang:'en', kind:'conflict', memory:'2018 travel spending limit: €4,200.', query:'What was the trip allowance in 2018?' },
  { id:'new_budget', lang:'en', kind:'conflict', memory:'2024 travel spending limit: €6,800.', query:'What was the cap for the later 2024 plan?' },
  { id:'old_phrase', lang:'zh', kind:'conflict', memory:'工作室旧门禁短语：白帆过桥（2019）。', query:'2019年那间工作室以前用什么词开门？' },
  { id:'new_phrase', lang:'zh', kind:'conflict', memory:'工作室新门禁短语：青石听雨（2025）。', query:'后来换过的工作室门禁短语是什么？' },
  { id:'name_zho', lang:'zh', kind:'fact', memory:'我把交付校订后的蓝色手册给小周，截止季度结算前。', query:'我对小周说好要完成哪份东西？' },
  { id:'plant', lang:'zh', kind:'fact', memory:'办公室香草盆栽来源于南门花市，品种为柠檬香蜂草。', query:'工位上的香草最初从哪儿买到？' },
];
const distractors = [
  'Jordan效力于芝加哥公牛，球衣号码23。', 'Berlin archivist Jordan stores the south site key.',
  'The 2024 travel spending limit was €4,200.', '2018 travel spending limit: €6,800.',
  '松木盒在博物馆，里面存放一本家庭相册。', 'The harbor museum stores a walking guide in drawer four.',
  '办公室的钢琴调音记录放在抽屉里。', 'The garden fair takes place after the pump repair.',
  '早餐常吃蜂蜜酸奶和香蕉。', 'Overnight travel is easier with a window seat.',
  '青石听雨是2019年短语，白帆过桥是2025年短语。', 'Alex lent Mira a camping tent before a spring trip.',
  '北方仓库钥匙由柏林的Jordan保管。', 'I promised Zhou a green checklist after quarter close.',
  '南门花市出售薄荷和柠檬香蜂草。', 'A cedar recipe box is kept in the harbor museum archive.',
];

function fakeStorage() {
  const secret = crypto.randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(s) { const n=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',secret,n), d=Buffer.concat([c.update(s),c.final()]); return Buffer.concat([n,c.getAuthTag(),d]); },
    decryptString(b) { const d=crypto.createDecipheriv('aes-256-gcm',secret,b.subarray(0,12)); d.setAuthTag(b.subarray(12,28)); return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString(); },
  };
}

async function main() {
  execFileSync(path.join(__dirname,'build-vault.sh'), { cwd:root, stdio:'ignore' });
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-retrieval-eval-'));
  const service=new MemoryService({dir:path.join(temp,'vault'),bin,safeStorage:fakeStorage(),getSettings:()=>({enabled:true,extract:false}),clock:()=>Date.UTC(2026,9,25)});
  try {
    await service.init(); assert(service.db,service.error);
    for(let i=0;i<cases.length;i++) {
      const c=cases[i], ts=Date.UTC(2010+i, (i*5)%12, 3);
      const sid=`eval-source-${c.id}`, mid=`eval-memory-${c.id}`;
      await service.write([{id:sid,kind:'message',ts,value:{role:'user',content:`合成证据 ${c.memory}`,sources:[]}}]);
      await service.write([{id:mid,kind:'memory',ts:ts+1,value:{content:c.memory,memoryKind:c.kind,status:'confirmed',importance:0.6,sources:[sid]}}]);
      c.memoryId=mid;
    }
    for(let i=0;i<distractors.length;i++) await service.write([{id:`eval-distractor-${i}`,kind:'memory',ts:Date.UTC(2012+i,0,1),value:{content:distractors[i],memoryKind:'fact',status:'confirmed',importance:0.6,sources:[]}}]);
    const rows=[];
    for(const c of cases) {
      const tokens=tokenKeys(service.key,c.query,128);
      const baseline=(await service.db.request('search',{tokens,kinds:['memory'],limit:5,now:service.clock()})).rows;
      const improved=await service.search(c.query,['memory'],5);
      const context=await service.context(c.query,{budget:4000});
      const baselineRank=baseline.findIndex(r=>r.id===c.memoryId), expandedRank=improved.findIndex(r=>r.id===c.memoryId);
      rows.push({id:c.id,lang:c.lang,kind:c.kind,baseline:baselineRank>=0,expanded:expandedRank>=0,context:context.sourceIds.includes(c.memoryId),baselineTop1:baselineRank===0,expandedTop1:expandedRank===0,baselineRank:baselineRank<0?null:baselineRank+1,expandedRank:expandedRank<0?null:expandedRank+1,top1:improved[0]?.id});
    }
    const summarize=xs=>({n:xs.length,baselineRecallAt5:xs.filter(x=>x.baseline).length,expandedRecallAt5:xs.filter(x=>x.expanded).length,contextHit:xs.filter(x=>x.context).length,baselineTop1:xs.filter(x=>x.baselineTop1).length,expandedTop1:xs.filter(x=>x.expandedTop1).length});
    const report={cases:cases.length,distractors:distractors.length,overall:summarize(rows),byLanguage:Object.fromEntries(['zh','en'].map(k=>[k,summarize(rows.filter(x=>x.lang===k))])),byKind:Object.fromEntries([...new Set(rows.map(x=>x.kind))].map(k=>[k,summarize(rows.filter(x=>x.kind===k))])),gains:rows.filter(x=>!x.baseline&&x.expanded).map(x=>x.id),regressions:rows.filter(x=>x.baseline&&!x.expanded).map(x=>x.id),misses:rows.filter(x=>!x.expanded).map(x=>x.id),top1Misses:rows.filter(x=>!x.expandedTop1).map(x=>({query:x.id,top1:x.top1})),constraints:{synthetic:true,paidModels:0,modelDownloads:0,realKeychain:false,pinnedCountedAsRecall:false}};
    console.log(JSON.stringify(report,null,2));
    assert(report.overall.expandedRecallAt5 >= report.overall.baselineRecallAt5 + 0.2, 'query expansion should materially improve this fixed sample');
    assert.equal(report.regressions.length,0, 'query expansion must not lose any baseline target in this sample');
    assert(report.overall.contextHit >= 20, 'retrieved targets should make it into the context on at least 20/24 cases');
    return report;
  } finally { await service.close(); fs.rmSync(temp,{recursive:true,force:true}); }
}
if(require.main===module) main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
module.exports={cases};
