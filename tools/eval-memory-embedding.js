'use strict';

// Offline local sentence-vector and fixed-seed random-hyperplane LSH evaluation.
// Only public synthetic sentences are passed to Apple's on-device NaturalLanguage models.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { cases } = require('./eval-memory-recall');

const root = path.resolve(__dirname, '..');
const distractorCount = Number(process.argv.find(x => x.startsWith('--distractors='))?.split('=')[1] || 1000);
assert(Number.isInteger(distractorCount) && distractorCount >= 0 && distractorCount <= 10000, '--distractors must be 0..10000');
const start = Date.now();

function distractor(i) {
  if (i % 2 === 0) return {
    id: `distractor-${i}`, language: 'en',
    text: `Synthetic archive note ${i}: specimen ${i % 71} moved to depot ${i % 43} during cycle ${2000 + i % 26}; status mark ${i % 97}.`,
  };
  return {
    id: `distractor-${i}`, language: 'zh',
    text: `合成档案条目${i}：样本${i % 71}于周期${2000 + i % 26}转入${i % 43}号仓位，状态标记${i % 97}。`,
  };
}

function readVectors(items) {
  const input = items.map(x => JSON.stringify(x)).join('\n') + '\n';
  const result = spawnSync('swift', [path.join(__dirname, 'natural-language-vectors.swift')], {
    input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Swift vector tool exited ${result.status}`);
  const vectors = new Map();
  for (const line of result.stdout.trim().split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line), bytes = Buffer.from(row.float32le, 'base64');
    assert.equal(bytes.length, row.dimension * 4);
    const vector = new Float32Array(row.dimension);
    for (let i = 0; i < vector.length; i++) vector[i] = bytes.readFloatLE(i * 4);
    vectors.set(row.id, vector);
  }
  if (vectors.size !== items.length) throw new Error(`Received ${vectors.size}/${items.length} vectors. ${result.stderr}`);
  return vectors;
}

function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return dot / (Math.sqrt(aa * bb) || 1);
}

function mulberry32(seed) {
  return () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function gaussian(random) {
  const u = Math.max(random(), 1e-12), v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function makePlanes(dimension, seed) {
  const random = mulberry32(seed);
  return Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => {
    const plane = new Float32Array(dimension);
    for (let i = 0; i < dimension; i++) plane[i] = gaussian(random);
    return plane;
  }));
}
function signature(vector, planes) {
  return planes.map(table => {
    let bits = 0;
    for (let i = 0; i < table.length; i++) {
      const plane = table[i]; let dot = 0;
      for (let d = 0; d < vector.length; d++) dot += vector[d] * plane[d];
      if (dot >= 0) bits |= 1 << i;
    }
    return bits;
  });
}
function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}
function summarize(rows) {
  const ranks = rows.map(x => x.targetRank).filter(Number.isFinite);
  return {
    cases: rows.length,
    recallAt5: rows.filter(x => x.targetRank <= 5).length / rows.length,
    top1: rows.filter(x => x.targetRank === 1).length / rows.length,
    meanTargetRankWhenFound: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null,
    targetFoundCount: ranks.length,
  };
}

function evaluateLanguage(language, rows, queries) {
  const seed = language === 'zh' ? 0x5A17C0DE : 0xE71A2026;
  const dimension = rows[0].vector.length, planes = makePlanes(dimension, seed);
  for (const row of rows) row.signature = signature(row.vector, planes);
  const distinctSignaturesPerTable = Array.from({ length: 10 }, (_, table) => new Set(rows.map(row => row.signature[table])).size);
  const bucketIndex = Array.from({ length: 10 }, () => new Map());
  for (const row of rows) for (let table = 0; table < 10; table++) {
    const key = row.signature[table], bucket = bucketIndex[table].get(key) || [];
    bucket.push(row); bucketIndex[table].set(key, bucket);
  }
  const exactRows = [], exactParaphraseRows = [], lshRows = [], caseResults = [], exactTop1Counts = new Map(), exactTop5Counts = new Map();
  const candidateSizes = [], sharedBucketHits = [];
  for (const q of queries) {
    const exact = rows.map(row => ({ row, score: cosine(q.vector, row.vector) })).sort((a, b) => b.score - a.score);
    const targetRank = exact.findIndex(x => x.row.id === q.targetId) + 1;
    exactRows.push({ ...q, targetRank });
    const paraphraseOnly = exact.filter(x => x.row.caseId);
    const paraphraseOnlyRank = paraphraseOnly.findIndex(x => x.row.id === q.targetId) + 1;
    exactParaphraseRows.push({ ...q, targetRank: paraphraseOnlyRank });
    if (exact[0]) exactTop1Counts.set(exact[0].row.id, (exactTop1Counts.get(exact[0].row.id) || 0) + 1);
    for (const { row } of exact.slice(0, 5)) exactTop5Counts.set(row.id, (exactTop5Counts.get(row.id) || 0) + 1);

    const querySignature = signature(q.vector, planes), candidateHits = new Map();
    for (let table = 0; table < 10; table++) {
      const base = querySignature[table];
      const keys = [base];
      for (let bit = 0; bit < 10; bit++) keys.push(base ^ (1 << bit));
      for (const key of keys) for (const row of bucketIndex[table].get(key) || []) candidateHits.set(row.id, (candidateHits.get(row.id) || 0) + 1);
    }
    const candidates = [...candidateHits].map(([id, hits]) => ({ row: rows.find(r => r.id === id), hits }))
      .sort((a, b) => b.hits - a.hits || a.row.id.localeCompare(b.row.id)).slice(0, 50);
    candidateSizes.push(candidateHits.size);
    sharedBucketHits.push(candidates[0]?.hits || 0);
    const reranked = candidates.map(x => ({ row: x.row, score: cosine(q.vector, x.row.vector), hits: x.hits })).sort((a, b) => b.score - a.score);
    const lshRank = reranked.findIndex(x => x.row.id === q.targetId) + 1;
    lshRows.push({ ...q, targetRank: lshRank || Infinity, targetInCandidates: candidates.some(x => x.row.id === q.targetId), candidates: candidateHits.size, maxBucketHits: candidates[0]?.hits || 0 });
    caseResults.push({ id: q.caseId, category: q.category, queryId: q.id,
      exactTargetRank: targetRank, exactParaphraseOnlyRank: paraphraseOnlyRank, exactTop1Id: exact[0]?.row.id || null, exactTargetCosine: exact.find(x => x.row.id === q.targetId)?.score ?? null,
      lshTargetRank: lshRank || null, lshTargetIn50: candidates.some(x => x.row.id === q.targetId), lshCandidates: candidateHits.size,
      lshTop1Id: reranked[0]?.row.id || null,
    });
  }
  const hubThreshold = Math.max(3, Math.ceil(queries.length * 0.2));
  return {
    language, dimension, corpusRecords: rows.length, queries: queries.length,
    exact: summarize(exactRows), exactParaphrasesOnly: summarize(exactParaphraseRows), lshRerankedTop50: summarize(lshRows),
    lshCandidateRecall: lshRows.filter(x => x.targetInCandidates).length / lshRows.length,
    candidateCount: { mean: candidateSizes.reduce((a, b) => a + b, 0) / candidateSizes.length, p50: percentile(candidateSizes, 0.5), p95: percentile(candidateSizes, 0.95), min: Math.min(...candidateSizes), max: Math.max(...candidateSizes) },
    bucketHitsPerCandidateLead: { mean: sharedBucketHits.reduce((a, b) => a + b, 0) / sharedBucketHits.length, p50: percentile(sharedBucketHits, 0.5), p95: percentile(sharedBucketHits, 0.95) },
    exactHubness: {
      maxTop1Appearances: Math.max(0, ...exactTop1Counts.values()),
      maxTop5Appearances: Math.max(0, ...exactTop5Counts.values()),
      top5HubsAt20Percent: [...exactTop5Counts.values()].filter(n => n >= hubThreshold).length,
    },
    distinctSignaturesPerTable,
    cases: caseResults,
  };
}

function main() {
  const allItems = [];
  for (const c of cases) {
    allItems.push({ id: `memory:${c.id}`, language: c.language, text: c.memory });
    allItems.push({ id: `query:${c.id}`, language: c.language, text: c.query });
  }
  for (let i = 0; i < distractorCount; i++) allItems.push(distractor(i));
  const vectors = readVectors(allItems);
  const rowsByLang = {}, queriesByLang = {};
  for (const c of cases) {
    const memory = { id: `memory:${c.id}`, caseId: c.id, category: c.category, vector: vectors.get(`memory:${c.id}`) };
    const query = { id: `query:${c.id}`, caseId: c.id, category: c.category, targetId: memory.id, vector: vectors.get(`query:${c.id}`) };
    (rowsByLang[c.language] ||= []).push(memory); (queriesByLang[c.language] ||= []).push(query);
  }
  for (let i = 0; i < distractorCount; i++) {
    const d = distractor(i); (rowsByLang[d.language] ||= []).push({ ...d, vector: vectors.get(d.id) });
  }
  const byLanguage = {};
  for (const lang of Object.keys(rowsByLang)) byLanguage[lang] = evaluateLanguage(lang, rowsByLang[lang], queriesByLang[lang]);

  const overall = method => {
    const all = Object.values(byLanguage).map(x => x[method]);
    const total = all.reduce((a, x) => a + x.cases, 0);
    return { cases: total, recallAt5: all.reduce((a, x) => a + x.recallAt5 * x.cases, 0) / total, top1: all.reduce((a, x) => a + x.top1 * x.cases, 0) / total };
  };
  const allCaseRows = Object.values(byLanguage).flatMap(x => x.cases);
  const grouped = Object.fromEntries([...new Set(allCaseRows.map(x => x.category))].map(category => {
    const group = allCaseRows.filter(x => x.category === category);
    return [category, {
      cases: group.length,
      exactRecallAt5: group.filter(x => x.exactTargetRank <= 5).length / group.length,
      exactParaphrasesOnlyRecallAt5: group.filter(x => x.exactParaphraseOnlyRank <= 5).length / group.length,
      exactTop1: group.filter(x => x.exactTargetRank === 1).length / group.length,
      lshRecallAt5: group.filter(x => x.lshTargetRank !== null && x.lshTargetRank <= 5).length / group.length,
      lshTop1: group.filter(x => x.lshTargetRank === 1).length / group.length,
    }];
  }));
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs/workbunny-memory-recall-2026-10-25.json'), 'utf8'));
  const dimensions = Object.fromEntries(Object.entries(byLanguage).map(([lang, value]) => [lang, {
    dimension: value.dimension,
    rawFloat32Bytes: value.dimension * 4,
    encryptedBinaryBytesWithNonceAndTag: value.dimension * 4 + 28,
    encryptedBase64CharactersApprox: 4 * Math.ceil((value.dimension * 4 + 28) / 3),
    lshBucketTokensPerMemory: 10,
    indexedTokenTextCharactersApprox: 10 * 22,
  }]));
  const report = {
    generatedAt: new Date().toISOString(),
    evaluator: 'Apple NaturalLanguage NLEmbedding.sentenceEmbedding, local macOS models; no model downloads',
    dataset: { paraphraseCases: cases.length, syntheticDistractors: distractorCount, corpusTotal: cases.length + distractorCount, noPersonalData: true, noModelServiceCalls: true, lexicalBaseline: { recallAt5: baseline.overall.recallAt5, contextHitRate: baseline.overall.contextHitRate } },
    methods: {
      exactCosine: 'Rank every same-language memory vector by exact cosine; no cross-language cosine.',
      lsh: 'Fixed-seed random hyperplane LSH; 10 tables x 10 bits; probe each bucket and its 10 one-bit neighbors (110 bucket lookups/query); rank candidates by shared bucket count, keep top 50, exact-cosine rerank.',
      indexSimulation: 'Synthetic bucket IDs; no real HMAC or SQLite writes. The vector-byte estimate assumes float32 plus 12-byte nonce and 16-byte GCM tag, then base64 text storage.',
    },
    quality: { exactOverall: overall('exact'), exactParaphrasesOnlyOverall: overall('exactParaphrasesOnly'), lshRerankedOverall: overall('lshRerankedTop50'), perLanguage: byLanguage, perCategory: grouped, paraphraseAndEntityRanks: allCaseRows.filter(x => ['same_name', 'conflict'].includes(x.category)), failures: allCaseRows.filter(x => x.exactTargetRank > 5 || x.lshTargetRank === null || x.lshTargetRank > 5) },
    storageEstimatePerMemory: dimensions,
    elapsedMs: Date.now() - start,
    decisionEvidence: 'Compare exact sentence-vector recall with the existing lexical baseline, then measure LSH target-candidate and reranked recall plus hubness before considering indexing.',
  };
  fs.writeFileSync(path.join(root, 'docs/workbunny-memory-embedding-2026-10-25.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ elapsedMs: report.elapsedMs, exactOverall: report.quality.exactOverall, exactParaphrasesOnly: report.quality.exactParaphrasesOnlyOverall, lshRerankedOverall: report.quality.lshRerankedOverall, perLanguage: Object.fromEntries(Object.entries(byLanguage).map(([k, v]) => [k, { exact: v.exact, exactParaphrasesOnly: v.exactParaphrasesOnly, lsh: v.lshRerankedTop50, candidateRecall: v.lshCandidateRecall, candidates: v.candidateCount, hubs: v.exactHubness, distinctSignaturesPerTable: v.distinctSignaturesPerTable }])), perCategory: grouped }, null, 2));
}

main();
