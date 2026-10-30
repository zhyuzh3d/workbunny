'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openKey } = require('../src/main/keychain-key-provider');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-key-provider-'));
const binary = '/Applications/workbunny.app/Contents/Resources/bin/workbunny-keychain.app/Contents/MacOS/workbunny-keychain';
const failure = /本机记忆钥匙不可用/;
function childStub(onRequest, { keepOpen = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
  let input = '';
  child.stdin.on('data', chunk => { input += chunk.toString('utf8'); });
  child.stdin.on('finish', async () => {
    if (keepOpen) return;
    try {
      const response = await onRequest(JSON.parse(input));
      if (response?.raw !== undefined) child.stdout.write(response.raw);
      else child.stdout.write(JSON.stringify(response) + '\n');
      if (response?.stderr) child.stderr.write(response.stderr);
      child.stdin.destroy(); child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit('close', response?.code ?? 0, null));
    } catch { setImmediate(() => child.emit('close', 1, null)); }
  });
  child.kill = signal => { child.kills.push(signal); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); setImmediate(() => child.emit('close', null, signal)); return true; };
  return child;
}
function stubSpawn(onRequest, record = []) {
  return (exe, args, options) => {
    assert.equal(exe, binary); assert.deepEqual(args, []); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    return childStub(async request => { record.push(request); return onRequest(request); });
  };
}
async function rejectsGeneric(promise) {
  await assert.rejects(promise, error => { assert.match(error.message, failure); assert(!error.message.includes('SECRET')); return true; });
}

async function main() {
  const knownDir = path.join(tmp, 'existing', 'vault'); fs.mkdirSync(knownDir, { recursive: true });
  const knownKey = Buffer.alloc(32, 0x35); let legacyCalls = 0, readCalls = 0;
  const existing = await openKey({ dir: knownDir, binary, legacyOpen: async () => { legacyCalls++; throw Error('SECRET'); }, spawn: stubSpawn(req => {
    readCalls++; return { ok: true, key: knownKey.toString('base64') };
  }) });
  assert.deepEqual(existing, knownKey); assert.equal(legacyCalls, 0); assert.equal(readCalls, 1);
  const metadata = JSON.parse(fs.readFileSync(path.join(knownDir, 'key-provider.json'), 'utf8'));
  assert.equal(metadata.version, 1); assert.match(metadata.account, /^vault-[0-9a-f-]{36}$/i);
  assert.equal((fs.statSync(path.join(knownDir, 'key-provider.json')).mode & 0o777), 0o600);
  existing.fill(0);

  const migrationDir = path.join(tmp, 'migration', 'vault'); fs.mkdirSync(migrationDir, { recursive: true });
  const envelope = Buffer.from('legacy-envelope-bytes'); fs.writeFileSync(path.join(migrationDir, 'key-envelope'), envelope, { mode: 0o600 });
  const master = Buffer.alloc(32, 0x7b), store = new Map(), migrationRequests = [];
  const migration = await openKey({ dir: migrationDir, binary, legacyOpen: async () => Buffer.from(master), spawn: stubSpawn(req => {
    migrationRequests.push(req);
    if (req.op === 'read') return store.has(req.account) ? { ok: true, key: store.get(req.account).toString('base64') } : { ok: false, error: 'not_found' };
    store.set(req.account, Buffer.from(req.key, 'base64')); return { ok: true, imported: true };
  }) });
  assert(cryptoEqual(migration, master)); assert.deepEqual(fs.readFileSync(path.join(migrationDir, 'key-envelope')), envelope);
  assert.deepEqual(migrationRequests.map(r => r.op), ['read', 'import', 'read']);
  assert(migrationRequests.every(r => r.account === metadataFor(migrationDir).account));
  migration.fill(0); master.fill(0);

  const retryDir = path.join(tmp, 'retry', 'vault'); fs.mkdirSync(retryDir, { recursive: true });
  const retryRequests = [], retryStore = new Map(); let failImportOnce = true;
  const retrySpawn = stubSpawn(req => {
    retryRequests.push(req);
    if (req.op === 'read') return retryStore.has(req.account) ? { ok: true, key: retryStore.get(req.account).toString('base64') } : { ok: false, error: 'not_found' };
    if (failImportOnce) { failImportOnce = false; return { ok: false, error: 'SECRET native failure' }; }
    retryStore.set(req.account, Buffer.from(req.key, 'base64'));
    return { ok: true, imported: true };
  });
  await rejectsGeneric(openKey({ dir: retryDir, binary, legacyOpen: async () => Buffer.alloc(32, 1), spawn: retrySpawn }));
  const stableAccount = metadataFor(retryDir).account;
  assert(await openKey({ dir: retryDir, binary, legacyOpen: async () => Buffer.alloc(32, 2), spawn: retrySpawn }).then(key => { key.fill(0); return true; }));
  assert(retryRequests.every(req => req.account === stableAccount), 'retry must reuse persisted account');
  assert.deepEqual(retryRequests.map(req => req.op), ['read', 'import', 'read', 'import', 'read']);

  const mismatchDir = path.join(tmp, 'mismatch', 'vault'); fs.mkdirSync(mismatchDir, { recursive: true });
  let mismatchRead = 0;
  await rejectsGeneric(openKey({ dir: mismatchDir, binary, legacyOpen: async () => Buffer.alloc(32, 3), spawn: stubSpawn(req => {
    if (req.op === 'read') return ++mismatchRead === 1 ? { ok: false, error: 'not_found' } : { ok: true, key: Buffer.alloc(32, 4).toString('base64') };
    return { ok: true, imported: true };
  }) }));

  const linkDir = path.join(tmp, 'symlink', 'vault'); fs.mkdirSync(linkDir, { recursive: true });
  const outside = path.join(tmp, 'metadata-outside.json'); fs.writeFileSync(outside, JSON.stringify({ version: 1, account: metadataFor(knownDir).account }));
  fs.symlinkSync(outside, path.join(linkDir, 'key-provider.json'));
  await rejectsGeneric(openKey({ dir: linkDir, binary, spawn: () => { throw Error('must not spawn'); } }));

  const badKeyDir = path.join(tmp, 'bad-key', 'vault'); fs.mkdirSync(badKeyDir, { recursive: true });
  await rejectsGeneric(openKey({ dir: badKeyDir, binary, spawn: stubSpawn(() => ({ ok: true, key: '!!!!' })) }));

  const oversizedDir = path.join(tmp, 'oversized', 'vault'); fs.mkdirSync(oversizedDir, { recursive: true });
  let oversizedChild;
  await rejectsGeneric(openKey({ dir: oversizedDir, binary, spawn: (exe, args, options) => {
    oversizedChild = childStub(async () => ({ raw: 'x'.repeat(8193) })); return oversizedChild;
  } }));
  assert.deepEqual(oversizedChild.kills, ['SIGKILL']);

  const timeoutDir = path.join(tmp, 'timeout', 'vault'); fs.mkdirSync(timeoutDir, { recursive: true });
  let timeoutChild;
  await rejectsGeneric(openKey({ dir: timeoutDir, binary, timeoutMs: 20, spawn: (exe, args, options) => {
    timeoutChild = childStub(async () => ({}), { keepOpen: true }); return timeoutChild;
  } }));
  assert.deepEqual(timeoutChild.kills, ['SIGKILL']);

  const abortDir = path.join(tmp, 'abort', 'vault'); fs.mkdirSync(abortDir, { recursive: true });
  const controller = new AbortController(); let abortChild;
  const aborted = openKey({ dir: abortDir, binary, signal: controller.signal, spawn: (exe, args, options) => {
    abortChild = childStub(async () => ({}), { keepOpen: true }); return abortChild;
  } });
  setTimeout(() => controller.abort(), 20);
  await rejectsGeneric(aborted); assert.deepEqual(abortChild.kills, ['SIGKILL']);

  await rejectsGeneric(openKey({ dir: path.join(tmp, 'not-vault'), binary, spawn: () => { throw Error('must not spawn'); } }));
  for (const key of retryStore.values()) key.fill(0);
  for (const key of store.values()) key.fill(0);
  knownKey.fill(0);
  console.log('Keychain key provider checks passed');
}
function metadataFor(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'key-provider.json'), 'utf8')); }
function cryptoEqual(a, b) { return require('node:crypto').timingSafeEqual(a, b); }

main().then(() => fs.rmSync(tmp, { recursive: true, force: true }), error => { fs.rmSync(tmp, { recursive: true, force: true }); console.error(error.stack || error); process.exitCode = 1; });
