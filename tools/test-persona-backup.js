'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryService } = require('../src/main/memory-service');
const vaultCrypto = require('../src/main/vault-crypto');
const config = require('../src/main/config');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'vault');
const testKey = Buffer.alloc(32, 0x5a);
const passphrase = 'test-only-persona-backup-passphrase';
const services = new Set();
let tick = Date.UTC(2026, 0, 1);

function createService(dir, { persona, scene = 'life' } = {}) {
  const service = new MemoryService({
    dir,
    bin,
    openKey: async () => Buffer.from(testKey),
    getSettings: () => ({ enabled: true, extract: false, scene }),
    getPersona: () => persona,
    clock: () => tick++,
    random: () => 0,
    extract: async () => [],
  });
  services.add(service);
  return service.init();
}

async function writeScopedMessage(service, id, domain, visibilityFloor, content) {
  await service.write([{
    id, kind: 'message', ts: tick++, domain, visibilityFloor,
    value: { role: 'user', content, sources: [] },
  }]);
}

async function assertRecord(service, id, expected) {
  const rows = (await service.db.request('get', { ids: [id] })).rows;
  assert.equal(rows.length, 1, `record ${id} should remain present`);
  const decoded = service.decode(rows[0]);
  if (expected.domain) assert.equal(decoded.domain, expected.domain);
  if (expected.visibilityFloor !== undefined) assert.equal(decoded.visibilityFloor, expected.visibilityFloor);
  if (expected.content) assert.equal(decoded.value.content, expected.content);
  return decoded;
}

async function testPersonaRoundTripAndConfig(temp) {
  const privateText = 'PRIVATE_PERSONA_BACKUP_FIXTURE_ONLY_7fa1';
  const persona = {
    name: '小兔', ownerName: '主人', profile: '共用设定：温和、诚实。',
    sceneProfiles: {
      private: '私聊设定：保留亲密对话上下文。',
      life: '生活设定：协助日常安排。',
      work: '工作设定：简洁核对进度。',
    },
    apiKey: 'DO_NOT_EXPORT_EXTRA_FIELDS',
  };
  const source = await createService(path.join(temp, 'source'), { persona });
  await writeScopedMessage(source, 'persona-private-message', 'private', 2, privateText);
  await writeScopedMessage(source, 'persona-life-message', 'life', 1, 'LIFE_BACKUP_FIXTURE');
  await writeScopedMessage(source, 'persona-work-message', 'work', 0, 'WORK_BACKUP_FIXTURE');
  const backup = await source.export(passphrase);
  assert.equal(backup.includes(privateText), false, 'encrypted backup bytes must not expose private conversation content');
  assert.equal(backup.includes('DO_NOT_EXPORT_EXTRA_FIELDS'), false, 'non-whitelisted persona fields must not be exported');

  const clearEnvelope = await vaultCrypto.importEnvelope(backup, passphrase);
  assert.deepEqual(clearEnvelope.persona, {
    name: persona.name, ownerName: persona.ownerName, profile: persona.profile,
    sceneProfiles: persona.sceneProfiles,
  }, 'backup carries common profile and each scene overlay exactly');

  // Exercise the same partial deep-merge entry point used by index.js after restore.
  const configFile = path.join(temp, 'dest-config', 'config.json');
  config.setPath(configFile);
  config.save({
    memory: { scene: 'work' },
    buddy: { name: 'destination name', ownerName: 'destination owner', profile: 'destination profile', sceneProfiles: { private: 'destination private', life: 'destination life', work: 'destination work' } },
    brain: { apiKey: 'brain-CREDENTIAL-KEEP', model: 'hy3' },
    tts: { apiKey: 'tts-CREDENTIAL-KEEP', voice: 'fixture-voice' },
  });
  const before = config.load();

  const destination = await createService(path.join(temp, 'destination'));
  const restored = await destination.restore(backup, passphrase);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.persona, clearEnvelope.persona);
  config.save({ buddy: {
    name: restored.persona.name,
    ownerName: restored.persona.ownerName,
    profile: restored.persona.profile,
    ...(restored.persona.sceneProfiles ? { sceneProfiles: restored.persona.sceneProfiles } : {}),
  } });
  const after = config.load();
  assert.equal(after.memory.scene, 'work', 'restore must retain destination active scene');
  assert.equal(after.brain.apiKey, before.brain.apiKey);
  assert.equal(after.brain.model, before.brain.model);
  assert.equal(after.tts.apiKey, before.tts.apiKey);
  assert.equal(after.tts.voice, before.tts.voice);
  assert.deepEqual(after.buddy, {
    ...before.buddy,
    name: persona.name, ownerName: persona.ownerName, profile: persona.profile,
    sceneProfiles: persona.sceneProfiles,
  }, 'only the whitelisted buddy fields should be restored');
  await assertRecord(destination, 'persona-private-message', { domain: 'private', visibilityFloor: 2, content: privateText });
  await assertRecord(destination, 'persona-life-message', { domain: 'life', visibilityFloor: 1 });
  await assertRecord(destination, 'persona-work-message', { domain: 'work', visibilityFloor: 0 });
}

async function testInvalidPersonaRejectedBeforeClear(temp) {
  const source = await createService(path.join(temp, 'malformed-source'), {
    persona: { name: '小兔', ownerName: '主人', profile: '合法', sceneProfiles: { private: '', life: '', work: '' } },
  });
  await writeScopedMessage(source, 'malformed-source-message', 'life', 1, 'SOURCE_RECORD_SENTINEL');
  const normal = await source.export(passphrase);
  const parsed = await vaultCrypto.importEnvelope(normal, passphrase);

  const target = await createService(path.join(temp, 'nonempty-target'));
  await writeScopedMessage(target, 'protected-before-invalid-restore', 'work', 0, 'DO_NOT_CLEAR_ON_BAD_PERSONA');
  const invalidPersonas = [
    { ...parsed.persona, profile: { unexpected: true } },
    { ...parsed.persona, sceneProfiles: { ...parsed.persona.sceneProfiles, private: 'x'.repeat(2001) } },
    { ...parsed.persona, name: 'n'.repeat(65) },
  ];
  for (const invalidPersona of invalidPersonas) {
    const malformed = await vaultCrypto.exportEnvelope({ ...parsed, persona: invalidPersona }, passphrase);
    await assert.rejects(target.restore(malformed, passphrase), /角色设定|场景设定/);
    await assertRecord(target, 'protected-before-invalid-restore', { domain: 'work', visibilityFloor: 0, content: 'DO_NOT_CLEAR_ON_BAD_PERSONA' });
  }
}

async function testLegacyScopeAndPersonaCompatibility(temp) {
  const persona = { name: 'legacy-source', ownerName: '主人', profile: 'private-scoped legacy fixture', sceneProfiles: { private: '', life: '', work: '' } };
  const source = await createService(path.join(temp, 'legacy-source'), { persona });
  await writeScopedMessage(source, 'legacy-private-message', 'private', 2, 'OLDER_PRIVATE_SENTINEL');
  await writeScopedMessage(source, 'legacy-life-message', 'life', 1, 'OLDER_LIFE_SENTINEL');
  const modern = await vaultCrypto.importEnvelope(await source.export(passphrase), passphrase);

  // Recreate the older envelope shape: no persona, scope, or ingestion sequence;
  // old row bodies likewise predate the authenticated _scopeV1 field.
  const records = modern.records.map(record => {
    const copy = { ...record, value: { ...record.value } };
    delete copy.domain;
    delete copy.visibilityFloor;
    delete copy.ingestionSeq;
    return copy;
  });
  const oldBackup = await vaultCrypto.exportEnvelope({ format: 1, exportedAt: tick++, records }, passphrase);
  const legacyTarget = await createService(path.join(temp, 'legacy-target'));
  const result = await legacyTarget.restore(oldBackup, passphrase);
  assert.equal(result.ok, true, 'legacy backup without persona remains restorable');
  assert.equal(Object.hasOwn(result, 'persona'), false);
  assert.equal(result.legacyPrivateRecords, records.length, 'missing legacy scope is reported for every old record');
  for (const record of records) await assertRecord(legacyTarget, record.id, { domain: 'private', visibilityFloor: 2 });
}

async function main() {
  if (!fs.existsSync(bin)) throw new Error(`既有 vault 二进制不存在，未运行构建脚本：${bin}`);
  assert.equal(testKey.length, 32, 'fixture key must be exactly 32 bytes');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-persona-backup-'));
  try {
    await testPersonaRoundTripAndConfig(temp);
    await testInvalidPersonaRejectedBeforeClear(temp);
    await testLegacyScopeAndPersonaCompatibility(temp);
    console.log('persona backup integration checks passed (temporary SQLite vault; no build or app launch)');
  } finally {
    await Promise.all([...services].map(service => service.close().catch(() => {})));
    services.clear();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
