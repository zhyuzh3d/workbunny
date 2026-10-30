'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const { fingerprint, snapshotsOf, readRecords, verifySnapshots, evidenceFor } = require('../src/main/memory-evidence');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-memory-evidence-'));
const services = new Set();

async function createMemory(name, scene = 'private') {
  const key = crypto.randomBytes(32);
  const service = new MemoryService({ dir: path.join(temp, name), bin,
    getSettings: () => ({ enabled: true, extract: false, scene }),
    openKey: async () => Buffer.from(key), clock: () => 1_800_000_000_000, random: () => 0 });
  services.add(service);
  await service.init();
  assert.equal(service.ready, true, `isolated vault should open: ${service.error}`);
  return service;
}

function message(id, role, content, ts, { domain = 'life', visibilityFloor = 1, sources = [] } = {}) {
  return { id, kind: 'message', ts, updatedAt: ts, domain, visibilityFloor,
    value: { role, content, sources } };
}

function memory(id, content, source, quote, ts, extras = {}) {
  return { id, kind: 'memory', ts, updatedAt: ts, domain: 'life', visibilityFloor: 1,
    value: { content, memoryKind: 'candidate', status: 'pending', origin: 'model-candidate',
      evidence: quote, evidenceSourceId: source, sources: [source], ...extras } };
}

async function put(service, records) {
  for (let i = 0; i < records.length; i += 200) await service.write(records.slice(i, i + 200), service.epoch, { notify: false });
}

async function testFingerprintAndEvidence() {
  const service = await createMemory('evidence-primary');
  try {
    const source = message('ev-user', 'user', '我习惯在周五下班后整理项目清单。', 100);
    const derived = memory('ev-memory', '用户会在周五整理项目清单。', source.id, '周五下班后整理项目清单', 101);
    const assistant = message('ev-assistant', 'assistant', '我记得你周五会整理清单。', 102,
      { sources: [source.id] });
    const assistantDerived = memory('ev-from-assistant', '助手刚才提到的周五清单。', assistant.id,
      '周五会整理清单', 103);
    await put(service, [source]);
    await put(service, [assistant]);
    await put(service, [derived, assistantDerived]);

    const evidence = await evidenceFor(service, derived, { scene: 'life' });
    assert.deepEqual({ recordId: evidence?.recordId, sourceId: evidence?.sourceId, quote: evidence?.quote },
      { recordId: derived.id, sourceId: source.id, quote: derived.value.evidence });
    assert.equal(evidence.source.value.role, 'user');
    assert.equal((await evidenceFor(service, assistantDerived, { scene: 'life' })), null,
      'evidence must be a direct user message, never recursively derived from assistant text');
    assert.equal(await evidenceFor(service, { ...derived, value: { ...derived.value, evidenceSourceId: 'absent' } }), null);
    assert.equal(await evidenceFor(service, { ...derived, value: { ...derived.value, evidence: 'x' } }), null);
    assert.equal(await evidenceFor(service, { ...derived, value: { ...derived.value, evidence: 'x'.repeat(2001) } }), null);

    const decoded = await readRecords(service, [source.id, derived.id, 'missing'], { scene: 'life' });
    assert.deepEqual(decoded.map(row => row.id), [source.id, derived.id], 'missing IDs return fewer decoded rows');
    assert.equal((await readRecords(service, [source.id], { scene: 'work' })).length, 0,
      'scope-filtered get does not reveal a life-only message in work');

    const baseline = snapshotsOf(await readRecords(service, [source.id, derived.id], { scene: 'life' }));
    assert.deepEqual(baseline.map(item => item.id), [derived.id, source.id].sort());
    assert.equal((await verifySnapshots(service, baseline, { scene: 'life' })).ok, true);
    assert.equal(fingerprint({ ...source, body: 'changed-ciphertext', tokens: ['different'], score: 99 }), fingerprint(source),
      'ciphertext, index tokens, and ranking score are excluded from fingerprint');
    assert.equal(snapshotsOf([source, source]).length, 1, 'identical duplicate rows yield one sorted snapshot');
    assert.notEqual(fingerprint({ ...source, state: 'superseded' }), fingerprint(source), 'state changes affect fingerprint');
    assert.notEqual(fingerprint({ ...source, visibilityFloor: 2 }), fingerprint(source), 'scope changes affect fingerprint');
    const reordered = { ...source, value: { sources: [], content: source.value.content, role: 'user' } };
    assert.equal(fingerprint(reordered), fingerprint(source), 'value key insertion order does not affect hash');

    // A same-ID source rewrite changes its snapshot and invalidates the literal evidence match.
    const revisedSource = { ...source, updatedAt: 200,
      value: { ...source.value, content: '现在改为周四下班后整理项目清单。' } };
    await put(service, [revisedSource]);
    assert.equal((await verifySnapshots(service, baseline, { scene: 'life' })).ok, false);
    const revisedChild = (await readRecords(service, [derived.id], { scene: 'life' }))[0];
    assert.equal(await evidenceFor(service, revisedChild, { scene: 'life' }), null,
      'stale quote does not survive a same-ID source rewrite');

    // A state-only retirement is part of the fingerprint; subsequent source deletion cascades descendants.
    const currentChild = { ...revisedChild, state: 'superseded', updatedAt: 201,
      value: { ...revisedChild.value, status: 'superseded' } };
    await put(service, [currentChild]);
    assert.equal((await verifySnapshots(service, baseline, { scene: 'life' })).ok, false);
    await service.remove(source.id);
    assert.equal((await readRecords(service, [source.id, derived.id, assistant.id, assistantDerived.id], { scene: null })).length, 0,
      'deleting the source cascades its direct and indirect derived records');
    assert.equal((await verifySnapshots(service, baseline, { scene: null })).ok, false);
  } finally { await service.close(); }
}

async function testScopeAndSecretGuards() {
  const service = await createMemory('evidence-scope');
  try {
    const privateSource = message('ev-private-source', 'user', '我的私聊安排是周日下午休息。', 300,
      { domain: 'private', visibilityFloor: 2 });
    await put(service, [privateSource]);
    const crossDomainMemory = { ...memory('ev-cross-domain', '工作记录保留了一个高范围来源。', privateSource.id,
      '周日下午休息', 301), domain: 'work', visibilityFloor: 2 };
    await put(service, [crossDomainMemory]);
    const privateRow = (await readRecords(service, [crossDomainMemory.id], { scene: null }))[0];
    assert.equal((await evidenceFor(service, privateRow, { scene: 'life' })), null,
      'scene filtering blocks a high-floor source');
    const crossEvidence = await evidenceFor(service, privateRow, { scene: 'private' });
    assert.equal(crossEvidence.sourceId, privateSource.id, 'domain labels may differ when visibility floor is preserved');

    const secretText = '密码是fixture-secret-evidence-8273';
    const secretSource = message('ev-secret-source', 'user', `旧导入记录：${secretText}`, 400);
    await put(service, [secretSource]);
    const secretMemory = memory('ev-secret-memory', 'secret phrase remembered', secretSource.id, secretText, 401);
    await put(service, [secretMemory]);
    assert.equal(await evidenceFor(service, secretMemory, { scene: 'private' }), null,
      'a secret anywhere in the source or evidence is not surfaced');
    assert.equal(await evidenceFor(service, { ...privateRow, value: { ...privateRow.value,
      content: `密码是fixture-memory-secret-8274` } }, { scene: 'private' }), null,
    'a secret in the derived record is not returned as evidence');
    assert.equal(await evidenceFor(service, { ...privateRow,
      value: { ...privateRow.value, sources: Array(201).fill(privateSource.id) } }, { scene: 'private' }), null,
    'direct evidence expansion is bounded to 200 source IDs');
  } finally { await service.close(); }
}

async function testReadBatchesAndRestore() {
  const service = await createMemory('evidence-export');
  let target;
  try {
    const source = message('restore-evidence-source', 'user', 'I prefer a quiet review before Friday.', 500);
    const derived = memory('restore-evidence-memory', 'Prefers a quiet review before Friday.', source.id,
      'quiet review before Friday', 501);
    await put(service, [source]);
    await put(service, [derived]);
    const bulk = Array.from({ length: 205 }, (_, index) => ({ id: `ev-bulk-${String(index).padStart(3, '0')}`,
      kind: 'state', ts: 600 + index, updatedAt: 600 + index, domain: 'private', visibilityFloor: 2,
      value: { marker: index, sources: [] } }));
    await put(service, bulk);

    let getCalls = 0;
    const request = service.db.request.bind(service.db);
    service.db.request = (op, payload) => {
      if (op === 'get') { getCalls++; assert(payload.ids.length <= 200); }
      return request(op, payload);
    };
    const read = await readRecords(service, bulk.map(row => row.id), { scene: 'private' });
    assert.equal(read.length, bulk.length);
    assert.equal(getCalls, 2, '205 IDs are fetched in bounded batches of at most 200');
    service.db.request = request;

    const snapshots = snapshotsOf(await readRecords(service, [source.id, derived.id], { scene: 'private' }));
    const passphrase = 'isolated evidence backup passphrase';
    const backup = await service.export(passphrase);
    assert(!backup.includes(source.value.content) && !backup.includes(derived.value.content));

    target = await createMemory('evidence-restore-target');
    const restored = await target.restore(backup, passphrase);
    assert.equal(restored.ok, true);
    const check = await verifySnapshots(target, snapshots, { scene: 'private' });
    assert.equal(check.ok, true, 'reencryption under a new database key preserves evidence fingerprints');
    const evidence = await evidenceFor(target, check.rows.find(row => row.id === derived.id), { scene: 'private' });
    assert.equal(evidence.sourceId, source.id);
  } finally {
    if (target) await target.close();
    await service.close();
  }
}

async function main() {
  try {
    await testFingerprintAndEvidence();
    await testScopeAndSecretGuards();
    await testReadBatchesAndRestore();
    console.log('Memory evidence validation checks passed');
  } finally {
    for (const service of services) await service.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
