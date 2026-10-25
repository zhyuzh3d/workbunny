'use strict';

// Synthetic scale check using the real encrypted MemoryService + SQLite vault.
// The temporary vault is always removed; no model or production profile is used.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { MemoryService } = require('../src/main/memory-service');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const anchors = [
  '十年旧事实：合成旅人每年春天在京都赏樱',
  'Synthetic old fact: the fictional traveler visits Kyoto each spring',
  '多年约定：合成旅人每年秋天写旅行札记',
  'Long-term plan: the fictional traveler writes an annual travel journal',
];
const MAX_RUNTIME_MS = 170000;
const queries = [
  '合成旅人 京都 春天 赏樱',
  'fictional traveler Kyoto spring visit',
  '合成旅人 秋天 旅行札记',
  'fictional traveler annual travel journal',
];

function parseRows(argv) {
  const arg = argv.find(x => x.startsWith('--rows='));
  const rows = arg ? Number(arg.slice('--rows='.length)) : 10000;
  if (!Number.isSafeInteger(rows) || rows < 1000 || rows > 50000) throw new Error('--rows must be an integer from 1000 to 50000');
  return rows;
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)].toFixed(2));
}
function makeSafeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decryptString(envelope) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.subarray(0, 12));
      decipher.setAuthTag(envelope.subarray(12, 28));
      return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString('utf8');
    },
    destroy() { key.fill(0); },
  };
}
function makeService(dir, safeStorage) {
  return new MemoryService({ dir, bin, safeStorage, getSettings: () => ({ enabled: true, extract: false }), random: () => 0 });
}
function sizes(dir) {
  const get = name => {
    try { return fs.statSync(path.join(dir, name)).size; } catch { return 0; }
  };
  return { database: get('companion.db'), wal: get('companion.db-wal'), sharedMemory: get('companion.db-shm') };
}
function anchorIndex(i, count) {
  let index = Math.round(i * (count - 1) / (anchors.length - 1));
  if (index % 2) index--;
  return Math.max(0, Math.min(count - 2, index));
}
function messageContent(i, anchorIndexes) {
  const anchor = anchorIndexes.indexOf(i);
  const text = anchor >= 0
    ? anchors[anchor]
    : `Synthetic public conversation sample ${String(i).padStart(6, '0')}: the fictional traveler discusses weather, cafes, routes, and trains.`;
  return `${text} sample=${i}.`;
}
async function writeBatches(service, count, factory, started, batchSize = 200) {
  for (let start = 0; start < count; start += batchSize) {
    if (performance.now() - started > MAX_RUNTIME_MS) throw new Error(`evaluation stopped at ${MAX_RUNTIME_MS}ms cap`);
    const batch = Array.from({ length: Math.min(batchSize, count - start) }, (_, offset) => factory(start + offset));
    await service.write(batch);
  }
}
async function main() {
  const messageCount = parseRows(process.argv.slice(2));
  const memoryCount = Math.round(messageCount / 10);
  if (!fs.existsSync(bin)) execFileSync(path.join(__dirname, 'build-vault.sh'), { cwd: root, stdio: 'inherit', timeout: 30000 });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-scale-'));
  const dir = path.join(tempRoot, 'vault');
  const safeStorage = makeSafeStorage();
  const now = Date.now(), firstTs = now - 10 * 365.25 * 24 * 60 * 60 * 1000;
  const anchorIndexes = anchors.map((_, i) => anchorIndex(i, messageCount));
  const anchorSourceIds = anchorIndexes.map(i => `scale-message-${String(i).padStart(6, '0')}`);
  let service = null;
  const started = performance.now();
  try {
    service = makeService(dir, safeStorage);
    await service.init();
    if (!service.db) throw new Error(`vault init failed: ${service.error}`);

    const messageStarted = performance.now();
    await writeBatches(service, messageCount, i => {
      return { id: `scale-message-${String(i).padStart(6, '0')}`, kind: 'message',
        ts: Math.round(firstTs + (now - firstTs) * (i / Math.max(1, messageCount - 1))),
        value: { role: i % 2 ? 'assistant' : 'user', content: messageContent(i, anchorIndexes), sources: [] } };
    }, started);
    const messageWriteMs = performance.now() - messageStarted;

    const memoryStarted = performance.now();
    await writeBatches(service, memoryCount, i => {
      const sourceIndex = i < anchors.length ? anchorIndexes[i] : Math.floor((i * messageCount / memoryCount) / 2) * 2;
      const sourceId = `scale-message-${String(sourceIndex).padStart(6, '0')}`;
      const ts = Math.round(firstTs + (now - firstTs) * (sourceIndex / Math.max(1, messageCount - 1)));
      const content = i < anchors.length ? anchors[i]
        : `Synthetic long-term note ${String(i).padStart(6, '0')}: the fictional traveler records public itinerary topic ${i % 53}.`;
      return { id: `scale-memory-${String(i).padStart(6, '0')}`, kind: 'memory', ts, updatedAt: ts,
        value: { content, memoryKind: i < anchors.length ? 'fact' : 'synthetic', importance: i < anchors.length ? 1 : 0.6,
          status: 'confirmed', evidence: messageContent(sourceIndex, anchorIndexes).slice(0, 180), sources: [sourceId], origin: 'scale-evaluation' } };
    }, started);
    const memoryWriteMs = performance.now() - memoryStarted;
    service.recent = (await service.query('message', 40)).reverse();
    const liveSizes = sizes(dir);

    const searchTimes = [], searchPasses = [];
    for (let i = 0; i < 40; i++) {
      const anchor = i % anchors.length, start = performance.now();
      const found = await service.search(queries[anchor], ['memory'], 5);
      searchTimes.push(performance.now() - start);
      searchPasses.push(found.some(row => row.id === `scale-memory-${String(anchor).padStart(6, '0')}`));
    }
    const contextTimes = [], contextBudgets = [], contextSourceChecks = [];
    for (let i = 0; i < 30; i++) {
      const anchor = i % anchors.length, start = performance.now();
      const context = await service.context(queries[anchor], { budget: 8500 });
      contextTimes.push(performance.now() - start);
      const usedChars = context.text.length + context.messages.reduce((n, row) => n + JSON.stringify(row).length, 0);
      contextBudgets.push(usedChars);
      const reference = context.references.find(row => row.id === `scale-memory-${String(anchor).padStart(6, '0')}`);
      contextSourceChecks.push(!!reference && reference.sources.length === 1 && reference.sources[0] === anchorSourceIds[anchor]);
    }

    const provenanceRows = await service.db.request('get', { ids: [
      ...anchorSourceIds, ...anchors.map((_, i) => `scale-memory-${String(i).padStart(6, '0')}`),
    ] });
    const byId = new Map(provenanceRows.rows.map(row => [row.id, service.decode(row)]));
    const provenancePass = anchors.every((_, i) => {
      const memory = byId.get(`scale-memory-${String(i).padStart(6, '0')}`);
      const source = byId.get(anchorSourceIds[i]);
      return memory?.kind === 'memory' && memory.value.sources?.[0] === anchorSourceIds[i]
        && source?.kind === 'message' && source.value.role === 'user' && source.value.content.includes(memory.value.evidence);
    });

    await service.close(); service = null;
    const closedSizes = sizes(dir);
    const reopenStarted = performance.now();
    service = makeService(dir, safeStorage);
    await service.init();
    const reopenMs = performance.now() - reopenStarted;
    if (!service.db) throw new Error(`vault reopen failed: ${service.error}`);
    const stats = await service.stats();
    const reopenedAnchorSearches = await Promise.all(queries.map(async (query, i) =>
      (await service.search(query, ['memory'], 5)).some(row => row.id === `scale-memory-${String(i).padStart(6, '0')}`)));
    const reopenedSourceRows = await service.db.request('get', { ids: anchorSourceIds });
    const reopenProvenancePass = reopenedSourceRows.rows.length === anchorSourceIds.length
      && reopenedAnchorSearches.every(Boolean);
    await service.close(); service = null;

    const report = {
      schema: 'workbunny-memory-scale-v1', generatedAt: new Date().toISOString(),
      dataset: { messages: messageCount, memories: memoryCount, totalRows: messageCount + memoryCount,
        syntheticOnly: true, timelineYears: 10, memorySourceRatio: 0.1 },
      environment: { platform: os.platform(), architecture: os.arch(), node: process.version, cpuCount: os.cpus().length },
      insertMs: { messages: Number(messageWriteMs.toFixed(2)), memories: Number(memoryWriteMs.toFixed(2)), total: Number((performance.now() - started).toFixed(2)) },
      sizesBytes: { whileOpen: liveSizes, afterClose: closedSizes },
      searchMs: { samples: searchTimes.length, p50: percentile(searchTimes, 0.50), p95: percentile(searchTimes, 0.95) },
      contextMs: { samples: contextTimes.length, p50: percentile(contextTimes, 0.50), p95: percentile(contextTimes, 0.95), budgetChars: 8500,
        maxUsedChars: Math.max(...contextBudgets), maxUsedPercent: Number((Math.max(...contextBudgets) / 8500 * 100).toFixed(2)) },
      checks: { oldFactRecall: searchPasses.filter(Boolean).length, oldFactQueries: searchPasses.length,
        contextSourceReferences: contextSourceChecks.filter(Boolean).length, contextSourceChecks: contextSourceChecks.length,
        anchorProvenance: provenancePass, reopenedOldFactRecall: reopenedAnchorSearches.filter(Boolean).length,
        reopenedSourceRows: reopenedSourceRows.rows.length, reopenedMessageCount: stats.counts.message,
        reopenedMemoryCount: stats.counts.memory, reopenedProvenance: reopenProvenancePass, reopenMs: Number(reopenMs.toFixed(2)) },
      scope: 'Synthetic ten-year scale, retrieval, and reopen simulation using real encrypted writes and SQLite indexes; not evidence of real-user memory accuracy or ten-year production reliability.',
    };
    if (report.checks.oldFactRecall !== report.checks.oldFactQueries || report.checks.contextSourceReferences !== report.checks.contextSourceChecks
      || !report.checks.anchorProvenance || !report.checks.reopenedProvenance || report.contextMs.maxUsedChars > 8500
      || stats.counts.message !== messageCount || stats.counts.memory !== memoryCount) {
      throw new Error('scale correctness check failed');
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    await service?.close().catch(() => {});
    safeStorage.destroy();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`scale evaluation failed: ${error.message}\n`); process.exitCode = 1; });
