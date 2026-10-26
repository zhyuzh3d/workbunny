'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { PassThrough, Writable } = require('stream');
const { DesktopNative, defaultBinary } = require('../src/main/desktop-native');
const nativeTestBinary = () => process.env.WORKBUNNY_NATIVE_TEST_BINARY || defaultBinary();

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
  assert.match(source, /filter\.pointPixelScale/);
  assert.match(source, /config\.scalesToFit = true/);
  assert.match(source, /config\.preservesAspectRatio = true/);
  assert.match(source, /func capturePixelSize\(rect: CGRect, pointPixelScale: CGFloat\)/);
  assert.match(source, /open\(\$0, O_RDONLY \| O_DIRECTORY \| O_NOFOLLOW\)/);
  assert.match(source, /O_WRONLY \| O_CREAT \| O_EXCL \| O_NOFOLLOW, 0o600/);
});

test('locked-session guard covers capture, activate, and all input actions; permissions reports lock state', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  assert.match(source, /session\["CGSSessionScreenIsLocked"\]/);
  assert.match(source, /"sessionLocked": sessionLocked\(\)/);
  assert.equal((source.match(/guard !sessionLocked\(\) else \{ throw DesktopError\(message: "电脑已锁屏，请解锁后重试"\) \}/g) || []).length, 6);
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
  const run = spawnSync(nativeTestBinary(), ['--self-test-native'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.selfTest, 'native');
  assert.deepEqual(result.capturePixelSize, [840, 630]);
  assert.equal(result.windowFit, true);
  assert.deepEqual(result.rectCases, ['CGWindowBounds', 'lowercase']);
  assert.equal(result.invalidRectsRejected, 5);
  assert.deepEqual(result.multilineEvents, ['text:A', 'shiftEnter', 'text:B', 'shiftEnter', 'text:C']);
  assert.deepEqual(result.surrogateChunkSizes, [19, 3]);
});

test('generic visual sampling is bounded, commit-based, and never queries application UI', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  const visual = source.slice(source.indexOf('func captureVisualFrame('), source.indexOf('func recognizePNG('));
  assert.match(source, /func normalizedVisualRegions\(_ value: Any\?\)/);
  assert.match(source, /\(1\.\.\.4\)\.contains\(rows\.count\)/);
  assert.match(source, /let visualRegionMaxSide = 320/);
  assert.match(source, /let visualSampleCapacity = 8/);
  assert.match(source, /func compareVisualRegion\(_ baseline: VisualRegionFrame, _ current: VisualRegionFrame, threshold: Int\)/);
  assert.match(source, /func visualCommit\(_ request: \[String: Any\]\)/);
  assert.match(source, /func resetVisualBaseline\(_ id: String\)/);
  assert.match(source, /func visualForget\(_ request: \[String: Any\]\)/);
  assert.match(source, /if shouldIncludeVisualImage\(changed: changed, reset: reset/);
  assert.match(source, /shouldIncludeVisualImage\(changed: changed, reset: reset, geometryChanged: geometryChanged,[\s\S]{0,120}hasBaseline: hasBaseline/);
  assert.match(source, /NSRunningApplication\(processIdentifier: pid_t\(pid\)\)\?\.bundleIdentifier/);
  assert.match(source, /case "visualSample": return try visualSample\(request\)/);
  assert.doesNotMatch(visual, /AXUIElement|AppleScript|NSWorkspace\.shared\.frontmostApplication/);
  assert.match(source, /CGEventSource\.secondsSinceLastEventType\(\.hidSystemState, eventType: anyInput\)/);
  assert.match(source, /CGEventSource\.secondsSinceLastEventType\(\.combinedSessionState, eventType: anyInput\)/);
  const run = spawnSync(nativeTestBinary(), ['--self-test-visual'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.visualSample, true);
  assert.equal(result.visualCapacity, 8);
  assert.equal(result.inputIdleReadOnly, true);
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

test('WorkBuddy AX path is app-locked, geometry-bound, and exposes only three bounded controls', () => {
  const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
  const context = source.slice(source.indexOf('func workBuddyControls('), source.indexOf('func workBuddyInspect('));
  assert.ok(context.indexOf('validateWorkBuddyContext(request)') < context.indexOf('AXUIElementCreateApplication'));
  assert.match(source, /workBuddyBundleAllowed\(front\.bundleIdentifier\)/);
  assert.match(source, /let workBuddyBundleID = "com\.tencent\.workbuddy\.mac"/);
  assert.match(source, /func workBuddyMarkerAllowed\(_ marker: String\?\)/);
  assert.match(source, /func workBuddyTargetReady\(mode: String, homeReady: Bool, conversationMarkerPresent: Bool\)/);
  assert.match(source, /mode == "conversation" && workBuddyMarkerAllowed\(marker\)/);
  assert.match(source, /if !insideEditor && !isEditor, let associationMarker/);
  assert.match(source, /let frame = axWindowRect\(element\)[\s\S]{0,180}rectIntersects\(frame, targetRect\)/);
  assert.match(source, /"conversationReady": controls\.associationMarkerPresent/);
  assert.match(source, /abs\(lhs\.minX-rhs\.minX\) <= 2/);
  assert.match(source, /AXUIElementSetMessagingTimeout\(element, 0\.2\)/);
  assert.match(source, /visited >= 2000/);
  assert.match(source, /let workBuddyMaxAXDepth = 48/);
  assert.match(source, /func workBuddyCanDescend\(depth: Int, childCount: Int/);
  assert.match(source, /depthCutoff = true/);
  assert.match(source, /"visitedNodes": controls\.visitedNodes/);
  assert.match(source, /"markerFrameMissing": controls\.markerFrameMissing/);
  assert.match(source, /"markerFrameOutsideTarget": controls\.markerFrameOutsideTarget/);
  assert.match(source, /2_000_000_000/);
  assert.match(source, /role == kAXTextAreaRole/);
  assert.match(source, /description\.hasPrefix\("Select model:"\)/);
  assert.match(source, /role == kAXHeadingRole[\s\S]{0,420}workBuddyHeadingHomeReady\(value: value, title: title, description: description\)/);
  assert.match(source, /== "发送"/);
  assert.match(source, /description == "发送"/);
  assert.match(source, /workBuddyReadbackFlags\(actual: finalReadback, expected: expectedText\)\.matches/);
  assert.match(source, /func workBuddyDraftIsEmpty\(_ raw: String\?/);
  assert.match(source, /raw == "\\u\{FEFF\}"/);
  assert.match(source, /if !expected\.hasPrefix\("\\u\{FEFF\}"\) && comparable\.hasPrefix\("\\u\{FEFF\}"\) \{ comparable\.removeFirst\(\) \}/);
  assert.match(source, /workBuddyDraftIsEmpty\(controls\.draft, sendButtonCount:/);
  assert.match(source, /workBuddyTextMatches\(controls\.draft, expected: text\)/);
  assert.match(source, /raw == workBuddyRTEEmptyValue && sendButtonCount == 1 && !sendEnabled/);
  assert.match(source, /workBuddyDraftPlan\(current: workBuddyRTEEmptyValue, requested: "task text", sendButtonCount: 1, sendEnabled: false\)/);
  assert.match(source, /draftMatchesRequest = available && workBuddyTargetReady\(mode: mode, homeReady: controls\.homeReady, conversationMarkerPresent: controls\.associationMarkerPresent\) && controls\.selectedModel == workBuddyUIModel/);
  assert.match(source, /components\(separatedBy: "\\n"\)/);
  assert.match(source, /expectedLine\.isEmpty && actualLine == "\\u\{FEFF\}"/);
  const textMatch = source.slice(source.indexOf('func workBuddyTextMatches('), source.indexOf('func workBuddyDraftPlan('));
  assert.doesNotMatch(textMatch, /trimmingCharacters/);
  assert.doesNotMatch(source, /func canonicalWorkBuddyText/);
  assert.match(source, /makeInputPlan\(text, lineBreak: "shiftEnter"\)/);
  assert.match(source, /func postUnicodeText\(_ units: \[UInt16\]\)/);
  assert.match(source, /func postShiftReturn\(\)/);
  assert.match(source, /AXUIElementSetAttributeValue\(editor, kAXFocusedAttribute/);
  assert.match(source, /kAXFocusedUIElementAttribute/);
  assert.match(source, /waitDeadline = DispatchTime\.now\(\)\.uptimeNanoseconds \+ 800_000_000/);
  assert.doesNotMatch(source, /AXUIElementSetAttributeValue\(editor, kAXValueAttribute[^\n]*text/);
  assert.match(source, /AXUIElementPerformAction\(button, kAXPressAction as CFString\)/);
  assert.match(source, /case "workbuddyInspect"/);
  assert.match(source, /case "workbuddyFill"/);
  assert.match(source, /case "workbuddySend"/);
  const run = spawnSync(nativeTestBinary(), ['--self-test-workbuddy'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout.trim()).workBuddyGuards, true);
  assert.equal(JSON.parse(run.stdout.trim()).workBuddyConversationGuard, true);
  assert.equal(JSON.parse(run.stdout.trim()).workBuddyReadbackGuards, true);
  assert.equal(JSON.parse(run.stdout.trim()).workBuddySerializedMatch, true);
  const rejected = spawnSync(nativeTestBinary(), [], {
    encoding: 'utf8', timeout: 5000,
    input: `${JSON.stringify({ id: 'wrong-bundle', op: 'workbuddyInspect', windowId: 1,
      expected: { pid: 1, bundleId: 'com.tencent.wechat' }, sentAtMs: Date.now(), timeoutMs: 1000 })}\n`,
  });
  assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
  const response = JSON.parse(rejected.stdout.trim());
  assert.equal(response.ok, false);
  assert.match(response.error, /仅允许目标应用 com\.tencent\.workbuddy\.mac/);
  const invalidMarker = spawnSync(nativeTestBinary(), [], {
    encoding: 'utf8', timeout: 5000,
    input: `${JSON.stringify({ id: 'invalid-marker', op: 'workbuddyInspect', mode: 'conversation', marker: '[workbunny:invalid]', windowId: 1,
      expected: { pid: 1, bundleId: 'com.tencent.workbuddy.mac' }, sentAtMs: Date.now(), timeoutMs: 1000 })}\n`,
  });
  assert.equal(invalidMarker.status, 0, invalidMarker.stderr || invalidMarker.stdout);
  assert.match(JSON.parse(invalidMarker.stdout.trim()).error, /模式或会话关联标记无效/);
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
