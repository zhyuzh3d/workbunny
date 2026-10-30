'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { VaultDB } = require('../src/main/vault-db');

function row(id, ts, { kind = 'message', tokens = [], sources = [], domain, visibilityFloor, ...extra } = {}) {
  return { id, kind, ts, updatedAt: ts, state: 'active', body: `cipher:${id}`, tokens, sources,
    ...(domain === undefined ? {} : { domain }),
    ...(visibilityFloor === undefined ? {} : { visibilityFloor }), ...extra };
}

async function makeVault(bin, file) {
  const vault = new VaultDB({ bin, file, timeoutMs: 10000 });
  await vault.init();
  return vault;
}

async function testMatrix(bin, dir) {
  const file = path.join(dir, 'scenes.sqlite3');
  const vault = await makeVault(bin, file);
  try {
    // Legacy callers which omit both fields must get the conservative default.
    await vault.request('write', { epoch: 0, records: [
      row('legacy-default', 1, { tokens: ['shared'] }),
      row('work', 100, { domain: 'work', visibilityFloor: 0, tokens: ['q1'] }),
      row('life', 200, { domain: 'life', visibilityFloor: 1, tokens: ['q1', 'q2'] }),
      row('private', 1000, { domain: 'private', visibilityFloor: 2, tokens: ['q1', 'q2', 'q3'] }),
    ] });

    const defaults = (await vault.request('get', { ids: ['legacy-default'] })).rows[0];
    assert.equal(defaults.domain, 'private');
    assert.equal(defaults.visibilityFloor, 2);
    assert.deepEqual((await vault.request('query', { scene: 'work', state: 'all' })).rows.map(x => x.id), ['work']);
    assert.deepEqual((await vault.request('query', { scene: 'life', state: 'all' })).rows.map(x => x.id), ['life', 'work']);
    assert.deepEqual((await vault.request('query', { scene: 'private', state: 'all' })).rows.map(x => x.id), ['private', 'life', 'work', 'legacy-default']);
    assert.deepEqual((await vault.request('query', { state: 'all', scene: null })).rows.map(x => x.id),
      ['private', 'life', 'work', 'legacy-default']);
    assert.deepEqual((await vault.request('query', { state: 'all' })).rows.map(x => x.id),
      ['private', 'life', 'work', 'legacy-default']);

    // Visibility is part of SQL filtering before LIMIT, rather than a JS post-filter.
    const page = await vault.request('query', { scene: 'life', state: 'all', limit: 1 });
    assert.deepEqual(page.rows.map(x => x.id), ['life']);
    const workPage = await vault.request('query', { scene: 'work', state: 'all', limit: 1 });
    assert.deepEqual(workPage.rows.map(x => x.id), ['work']);

    // The maintenance worker can page one stable domain/floor partition in
    // either direction without losing records that share a millisecond.
    await vault.request('write', { epoch: 0, records: [
      row('page-a', 77, { domain: 'work', visibilityFloor: 0 }),
      row('page-b', 77, { domain: 'work', visibilityFloor: 0 }),
      row('page-c', 77, { domain: 'work', visibilityFloor: 0 }),
      row('page-life', 77, { domain: 'life', visibilityFloor: 1 }),
      row('page-private-work', 77, { domain: 'work', visibilityFloor: 2 }),
    ] });
    const ascOne = await vault.request('query', { scene: 'life', domain: 'work', visibilityFloor: 0,
      state: 'all', order: 'asc', after: 77, afterId: 'page-a', limit: 1 });
    assert.deepEqual(ascOne.rows.map(x => x.id), ['page-b']);
    const ascTwo = await vault.request('query', { scene: 'life', domain: 'work', visibilityFloor: 0,
      state: 'all', order: 'asc', after: ascOne.rows[0].ts, afterId: ascOne.rows[0].id, limit: 1 });
    assert.deepEqual(ascTwo.rows.map(x => x.id), ['page-c']);
    const descOne = await vault.request('query', { scene: 'life', domain: 'work', visibilityFloor: 0,
      state: 'all', before: 78, beforeId: 'z', limit: 1 });
    assert.deepEqual(descOne.rows.map(x => x.id), ['page-c']);
    const descTwo = await vault.request('query', { scene: 'life', domain: 'work', visibilityFloor: 0,
      state: 'all', before: descOne.rows[0].ts, beforeId: descOne.rows[0].id, limit: 1 });
    assert.deepEqual(descTwo.rows.map(x => x.id), ['page-b']);
    const exactFloor = await vault.request('query', { scene: 'private', domain: 'work', visibilityFloor: 2, state: 'all' });
    assert.deepEqual(exactFloor.rows.map(x => x.id), ['page-private-work']);
    const exactDomain = await vault.request('query', { scene: 'life', domain: 'life', state: 'all' });
    assert.deepEqual(exactDomain.rows.map(x => x.id), ['life', 'page-life']);
    assert.equal((await vault.request('stats', { scene: 'work' })).counts.total, 4);
    assert.equal((await vault.request('stats', { scene: 'life' })).counts.total, 6);
    assert.equal((await vault.request('stats', { scene: 'private' })).counts.total, 9);
    assert.equal((await vault.request('stats', { scene: null })).counts.total, 9);

    // Search scoring and LIMIT also run only over visible rows.
    const ranked = await vault.request('search', { tokens: ['q1', 'q2', 'q3'], scene: 'life', now: 2000, limit: 1 });
    assert.deepEqual(ranked.rows.map(x => x.id), ['life']);
    assert.equal(ranked.rows[0].score, 2);
    assert.deepEqual((await vault.request('search', { tokens: ['q1', 'q2', 'q3'], scene: 'work', now: 2000, limit: 50 })).rows.map(x => x.id), ['work']);
    assert.deepEqual((await vault.request('search', { tokens: ['q1', 'q2', 'q3'], scene: 'private', now: 2000, limit: 50 })).rows.map(x => x.id), ['private', 'life', 'work']);

    // Exact domain/floor constraints are applied in SQLite before grouping,
    // ranking, and LIMIT. A popular newer life-derived version must not crowd
    // an older work-floor-0 result out of a life-readable scene.
    await vault.request('write', { epoch: 0, records: [
      row('search-work-floor0', 10, { kind: 'memory', domain: 'work', visibilityFloor: 0, tokens: ['scene-needle'] }),
      row('search-work-floor1-a', 500, { kind: 'memory', domain: 'work', visibilityFloor: 1, tokens: ['scene-needle', 'scene-extra'] }),
      row('search-work-floor1-b', 600, { kind: 'memory', domain: 'work', visibilityFloor: 1, tokens: ['scene-needle', 'scene-extra'] }),
      row('search-work-floor2', 700, { kind: 'memory', domain: 'work', visibilityFloor: 2, tokens: ['scene-needle', 'scene-extra'] }),
      row('search-state-life', 15, { kind: 'state', domain: 'life', visibilityFloor: 1, tokens: ['state-needle'] }),
      row('search-state-work', 800, { kind: 'state', domain: 'work', visibilityFloor: 0, tokens: ['state-needle', 'state-extra'] }),
    ] });
    const partitionHit = await vault.request('search', { tokens: ['scene-needle', 'scene-extra'], kind: 'memory',
      scene: 'life', domain: 'work', visibilityFloor: 0, now: 2000, limit: 1 });
    assert.deepEqual(partitionHit.rows.map(x => x.id), ['search-work-floor0']);
    assert.equal(partitionHit.rows[0].score, 1);
    const statePartitionHit = await vault.request('search', { tokens: ['state-needle', 'state-extra'], kind: 'state',
      scene: null, domain: 'life', visibilityFloor: 1, now: 2000, limit: 1 });
    assert.deepEqual(statePartitionHit.rows.map(x => x.id), ['search-state-life'], 'exact partition search includes state-only rows');
    await assert.rejects(vault.request('search', { tokens: ['q1'], scene: 'life', domain: null, now: 2000 }),
      error => error.code === 'invalid_request');
    await assert.rejects(vault.request('search', { tokens: ['q1'], scene: 'life', visibilityFloor: '0', now: 2000 }),
      error => error.code === 'invalid_request');

    await vault.request('write', { epoch: 0, records: [
      row('stats-work-active', 900, { kind: 'memory', domain: 'work', visibilityFloor: 0 }),
      row('stats-work-superseded', 901, { kind: 'memory', domain: 'work', visibilityFloor: 0, state: 'superseded' }),
      row('stats-work-archived', 902, { kind: 'memory', domain: 'work', visibilityFloor: 0, state: 'archived' }),
      row('stats-life-active', 903, { kind: 'memory', domain: 'life', visibilityFloor: 1 }),
      row('stats-private-work-active', 904, { kind: 'memory', domain: 'work', visibilityFloor: 2 }),
    ] });
    for (const [scene, expectedAll, expectedActive] of [
      ['work', 4, 2], ['life', 7, 5], ['private', 9, 7],
    ]) {
      const defaults = await vault.request('stats', { scene });
      const all = await vault.request('stats', { scene, state: 'all' });
      const active = await vault.request('stats', { scene, state: 'active' });
      assert.deepEqual(defaults.counts, all.counts, `${scene} default retains full internal counts`);
      assert.equal(all.counts.memory, expectedAll, `${scene} all count includes archived/superseded within visibility`);
      assert.equal(active.counts.memory, expectedActive, `${scene} active count excludes archived/superseded within visibility`);
      assert.equal(all.counts.total - active.counts.total, 2, `${scene} state filter shares the scene visibility boundary`);
    }
    await assert.rejects(vault.request('stats', { scene: 'life', state: 'superseded' }), error => error.code === 'invalid_request');
    await assert.rejects(vault.request('stats', { scene: 'life', state: null }), error => error.code === 'invalid_request');

    // Direct ID access is filtered too. Omitting scene remains the internal management path.
    assert.deepEqual((await vault.request('get', { ids: ['private', 'work'], scene: 'life' })).rows.map(x => x.id), ['work']);
    assert.equal((await vault.request('get', { ids: ['private', 'work'] })).rows.length, 2);
    for (const op of ['query', 'search', 'get']) {
      await assert.rejects(vault.request(op, op === 'query' ? { scene: 'unknown' }
        : op === 'search' ? { scene: 'unknown', tokens: ['q1'], now: 2000 }
          : { scene: 'unknown', ids: ['work'] }), error => error.code === 'invalid_request');
    }
    for (const args of [
      ['query', { scene: 123 }],
      ['search', { scene: 123, tokens: ['q1'], now: 2000 }],
      ['get', { scene: 123, ids: ['work'] }],
      ['query', { domain: null }],
      ['query', { visibilityFloor: '0' }],
      ['query', { beforeId: 'work' }],
      ['query', { afterId: 'work' }],
      ['query', { after: 1, afterId: 2 }],
      ['query', { order: 'sideways' }],
    ]) await assert.rejects(vault.request(args[0], args[1]), error => error.code === 'invalid_request');

    await assert.rejects(vault.request('write', { epoch: 0, records: [row('bad-domain', 2, { domain: 'other', visibilityFloor: 2 })] }),
      error => error.code === 'invalid_record');
    await assert.rejects(vault.request('write', { epoch: 0, records: [row('bad-floor', 2, { domain: 'private', visibilityFloor: 1 })] }),
      error => error.code === 'invalid_record');

    // A derived row cannot have a lower floor than any source, even across domain labels.
    await vault.request('write', { epoch: 0, records: [row('private-source', 10, { domain: 'private', visibilityFloor: 2 })] });
    await assert.rejects(vault.request('write', { epoch: 0, records: [row('downgrade', 11, {
      kind: 'summary', domain: 'work', visibilityFloor: 0, sources: ['private-source'],
    })] }), error => error.code === 'invalid_source');
    assert.equal((await vault.request('get', { ids: ['downgrade'] })).rows.length, 0);

    // Mixed sources inherit the highest floor; a valid high-floor derivative is accepted.
    await vault.request('write', { epoch: 0, records: [row('work-source', 12, { domain: 'work', visibilityFloor: 0 })] });
    await assert.rejects(vault.request('write', { epoch: 0, records: [row('mixed-low', 13, {
      kind: 'summary', domain: 'work', visibilityFloor: 1, sources: ['work-source', 'private-source'],
    })] }), error => error.code === 'invalid_source');
    await vault.request('write', { epoch: 0, records: [row('mixed-private', 14, {
      kind: 'summary', domain: 'work', visibilityFloor: 2, sources: ['work-source', 'private-source'],
    })] });
    await vault.request('write', { epoch: 0, records: [row('work-child', 14, {
      kind: 'summary', domain: 'work', visibilityFloor: 0, sources: ['work-source'],
    })] });
    assert.equal((await vault.request('get', { ids: ['mixed-private'], scene: 'life' })).rows.length, 0);
    assert.equal((await vault.request('get', { ids: ['mixed-private'], scene: 'private' })).rows[0].visibilityFloor, 2);

    // An upsert cannot raise a source's floor while leaving a lower-floor child visible.
    await assert.rejects(vault.request('write', { epoch: 0, records: [row('work-source', 15, {
      domain: 'work', visibilityFloor: 2,
    })] }), error => error.code === 'invalid_source');
    assert.equal((await vault.request('get', { ids: ['work-source'] })).rows[0].visibilityFloor, 0);
    await vault.request('write', { epoch: 0, records: [
      row('work-source', 16, { domain: 'work', visibilityFloor: 2 }),
      row('work-child', 17, { kind: 'summary', domain: 'work', visibilityFloor: 2, sources: ['work-source'] }),
    ] });
    assert.equal((await vault.request('get', { ids: ['work-source', 'work-child'] })).rows.every(x => x.visibilityFloor === 2), true);

    // A rejected mixed batch rolls back earlier writes in the same transaction.
    await assert.rejects(vault.request('write', { epoch: 0, records: [
      row('atomic-first', 20, { domain: 'work', visibilityFloor: 0 }),
      row('atomic-second', 21, { domain: 'life', visibilityFloor: 1, sources: ['missing-source'] }),
    ] }), error => error.code === 'invalid_source');
    assert.equal((await vault.request('get', { ids: ['atomic-first'] })).rows.length, 0);

    await vault.request('write', { epoch: 0, records: [row('cycle-a', 25, { domain: 'work', visibilityFloor: 0 })] });
    await vault.request('write', { epoch: 0, records: [row('cycle-b', 26, {
      kind: 'summary', domain: 'work', visibilityFloor: 0, sources: ['cycle-a'],
    })] });
    await assert.rejects(vault.request('write', { epoch: 0, records: [row('cycle-a', 27, {
      domain: 'work', visibilityFloor: 0, sources: ['cycle-b'],
    })] }), error => error.code === 'invalid_source');
    assert.deepEqual((await vault.request('get', { ids: ['cycle-a', 'cycle-b'] })).rows.map(x => x.id).sort(), ['cycle-a', 'cycle-b']);
    // Recursive deletion follows the source graph across visibility floors.
    await vault.request('write', { epoch: 0, records: [row('delete-root', 30, { domain: 'work', visibilityFloor: 0 })] });
    await vault.request('write', { epoch: 0, records: [row('delete-child', 31, {
      kind: 'summary', domain: 'work', visibilityFloor: 1, sources: ['delete-root'],
    })] });
    await vault.request('write', { epoch: 0, records: [row('delete-grandchild', 32, {
      kind: 'memory', domain: 'life', visibilityFloor: 2, sources: ['delete-child'],
    })] });
    const removed = await vault.request('remove', { epoch: (await vault.request('stats')).epoch, id: 'delete-root' });
    assert.equal(removed.removed, 3);
    assert.equal((await vault.request('get', { ids: ['delete-root', 'delete-child', 'delete-grandchild'] })).rows.length, 0);

    const cycleRemoved = await vault.request('remove', { epoch: removed.epoch, id: 'cycle-a' });
    assert.equal(cycleRemoved.removed, 2);
  } finally {
    await vault.close();
  }
}

async function testSourceIdQueryFilter(bin, dir) {
  const vault = await makeVault(bin, path.join(dir, 'source-query.sqlite3'));
  try {
    await vault.request('write', { epoch: 0, records: [
      row('event-source', 1, { kind: 'task', domain: 'work', visibilityFloor: 0 }),
      row('empty-event-source', 2, { kind: 'task', domain: 'work', visibilityFloor: 0 }),
    ] });
    await vault.request('write', { epoch: 0, records: [
      row('receipt-work', 100, { kind: 'message', domain: 'work', visibilityFloor: 0, sources: ['event-source'], tokens: ['archive-token'] }),
      row('receipt-life', 200, { kind: 'message', domain: 'life', visibilityFloor: 1, sources: ['event-source'] }),
      row('receipt-private', 300, { kind: 'message', domain: 'private', visibilityFloor: 2, sources: ['event-source'] }),
    ] });
    const unrelated = Array.from({ length: 240 }, (_, i) => row(`unrelated-${i}`, 10_000 + i, {
      kind: 'message', domain: 'work', visibilityFloor: 0,
    }));
    for (let i = 0; i < unrelated.length; i += 120) {
      await vault.request('write', { epoch: 0, records: unrelated.slice(i, i + 120) });
    }

    const query = (scene, limit = 10) => vault.request('query', {
      scene, state: 'all', kind: 'message', sourceId: 'event-source', limit,
    });
    assert.deepEqual((await query('work')).rows.map(x => x.id), ['receipt-work']);
    assert.deepEqual((await query('life')).rows.map(x => x.id), ['receipt-life', 'receipt-work']);
    assert.deepEqual((await query('private')).rows.map(x => x.id), ['receipt-private', 'receipt-life', 'receipt-work']);
    assert.deepEqual((await query('work', 1)).rows.map(x => x.id), ['receipt-work'],
      'source filtering happens in SQL before newer unrelated rows can consume LIMIT');
    assert.deepEqual((await vault.request('query', { scene: 'private', state: 'all', kind: 'message', sourceId: 'empty-event-source' })).rows, []);
    assert.deepEqual((await vault.request('query', { scene: null, state: 'all', kind: 'message', sourceId: 'valid-but-missing-source' })).rows, []);
    assert.equal((await vault.request('stats')).counts.message, 243, 'unrelated records remain queryable through ordinary criteria');
    assert.deepEqual((await vault.request('search', { tokens: ['archive-token'], kind: 'message', scene: 'work', now: 2000 })).rows.map(x => x.id), ['receipt-work']);

    // Dream archives remain in the source graph, but active recall/search omits them.
    await vault.request('write', { epoch: 0, records: [row('receipt-work', 100, {
      kind: 'message', domain: 'work', visibilityFloor: 0, sources: ['event-source'], tokens: ['archive-token'], state: 'archived',
    })] });
    assert.deepEqual((await vault.request('query', { scene: 'work', kind: 'message', sourceId: 'event-source' })).rows, []);
    assert.deepEqual((await vault.request('search', { tokens: ['archive-token'], kind: 'message', scene: 'work', now: 2000 })).rows, []);
    assert.deepEqual((await vault.request('query', { scene: 'work', state: 'all', kind: 'message', sourceId: 'event-source' })).rows.map(x => [x.id, x.state]), [['receipt-work', 'archived']]);
    const removed = await vault.request('remove', { epoch: 0, id: 'event-source' });
    assert.equal(removed.removed, 4, 'source deletion cascades through archived and active descendants');
    assert.deepEqual((await vault.request('query', { scene: null, state: 'all', kind: 'message', sourceId: 'event-source' })).rows, []);

    const invalidSourceIDs = ['', ' ', 'x'.repeat(257), 'bad' + String.fromCharCode(0) + 'id',
      'bad' + String.fromCharCode(10) + 'id', null, 123];
    for (const sourceId of invalidSourceIDs) {
      await assert.rejects(vault.request('query', { sourceId }), error => error.code === 'invalid_request');
    }
  } finally {
    await vault.close();
  }
}

async function testIngestionSequence(bin, dir) {
  const vault = await makeVault(bin, path.join(dir, 'ingestion.sqlite3'));
  try {
    await vault.request('write', { epoch: 0, records: [
      row('zulu-id', 100, { domain: 'work', visibilityFloor: 0, tokens: ['seq-token'] }),
      row('middle-id', 100, { domain: 'work', visibilityFloor: 0, tokens: ['seq-token'] }),
    ] });
    const initial = await vault.request('query', { scene: 'work', domain: 'work', visibilityFloor: 0,
      state: 'all', sort: 'ingestion', order: 'asc' });
    assert.deepEqual(initial.rows.map(x => x.id), ['zulu-id', 'middle-id']);
    assert.deepEqual(initial.rows.map(x => x.ingestionSeq), [1, 2]);

    // Once a worker commits seq=2, same-ms lower UUIDs remain visible after its watermark.
    await vault.request('write', { epoch: 0, records: [
      row('000-smaller-than-cursor', 100, { domain: 'work', visibilityFloor: 0, tokens: ['seq-token'] }),
      row('clock-went-backward', 50, { domain: 'work', visibilityFloor: 0, tokens: ['seq-token'] }),
    ] });
    const afterWatermark = await vault.request('query', { scene: 'work', domain: 'work', visibilityFloor: 0,
      state: 'all', sort: 'ingestion', afterSeq: initial.rows[1].ingestionSeq, order: 'asc' });
    assert.deepEqual(afterWatermark.rows.map(x => x.id), ['000-smaller-than-cursor', 'clock-went-backward']);
    assert.deepEqual(afterWatermark.rows.map(x => x.ingestionSeq), [3, 4]);
    assert.equal((await vault.request('get', { ids: ['clock-went-backward'] })).rows[0].ingestionSeq, 4);
    const searched = await vault.request('search', { tokens: ['seq-token'], scene: 'work', now: 1000 });
    assert.equal(searched.rows.find(x => x.id === 'clock-went-backward').ingestionSeq, 4);

    // Upserts preserve immutable sequence even when timestamps are changed.
    await vault.request('write', { epoch: 0, records: [row('zulu-id', 1, {
      domain: 'work', visibilityFloor: 0, tokens: ['seq-token'], body: 'cipher:updated',
    })] });
    assert.equal((await vault.request('get', { ids: ['zulu-id'] })).rows[0].ingestionSeq, 1);

    // A failed transaction rolls back the sequence allocator as well as rows.
    await assert.rejects(vault.request('write', { epoch: 0, records: [
      row('rolled-back-row', 3, { domain: 'work', visibilityFloor: 0 }),
      row('rolled-back-invalid', 4, { domain: 'private', visibilityFloor: 1 }),
    ] }), error => error.code === 'invalid_record');
    assert.equal((await vault.request('get', { ids: ['rolled-back-row'] })).rows.length, 0);

    // Deleting the highest sequence does not reuse it.
    const removed = await vault.request('remove', { epoch: 0, id: 'clock-went-backward' });
    assert.equal(removed.removed, 1);
    await vault.request('write', { epoch: removed.epoch, records: [row('after-delete', 0, { domain: 'work', visibilityFloor: 0 })] });
    assert.equal((await vault.request('get', { ids: ['after-delete'] })).rows[0].ingestionSeq, 5);

    const ascending = await vault.request('query', { scene: 'work', domain: 'work', visibilityFloor: 0,
      state: 'all', sort: 'ingestion', afterSeq: 2, order: 'asc', limit: 1 });
    assert.equal(ascending.rows[0].id, '000-smaller-than-cursor');
    const descending = await vault.request('query', { scene: 'work', domain: 'work', visibilityFloor: 0,
      state: 'all', sort: 'ingestion', beforeSeq: 5, order: 'desc', limit: 1 });
    assert.equal(descending.rows[0].id, '000-smaller-than-cursor');
    await assert.rejects(vault.request('query', { sort: 'ingestion', after: 1 }), error => error.code === 'invalid_request');
    await assert.rejects(vault.request('query', { afterSeq: 1 }), error => error.code === 'invalid_request');
  } finally {
    await vault.close();
  }
}

async function testRestoreSequenceProtocol(bin, dir) {
  const vault = await makeVault(bin, path.join(dir, 'restore-sequences.sqlite3'));
  try {
    await assert.rejects(vault.request('write', { epoch: 0, records: [row('spoof-sequence', 1, { ingestionSeq: 9 })] }),
      error => error.code === 'invalid_record');
    await assert.rejects(vault.request('write', { epoch: 0, restoreSequence: true, records: [row('spoof-restore', 1, { ingestionSeq: 9 })] }),
      error => error.code === 'invalid_request');
    assert.equal((await vault.request('begin_restore')).restoring, true);
    await assert.rejects(vault.request('write', { epoch: 0, records: [row('normal-during-restore', 1)] }),
      error => error.code === 'invalid_request');

    await vault.request('write', { epoch: 0, restoreSequence: true, records: [
      row('restore-parent', 50, { ingestionSeq: 10, domain: 'work', visibilityFloor: 0 }),
    ] });
    await vault.request('write', { epoch: 0, restoreSequence: true, records: [
      row('restore-child', 5, { ingestionSeq: 5, kind: 'summary', domain: 'work', visibilityFloor: 0, sources: ['restore-parent'] }),
    ] });
    await vault.request('write', { epoch: 0, restoreSequence: true, records: [
      row('restore-archive', 6, { ingestionSeq: 6, kind: 'memory', domain: 'work', visibilityFloor: 0,
        state: 'archived', tokens: ['archived-token'], sources: ['restore-parent'] }),
    ] });
    assert.deepEqual((await vault.request('query', { state: 'all', scene: 'work', sort: 'ingestion', order: 'asc' })).rows
      .map(r => [r.id, r.ingestionSeq]), [['restore-child', 5], ['restore-archive', 6], ['restore-parent', 10]]);
    assert.deepEqual((await vault.request('query', { scene: 'work', kind: 'memory', sourceId: 'restore-parent' })).rows, []);
    assert.deepEqual((await vault.request('query', { scene: 'work', state: 'all', kind: 'memory', sourceId: 'restore-parent' })).rows
      .map(r => [r.id, r.state]), [['restore-archive', 'archived']]);
    assert.deepEqual((await vault.request('search', { tokens: ['archived-token'], scene: 'work', now: 1000 })).rows, []);

    await assert.rejects(vault.request('write', { epoch: 0, restoreSequence: true, records: [
      row('duplicate-a', 60, { ingestionSeq: 20 }), row('duplicate-b', 61, { ingestionSeq: 20 }),
    ] }), error => error.code === 'invalid_record');
    await assert.rejects(vault.request('write', { epoch: 0, restoreSequence: true, records: [
      row('same-restore-id', 60, { ingestionSeq: 20 }), row('same-restore-id', 61, { ingestionSeq: 21 }),
    ] }), error => error.code === 'invalid_record');
    for (const [id, seq] of [['zero-seq', 0], ['bool-seq', true], ['float-seq', 1.25], ['unsafe-seq', Number.MAX_SAFE_INTEGER + 1]]) {
      await assert.rejects(vault.request('write', { epoch: 0, restoreSequence: true, records: [row(id, 62, { ingestionSeq: seq })] }),
        error => error.code === 'invalid_record');
    }
    await assert.rejects(vault.request('write', { epoch: 0, restoreSequence: true, records: [row('duplicate-global', 63, { ingestionSeq: 10 })] }),
      error => error.code === 'invalid_record');
    await assert.rejects(vault.request('write', { epoch: 0, restoreSequence: true, records: [row('restore-parent', 64, { ingestionSeq: 11, domain: 'work', visibilityFloor: 0 })] }),
      error => error.code === 'invalid_record');

    await vault.request('end_restore');
    await assert.rejects(vault.request('write', { epoch: 0, restoreSequence: true, records: [row('after-end-spoof', 65, { ingestionSeq: 30 })] }),
      error => error.code === 'invalid_request');
    await vault.request('write', { epoch: 0, records: [row('normal-after-restore', 1)] });
    assert.equal((await vault.request('get', { ids: ['normal-after-restore'] })).rows[0].ingestionSeq, 11,
      'the ordinary counter stays above all imported sequence values and timestamps do not affect it');
    const removedArchivedSource = await vault.request('remove', { epoch: 0, id: 'restore-parent' });
    assert.equal(removedArchivedSource.removed, 3, 'restore source deletion removes its active and archived derivations');
    assert.deepEqual((await vault.request('query', { scene: null, state: 'all', sourceId: 'restore-parent' })).rows, []);

    // Clear cancels restore state but does not reset the monotonic allocator.
    await vault.request('clear');
    await vault.request('begin_restore');
    await vault.request('clear');
    const afterClear = await vault.request('stats');
    await assert.rejects(vault.request('write', { epoch: afterClear.epoch, restoreSequence: true, records: [row('cleared-mode', 1, { ingestionSeq: 50 })] }),
      error => error.code === 'invalid_request');
    await vault.request('write', { epoch: afterClear.epoch, records: [row('counter-after-clear', 0)] });
    assert.equal((await vault.request('get', { ids: ['counter-after-clear'] })).rows[0].ingestionSeq, 12);
  } finally {
    await vault.close();
  }

  const nonempty = await makeVault(bin, path.join(dir, 'restore-nonempty.sqlite3'));
  try {
    await nonempty.request('write', { epoch: 0, records: [row('existing-record', 1)] });
    await assert.rejects(nonempty.request('begin_restore'), error => error.code === 'restore_requires_empty_database');
    assert.equal((await nonempty.request('get', { ids: ['existing-record'] })).rows.length, 1);
  } finally { await nonempty.close(); }
}

async function testLegacyMigration(bin, dir) {
  const file = path.join(dir, 'legacy-v1.sqlite3');
  const script = String.raw`
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("""
PRAGMA foreign_keys=ON;
CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL, ts INTEGER NOT NULL, updatedAt INTEGER NOT NULL, state TEXT NOT NULL, expiresAt INTEGER, body TEXT NOT NULL);
CREATE TABLE tokens(recordId TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, token TEXT NOT NULL, PRIMARY KEY(recordId,token));
CREATE TABLE links(sourceId TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, derivedId TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE, PRIMARY KEY(sourceId,derivedId), CHECK(sourceId<>derivedId));
CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO meta(key,value) VALUES('epoch',0);
CREATE INDEX records_kind_state_ts_id_idx ON records(kind,state,ts DESC,id DESC);
CREATE INDEX tokens_token_idx ON tokens(token);
INSERT INTO records VALUES('legacy-root','message',100,100,'active',NULL,'legacy-cipher-root');
INSERT INTO records VALUES('legacy-derived','summary',101,101,'active',NULL,'legacy-cipher-derived');
INSERT INTO tokens VALUES('legacy-root','old-token');
INSERT INTO tokens VALUES('legacy-derived','old-token');
INSERT INTO links VALUES('legacy-root','legacy-derived');
PRAGMA user_version=1;
""")
db.commit(); db.close()
`;
  execFileSync('python3', ['-c', script, file], { stdio: 'ignore' });
  fs.chmodSync(file, 0o600);
  const vault = await makeVault(bin, file);
  try {
    const rows = await vault.request('query', { state: 'all', scene: 'private' });
    assert.deepEqual(rows.rows.map(x => [x.id, x.domain, x.visibilityFloor]), [
      ['legacy-derived', 'private', 2], ['legacy-root', 'private', 2],
    ]);
    assert.deepEqual(rows.rows.map(x => [x.id, x.ingestionSeq]), [['legacy-derived', 2], ['legacy-root', 1]]);
    assert.equal((await vault.request('query', { state: 'all', scene: 'life' })).rows.length, 0);
    assert.equal((await vault.request('query', { state: 'all', scene: 'work' })).rows.length, 0);
    assert.equal((await vault.request('search', { tokens: ['old-token'], scene: 'life', now: 1000 })).rows.length, 0);
    assert.equal((await vault.request('search', { tokens: ['old-token'], scene: 'private', now: 1000 })).rows.length, 2);
    await assert.rejects(vault.request('write', { epoch: 0, records: [row('legacy-downgrade', 102, {
      kind: 'summary', domain: 'work', visibilityFloor: 0, sources: ['legacy-root'],
    })] }), error => error.code === 'invalid_source');
    const removed = await vault.request('remove', { epoch: 0, id: 'legacy-root' });
    assert.equal(removed.removed, 2);
  } finally {
    await vault.close();
  }
  const version = execFileSync('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("PRAGMA user_version").fetchone()[0])', file], { encoding: 'utf8' }).trim();
  assert.equal(version, '3');
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const suppliedBin = process.env.WORKBUNNY_VAULT_TEST_BINARY;
  if (!suppliedBin) execFileSync(path.join(__dirname, '../tools/build-vault.sh'), { cwd: root, stdio: 'inherit' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-vault-scenes-'));
  try {
    const bin = suppliedBin ? path.resolve(suppliedBin) : path.join(root, 'bin', 'vault');
    if (!fs.existsSync(bin) || !fs.statSync(bin).isFile()) throw new Error('test vault binary is missing');
    await testMatrix(bin, temp);
    await testSourceIdQueryFilter(bin, temp);
    await testIngestionSequence(bin, temp);
    await testRestoreSequenceProtocol(bin, temp);
    await testLegacyMigration(bin, temp);
    console.log('Vault scene isolation checks passed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
