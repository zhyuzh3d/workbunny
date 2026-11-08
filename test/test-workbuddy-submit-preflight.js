'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');

test('raw submit verification stays inside native dispatch and precedes mouse or keyboard input', () => {
  const perform = source.slice(source.indexOf('func perform('), source.indexOf('func runNativeSelfTest('));
  const click = perform.slice(perform.indexOf('if op == "click" || op == "move"'), perform.indexOf('if op == "scroll"'));
  const key = perform.slice(perform.indexOf('if op == "key"'), perform.indexOf('guard let value = request["text"]'));
  for (const [body, dispatch] of [[click, 'try postMouse(.rightMouseDown'], [key, 'event.post(tap: .cghidEventTap)']]) {
    assert(body.indexOf('try validateWorkBuddySubmission(request, submissionExpectation)') >= 0);
    assert(body.indexOf('try validateWorkBuddySubmission(request, submissionExpectation)') < body.indexOf(dispatch));
  }
  assert.match(perform, /let submissionExpectation = try workBuddySubmissionExpectation\(request\)/);
  const verifier = source.slice(source.indexOf('func validateWorkBuddySubmission('), source.indexOf('// WorkBuddy-only semantic navigation.'));
  assert.match(verifier, /guard let expectation else \{ return \}/);
  assert.match(verifier, /try workBuddyControls\(scoped\)/);
  assert.match(verifier, /scoped\["background"\] = false/);
  assert.match(verifier, /scannedDraft: controls\.draft, currentDraft: currentDraft, expected: expectation\.text/);
  assert.match(verifier, /scanComplete: controls\.scanComplete && controls\.childrenFetchErrors == 0, editorCount: controls\.editors\.count/);
  assert.doesNotMatch(verifier, /modelAllowed|controls\.combos|controls\.sendButtons|controls\.selectedModel/);
  assert.match(verifier, /axAttribute\(\$0, kAXValueAttribute as String\)/);
  assert.match(verifier, /request\["op"\] as\? String == "key", !workBuddyEditorFocused\(controls\)/);
  assert.match(verifier, /_ = try validateActionContext\(request\)/);
  assert.match(verifier, /code: error\.code \?\? "E_GUI_DRAFT_UNVERIFIED", dispatched: false/);
  assert.doesNotMatch(verifier, /AXUIElementSetAttributeValue|postMouse|postUnicodeText|AXUIElementPerformAction/);
});

test('offline Swift validates host parameters and rejects changed or unverifiable submit drafts', t => {
  const error = source.slice(source.indexOf('struct DesktopError:'), source.indexOf('struct CaptureUnavailableError:'));
  const limits = source.slice(source.indexOf('let workBuddyTextUTF16Limit'), source.indexOf('func writeJSON('));
  const helpers = source.slice(source.indexOf('let workBuddyBundleID'), source.indexOf('func workBuddyControlsUnique('));
  const fixture = String.raw`
let text = "fixture request\n[workbunny:bcf0b2af-d420-4fb4-8fa3-98effc9246c9]"
let marker = "[workbunny:bcf0b2af-d420-4fb4-8fa3-98effc9246c9]"
let base: [String: Any] = ["op": "click", "expected": ["bundleId": workBuddyBundleID], "expectedSubmissionText": text, "expectedSubmissionMode": "home"]
let absent = try workBuddySubmissionExpectation(["op": "click"])
precondition(absent == nil)
for op in ["click", "key"] {
    let valid = try workBuddySubmissionExpectation(base.merging(["op": op]) { _, value in value })
    precondition(valid?.text == text && valid?.mode == "home")
}
let conversation = try workBuddySubmissionExpectation(base.merging(["expectedSubmissionMode": "conversation", "expectedSubmissionMarker": marker]) { _, value in value })
precondition(conversation?.marker == marker)
for patch: [String: Any] in [
    ["op": "type"], ["op": "move"], ["op": "workbuddySend"],
    ["expected": ["bundleId": "com.tencent.xinWeChat"]], ["expected": ["bundleId": "fixture.other"]],
    ["expectedSubmissionText": ""], ["expectedSubmissionText": 42],
    ["expectedSubmissionText": String(repeating: "x", count: workBuddyTextUTF16Limit + 1)],
    ["expectedSubmissionText": "bad\ttab"], ["expectedSubmissionMode": "unknown"],
    ["expectedSubmissionMode": "conversation"], ["expectedSubmissionMarker": "invalid"],
    ["expectedSubmissionMarker": NSNull()]
] {
    do { _ = try workBuddySubmissionExpectation(base.merging(patch) { _, value in value }); fatalError("invalid host fields accepted") }
    catch let error as DesktopError { precondition(error.code == "E_GUI_DRAFT_UNVERIFIED" && error.dispatched == false) }
}
for partial: [String: Any] in [["expectedSubmissionMode": "home"], ["expectedSubmissionMarker": marker]] {
    do { _ = try workBuddySubmissionExpectation(partial); fatalError("partial host fields accepted") }
    catch let error as DesktopError { precondition(error.code == "E_GUI_DRAFT_UNVERIFIED" && error.dispatched == false) }
}
func state(_ scanned: String?, _ current: String?, _ complete: Bool = true, _ editors: Int = 1, _ target: Bool = true) -> WorkBuddySubmissionDraftState {
    workBuddySubmissionDraftState(scanComplete: complete, editorCount: editors, targetReady: target, scannedDraft: scanned, currentDraft: current, expected: text)
}
guard case .ready = state(text, text), case .ready = state(text, "\u{FEFF}" + text),
      case .conflict = state(text, "unrelated draft"), case .conflict = state("unrelated draft", text),
      case .conflict = state(text, text + " suffix"), case .conflict = state(text, text + "\n"),
      case .unverified = state(nil, text), case .unverified = state(text, nil),
      case .unverified = state(text, text, false), case .unverified = state(text, text, true, 0),
      case .unverified = state(text, text, true, 2), case .unverified = state(text, text, true, 1, false) else { fatalError("unsafe draft state accepted") }
print("offline submit fixtures passed")
`;
  const run = spawnSync('/usr/bin/swift', ['-'], { input: `import Foundation\n${error}\n${limits}\n${helpers}\n${fixture}`, encoding: 'utf8', timeout: 30000 });
  if (run.error?.code === 'ENOENT') return t.skip('Swift compiler is unavailable');
  assert.equal(run.status, 0, run.stderr || run.stdout || String(run.error));
  assert.match(run.stdout, /offline submit fixtures passed/);
});
