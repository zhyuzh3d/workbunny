'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { Asr } = require('../src/main/asr');

function fakeSpawner() {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.pid = 4000 + children.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = { write() {} };
    child.kills = [];
    child.kill = signal => child.kills.push(signal);
    children.push(child);
    return child;
  };
  return { spawn, children };
}

const send = (child, message) => child.stdout.write(JSON.stringify(message) + '\n');

test('discarded ASR generation cannot leak messages, auth, errors, or close into its replacement', t => {
  const fake = fakeSpawner();
  const asr = new Asr('/fake/asr', () => {}, fake.spawn);
  t.after(() => asr.kill({ discard: true }));
  const events = { auth: [], ready: 0, partial: [], final: [], errors: [], exits: 0 };
  asr.on('auth', value => events.auth.push(value));
  asr.on('ready', () => events.ready++);
  asr.on('partial', value => events.partial.push(value));
  asr.on('final', value => events.final.push(value));
  asr.on('error', value => events.errors.push(value));
  asr.on('exit', () => events.exits++);

  asr.start({ always: true });
  const old = fake.children[0];
  send(old, { t: 'partial', v: '旧场景半句' });
  asr.kill({ discard: true });
  assert.deepEqual(old.kills, ['SIGKILL']);

  asr.start({ always: true });
  const current = fake.children[1];
  const currentAuthTimer = asr.authWaitTimer;
  old.stdout.write(JSON.stringify({ t: 'partial', v: '旧迟到半句' }) + '\n' +
    JSON.stringify({ t: 'final', v: '旧场景最终文本' }) + '\n' +
    JSON.stringify({ t: 'auth', speech: true, mic: true }) + '\n' +
    JSON.stringify({ t: 'error', v: '旧进程错误' }) + '\n');
  old.stderr.write('旧进程 stderr\n');
  old.emit('error', new Error('late old child error'));
  old.emit('close', 0, null);
  assert.equal(asr.proc, current);
  assert.equal(asr.authWaitTimer, currentAuthTimer, 'old close leaves replacement auth timer untouched');
  assert.equal(events.exits, 0, 'discarded generation emits no restart-triggering exit');
  assert.deepEqual(events.partial, ['旧场景半句']);
  assert.deepEqual(events.final, []);
  assert.deepEqual(events.auth, []);
  assert.deepEqual(events.errors, []);

  send(current, { t: 'auth', speech: true, mic: true, locale: 'zh-CN' });
  send(current, { t: 'ready', captureHeartbeat: true });
  send(current, { t: 'partial', v: '新场景文本' });
  send(current, { t: 'final', v: '新场景最终文本' });
  assert.equal(events.ready, 1);
  assert.equal(events.auth.length, 1);
  assert.deepEqual(events.partial, ['旧场景半句', '新场景文本']);
  assert.deepEqual(events.final, ['新场景最终文本']);
  const captureTimer = asr.captureTimer;
  assert(captureTimer, 'replacement owns its capture watchdog');
  old.emit('close', 0, null);
  assert.equal(asr.captureTimer, captureTimer, 'repeated stale close cannot clear replacement capture timer');
  assert.equal(asr.ready, true);
});

test('default kill still emits exit so existing health recovery can restart ASR', t => {
  const fake = fakeSpawner();
  const asr = new Asr('/fake/asr', () => {}, fake.spawn);
  t.after(() => asr.kill({ discard: true }));
  let exits = 0;
  asr.on('exit', () => {
    exits++;
    if (exits === 1) asr.start({ always: true });
  });
  asr.start({ always: true });
  const previous = fake.children[0];
  asr.kill();
  previous.emit('close', null, 'SIGKILL');
  assert.equal(exits, 1);
  assert.equal(fake.children.length, 2, 'health exit listener can immediately start the replacement');
  assert.equal(asr.proc, fake.children[1]);
});
