'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ContactDirectory } = require('../src/main/contact-directory');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('timed out waiting for fixture operation');
}

test('invalidate clears cached aliases; a delayed prior read cannot resurrect or delete a replacement load', async () => {
  const oldRead = deferred();
  let calls = 0;
  const directory = new ContactDirectory({ read: async () => {
    calls++;
    if (calls === 1) return oldRead.promise;
    return [{ recipient: 'Alice', aliases: ['爱丽丝'], scene: 'private', domain: 'private', visibilityFloor: 2 }];
  } });

  const staleResolve = directory.resolve('爱丽丝', { scene: 'private' });
  await until(() => calls === 1);
  directory.invalidate();
  const fresh = await directory.resolve('爱丽丝', { scene: 'private' });
  assert.equal(fresh.confirmed, true);
  assert.equal(fresh.recipient, 'Alice');

  oldRead.resolve([{ recipient: 'Old Contact', aliases: ['旧别名'], scene: 'private', domain: 'private', visibilityFloor: 2 }]);
  await assert.rejects(staleResolve, /已失效/);
  const stillFresh = await directory.resolve('爱丽丝', { scene: 'private' });
  assert.equal(stillFresh.confirmed, true, 'stale rejection does not delete the replacement cache entry');
  assert.equal((await directory.resolve('旧别名', { scene: 'private' })).confirmed, false);
});

test('invalidate during remember prevents the completed old write from repopulating RAM', async () => {
  const writing = deferred();
  let readCalls = 0;
  let writeCalled = false;
  const directory = new ContactDirectory({
    read: async () => { readCalls++; return []; },
    write: async () => { writeCalled = true; await writing.promise; },
  });
  const pending = directory.remember('Alice', ['爱丽丝'], { scene: 'private' });
  await until(() => writeCalled);
  directory.invalidate();
  writing.resolve();
  await assert.rejects(pending, /已失效/);
  assert.equal(directory.snapshot('private').length, 0, 'stale remember does not repopulate the invalidated cache');

  const resolved = await directory.resolve('爱丽丝', { scene: 'private' });
  assert.equal(resolved.confirmed, false, 'fresh reads determine whether the alias still exists');
  assert.equal(readCalls, 2);
});

test('invalidate during a delayed remember read stops it before persistence', async () => {
  const reading = deferred();
  let writes = 0;
  const directory = new ContactDirectory({
    read: async () => reading.promise,
    write: async () => { writes++; },
  });
  const pending = directory.remember('Alice', ['爱丽丝'], { scene: 'private' });
  await new Promise(resolve => setImmediate(resolve));
  directory.invalidate();
  reading.resolve([]);
  await assert.rejects(pending, /已失效/);
  assert.equal(writes, 0, 'invalidated read cannot proceed to contact persistence');
});
