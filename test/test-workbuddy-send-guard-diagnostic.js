'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(require.resolve('../native/desktop.swift'), 'utf8');

test('send reports safe first-guard facts before dispatch and its wrapper preserves diagnostics', () => {
  const send = source.slice(source.indexOf('func workBuddySend('), source.indexOf('func unicodeChunks('));
  assert.match(send, /guard available, preflight\.ready, let editor = controls\.editors\.first else/);
  assert.match(send, /modelMatched: controls\.combos\.count == 1 && workBuddyModelAllowed/);
  assert.match(send, /childrenFetchErrors: controls\.childrenFetchErrors/);
  assert.match(send, /code: preflight\.conflictingDraft \? "E_WORKBUDDY_DRAFT_CONFLICT" : "E_GUI_BEFORE_DISPATCH", dispatched: false/);
  assert.match(send, /diagnostic: workBuddySendGuardDiagnostic\(preflight, background: background, sendButtonCount: controls\.sendButtons\.count\)/);
  assert(send.indexOf('guard available, preflight.ready') < send.indexOf('AXUIElementPerformAction'));
  assert(send.indexOf('guard available, preflight.ready') < send.indexOf('try postClick(clickPoint)'));
  assert.match(source, /code: error\.code \?\? "E_GUI_BEFORE_DISPATCH", dispatched: error\.dispatched \?\? false, diagnostic: error\.diagnostic/);
});

test('offline Swift identifies each rejected guard without exposing draft content', t => {
  const textHelpers = source.slice(source.indexOf('func workBuddyDraftIsEmpty('), source.indexOf('struct WorkBuddySubmissionExpectation'));
  const helpers = source.slice(source.indexOf('struct WorkBuddySendGuardPlan'), source.indexOf('func workBuddyControlsUnique('));
  const emptyValue = source.match(/^let workBuddyRTEEmptyValue = .*$/m)?.[0];
  const planEnum = source.match(/^enum WorkBuddyDraftPlan .*$/m)?.[0];
  const fixture = String.raw`
let expected = "private-request-canary"
let unrelated = "private-unrelated-canary"
func plan(_ complete: Bool = true, _ fetchErrors: Int = 0, _ editors: Int = 1,
          _ target: Bool = true, _ model: Bool = true, _ draft: String? = expected,
          _ buttons: Int = 1, _ enabled: Bool = true) -> WorkBuddySendGuardPlan {
    workBuddySendGuardPlan(scanComplete: complete, childrenFetchErrors: fetchErrors, editorCount: editors,
        targetReady: target, modelMatched: model, draft: draft, requested: expected,
        sendButtonCount: buttons, sendEnabled: enabled)
}
let good = plan()
precondition(good.ready && !good.conflictingDraft && good.checks.count == 8)
let cases: [(String, WorkBuddySendGuardPlan)] = [
    ("scanComplete", plan(false)), ("childrenReadable", plan(true, 1)),
    ("editorUnique", plan(true, 0, 0)), ("editorUnique", plan(true, 0, 2)),
    ("targetReady", plan(true, 0, 1, false)), ("modelMatched", plan(true, 0, 1, true, false)),
    ("draftMatched", plan(true, 0, 1, true, true, nil)),
    ("draftMatched", plan(true, 0, 1, true, true, unrelated)),
    ("sendButtonUnique", plan(true, 0, 1, true, true, expected, 0)),
    ("sendButtonUnique", plan(true, 0, 1, true, true, expected, 2)),
    ("sendEnabled", plan(true, 0, 1, true, true, expected, 1, false))
]
for (key, rejected) in cases {
    precondition(!rejected.ready && rejected.checks[key] == false)
}
precondition(plan(true, 0, 1, true, true, unrelated).conflictingDraft)
for draft: String? in [nil, "", "\u{FEFF}", workBuddyRTEEmptyValue] {
    precondition(!plan(true, 0, 1, true, true, draft, 1, false).conflictingDraft)
}
precondition(!plan(true, 0, 2, true, true, unrelated).conflictingDraft)
precondition(plan(true, 0, 1, true, true, expected + " suffix").conflictingDraft)
precondition(plan(true, 0, 1, true, true, "\u{FEFF}" + expected).ready)
for background in [true, false] {
    let diagnostic = workBuddySendGuardDiagnostic(plan(true, 0, 1, true, true, unrelated), background: background, sendButtonCount: 1)
    precondition(Set(diagnostic.keys) == Set(["operation", "method", "candidateCount", "guardChecks"]))
    precondition(diagnostic["operation"] as? String == "submit")
    precondition(diagnostic["method"] as? String == (background ? "background-ax" : "foreground-ax"))
    let checks = diagnostic["guardChecks"] as! [String: Bool]
    precondition(checks.count == 8 && checks.count <= 16 && checks["draftMatched"] == false)
    let data = try JSONSerialization.data(withJSONObject: diagnostic)
    let serialized = String(data: data, encoding: .utf8)!
    precondition(!serialized.contains(expected) && !serialized.contains(unrelated))
}
print("offline send guard fixtures passed")
`;
  const run = spawnSync('/usr/bin/swift', ['-'], { input: `import Foundation\n${emptyValue}\n${planEnum}\n${textHelpers}\n${helpers}\n${fixture}`, encoding: 'utf8', timeout: 30000 });
  if (run.error?.code === 'ENOENT') return t.skip('Swift compiler is unavailable');
  assert.equal(run.status, 0, run.stderr || run.stdout || String(run.error));
  assert.match(run.stdout, /offline send guard fixtures passed/);
});
