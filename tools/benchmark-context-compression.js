'use strict';

// Synthetic one-shot benchmark for the v0.7 context compression path.
// Uses an isolated SQLite vault, random test key, and a deterministic local
// summarizer stub. It never invokes a model or the packaging/build scripts.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { MemoryService } = require('../src/main/memory-service');
const { ContextCompression, HEAD_TEXT_BUDGET } = require('../src/main/context-compression');
const { SCENES, rank } = require('../src/main/memory-scope');

const ROOT = path.resolve(__dirname, '..');
const VAULT_BIN = path.join(ROOT, 'bin', 'vault');
const MESSAGES_PER_SCENE = 2_500;
const ROUNDS_PER_SCENE = MESSAGES_PER_SCENE / 2;
const WRITE_BATCH = 200;
const CONTEXT_SAMPLES = 15;
const FIXED_RECENT_ROUNDS = 8;

function percentile(values, percentileValue) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(percentileValue * ordered.length) - 1)];
}

function bytesInTree(dir) {
  if (!fs.existsSync(dir)) return 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? bytesInTree(full) : fs.statSync(full).size;
  }
  return bytes;
}

function nativeRssBytes(pid) {
  if (!pid) return null;
  try {
    const value = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return Number.isFinite(value) && value > 0 ? value * 1024 : null;
  } catch { return null; }
}

function startResourceSampler(pid) {
  const stats = { nodePeakBytes: 0, nativePeakBytes: null, nodeCurrentBytes: 0, nativeCurrentBytes: null };
  const sample = () => {
    const nodeBytes = process.memoryUsage().rss;
    stats.nodeCurrentBytes = nodeBytes;
    stats.nodePeakBytes = Math.max(stats.nodePeakBytes, nodeBytes);
    const nativeBytes = nativeRssBytes(pid);
    if (nativeBytes !== null) {
      stats.nativeCurrentBytes = nativeBytes;
      stats.nativePeakBytes = Math.max(stats.nativePeakBytes || 0, nativeBytes);
    }
  };
  sample();
  const timer = setInterval(sample, 250);
  timer.unref();
  return { stats, stop() { clearInterval(timer); sample(); return stats; } };
}

function makeRecords() {
  const records = [];
  const idsByScene = Object.fromEntries(SCENES.map(scene => [scene, []]));
  const turnsByScene = Object.fromEntries(SCENES.map(scene => [scene, []]));
  let ts = Date.UTC(2025, 0, 1);
  for (const scene of SCENES) {
    for (let round = 1; round <= ROUNDS_PER_SCENE; round++) {
      const turnId = `bench-${scene}-turn-${String(round).padStart(5, '0')}`;
      turnsByScene[scene].push(turnId);
      for (const role of ['user', 'assistant']) {
        const id = `bench-${scene}-${String(round).padStart(5, '0')}-${role === 'user' ? 'u' : 'a'}`;
        const content = role === 'user'
          ? `Synthetic benchmark project planning request in ${scene}, round ${round}: review the milestones and schedule the next checkpoint.`
          : `Synthetic benchmark response in ${scene}, round ${round}: milestones recorded and the next checkpoint is ready for review.`;
        records.push({ id, kind: 'message', ts: ts++, domain: scene, visibilityFloor: rank(scene),
          value: { role, content, turnId, sources: [] } });
        idsByScene[scene].push(id);
      }
    }
  }
  return { records, idsByScene, turnsByScene };
}

async function writeSyntheticMessages(memory, records) {
  const started = performance.now();
  for (let offset = 0; offset < records.length; offset += WRITE_BATCH) {
    await memory.write(records.slice(offset, offset + WRITE_BATCH), memory.epoch, { notify: false });
  }
  return performance.now() - started;
}

async function verifyScopeAndRecentBoundary(memory, scene, callsForScene, turnsByScene) {
  const sceneRank = rank(scene);
  const allowedTurns = [];
  for (const sourceScene of SCENES) {
    if (rank(sourceScene) <= sceneRank) allowedTurns.push(...turnsByScene[sourceScene]);
  }
  // Ingestion is grouped by source scene, matching the generated write order.
  const recentTurns = new Set(allowedTurns.slice(-FIXED_RECENT_ROUNDS));
  for (const call of callsForScene) {
    for (const input of call.messages) {
      const sourceScene = SCENES.find(candidate => input.id.startsWith(`bench-${candidate}-`));
      if (!sourceScene || rank(sourceScene) > sceneRank) throw new Error(`${scene} summarize received an out-of-scope source`);
      if (recentTurns.has(input.turnId)) throw new Error(`${scene} summarize included one of the recent ${FIXED_RECENT_ROUNDS} turns`);
    }
  }
  const snapshot = await memory.compression.snapshot(scene);
  if (!snapshot.recordId || snapshot.text.length > HEAD_TEXT_BUDGET) throw new Error(`${scene} head missing or over text budget`);
  const headRaw = (await memory.db.request('get', { ids: [snapshot.recordId], scene })).rows[0];
  const head = memory.decode(headRaw);
  if (head.domain !== scene || head.visibilityFloor !== sceneRank) throw new Error(`${scene} head scope mismatch`);
  const scoped = (await memory.db.request('get', { ids: head.value.sources, scene })).rows;
  if (scoped.length !== head.value.sources.length || scoped.some(row => row.visibilityFloor > sceneRank))
    throw new Error(`${scene} head source list crossed visibility scope`);
  return { snapshot, head, scopedSourceCount: scoped.length };
}

async function main() {
  if (!fs.existsSync(VAULT_BIN)) throw new Error(`Existing vault binary is missing; benchmark will not build it: ${VAULT_BIN}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-context-bench-'));
  const vaultDir = path.join(tempRoot, 'vault');
  const memory = new MemoryService({
    dir: vaultDir,
    bin: VAULT_BIN,
    openKey: async () => crypto.randomBytes(32),
    getSettings: () => ({ enabled: true, extract: false, scene: 'life', recentRounds: FIXED_RECENT_ROUNDS }),
    clock: () => Date.now(),
    random: () => 0.5,
  });
  const { records, idsByScene, turnsByScene } = makeRecords();
  const modelCallsByScene = Object.fromEntries(SCENES.map(scene => [scene, 0]));
  const modelInputsByScene = Object.fromEntries(SCENES.map(scene => [scene, []]));
  let sampler;
  let report;
  try {
    await memory.init();
    if (!memory.ready) throw new Error(`Temporary vault did not open: ${memory.error || 'unknown error'}`);
    sampler = startResourceSampler(memory.db.child?.pid);
    const writeMs = await writeSyntheticMessages(memory, records);
    const compression = new ContextCompression({
      memory,
      recentRounds: FIXED_RECENT_ROUNDS,
      summarize: async (messages, { scene }) => {
        const callNo = ++modelCallsByScene[scene];
        modelInputsByScene[scene].push(...messages);
        const first = messages[0];
        return {
          content: `离线导航摘要：${scene} 路径第 ${callNo} 批覆盖 ${messages.length} 条合成原文。`,
          excerpts: [{ sourceId: first.id, quote: first.content.slice(0, 120) }],
        };
      },
    });
    memory.compression = compression;
    const compressionStarted = performance.now();
    const compressed = await compression.run({
      canRun: async () => true,
      reserveModelCall: async () => ({ ok: true }),
    });
    const compressionMs = performance.now() - compressionStarted;
    if (compressed.status !== 'done') throw new Error(`Compression stopped: ${compressed.status}${compressed.note ? ` (${compressed.note})` : ''}`);

    const expectedProcessedByScene = {
      work: (MESSAGES_PER_SCENE - FIXED_RECENT_ROUNDS * 2),
      life: (MESSAGES_PER_SCENE * 2 - FIXED_RECENT_ROUNDS * 2),
      private: (MESSAGES_PER_SCENE * 3 - FIXED_RECENT_ROUNDS * 2),
    };
    const expectedProcessedTotal = Object.values(expectedProcessedByScene).reduce((sum, count) => sum + count, 0);
    if (compressed.processed !== expectedProcessedTotal)
      throw new Error(`compression processed ${compressed.processed} inputs; expected ${expectedProcessedTotal}`);
    for (const scene of SCENES) {
      const seen = modelInputsByScene[scene].length;
      if (seen !== expectedProcessedByScene[scene])
        throw new Error(`${scene} compressed ${seen} inputs; expected ${expectedProcessedByScene[scene]} after leaving the recent tail intact`);
      await verifyScopeAndRecentBoundary(memory, scene, modelInputsByScene[scene].length ?
        // Build the same call boundary while using retained IDs to validate each message.
        [{ messages: modelInputsByScene[scene] }] : [], turnsByScene);
    }
    const callsTotal = Object.values(modelCallsByScene).reduce((sum, count) => sum + count, 0);
    const segmentsByScene = {};
    const headBytesByScene = {};
    const scopedHeadSources = {};
    for (const scene of SCENES) {
      const { snapshot, head, scopedSourceCount } = await verifyScopeAndRecentBoundary(memory, scene,
        [{ messages: modelInputsByScene[scene] }], turnsByScene);
      segmentsByScene[scene] = {
        createdInThisRun: modelCallsByScene[scene],
        retainedInHead: head.value.segments.length,
      };
      headBytesByScene[scene] = Buffer.byteLength(snapshot.text, 'utf8');
      scopedHeadSources[scene] = scopedSourceCount;
    }

    const contextStats = {};
    for (const scene of SCENES) {
      const samples = [];
      let observedMessages = 0, observedSources = 0, observedChars = 0;
      for (let sample = 0; sample < CONTEXT_SAMPLES; sample++) {
        const started = performance.now();
        const assembled = await memory.context('synthetic benchmark project planning schedule', {
          scene, budget: 8_500, recent: [],
        });
        samples.push(performance.now() - started);
        if (assembled.used > 8_500) throw new Error(`${scene} context exceeded its 8,500 character budget`);
        if (assembled.compressionVersion < 1) throw new Error(`${scene} context did not include the compressed head version`);
        if (assembled.messages.length !== FIXED_RECENT_ROUNDS * 2) throw new Error(`${scene} context did not retain exactly the most recent eight complete turns`);
        if (assembled.messages.some(message => !message.content.includes('Synthetic benchmark')))
          throw new Error(`${scene} recent context included non-synthetic data`);
        const sourceRows = (await memory.db.request('get', { ids: assembled.sourceIds, scene })).rows;
        if (sourceRows.length !== new Set(assembled.sourceIds).size || sourceRows.some(row => row.visibilityFloor > rank(scene)))
          throw new Error(`${scene} assembled context exposes an unavailable source`);
        const tailRows = (await memory.query('message', 16, { scene, sort: 'ingestion', order: 'desc' }));
        if (assembled.messages.some((message, index) => message.content !== tailRows[tailRows.length - 1 - index]?.value.content))
          throw new Error(`${scene} assembled context did not use the expected recent raw messages`);
        observedMessages = assembled.messages.length;
        observedSources = assembled.sourceIds.length;
        observedChars = assembled.used;
      }
      contextStats[scene] = {
        samples: CONTEXT_SAMPLES,
        p50Ms: Number(percentile(samples, 0.50).toFixed(2)),
        p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
        messageCount: observedMessages,
        sourceCount: observedSources,
        usedCharacters: observedChars,
        headVersion: (await compression.snapshot(scene)).version,
      };
    }

    const vaultBytesBeforeClose = bytesInTree(vaultDir);
    const rss = sampler.stop();
    report = {
      benchmark: 'context-compression synthetic one-shot',
      disclaimer: '合成单机数据，只观测当前实现的机械性能与边界，不代表多年内容质量、真实召回效果或生产硬件表现。',
      environment: { node: process.version, platform: process.platform, arch: process.arch, vaultBinary: path.relative(ROOT, VAULT_BIN) },
      data: {
        rawMessageRecords: records.length,
        roundsPerDomain: ROUNDS_PER_SCENE,
        rawRecordsByDomain: Object.fromEntries(SCENES.map(scene => [scene, idsByScene[scene].length])),
        syntheticPayloadBytes: records.reduce((sum, row) => sum + Buffer.byteLength(row.value.content, 'utf8'), 0),
      },
      ingestion: { batchSize: WRITE_BATCH, elapsedMs: Number(writeMs.toFixed(2)) },
      compression: {
        status: compressed.status,
        processedInputs: compressed.processed,
        expectedInputs: expectedProcessedByScene,
        offlineStubCalls: callsTotal,
        callsByScene: modelCallsByScene,
        segmentsRetainedInHeads: segmentsByScene,
        headUtf8Bytes: headBytesByScene,
        headSourceCounts: scopedHeadSources,
        elapsedMs: Number(compressionMs.toFixed(2)),
      },
      contextAssembly: contextStats,
      storage: { vaultDirectoryBytesBeforeClose: vaultBytesBeforeClose },
      memory: {
        nodeRssPeakBytesObserved: rss.nodePeakBytes,
        nodeRssCurrentBytesObserved: rss.nodeCurrentBytes,
        vaultNativeRssPeakBytesObserved: rss.nativePeakBytes,
        vaultNativeRssCurrentBytesObserved: rss.nativeCurrentBytes,
        samplingIntervalMs: 250,
      },
    };
  } finally {
    if (sampler) sampler.stop();
    await memory.close();
    const bytesAfterClose = bytesInTree(vaultDir);
    if (report) report.storage.vaultDirectoryBytesAfterClose = bytesAfterClose;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(`context benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
