'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { VaultDB } = require('../src/main/vault-db');

function row(id, ts, { sources = [], tokens = [], kind = 'state', domain = 'work', visibilityFloor = 0, ...extra } = {}) {
  return { id, kind, ts, updatedAt: ts, state: 'active', body: `cipher-${id}`, sources, tokens, domain, visibilityFloor, ...extra };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const suppliedBin = process.env.WORKBUNNY_VAULT_TEST_BINARY;
  if (!suppliedBin) execFileSync(path.join(__dirname, '../tools/build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-vault-knowledge-'));
  const vault = new VaultDB({ bin: suppliedBin ? path.resolve(suppliedBin) : path.join(root, 'bin', 'vault'),
    file: path.join(temp, 'knowledge.sqlite3'), timeoutMs: 10000 });
  const h = {
    relevance: 'R'.repeat(22), doubt: 'D'.repeat(22), experience: 'E'.repeat(22), tool: 'T'.repeat(22),
    private: 'P'.repeat(22), excluded: 'X'.repeat(22), source: 'S'.repeat(22),
  };
  try {
    await vault.init();
    await vault.request('write', { epoch: 0, records: [
      row('state-doubt-hot', 30, { tokens: [h.relevance, h.doubt, h.private] }),
      row('state-experience', 20, { tokens: [h.relevance, h.experience, h.tool] }),
      row('state-doubt-cool', 10, { tokens: [h.relevance, h.doubt] }),
      row('state-other-scope', 40, { tokens: [h.relevance, h.doubt, h.private], domain: 'life', visibilityFloor: 1 }),
      row('source-root', 50, { tokens: [h.source] }),
    ] });

    // The default query/search path remains unchanged when the optional filters are omitted.
    const defaults = await vault.request('search', { tokens: [h.relevance], kind: 'state', scene: 'work', now: 100 });
    assert.deepEqual(defaults.rows.map(x => x.id), ['state-doubt-hot', 'state-experience', 'state-doubt-cool']);
    const defaultQuery = await vault.request('query', { kind: 'state', scene: 'work', state: 'all' });
    assert.equal(defaultQuery.rows.length, 4);

    // All required tokens must match and any excluded token removes the row,
    // before ranking/limit; high scoring records in other classes cannot crowd it out.
    const doubt = await vault.request('search', { tokens: [h.relevance, h.private], requiredTokens: [h.doubt],
      excludedTokens: [h.private], kind: 'state', scene: 'work', now: 100, limit: 1 });
    assert.deepEqual(doubt.rows.map(x => x.id), ['state-doubt-cool']);
    const scopedSearch = await vault.request('search', { tokens: [h.relevance, h.private], requiredTokens: [h.doubt],
      kind: 'state', scene: 'work', now: 100, limit: 1 });
    assert.deepEqual(scopedSearch.rows.map(x => x.id), ['state-doubt-hot'], 'scene filter precedes ranking and LIMIT');
    const scopedQuery = await vault.request('query', { kind: 'state', scene: 'work', state: 'all',
      requiredTokens: [h.doubt], limit: 1 });
    assert.deepEqual(scopedQuery.rows.map(x => x.id), ['state-doubt-hot'], 'scene and required-token filters precede query LIMIT');
    const experience = await vault.request('search', { tokens: [h.relevance], requiredTokens: [h.experience, h.tool],
      kind: 'state', scene: 'work', now: 100, limit: 1 });
    assert.deepEqual(experience.rows.map(x => x.id), ['state-experience']);
    assert.deepEqual((await vault.request('search', { tokens: [h.relevance], requiredTokens: [h.doubt],
      scene: 'work', now: 100, limit: 10 })).rows.map(x => x.id), ['state-doubt-hot', 'state-doubt-cool']);

    // Query filters are also applied before LIMIT and work with indexed sourceId entry.
    await vault.request('write', { epoch: 0, records: [
      row('child-doubt', 60, { sources: ['source-root'], tokens: [h.source, h.doubt] }),
      row('child-experience', 70, { sources: ['source-root'], tokens: [h.source, h.experience] }),
    ] });
    const child = await vault.request('query', { kind: 'state', scene: 'work', sourceId: 'source-root',
      requiredTokens: [h.experience], excludedTokens: [h.doubt], limit: 1 });
    assert.deepEqual(child.rows.map(x => x.id), ['child-experience']);
    assert.deepEqual((await vault.request('query', { kind: 'state', scene: 'work', sourceId: 'source-root',
      requiredTokens: [h.doubt] })).rows.map(x => x.id), ['child-doubt']);

    for (const [op, payload] of [
      ['query', { requiredTokens: ['not-an-hmac-token'] }],
      ['query', { excludedTokens: Array(9).fill(h.doubt) }],
      ['search', { tokens: [h.relevance], requiredTokens: [h.doubt, 'bad'] }],
      ['search', { tokens: [h.relevance], excludedTokens: 'not-an-array' }],
    ]) await assert.rejects(vault.request(op, { ...payload, now: 100 }), error => error.code === 'invalid_request');

    // A long acyclic lineage is accepted; adding an edge back to its root is rejected atomically.
    const chainLength = 120;
    for (let i = 0; i < chainLength; i++) {
      const id = `chain-${String(i).padStart(3, '0')}`;
      const sources = i === 0 ? [] : [`chain-${String(i - 1).padStart(3, '0')}`];
      await vault.request('write', { epoch: 0, records: [row(id, 100 + i, { sources })] });
    }
    const rootId = 'chain-000', leafId = `chain-${String(chainLength - 1).padStart(3, '0')}`;
    await assert.rejects(vault.request('write', { epoch: 0, records: [row(rootId, 999, { sources: [leafId] })] }),
      error => error.code === 'invalid_source');
    assert.deepEqual((await vault.request('get', { ids: [rootId] })).rows[0].body, `cipher-${rootId}`);

    // Validate against the batch's final graph, not temporary old edges: the
    // removed a->b edge means the replacement b->a is legal.
    await vault.request('write', { epoch: 0, records: [row('replace-a', 1)] });
    await vault.request('write', { epoch: 0, records: [row('replace-b', 2, { sources: ['replace-a'] })] });
    await vault.request('write', { epoch: 0, records: [
      row('replace-a', 3, { sources: ['replace-b'] }),
      row('replace-b', 4),
    ] });
    assert.deepEqual((await vault.request('query', { sourceId: 'replace-b', state: 'all' })).rows.map(x => x.id), ['replace-a']);
    assert.deepEqual((await vault.request('query', { sourceId: 'replace-a', state: 'all' })).rows, []);

    // A cycle composed entirely of two batch upserts is rejected as one transaction.
    await vault.request('write', { epoch: 0, records: [row('cycle-a', 5), row('cycle-b', 6)] });
    await assert.rejects(vault.request('write', { epoch: 0, records: [
      row('cycle-a', 7, { sources: ['cycle-b'] }), row('cycle-b', 8, { sources: ['cycle-a'] }),
    ] }), error => error.code === 'invalid_source');
    assert.deepEqual((await vault.request('query', { sourceId: 'cycle-a', state: 'all' })).rows, []);
    assert.deepEqual((await vault.request('query', { sourceId: 'cycle-b', state: 'all' })).rows, []);
    assert.deepEqual((await vault.request('get', { ids: ['cycle-a', 'cycle-b'] })).rows.map(x => x.body),
      ['cipher-cycle-b', 'cipher-cycle-a']);
    assert.equal((await vault.request('stats', { scene: null })).epoch, 0, 'rejected cycle does not advance privacy epoch');

    console.log('Vault knowledge filters and lineage checks passed');
  } finally {
    await vault.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
