'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { PassThrough, Writable } = require('stream');
const { DesktopNative, defaultBinary } = require('../src/main/desktop-native');

function fixture(options = {}) {
  const children = [];
  const client = new DesktopNative('/fixture/desktop', { ...options, spawn: (bin, args, opts) => {
    assert.equal(bin, '/fixture/desktop'); assert.deepEqual(args, []); assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) { child.lines.push(String(chunk)); callback(); } });
    child.lines = []; child.kill = () => {}; children.push(child); return child;
  } });
  return { client, children };
}

test('JSONL client correlates concurrent requests and resolves native responses', async () => {
  const { client, children } = fixture();
  const first = client.request('permissions');
  const second = client.request('frontmost');
  const child = children[0];
  const messages = child.lines.map(line => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].op, 'permissions');
  assert.ok(Number.isFinite(messages[0].sentAtMs));
  child.stdout.write(`${JSON.stringify({ id: messages[1].id, ok: true, result: { pid: 11 } })}\n`);
  child.stdout.write(`${JSON.stringify({ id: messages[0].id, ok: true, result: { accessibilityTrusted: false } })}\n`);
  assert.deepEqual(await second, { pid: 11 });
  assert.deepEqual(await first, { accessibilityTrusted: false });
});

test('native failures reject and invalid timeout is refused before spawning', async () => {
  const { client, children } = fixture();
  await assert.rejects(client.request('capture', {}, 0), /timeoutMs/);
  assert.equal(children.length, 0);
  const pending = client.request('capture');
  const request = JSON.parse(children[0].lines[0]);
  children[0].stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: '缺少屏幕录制权限' })}\n`);
  await assert.rejects(pending, /缺少屏幕录制权限/);
});

test('client resolves a stable packaged or development executable path', () => {
  assert.equal(defaultBinary().endsWith('/bin/desktop'), true);
});

test('native key map explicitly covers ANSI letters, digits, editing keys, and F1-F12', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  const keyMap = source.slice(source.indexOf('func keyCode('), source.indexOf('func modifiers('));
  const modifierMap = source.slice(source.indexOf('func modifiers('), source.indexOf('func validateActionContext('));
  for (const key of 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) assert.match(keyMap, new RegExp(`\\"${key}\\"\\s*:`));
  for (const key of ['backspace', 'forwarddelete', 'f1', 'f12']) assert.match(keyMap, new RegExp(`\\"${key}\\"\\s*:`));
  assert.match(modifierMap, /case "command", "cmd": flags\.insert\(\.maskCommand\)/);
});

test('Unicode chunks iterate scalar values and revalidate focus before each type chunk', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /for scalar in value\.unicodeScalars/);
  assert.match(source, /current\.count \+ units\.count > limit/);
  assert.match(source, /for item in plan \{\s*let \(currentId, _\) = try validateActionContext\(request\)/);
});

test('capture disables shadows and cursor and writes screenshot files with no-follow private modes', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /config\.showsCursor = false/);
  assert.match(source, /config\.ignoreShadowsSingleWindow = true/);
  assert.match(source, /config\.ignoreShadowsDisplay = true/);
  assert.match(source, /open\(\$0, O_RDONLY \| O_DIRECTORY \| O_NOFOLLOW\)/);
  assert.match(source, /O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW, 0o600/);
});

test('locked-session guard covers capture, activate, and all input actions; permissions reports lock state', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /session\["CGSSessionScreenIsLocked"\]/);
  assert.match(source, /"sessionLocked": sessionLocked\(\)/);
  assert.equal((source.match(/guard !sessionLocked\(\) else \{ throw DesktopError\(message: "电脑已锁屏，请解锁后重试"\) \}/g) || []).length, 4);
  assert.match(source, /DispatchQueue\.global\(qos: \.userInitiated\)\.async/);
  assert.match(source, /RunLoop\.main\.run\(mode: \.default, before: Date\(timeIntervalSinceNow: 0\.1\)\)/);
});

test('type plans reject implicit newlines and controls, emit explicit soft breaks, and preserve surrogate pairs', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /func makeInputPlan\(_ value: String, lineBreak: Any\? = nil\)/);
  assert.match(source, /value\.replacingOccurrences\(of: "\\r\\n", with: "\\n"\)/);
  assert.match(source, /scalar\.value <= 0x1f && scalar\.value != 0x0a/);
  assert.match(source, /event\.flags = \.maskShift[\s\S]{0,180}event\.post\(tap: \.cghidEventTap\)/);
  assert.match(source, /guard !sessionLocked\(\) else \{ throw DesktopError\(message: "电脑已锁屏，请解锁后重试"\) \}/);
  const run = spawnSync(defaultBinary(), ['--self-test-native'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.selfTest, 'native');
  assert.deepEqual(result.rectCases, ['CGWindowBounds', 'lowercase']);
  assert.equal(result.invalidRectsRejected, 5);
  assert.deepEqual(result.multilineEvents, ['text:A', 'shiftEnter', 'text:B', 'shiftEnter', 'text:C']);
  assert.deepEqual(result.surrogateChunkSizes, [19, 3]);
});

test('rectFrom accepts CGWindowBounds casing and preserves dimension validation', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /v\["x"\] \?\? v\["X"\]/);
  assert.match(source, /v\["y"\] \?\? v\["Y"\]/);
  assert.match(source, /v\["width"\] \?\? v\["Width"\]/);
  assert.match(source, /v\["height"\] \?\? v\["Height"\]/);
  assert.match(source, /\[x, y, w, h\]\.allSatisfy\(\{ \$0\.isFinite \}\)/);
  assert.match(source, /w < 100_000, h < 100_000/);
});

test('close kills and waits; cancel kills, waits, and permits a later restart', async () => {
  const { client, children } = fixture();
  const pending = client.request('frontmost');
  const first = children[0]; const signals = [];
  first.kill = signal => { signals.push(signal); process.nextTick(() => first.emit('close', null, signal)); return true; };
  const closing = client.close();
  await assert.rejects(pending, /已取消/);
  await closing;
  assert.deepEqual(signals, ['SIGTERM']);
  await assert.rejects(client.request('permissions'), /已关闭/);

  const restart = fixture();
  const inFlight = restart.client.request('frontmost');
  const current = restart.children[0]; const cancelSignals = [];
  current.kill = signal => { cancelSignals.push(signal); process.nextTick(() => current.emit('close', null, signal)); return true; };
  const cancelling = restart.client.cancel();
  await assert.rejects(inFlight, /已取消/);
  await cancelling;
  assert.deepEqual(cancelSignals, ['SIGTERM']);
  const next = restart.client.request('permissions');
  assert.equal(restart.children.length, 2);
  const request = JSON.parse(restart.children[1].lines[0]);
  restart.children[1].stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: { ok: true } })}\n`);
  assert.deepEqual(await next, { ok: true });
});

test('stdin errors reject pending requests and response lines have a byte limit', async () => {
  const { client, children } = fixture({ maxResponseLineBytes: 8 });
  const pending = client.request('frontmost');
  children[0].stdin.emit('error', new Error('pipe broke'));
  await assert.rejects(pending, /stdin 错误/);

  const other = fixture({ maxResponseLineBytes: 8 });
  const tooLarge = other.client.request('permissions');
  other.children[0].stdout.write(Buffer.from('123456789'));
  await assert.rejects(tooLarge, /超过 64 MiB/);
});
