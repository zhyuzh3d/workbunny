'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createSystemTTS } = require('../src/main/tts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbunny-tts-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function outputPath(args) { return args[args.indexOf('-o') + 1]; }
function wav() { const b = Buffer.alloc(44); b.write('RIFF'); b.write('WAVE', 8); return b; }

test('say failure hides command text and removes partial WAV after callback', async (t) => {
  const root = fixture(t), marker = 'private-marker-zh-猫';
  const speak = createSystemTTS({ tmpdir: () => root, execFileImpl(_bin, args, _opts, callback) {
    const out = outputPath(args);
    assert.equal(args.includes(marker), false);
    assert.deepEqual(args.slice(-2), ['-f', '-']);
    assert.equal(fs.statSync(path.dirname(out)).mode & 0o777, 0o700);
    fs.writeFileSync(out, Buffer.from('partial speech'));
    setImmediate(() => callback(Object.assign(new Error(`Command failed: ${args.join(' ')}`), { cmd: args.join(' ') })));
    const stdin = new EventEmitter();
    stdin.end = value => assert.equal(value, marker);
    return { stdin, kill() { return true; } };
  }});
  await assert.rejects(speak(marker, 'Voice', 200), error => {
    assert.match(error.message, /系统语音合成失败/);
    assert.equal(error.message.includes(marker), false);
    assert.equal(error.message.includes('/usr/bin/say'), false);
    return true;
  });
  assert.deepEqual(fs.readdirSync(root), []);
});

test('timeout removes partial WAV and reports a fixed timeout', async (t) => {
  const root = fixture(t);
  const speak = createSystemTTS({ tmpdir: () => root, execFileImpl(_bin, args, _opts, callback) {
    fs.writeFileSync(outputPath(args), Buffer.from('partial speech'));
    setImmediate(() => callback(Object.assign(new Error('includes private command'), { code: 'ETIMEDOUT', killed: true })));
    const stdin = new EventEmitter(); stdin.end = () => {};
    return { stdin, kill() { return true; } };
  }});
  await assert.rejects(speak('private timeout text', '', 200), /系统语音合成超时/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('abort kills the child and removes its WAV after the child callback', async (t) => {
  const root = fixture(t), controller = new AbortController();
  let killed = false;
  const speak = createSystemTTS({ tmpdir: () => root, execFileImpl(_bin, args, _opts, callback) {
    const out = outputPath(args);
    fs.writeFileSync(out, Buffer.from('partial speech'));
    const stdin = new EventEmitter(); stdin.end = () => {};
    return { kill(signal) {
      assert.equal(signal, 'SIGKILL');
      killed = true;
      setTimeout(() => callback(Object.assign(new Error('contains private text'), { killed: true })), 20);
      return true;
    }, stdin };
  }});
  const pending = speak('private abort text', '', 200, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(fs.readdirSync(root).length, 1, 'must wait until child callback before cleaning its output');
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(killed, true);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('success returns WAV and removes its temporary directory', async (t) => {
  const root = fixture(t), expected = wav();
  const speak = createSystemTTS({ tmpdir: () => root, execFileImpl(_bin, args, _opts, callback) {
    fs.writeFileSync(outputPath(args), expected);
    setImmediate(() => callback(null));
    const stdin = new EventEmitter(); stdin.end = () => {};
    return { stdin, kill() { return true; } };
  }});
  assert.deepEqual(await speak('safe test phrase', '', 200), expected);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('stdin error and early child exit are sanitized and cleaned after child callback', async (t) => {
  const root = fixture(t), marker = 'private-stdin-marker';
  let callbackCalled = false;
  const speak = createSystemTTS({ tmpdir: () => root, execFileImpl(_bin, args, _opts, callback) {
    const out = outputPath(args), dir = path.dirname(out);
    fs.writeFileSync(out, Buffer.from('partial speech'));
    const stdin = new EventEmitter();
    stdin.end = value => {
      assert.equal(value, marker);
      setImmediate(() => stdin.emit('error', Object.assign(new Error(`EPIPE ${marker}`), { code: 'EPIPE' })));
    };
    return { stdin, kill() {
      setTimeout(() => {
        callbackCalled = true;
        callback(Object.assign(new Error(`early exit ${marker}`), { code: 1 }));
      }, 20);
      setTimeout(() => assert.equal(fs.existsSync(dir), true), 5);
      return true;
    }};
  }});
  await assert.rejects(speak(marker, '', 200), error => {
    assert.equal(error.message.includes(marker), false);
    assert.match(error.message, /系统语音合成失败/);
    return true;
  });
  assert.equal(callbackCalled, true);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('real say stdin produces a WAV without playing it', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = fixture(t), speak = createSystemTTS({ tmpdir: () => root });
  const result = await speak('This is an isolated synthetic voice test.', '', 200);
  assert.equal(result.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(fs.readdirSync(root).length, 0);
  t.diagnostic(`generated_bytes=${result.length}`);
});
