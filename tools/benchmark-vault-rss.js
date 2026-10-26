#!/usr/bin/env node
'use strict';

// Synthetic, disposable long-lived vault RSS observation. Pass one or two
// binary paths to compare a pre-change build with a candidate build:
//   node tools/benchmark-vault-rss.js /tmp/vault-before /tmp/vault-after
// No app, user database, model, or real ciphertext is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { VaultDB } = require('../src/main/vault-db');

const root = path.resolve(__dirname, '..');
const defaultBin = path.join(root, 'bin', 'vault');
const bins = process.argv.slice(2).length ? process.argv.slice(2).map(p => path.resolve(p)) : [defaultBin];
const rowCount = Number(process.env.WORKBUNNY_VAULT_RSS_ROWS || 2400);
const iterations = Number(process.env.WORKBUNNY_VAULT_RSS_ITERATIONS || 1200);
if (!Number.isSafeInteger(rowCount) || rowCount < 200 || rowCount > 10000 ||
    !Number.isSafeInteger(iterations) || iterations < 100 || iterations > 10000) throw new Error('invalid synthetic workload size');

function rssBytes(pid) {
  const raw = execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const kb = Number(raw);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

async function seedFixture(bin, file) {
  const vault = new VaultDB({ bin, file, timeoutMs: 30_000 });
  try {
    await vault.init();
    const stats = await vault.request('stats');
    assert.equal(stats.counts.total || 0, 0, 'RSS fixture starts from an empty isolated database');
    const records = Array.from({ length: rowCount }, (_, index) => ({
      id: `rss-fixture-${String(index).padStart(6, '0')}`, kind: index % 5 === 0 ? 'state' : 'message',
      ts: 1_700_000_000_000 + index, updatedAt: 1_700_000_000_000 + index, state: 'active',
      body: `synthetic-cipher-envelope-${index}`, tokens: [], sources: [],
      domain: index % 3 === 0 ? 'work' : index % 3 === 1 ? 'life' : 'private',
      visibilityFloor: index % 3,
    }));
    for (let offset = 0; offset < records.length; offset += 200) {
      await vault.request('write', { epoch: 0, records: records.slice(offset, offset + 200) });
    }
  } finally { await vault.close().catch(() => {}); }
}

async function measure(bin, label, file, expectedInitialRows) {
  if (!fs.existsSync(bin) || !fs.statSync(bin).isFile()) throw new Error(`vault binary not found: ${bin}`);
  const vault = new VaultDB({ bin, file, timeoutMs: 30_000 });
  try {
    await vault.init();
    const beforeStats = await vault.request('stats');
    assert.equal(beforeStats.counts.total, expectedInitialRows);
    const ids = Array.from({ length: 200 }, (_, index) => `rss-fixture-${String(index).padStart(6, '0')}`);
    const pid = vault.child.pid;
    const rss = [];
    const sample = phase => {
      const value = rssBytes(pid);
      if (value !== null) rss.push({ phase, bytes: value });
    };
    sample('after-write');
    for (let index = 1; index <= iterations; index++) {
      const query = await vault.request('query', { scene: null, state: 'all', limit: 200, sort: 'ingestion', order: 'desc' });
      assert.equal(query.rows.length, 200);
      const get = await vault.request('get', { ids });
      assert.equal(get.rows.length, ids.length);
      if (index % 100 === 0 || index === iterations) sample(`after-${index * 2}-reads`);
    }
    await assert.rejects(vault.request('synthetic-invalid-op'), error => error.code === 'unknown_operation');
    await vault.request('write', { epoch: 0, records: [{ id: 'rss-post-read-write', kind: 'message', ts: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000, state: 'active', body: 'synthetic-cipher-after-read', tokens: [], sources: [],
      domain: 'work', visibilityFloor: 0 }] });
    assert.equal((await vault.request('get', { ids: ['rss-post-read-write'] })).rows[0]?.id, 'rss-post-read-write');
    assert.equal((await vault.request('query', { scene: 'work', state: 'all', limit: 1 })).rows[0]?.id, 'rss-post-read-write');
    const stats = await vault.request('stats');
    assert.equal(stats.counts.total, rowCount + 1, 'process remains responsive through an error and subsequent write/read');
    sample('after-final-stats');
    const bytes = rss.map(point => point.bytes);
    return {
      label, rows: rowCount, queryAndGetPairs: iterations,
      rssBytes: { initial: bytes[0], peakSampled: Math.max(...bytes), final: bytes.at(-1),
        sampledDelta: bytes.at(-1) - bytes[0], peakDelta: Math.max(...bytes) - bytes[0] },
      samples: rss,
      protocol: { finalStatsTotal: stats.counts.total, processAliveAfterWork: !vault.closed,
        errorResponseThenWriteAndReadSucceeded: true },
    };
  } finally {
    await vault.close().catch(() => {});
  }
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-vault-rss-'));
  const file = path.join(temp, 'companion.db');
  try {
    await seedFixture(bins[0], file);
    const results = [];
    for (let index = 0; index < bins.length; index++) {
      results.push(await measure(bins[index], index ? `candidate-${index}` : 'baseline-or-single', file,
        rowCount + (index > 0 ? 1 : 0)));
    }
    if (results.length === 2) {
      assert(results[1].rssBytes.peakDelta < results[0].rssBytes.peakDelta * 0.25,
        `candidate did not sufficiently reduce sampled RSS growth: baseline=${results[0].rssBytes.peakDelta}, candidate=${results[1].rssBytes.peakDelta}`);
    }
    process.stdout.write(JSON.stringify({ schema: 'workbunny-vault-rss-observation-v1', syntheticOnly: true,
      sameTemporaryDatabaseForAllRuns: true, platform: `${os.platform()}-${os.arch()}`, results }, null, 2) + '\n');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
