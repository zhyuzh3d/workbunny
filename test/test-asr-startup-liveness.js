'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Asr } = require('../src/main/asr');

function fixture(t) {
  let next = 0;
  const timers = new Map(), allTimers = new Map(), children = [], errors = [];
  const schedule = (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); allTimers.set(id, fn); return id; };
  t.mock.method(global, 'setTimeout', schedule);
  t.mock.method(global, 'clearTimeout', id => timers.delete(id));
  t.mock.method(global, 'setInterval', schedule);
  t.mock.method(global, 'clearInterval', id => timers.delete(id));
  const asr = new Asr('/fake/asr', () => {}, () => {
    const p = new EventEmitter(); p.pid = children.length + 1;
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new EventEmitter(); p.stdin.write = () => {};
    p.kills = []; p.kill = signal => p.kills.push(signal); children.push(p); return p;
  });
  asr.on('error', error => errors.push(error));
  t.after(() => asr.kill({ discard: true }));
  const message = (p, value) => p.stdout.write(JSON.stringify(value) + '\n');
  const fire = id => { timers.delete(id); allTimers.get(id)(); };
  return { asr, children, errors, message, fire, timers };
}

test('auth without capture readiness remains bounded even if the child never closes', t => {
  const f = fixture(t); f.asr.start({ always: true }); const child = f.children[0];
  f.message(child, { t: 'auth', speech: 3, mic: true });
  f.fire(f.asr.authWaitTimer);
  assert.deepEqual(child.kills, ['SIGKILL']); assert.equal(f.asr.running, false);
  assert.match(f.errors[0], /输入准备超时/);
  f.asr.start({ always: true }); assert.equal(f.children.length, 2, 'restart does not depend on a close callback');
});

test('ready cancels startup deadline and a delayed old timeout cannot kill the replacement', t => {
  const f = fixture(t); f.asr.start({ always: true }); const old = f.children[0], startup = f.asr.authWaitTimer;
  f.message(old, { t: 'ready', captureHeartbeat: true }); f.fire(startup);
  assert.deepEqual(old.kills, []); assert.equal(f.asr.ready, true);
  const oldCapture = f.asr.captureTimer;
  f.message(old, { t: 'installing' }); const installing = f.asr.authWaitTimer;
  f.asr.kill({ discard: true }); f.asr.start({ always: true }); const current = f.children[1];
  f.message(current, { t: 'installing' }); const currentTimer = f.asr.authWaitTimer;
  t.mock.method(Date, 'now', () => 10_000_000_000_000);
  f.fire(oldCapture); f.fire(installing); f.fire(startup);
  assert.deepEqual(current.kills, []); assert.equal(f.asr.proc, current);
  assert.equal(f.asr.authWaitTimer, currentTimer); assert.equal(f.errors.length, 0);
});

test('resource preparation gets its own bounded deadline and ready retires it', t => {
  const f = fixture(t); f.asr.start({ always: true }); const p = f.children[0];
  f.message(p, { t: 'installing' }); const installing = f.asr.authWaitTimer;
  assert.equal(f.timers.get(installing).ms, 300000);
  f.message(p, { t: 'ready', captureHeartbeat: true }); f.fire(installing);
  assert.equal(f.asr.ready, true); assert.deepEqual(p.kills, []);
  f.asr.kill({ discard: true }); f.asr.start({ always: true });
  f.message(f.children[1], { t: 'installing' }); f.fire(f.asr.authWaitTimer);
  assert.equal(f.asr.running, false); assert.match(f.errors[0], /资源准备超时/);
});
