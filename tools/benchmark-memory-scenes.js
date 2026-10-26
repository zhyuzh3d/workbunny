'use strict';

// Synthetic, isolated performance and scene-boundary benchmark. Uses the real
// encrypted MemoryService and the already-built native vault binary.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { MemoryService } = require('../src/main/memory-service');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const scenes = ['work', 'life', 'private'];
const sceneFloor = { work: 0, life: 1, private: 2 };
const markers = {
  work: 'SYNTHETIC_WORK_ONLY_MARKER_Q7M4',
  life: 'SYNTHETIC_LIFE_ONLY_MARKER_P3K8',
  private: 'SYNTHETIC_PRIVATE_ONLY_MARKER_V9C2',
};
const popular = 'popularneedle';
const hotWork = 'workscopehit';

function parseRows(argv) {
  const arg = argv.find(x => x.startsWith('--records-per-scene='));
  const count = arg ? Number(arg.slice('--records-per-scene='.length)) : 1000;
  if (!Number.isSafeInteger(count) || count < 200 || count > 10000) {
    throw new Error('--records-per-scene must be an integer from 200 to 10000');
  }
  return count;
}

function percentile(values, p) {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)].toFixed(2));
}

function sizes(dir) {
  const bytes = name => {
    try { return fs.statSync(path.join(dir, name)).size; } catch { return 0; }
  };
  const database = bytes('companion.db'), wal = bytes('companion.db-wal'), sharedMemory = bytes('companion.db-shm');
  return { database, wal, sharedMemory, databaseAndWal: database + wal, total: database + wal + sharedMemory };
}

function rssBytes(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const text = execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    const kb = Number(text);
    return Number.isFinite(kb) && kb > 0 ? Math.round(kb * 1024) : null;
  } catch { return null; }
}

function row(scene, kind, id, ts, value) {
  return { id, kind, ts, updatedAt: ts, domain: scene, visibilityFloor: sceneFloor[scene],
    state: 'active', value };
}

function makeService(dir, key, settings, fixedNow) {
  return new MemoryService({ dir, bin, openKey: async () => Buffer.from(key),
    getSettings: () => ({ enabled: true, extract: false, recentRounds: 8, scene: settings.scene }),
    clock: () => fixedNow, random: () => 0 });
}

async function writeBatches(service, records, batchSize = 200) {
  for (let i = 0; i < records.length; i += batchSize) {
    await service.write(records.slice(i, i + batchSize));
  }
}

function assertScopeResult(rows, scene, marker) {
  const visible = scene === 'private' ? scenes : scene === 'life' ? ['work', 'life'] : ['work'];
  for (const other of scenes) {
    const matching = rows.some(row => row.value?.content?.includes(markers[other]));
    assert.equal(matching, visible.includes(other), `search scope mismatch for ${scene}/${other}`);
  }
  assert(rows.some(row => row.value?.content?.includes(marker)), `scene ${scene} did not retrieve its synthetic marker`);
}

function assertContextScope(context, scene, marker) {
  const visible = scene === 'private' ? scenes : scene === 'life' ? ['work', 'life'] : ['work'];
  const text = `${context.text}\n${context.messages.map(m => m.content).join('\n')}`;
  for (const other of scenes) assert.equal(text.includes(markers[other]), visible.includes(other), `context scope mismatch for ${scene}/${other}`);
  assert(text.includes(marker), `context for ${scene} omitted the marker queried this round`);
  const chars = context.text.length + context.messages.reduce((n, message) => n + JSON.stringify(message).length, 0);
  assert(chars <= 8500, `context exceeded 8500 characters (${chars})`);
  assert.equal(context.used <= 8500, true);
  assert(context.messages.length <= 16, `context included more than eight complete rounds (${context.messages.length} messages)`);
  assert.equal(context.messages.length % 2, 0, 'context must retain complete user/assistant rounds');
  const expected = [];
  for (let turn = 4; turn < 12; turn++) {
    expected.push({ role: 'user', content: `ROUND_${scene.toUpperCase()}_${turn}_USER: complete synthetic sentence.` });
    expected.push({ role: 'assistant', content: `ROUND_${scene.toUpperCase()}_${turn}_ASSISTANT: complete synthetic reply.` });
  }
  assert.deepEqual(context.messages, expected, 'the recent window must contain eight intact rounds without clipped sentences');
}

async function pageMessages(service, scene) {
  let afterSeq;
  const ids = new Set(), pageMs = [];
  for (;;) {
    const started = performance.now();
    const cursor = { scene, state: 'all', sort: 'ingestion', order: 'asc', limit: 200,
      ...(afterSeq === undefined ? {} : { afterSeq }) };
    const rows = await service.query('message', 200, cursor);
    pageMs.push(performance.now() - started);
    if (!rows.length) break;
    for (const item of rows) {
      assert(!ids.has(item.id), 'ingestion pagination returned a duplicate row');
      ids.add(item.id);
    }
    const last = rows.at(-1).ingestionSeq;
    assert(Number.isSafeInteger(last) && last > (afterSeq || 0), 'ingestion cursor did not advance monotonically');
    afterSeq = last;
    if (rows.length < 200) break;
  }
  return { count: ids.size, pageMs };
}

async function main() {
  const recordsPerScene = parseRows(process.argv.slice(2));
  if (!fs.existsSync(bin) || !fs.statSync(bin).isFile()) throw new Error('existing bin/vault is required; this benchmark does not build or download it');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-scenes-bench-'));
  const dir = path.join(tempRoot, 'vault');
  const testKey = crypto.randomBytes(32);
  const settings = { scene: 'work' };
  const fixedNow = Date.now();
  let service = null;
  const writeMs = {}, queryTimes = {}, searchTimes = {}, contextTimes = {}, sceneCounts = {};
  let dbBytesOpen = null, dbBytesClosed = null, nodeRss = null, vaultRss = null;
  const pageCounts = {};
  try {
    const totalWriteStart = performance.now();
    service = makeService(dir, testKey, settings, fixedNow);
    await service.init();
    if (!service.db?.child?.pid) throw new Error(`vault init failed: ${service.error || 'native process missing'}`);

    const memoryCount = Math.max(4, Math.floor(recordsPerScene * 0.2));
    const recentMessages = Math.min(24, recordsPerScene - Math.max(4, Math.floor(recordsPerScene * 0.2)) - 1);
    const bulkMessages = recordsPerScene - memoryCount - recentMessages;
    assert(bulkMessages > 0);
    let timeOffset = 0;
    for (const scene of scenes) {
      const started = performance.now();
      const messages = Array.from({ length: bulkMessages + recentMessages }, (_, i) => {
        const ts = fixedNow - 5_000_000 + timeOffset++;
        if (i >= bulkMessages) {
          const turn = Math.floor((i - bulkMessages) / 2), isUser = (i - bulkMessages) % 2 === 0;
          return row(scene, 'message', `bench-${scene}-recent-${String(i - bulkMessages).padStart(3, '0')}`, ts, {
            role: isUser ? 'user' : 'assistant', content: isUser
              ? `ROUND_${scene.toUpperCase()}_${turn}_USER: complete synthetic sentence.`
              : `ROUND_${scene.toUpperCase()}_${turn}_ASSISTANT: complete synthetic reply.`,
            turnId: `bench-turn-${scene}-${turn}`, sources: [],
          });
        }
        const noise = scene === 'private' ? ` ${popular}` : '';
        return row(scene, 'message', `bench-${scene}-message-${String(i).padStart(6, '0')}`, ts, {
          role: i % 2 ? 'assistant' : 'user', content: `Synthetic ${scene} conversation item ${i}${noise}; fictional details only.`, sources: [],
        });
      });
      await writeBatches(service, messages);

      const memories = Array.from({ length: memoryCount }, (_, i) => {
        const sourceIndex = i === 0 ? Math.min(1, messages.length - 1)
          : Math.min(bulkMessages - 1, Math.floor((i - 1) * bulkMessages / Math.max(1, memoryCount - 1)));
        const source = messages[sourceIndex];
        let content = `Synthetic ${scene} long-term fact ${String(i).padStart(5, '0')}: a fictional person keeps a sample preference.`;
        if (i === 0) content = `Synthetic scope fact ${markers[scene]} says the fictional sample likes quiet tea.`;
        if (scene === 'private') content += ` ${popular}`;
        if (scene === 'work' && i === 1) content = `Synthetic work search fact ${popular} ${hotWork}: this is the true work-scene hit.`;
        return row(scene, 'memory', `bench-${scene}-memory-${String(i).padStart(6, '0')}`, source.ts, {
          content, memoryKind: 'fact', importance: i < 2 ? 1 : 0.6, status: 'confirmed',
          evidence: source.value.content.slice(0, 160), sources: [source.id], origin: 'scene-benchmark-synthetic',
        });
      });
      await writeBatches(service, memories);
      writeMs[scene] = Number((performance.now() - started).toFixed(2));
    }
    const totalWriteMs = Number((performance.now() - totalWriteStart).toFixed(2));

    // The only clear work-scoped row matching the common private hotspot plus
    // a work-only term must survive a top-1 search ahead of private noise.
    const hotspotTimes = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now();
      const rows = await service.search(`${popular} ${hotWork}`, ['memory'], 1, { scene: 'work' });
      hotspotTimes.push(performance.now() - start);
      assert(rows[0]?.value?.content.includes(hotWork), 'private popular-token rows crowded out the work-scoped hit');
    }

    for (const scene of scenes) {
      settings.scene = scene;
      await service.changeScene(scene);
      const marker = markers[scene];
      const query = `${markers.work} ${markers.life} ${markers.private}`;
      for (let i = 0; i < 3; i++) {
        const rows = await service.search(query, ['message', 'memory'], 30, { scene });
        assertScopeResult(rows, scene, marker);
        const context = await service.context(query, { scene, budget: 8500 });
        assertContextScope(context, scene, marker);
      }

      const timedSearch = [];
      for (let i = 0; i < 25; i++) {
        const start = performance.now();
        const rows = await service.search(query, ['message', 'memory'], 30, { scene });
        timedSearch.push(performance.now() - start);
        assertScopeResult(rows, scene, marker);
      }
      searchTimes[scene] = { samples: timedSearch.length, p50Ms: percentile(timedSearch, 0.50), p95Ms: percentile(timedSearch, 0.95) };

      const timedContext = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const context = await service.context(query, { scene, budget: 8500 });
        timedContext.push(performance.now() - start);
        assertContextScope(context, scene, marker);
      }
      contextTimes[scene] = { samples: timedContext.length, p50Ms: percentile(timedContext, 0.50), p95Ms: percentile(timedContext, 0.95) };

      const paged = await pageMessages(service, scene);
      const visibleSceneCount = scene === 'private' ? 3 : scene === 'life' ? 2 : 1;
      const expectedMessages = visibleSceneCount * (bulkMessages + recentMessages);
      assert.equal(paged.count, expectedMessages, `query pagination row count mismatch for ${scene}`);
      pageCounts[scene] = { records: paged.count, pages: paged.pageMs.length };
      queryTimes[scene] = { samples: paged.pageMs.length, p50Ms: percentile(paged.pageMs, 0.50), p95Ms: percentile(paged.pageMs, 0.95) };
      sceneCounts[scene] = visibleSceneCount * recordsPerScene;
    }

    // Database text should contain ciphertext/HMAC indexes, never these
    // synthetic plaintext markers. This check reads only the isolated fixture.
    const files = ['companion.db', 'companion.db-wal', 'companion.db-shm'];
    let dbRaw = Buffer.alloc(0);
    for (const name of files) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) dbRaw = Buffer.concat([dbRaw, fs.readFileSync(file)]);
    }
    for (const marker of Object.values(markers)) assert.equal(dbRaw.includes(Buffer.from(marker)), false, 'plaintext marker found in isolated SQLite files');
    dbBytesOpen = sizes(dir);
    nodeRss = process.memoryUsage().rss;
    vaultRss = rssBytes(service.db.child.pid);

    const stats = {};
    for (const scene of scenes) {
      settings.scene = scene;
      stats[scene] = (await service.stats()).counts;
      assert.equal(stats[scene].total, sceneCounts[scene]);
    }
    await service.close(); service = null;
    dbBytesClosed = sizes(dir);

    const results = {
      schema: 'workbunny-memory-scenes-benchmark-v1',
      dataset: { recordsPerScene, scenes, totalRows: recordsPerScene * scenes.length,
        memoryRecordsPerScene: memoryCount, conversationMessagesPerScene: recentMessages,
        syntheticOnly: true, randomTestKey: true },
      environment: { platform: os.platform(), architecture: os.arch(), node: process.version },
      timingsMs: { writePerScene: writeMs, totalWrite: totalWriteMs,
        search: searchTimes, context: contextTimes, queryPage: queryTimes,
        privateHotspotTop1Search: { samples: hotspotTimes.length, p50Ms: percentile(hotspotTimes, 0.50), p95Ms: percentile(hotspotTimes, 0.95) } },
      visibleRowsByScene: stats,
      queryPageRecords: pageCounts,
      retainedBytesWhileOpen: dbBytesOpen,
      retainedBytesAfterClose: dbBytesClosed,
      processRssReferenceBytes: { node: nodeRss, nativeVaultChild: vaultRss },
      checks: { sceneSearchMarkers: 'passed', sceneContextMarkers: 'passed', noPlaintextMarkersInSQLite: true,
        contextBudgetMaxChars: 8500, contextRecentRoundLimit: 8, contextRecentTurnsUntruncated: true,
        stableIngestionPagination: 'passed', privateHotspotDidNotCrowdWorkHit: true },
      scope: '本机临时SQLite合成数据观测；不代表真实记忆质量、多年可靠性或模型首声延迟。',
    };
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await service?.close().catch(() => {});
    testKey.fill(0);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message || 'benchmark failed'); process.exitCode = 1; });
