'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');
const fill = source.slice(source.indexOf('func workBuddyFill('), source.indexOf('func workBuddySendPoint('));

test('fill checks the live draft after both focus paths and before text dispatch or idempotent success', () => {
  const foregroundFocus = fill.indexOf('try focusWorkBuddyEditor(');
  const backgroundFocus = fill.indexOf('guard workBuddyEditorFocused(controls) else');
  const focusedCheck = fill.indexOf('sendEnabled: focusedSendEnabled)');
  const firstInput = fill.indexOf('try postUnicodeText(');
  const idempotent = fill.indexOf('return ["filled": true, "idempotent": true');
  assert(foregroundFocus >= 0 && backgroundFocus >= 0);
  assert(focusedCheck > foregroundFocus && focusedCheck > backgroundFocus);
  assert(firstInput > focusedCheck && idempotent > focusedCheck);
  assert.doesNotMatch(fill.slice(0, focusedCheck), /return \["filled": true/);
  assert.match(fill.slice(foregroundFocus, focusedCheck), /try revalidateWorkBuddyContext\(request, context, requireFrontmost: !background\)/);
  assert.match(fill.slice(foregroundFocus, focusedCheck), /workBuddyEditorFocused\(controls\)/);
  assert.match(fill.slice(foregroundFocus, focusedCheck), /workBuddyDraftPlan\(current: axAttribute\(editor, kAXValueAttribute as String\) as\? String/);
  assert.equal((fill.match(/code: "E_WORKBUDDY_DRAFT_CONFLICT", dispatched: false/g) || []).length, 3);
  assert.match(fill.slice(focusedCheck, firstInput), /case \.reject:[\s\S]*E_WORKBUDDY_DRAFT_CONFLICT[\s\S]*case \.write: break/);
});

test('an exact draft is not selected, cleared or rewritten to refresh a disabled send button', () => {
  assert.doesNotMatch(fill, /refreshMatchingDraft|kAXSelectedTextRangeAttribute|AXValueCreate|\.maskCommand|kAXValueAttribute as CFString/);
  assert.match(fill, /case \.alreadyFilled:\s*return \["filled": true, "idempotent": true, "verified": true, "sendEnabled": focusedSendEnabled\]/);
  assert.match(fill, /guard readback\.matches else \{\s*return \["filled": false, "resultUncertain": true, "verified": false/);
});

test('offline Swift fixtures reject restored or mixed drafts and retain exact disabled drafts', t => {
  // Compile only pure production helpers, with no AX/GUI/runtime dependencies.
  const emptyValue = source.match(/^let workBuddyRTEEmptyValue = .*$/m)?.[0];
  const planEnum = source.match(/^enum WorkBuddyDraftPlan .*$/m)?.[0];
  assert(emptyValue && planEnum);
  const helpers = source.slice(source.indexOf('func workBuddyDraftIsEmpty('), source.indexOf('struct WorkBuddySubmissionExpectation'));
  const fixture = String.raw`
let requested = "current fixture request"
let previous = "previous unrelated draft [workbunny:bcf0b2af-d420-4fb4-8fa3-98effc9246c9]"
for before in ["", "\u{FEFF}", requested] {
    if case .reject = workBuddyDraftPlan(current: before, requested: requested) { fatalError("invalid fixture precondition") }
    for after: String? in [previous, requested + previous, nil] {
        guard case .reject = workBuddyDraftPlan(current: after, requested: requested) else { fatalError("focus-restored draft was allowed") }
    }
}
for sendEnabled in [false, true] {
    guard case .alreadyFilled = workBuddyDraftPlan(current: requested, requested: requested, sendButtonCount: 1, sendEnabled: sendEnabled) else { fatalError("exact draft must stay intact") }
}
guard case .write = workBuddyDraftPlan(current: "", requested: requested),
      !workBuddyTextMatches(requested + previous, expected: requested),
      !workBuddyTextMatches(requested + " ", expected: requested) else { fatalError("mismatched readback was accepted") }
print("offline draft fixtures passed")
`;
  const run = spawnSync('/usr/bin/swift', ['-'], { input: `import Foundation\n${emptyValue}\n${planEnum}\n${helpers}\n${fixture}`, encoding: 'utf8', timeout: 30000 });
  if (run.error?.code === 'ENOENT') return t.skip('Swift compiler is unavailable');
  assert.equal(run.status, 0, run.stderr || run.stdout || String(run.error));
  assert.match(run.stdout, /offline draft fixtures passed/);
});
