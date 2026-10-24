'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { MemoryService } = require('../src/main/memory-service');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const reportPath = path.join(root, 'docs', 'workbunny-memory-benchmark-2026-10-25.json');
const anchors = [
  '十年旧事实：合成角色每年春天在京都赏樱',
  'Ten-year old fact: synthetic traveler visits Kyoto each spring',
  '十年计划：合成角色每年秋天记录一次旅行',
  'Long-term plan: synthetic traveler writes an annual travel journal',
];

function parseRows(argv) {
  const arg = argv.find(x => x.startsWith('--rows='));
  const rows = arg ? Number(arg.slice('--rows='.length)) : 10000;
  if (!Number.isSafeInteger(rows) || rows < 200 || rows > 10000) throw new Error('--rows must be an integer from 200 to 10000');
  return rows;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)].toFixed(2));
}

function makeSafeStorage() {
  const testOnlyKey = crypto.randomBytes(32);
  return {
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', testOnlyKey, nonce);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]);
    },
    decryptString(envelope) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', testOnlyKey, envelope.subarray(0, 12));
      decipher.setAuthTag(envelope.subarray(12, 28));
      return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString('utf8');
    },
    isEncryptionAvailable: () => true,
    destroy() { testOnlyKey.fill(0); },
  };
}

function makeService(dir, safeStorage, fixedNow) {
  return new MemoryService({ dir, bin, safeStorage, getSettings: () => ({ enabled: true, extract: false }),
    clock: () => fixedNow, random: () => 0 });
}

async function writeBatches(service, rows, size = 200) {
  for (let i = 0; i < rows.length; i += size) await service.write(rows.slice(i, i + size));
}

function batchMetrics(dir) {
  const sizes = {};
  for (const [key, suffix] of [['database', ''], ['wal', '-wal'], ['sharedMemory', '-shm']]) {
    const file = path.join(dir, `companion.db${suffix}`);
    sizes[key] = fs.existsSync(file) ? fs.statSync(file).size : 0;
  }
  sizes.databaseAndWal = sizes.database + sizes.wal;
  sizes.total = sizes.database + sizes.wal + sizes.sharedMemory;
  return sizes;
}

async function main() {
  const messageCount = parseRows(process.argv.slice(2));
  const memoryCount = Math.round(messageCount * 0.2);
  if (!fs.existsSync(bin)) execFileSync(path.join(__dirname, 'build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-benchmark-'));
  const dir = path.join(tempRoot, 'vault');
  const safeStorage = makeSafeStorage();
  const now = Date.now(), firstTs = now - 10 * 365.25 * 24 * 60 * 60 * 1000;
  const fixedRandom = 0;
  let service = null;
  try {
    const buildStarted = performance.now();
    service = makeService(dir, safeStorage, now);
    await service.init();
    if (!service.db) throw new Error(`vault init failed: ${service.error}`);

    const messages = Array.from({ length: messageCount }, (_, i) => {
      const ts = Math.round(firstTs + (now - firstTs) * (i / Math.max(1, messageCount - 1)));
      const anchorIndex = Math.round((i / Math.max(1, messageCount - 1)) * (anchors.length - 1));
      const isAnchor = i === Math.round((anchorIndex / (anchors.length - 1)) * (messageCount - 1));
      const base = isAnchor ? anchors[anchorIndex] : `Synthetic public sample ${i}: the fictional traveler records a Kyoto spring walk and an annual journal.`;
      return { id: `bench-message-${String(i).padStart(6, '0')}`, kind: 'message', ts,
        value: { role: i % 3 === 1 ? 'assistant' : 'user', content: `${base} Synthetic benchmark text only; sample=${i}; fixed-seed=${fixedRandom}.`, sources: [] } };
    });
    await writeBatches(service, messages);

    const memories = Array.from({ length: memoryCount }, (_, i) => {
      const sourceIndex = i < anchors.length
        ? Math.round((i / (anchors.length - 1)) * (messageCount - 1))
        : Math.min(messageCount - 1, Math.floor(i * messageCount / memoryCount));
      const sourceTs = messages[sourceIndex].ts;
      const content = i < anchors.length ? anchors[i] : `Synthetic long-term fact ${String(i).padStart(5, '0')}: the fictional traveler saves public itinerary topic ${i % 37}.`;
      return { id: `bench-memory-${String(i).padStart(6, '0')}`, kind: 'memory', ts: sourceTs, updatedAt: sourceTs,
        value: { content, memoryKind: i < anchors.length ? 'fact' : 'synthetic', importance: i < anchors.length ? 1 : 0.6,
          status: 'confirmed', evidence: messages[sourceIndex].value.content.slice(0, 120), sources: [messages[sourceIndex].id], origin: 'benchmark-synthetic' } };
    });
    await writeBatches(service, memories);
    const buildMs = performance.now() - buildStarted;
    const dbBytes = batchMetrics(dir);

    const retrievalTimes = [], retrievalChecks = [];
    for (let i = 0; i < 30; i++) {
      const query = i % 2 ? 'Kyoto synthetic traveler spring' : '合成角色 京都 赏樱 春天';
      const start = performance.now();
      const rows = await service.search(query, ['memory'], 50);
      retrievalTimes.push(performance.now() - start);
      retrievalChecks.push(i % 2 ? rows.some(r => r.id === 'bench-memory-000001') : rows.some(r => r.id === 'bench-memory-000000'));
    }
    const contextTimes = [], contexts = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const context = await service.context(i % 2 ? 'annual travel journal Kyoto' : '每年春天京都赏樱', { budget: 8500 });
      contextTimes.push(performance.now() - start); contexts.push(context);
    }
    const anchorIds = anchors.map((_, i) => `bench-memory-${String(i).padStart(6, '0')}`);
    const recalls = anchorIds.map((id, i) => contexts.some(c => c.text.includes(anchors[i])));
    const anchorYears = anchorIds.map((_, i) => {
      const sourceIndex = Math.round((i / (anchors.length - 1)) * (messageCount - 1));
      return recalls[i] ? new Date(messages[sourceIndex].ts).getUTCFullYear() : null;
    }).filter(year => year !== null);
    const crossYearRecallYearCount = new Set(anchorYears).size;
    const maxContextChars = Math.max(...contexts.map(c => c.text.length + c.messages.reduce((n, m) => n + JSON.stringify(m).length, 0)));

    await service.close();
    const reopenStarted = performance.now();
    service = makeService(dir, safeStorage, now);
    await service.init();
    const reopenMs = performance.now() - reopenStarted;
    if (!service.db) throw new Error(`vault reopen failed: ${service.error}`);
    const stats = await service.stats();
    if (stats.counts.message !== messageCount || stats.counts.memory !== memoryCount) throw new Error('reopened row counts did not match generated rows');
    await service.close(); service = null;

    const report = {
      schema: 'workbunny-memory-benchmark-v1',
      generatedAt: new Date().toISOString(),
      dataset: { messages: messageCount, memories: memoryCount, totalRows: messageCount + memoryCount,
        spanYears: 10, syntheticOnly: true, fixedRandom },
      environment: { platform: os.platform(), architecture: os.arch(), node: process.version, cpuCount: os.cpus().length },
      timingsMs: {
        databaseBuild: Number(buildMs.toFixed(2)),
        retrieval: { samples: retrievalTimes.length, p50: percentile(retrievalTimes, 0.50), p95: percentile(retrievalTimes, 0.95) },
        context: { samples: contextTimes.length, p50: percentile(contextTimes, 0.50), p95: percentile(contextTimes, 0.95), maxChars: maxContextChars, budgetChars: 8500 },
        reopen: Number(reopenMs.toFixed(2)),
      },
      databaseBytes: dbBytes,
      checks: { chineseOldFactSearchPassed: retrievalChecks.filter((_, i) => i % 2 === 0).every(Boolean),
        englishOldFactSearchPassed: retrievalChecks.filter((_, i) => i % 2 === 1).every(Boolean),
        crossYearMemoryRecallCount: recalls.filter(Boolean).length, crossYearRecallRequired: 3,
        crossYearRecallYearCount, crossYearRecallYearCountRequired: 3,
        reopenedMessageCount: stats.counts.message, reopenedMemoryCount: stats.counts.memory },
      scope: 'Synthetic scale and reopen simulation; not evidence of ten-year production reliability or real user-memory quality.',
    };
    if (!report.checks.chineseOldFactSearchPassed || !report.checks.englishOldFactSearchPassed || report.checks.crossYearMemoryRecallCount < 3 || crossYearRecallYearCount < 3 || maxContextChars > 8500) {
      throw new Error('benchmark correctness or context budget check failed');
    }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await service?.close().catch(() => {});
    safeStorage.destroy();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
