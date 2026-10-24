'use strict';

// Public synthetic lexical-recall benchmark for the current encrypted MemoryService.
// It intentionally sends no model requests and leaves no database in the workspace.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MemoryService } = require('../src/main/memory-service');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const cases = [
  { id: 'cn_fact_archive_city', language: 'zh', category: 'fact', year: 2012, source: '2012年我把野外录音磁带存进卑尔根的防潮柜。', memory: '野外录音备份放在挪威卑尔根的防潮柜。', query: '那些户外声音素材在哪座挪威城市做了长期保存？' },
  { id: 'cn_preference_train', language: 'zh', category: 'preference', year: 2013, source: '坐夜车时我习惯选靠窗的下铺，还会带保温杯。', memory: '长途夜车更喜欢窗边下铺和自带热水。', query: '铁路出行过夜时，我偏好的铺位是什么？' },
  { id: 'cn_promise_manual', language: 'zh', category: 'promise', year: 2014, source: '我答应小周在季度结算前交付校对完的蓝皮手册。', memory: '承诺在季末前把校订后的蓝色手册交给小周。', query: '我对小周说好要在什么时候交付哪份材料？' },
  { id: 'cn_fact_recipe', language: 'zh', category: 'fact', year: 2015, source: '祖母留下的汤方写在松木盒底部，纸张有一圈褐色水渍。', memory: '家传汤方抄本在松木盒的底面。', query: '那份老食谱藏在什么物件的哪个位置？' },
  { id: 'cn_preference_music', language: 'zh', category: 'preference', year: 2016, source: '写代码时我常听没有歌词的钢琴曲，音量开得很低。', memory: '工作时偏好轻声播放的纯器乐钢琴。', query: '编程时什么样的声音环境更让我专注？' },
  { id: 'cn_promise_garden', language: 'zh', category: 'promise', year: 2017, source: '我和林梅约好，春季第一场集市后一起修好社区菜园的水泵。', memory: '承诺和林梅在春季市集结束后修社区菜园水泵。', query: '和谁说好在什么活动之后处理灌溉设备？' },
  { id: 'cn_fact_map', language: 'zh', category: 'fact', year: 2018, source: '旧城步行地图的手绘底稿寄存在港口博物馆的三号档案柜。', memory: '手绘旧城步行图底稿在港口博物馆档案柜三号。', query: '那张徒步路线草图被收藏在哪家机构？' },
  { id: 'cn_preference_food', language: 'zh', category: 'preference', year: 2019, source: '早餐我喜欢燕麦粥配酸苹果，不放蜂蜜。', memory: '早饭偏好无蜂蜜的燕麦粥和酸苹果。', query: '早晨通常喜欢吃什么口味的东西？' },
  { id: 'cn_promise_trip', language: 'zh', category: 'promise', year: 2020, source: '我答应阿杰在六月出发前把儿童座椅送到他家。', memory: '承诺六月旅行前将儿童安全座椅送给阿杰。', query: '出游之前我需要给阿杰准备什么？' },
  { id: 'cn_fact_plant', language: 'zh', category: 'fact', year: 2021, source: '办公室那盆薄荷是2021年从南门花市买来的，品种叫柠檬香蜂草。', memory: '办公室香草盆栽来源于南门花市，品种为柠檬香蜂草。', query: '工位上的香草最初是从哪里带回来的？' },
  { id: 'cn_preference_light', language: 'zh', category: 'preference', year: 2022, source: '阅读纸书时我会把台灯调成偏暖的琥珀色。', memory: '看纸质书时喜欢暖黄灯光。', query: '晚上翻书时我偏好哪种照明色调？' },
  { id: 'cn_promise_photo', language: 'zh', category: 'promise', year: 2023, source: '我答应父亲在他的七十岁生日之前整理好家族照片。', memory: '承诺在父亲七十岁前完成家庭相册整理。', query: '有哪件家庭资料整理的事需要赶在爸爸生日之前做完？' },
  { id: 'en_fact_archive', language: 'en', category: 'fact', year: 2011, source: 'In 2011, I placed the field recordings in a humidity-controlled cabinet in Bergen.', memory: 'The field-audio archive is kept in Bergen in a moisture-safe cabinet.', query: 'Which Norwegian city holds the outdoor sound backups?' },
  { id: 'en_preference_travel', language: 'en', category: 'preference', year: 2013, source: 'On overnight trains I choose a lower window berth and carry a thermos.', memory: 'For long rail trips I prefer the lower window bunk and bring hot tea.', query: 'Where do I like to sleep when traveling by rail after dark?' },
  { id: 'en_promise_manual', language: 'en', category: 'promise', year: 2015, source: 'I promised Zhou that the blue handbook would be proofread before quarter close.', memory: 'I committed to deliver the edited blue manual to Zhou by quarter end.', query: 'What did I agree to finish for Zhou before the accounting period ended?' },
  { id: 'en_fact_recipe', language: 'en', category: 'fact', year: 2017, source: 'Grandmother’s soup recipe is written beneath the lid of the cedar box.', memory: 'The family soup recipe is on the underside of the cedar box lid.', query: 'Where can I find the old cooking instructions?' },
  { id: 'en_preference_music', language: 'en', category: 'preference', year: 2019, source: 'I work best with quiet piano music that has no vocals.', memory: 'My coding preference is low-volume instrumental piano.', query: 'What sound helps me focus while programming?' },
  { id: 'en_promise_garden', language: 'en', category: 'promise', year: 2020, source: 'Mira and I agreed to repair the community garden pump after the first spring market.', memory: 'I promised Mira we would fix the shared garden water pump after the spring fair.', query: 'Who is helping me handle the garden irrigation after the seasonal bazaar?' },
  { id: 'en_fact_map', language: 'en', category: 'fact', year: 2021, source: 'The hand-drawn walking map of the old quarter is filed in cabinet three at the harbor museum.', memory: 'The old-town walking route original is in drawer three of the maritime museum archive.', query: 'Which institution preserves my original pedestrian route sketch?' },
  { id: 'en_preference_food', language: 'en', category: 'preference', year: 2022, source: 'For breakfast I like tart apples with oatmeal and never add honey.', memory: 'I prefer unsweetened oats with sour apple in the morning.', query: 'What kind of first meal do I usually enjoy?' },
  { id: 'en_promise_trip', language: 'en', category: 'promise', year: 2023, source: 'I told Alex I would bring the child safety seat over before our June departure.', memory: 'I agreed to deliver the car seat to Alex before the June trip.', query: 'What item does Alex need from me before we leave?' },
  { id: 'same_name_jordan_country', language: 'en', category: 'same_name', year: 2016, source: 'Jordan, the archivist in Berlin, keeps the northern warehouse key.', memory: 'Berlin archivist Jordan holds the key for the north storage site.', query: 'Which Jordan is responsible for the warehouse access?' },
  { id: 'same_name_jordan_country_zh', language: 'zh', category: 'same_name', year: 2017, source: '我在旅行时买的Jordan球衣是芝加哥公牛队的23号。', memory: '收藏的Jordan球衣属于芝加哥公牛，号码23。', query: '篮球球星那件红色球衣对应哪个背号？' },
  { id: 'conflict_budget_old', language: 'en', category: 'conflict', year: 2018, source: 'The 2018 travel budget was 4,200 euros.', memory: '2018 travel spending limit: €4,200.', query: 'How much was the travel allowance in 2018?' },
  { id: 'conflict_budget_new', language: 'en', category: 'conflict', year: 2024, source: 'The 2024 travel budget was 6,800 euros.', memory: '2024 travel spending limit: €6,800.', query: 'What was the travel cap for the later 2024 plan?' },
  { id: 'conflict_room_early', language: 'zh', category: 'conflict', year: 2019, source: '2019年工作室门锁密码短语是“白帆过桥”。', memory: '工作室旧门禁短语：白帆过桥（2019）。', query: '2019年那间工作室用什么词作为门禁口令？' },
  { id: 'conflict_room_later', language: 'zh', category: 'conflict', year: 2025, source: '2025年工作室门锁密码短语改成“青石听雨”。', memory: '工作室新门禁短语：青石听雨（2025）。', query: '最近一次更换后，工作室的门禁短语是什么？' },
];

function stubSafeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) { const nonce = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, nonce); const data = Buffer.concat([c.update(value, 'utf8'), c.final()]); return Buffer.concat([nonce, c.getAuthTag(), data]); },
    decryptString(value) { const nonce = value.subarray(0, 12), d = crypto.createDecipheriv('aes-256-gcm', key, nonce); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString('utf8'); },
  };
}

async function main() {
  assert(cases.length >= 20);
  execFileSync(path.join(__dirname, 'build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-recall-eval-'));
  const service = new MemoryService({
    dir: path.join(temp, 'vault'), bin, safeStorage: stubSafeStorage(),
    getSettings: () => ({ enabled: true, extract: false }), clock: () => Date.UTC(2026, 9, 25, 12), random: () => 0,
  });
  try {
    await service.init();
    assert(service.db, `isolated vault failed to initialize: ${service.error}`);
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i], ts = Date.UTC(c.year, (i * 3) % 12, 12 + (i % 12));
      const sourceId = `eval-source-${c.id}`, memoryId = `eval-memory-${c.id}`;
      await service.write([{ id: sourceId, kind: 'message', ts, value: { role: 'user', content: c.source, sources: [] } }]);
      await service.write([{ id: memoryId, kind: 'memory', ts: ts + 1, value: {
        content: c.memory, memoryKind: c.category, importance: 0.6, status: 'confirmed', evidence: c.source,
        sources: [sourceId], origin: 'synthetic-eval',
      } }]);
      c.memoryId = memoryId;
    }

    const results = [];
    for (const c of cases) {
      const top = await service.search(c.query, ['memory'], 5);
      const context = await service.context(c.query, { budget: 4000 });
      results.push({
        id: c.id, category: c.category, language: c.language,
        recallAt5: top.some(r => r.id === c.memoryId), contextHit: context.sourceIds.includes(c.memoryId),
        top5: top.map(r => r.id),
      });
    }
    const summarize = subset => {
      const hit5 = subset.filter(r => r.recallAt5).length, hitContext = subset.filter(r => r.contextHit).length;
      return { cases: subset.length, recallAt5: hit5 / subset.length, contextHitRate: hitContext / subset.length, hits: hit5, contextHits: hitContext };
    };
    const byCategory = Object.fromEntries([...new Set(cases.map(c => c.category))].map(k => [k, summarize(results.filter(r => r.category === k))]));
    const byLanguage = Object.fromEntries([...new Set(cases.map(c => c.language))].map(k => [k, summarize(results.filter(r => r.language === k))]));
    const report = {
      generatedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      evaluation: 'synthetic paraphrase retrieval through encrypted MemoryService + isolated SQLite vault',
      cases: cases.length, languages: byLanguage, categories: byCategory, overall: summarize(results),
      failures: results.filter(r => !r.recallAt5 || !r.contextHit).map(({ id, category, language, recallAt5, contextHit, top5 }) => ({ id, category, language, recallAt5, contextHit, top5 })),
      constraints: { syntheticOnly: true, modelCalls: 0, networkModelDownloads: 0, usesRealKeychain: false, pinnedInjectionCountedAsSemanticSuccess: false },
    };
    fs.writeFileSync(path.join(root, 'docs/workbunny-memory-recall-2026-10-25.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ overall: report.overall, languages: report.languages, categories: report.categories, failedIds: report.failures.map(f => f.id) }, null, 2));
  } finally {
    await service.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { cases };
