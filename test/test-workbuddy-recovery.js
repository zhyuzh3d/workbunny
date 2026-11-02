'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkBuddyConnection } = require('../src/main/workbuddy-connection');
const { Secretary } = require('../src/main/secretary');
const fs = require('node:fs'), vm = require('node:vm');
const { isTransientConnectionError } = require('../src/main/workbuddy');

test('connection probe times out, backs off and preserves identity across transient failures', async t => {
  let identity = 'one', outcome = 'hang', now = 100000;
  const connection = new WorkBuddyConnection({ identity: () => identity, clock: () => now, timeoutMs: 20,
    catalog: () => outcome === 'hang' ? new Promise(() => {}) : outcome === 'fail' ? Promise.reject(new Error('连接不到')) : Promise.resolve({ models: [{ id: 'hy3' }] }),
    getModel: () => 'hy3', tasks: () => ({ status: 'ready', note: 'ready' }) });
  t.after(() => connection.close());
  connection.started = true;
  await connection.connect(); assert.equal(connection.status().ready, false); assert.equal(connection.status().nextRetryAt, now + 2000);
  outcome = 'fail'; await connection.connect(); assert.equal(connection.status().nextRetryAt, now + 5000);
  outcome = 'ok'; await connection.connect(); assert.equal(connection.status().ready, true); assert.equal(connection.status().generation, 0);
  connection.invalidate(); assert.equal(connection.status().generation, 0);
  await connection.connect(); assert.equal(connection.status().generation, 0);
  identity = 'two'; await connection.connect(); assert.equal(connection.status().generation, 1);
});

test('connection recovery resumes the same saved task at most once concurrently', async () => {
  const task = { id: 'task-one', target: 'workbuddy', origin: 'dialogue', status: 'paused', pauseCause: 'connection',
    privacyEpoch: 4, scene: 'life', domain: 'life', visibilityFloor: 1, sources: ['source-one'], submitAttemptedAt: 123 };
  let resumeCalls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const desktop = { task, running: false, journal: async () => {}, publicStatus: () => ({ task }),
    resume: async args => { resumeCalls++; assert.equal(desktop.task.id, 'task-one'); assert.equal(desktop.task.submitAttemptedAt, 123);
      assert.deepEqual(args.sources, ['source-one']); await gate; task.status = 'starting'; return { ok: true }; } };
  const secretary = new Secretary({ desktop, ready: () => true, epoch: () => 4, getScene: () => 'life', clock: () => 100000 });
  const first = secretary.recoverConnection(); const second = secretary.recoverConnection();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resumeCalls, 1); release(); await Promise.all([first, second]);
  await secretary.recoverConnection(); assert.equal(resumeCalls, 1); secretary.close();
});

test('user stop while recovery journals cannot resume the paused task', async () => {
  const task = { id: 'task-stop', target: 'workbuddy', origin: 'dialogue', status: 'paused', pauseCause: 'connection',
    privacyEpoch: 4, scene: 'life', domain: 'life', visibilityFloor: 1, sources: [] };
  let enter, release, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const desktop = { task, running: false, generation: 1,
    journal: async () => { enter(); await gate; },
    stop: async () => { desktop.generation++; },
    resume: async () => { calls++; return { ok: false }; } };
  const secretary = new Secretary({ desktop, ready: () => true, canRecover: () => true, epoch: () => 4, getScene: () => 'life', clock: () => 100000 });
  const recovery = secretary.recoverConnection(); await entered; await desktop.stop(); release(); await recovery;
  assert.equal(calls, 0); secretary.close();
});
test('actual inference retry is bounded, cancellable and never crosses an authorization generation', async () => {
  const source = fs.readFileSync('src/main/workbuddy.js', 'utf8');
  let calls = 0, version = 1;
  const options = { timeoutMs: 2000 };
  const ctx = { Date, Promise, setTimeout, clearTimeout, isTransientConnectionError, connectionVersion: () => version, request: () => {},
    recoverConnection: async () => ({ ready: true }),
    chatWithTransport: async opts => { calls++; if (calls === 1) throw new Error('连接已断开'); assert(opts.timeoutMs <= 2000); return { text: 'ok' }; } };
  vm.createContext(ctx); vm.runInContext(source.slice(source.indexOf('async function chat(opts)'), source.indexOf('\nmodule.exports')), ctx);
  assert.equal((await ctx.chat(options)).text, 'ok'); assert.equal(calls, 2);
  calls = 0; ctx.recoverConnection = async () => { version++; return { ready: true }; };
  await assert.rejects(ctx.chat(options), { code: 'E_AUTH_SESSION' }); assert.equal(calls, 1);
  calls = 0; ctx.recoverConnection = () => new Promise(() => {});
  const controller = new AbortController(), pending = ctx.chat({ timeoutMs: 2000, signal: controller.signal });
  setTimeout(() => controller.abort(), 10); await assert.rejects(pending, { code: 'ABORT_ERR' }); assert.equal(calls, 1);
  assert.equal(isTransientConnectionError({ code: 'E_UPSTREAM_TRANSIENT', message: 'server busy' }), true);
  assert.equal(isTransientConnectionError({ code: 'E_AUTH_SESSION', message: 'WorkBuddy 登录状态已变化' }), false);
});
