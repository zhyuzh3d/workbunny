'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { VaultDB } = require('../src/main/vault-db');

async function main() {
  const root = path.resolve(__dirname, '..');
  execFileSync(path.join(__dirname, '../tools/build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-vault-test-'));
  const dbFile = path.join(temp, 'vault.sqlite3');
  const bin = path.join(root, 'bin', 'vault');
  for (const args of [
    ['--verify-key-parent'],
    ['--verify-key-parent', '--parent-pid=1', '--parent-path=/Applications/Forged.app/Contents/MacOS/workbunny'],
  ]) {
    const result = execFileSync(bin, args, { cwd: root, encoding: 'utf8' });
    assert.equal(result, '{"authorized":false}\n');
  }
  const vault = new VaultDB({ bin, file: dbFile, timeoutMs: 10000 });
  const row = (id, kind, ts, tokens, sources = [], extra = {}) => ({
    id, kind, ts, updatedAt: ts, state: 'active', body: `ciphertext:${id}`,
    tokens, sources, ...extra,
  });
  try {
    const initial = await vault.init();
    assert.equal(initial.epoch, 0);
    assert.equal(initial.counts.total, 0);
    assert.equal(fs.statSync(temp).mode & 0o777, 0o700);
    assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600);

    const write = await vault.request('write', {
      epoch: 0,
      records: [
        row('source', 'message', 100, ['hmac:a', 'hmac:b']),
        row('source-tie', 'message', 100, ['hmac:a']),
      ],
    });
    assert.equal(write.epoch, 0);
    await vault.request('write', {
      epoch: 0,
      records: [row('summary', 'summary', 200, ['hmac:a'], ['source'])],
    });
    await vault.request('write', {
      epoch: 0,
      records: [
        row('memory', 'memory', 300, ['hmac:a', 'hmac:c'], ['summary']),
        row('expired', 'memory', 350, ['hmac:a', 'hmac:c'], [], { expiresAt: 399 }),
      ],
    });
    const search = await vault.request('search', { tokens: ['hmac:a', 'hmac:c'], now: 400 });
    assert.equal(search.rows[0].id, 'memory');
    assert.equal(search.rows[0].score, 2);
    const boundary = await vault.request('query', { state: 'all', before: 300, beforeId: 'memory', limit: 200 });
    assert.deepEqual(boundary.rows.map((item) => item.id), ['summary', 'source-tie', 'source']);
    const sameTimestampPage = await vault.request('query', { before: 100, beforeId: 'source-tie', limit: 200 });
    assert.deepEqual(sameTimestampPage.rows.map((item) => item.id), ['source']);
    assert(!search.rows.some((item) => item.id === 'expired'));

    await assert.rejects(vault.request('write', {
      epoch: 0,
      records: [row('should-rollback', 'memory', 400, ['hmac:x']), row('summary', 'summary', 401, [], ['memory'])],
    }), (error) => error.code === 'invalid_source');
    await assert.rejects(vault.request('write', {
      epoch: 0,
      records: [row('too-many-tokens', 'memory', 400, Array.from({ length: 513 }, (_, i) => `hmac:${i}`))],
    }), (error) => error.code === 'invalid_record');
    await assert.rejects(vault.request('write', {
      epoch: 0,
      records: [row('too-large-body', 'memory', 400, [], [], { body: 'x'.repeat(2 * 1024 * 1024 + 1) })],
    }), (error) => error.code === 'invalid_record');
    let stats = await vault.request('stats');
    assert.equal(stats.epoch, 0);
    assert.equal(stats.counts.total, 5);
    await assert.rejects(vault.request('write', { epoch: 1, records: [] }), (error) => error.code === 'stale_epoch');

    const removed = await vault.request('remove', { epoch: 0, id: 'source' });
    assert.equal(removed.removed, 3);
    assert.equal(removed.epoch, 1);
    stats = await vault.request('stats');
    assert.equal(stats.counts.total, 2);
    await vault.close();

    const reopened = new VaultDB({ bin, file: dbFile, timeoutMs: 10000 });
    const reopenedStats = await reopened.init();
    assert.equal(reopenedStats.epoch, 1);
    assert.equal(reopenedStats.counts.total, 2);
    await reopened.request('write', { epoch: 1, records: [row('fresh', 'state', 500, ['hmac:z'])] });
    const fetched = await reopened.request('get', { ids: ['fresh'] });
    assert.equal(fetched.rows[0].body, 'ciphertext:fresh');
    await reopened.request('clear');
    assert.equal((await reopened.request('stats')).counts.total, 0);
    assert.equal((await reopened.request('stats')).epoch, 2);
    await reopened.close();
    console.log('VaultDB integration checks passed');
  } finally {
    await vault.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
