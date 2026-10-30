'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { openKey } = require('../src/main/vault-key-broker');

const base = { execPath: '/Applications/workbunny.app/Contents/MacOS/workbunny', appPath: '/Applications/workbunny.app/Contents/Resources/app', dir: '/tmp/workbunny-test/vault', timeoutMs: 500 };
const secretMarker = 'SENSITIVE_DO_NOT_LEAK_8a1f';

function childProcessStub(onStart = () => {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
  child.kill = signal => { child.kills.push(signal); setImmediate(() => child.emit('close', null, signal)); return true; };
  setImmediate(() => onStart(child));
  return child;
}
function expectNoSecret(promise) {
  return assert.rejects(promise, error => {
    assert.equal(error.message.includes(secretMarker), false);
    assert.equal(error.message.includes('base64'), false);
    return true;
  });
}

async function main() {
  const expected = Buffer.alloc(32, 0x5a);
  let argsSeen, optionsSeen;
  const key = await openKey({ ...base, spawn: (exe, args, options) => {
    argsSeen = [exe, args]; optionsSeen = options;
    return childProcessStub(child => {
      child.stderr.write(`ignored child diagnostics ${secretMarker}`);
      child.stdout.write(JSON.stringify({ ok: true, key: expected.toString('base64') }) + '\n');
      setImmediate(() => child.emit('close', 0, null));
    });
  } });
  assert.deepEqual(key, expected);
  assert.deepEqual(argsSeen, [base.execPath, [base.appPath, '--workbunny-vault-key', base.dir]]);
  assert.deepEqual(optionsSeen.stdio, ['ignore', 'pipe', 'pipe']);
  key.fill(0);

  await assert.rejects(openKey({ ...base, dir: '/tmp/../etc', spawn: () => { throw new Error('must not spawn'); } }), /本机记忆钥匙辅助进程失败/);
  await assert.rejects(openKey({ ...base, dir: '/tmp/not-vault', spawn: () => { throw new Error('must not spawn'); } }), /本机记忆钥匙辅助进程失败/);

  let timeoutChild;
  await expectNoSecret(openKey({ ...base, timeoutMs: 20, spawn: () => { timeoutChild = childProcessStub(); return timeoutChild; } }));
  assert.deepEqual(timeoutChild.kills, ['SIGKILL']);

  await expectNoSecret(openKey({ ...base, spawn: () => childProcessStub(child => {
    child.stdout.write(JSON.stringify({ ok: true, key: Buffer.alloc(31).toString('base64') }) + '\n');
    setImmediate(() => child.emit('close', 0, null));
  }) }));

  await expectNoSecret(openKey({ ...base, spawn: () => childProcessStub(child => {
    child.stderr.end(secretMarker);
    setImmediate(() => child.emit('close', 1, null));
  }) }));

  const controller = new AbortController();
  let abortChild;
  const abortResult = openKey({ ...base, signal: controller.signal, spawn: () => {
    abortChild = childProcessStub(child => child.stderr.write(secretMarker));
    return abortChild;
  } });
  controller.abort();
  await expectNoSecret(abortResult);
  assert.deepEqual(abortChild.kills, ['SIGKILL']);

  await expectNoSecret(openKey({ ...base, spawn: () => childProcessStub(child => {
    child.stdout.write(JSON.stringify({ ok: false, error: secretMarker }) + '\n');
    setImmediate(() => child.emit('close', 1, null));
  }) }));

  console.log('Vault key broker checks passed');
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
