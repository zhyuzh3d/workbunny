'use strict';
const assert = require('node:assert/strict');
const { DesktopService } = require('../src/main/desktop-service');
const rect = { x: 0, y: 0, width: 1000, height: 700 };
async function scenario({ occupied = false, typeFails = false, sendFails = false, readbackFails = false } = {}) {
  const calls = [], journal = [], outcomes = [];
  const marker = '[workbunny:visual-test]';
  let draft = '', submissions = 0;
  const row = (text, y, x = .3) => ({ text, x, y, width: .3, height: .025, confidence: .99 });
  const native = { async request(op, payload = {}) {
    calls.push(op);
    if (op === 'frontmost') return { application: { bundleId: 'com.tencent.workbuddy.mac', pid: 5 }, windows: [{ pid: 5, windowId: 7, layer: 0, rect }] };
    if (op === 'workbuddyInspect') {
      if(draft&&!readbackFails)return {scanComplete:true,childrenFetchErrors:0,editorCount:1,conversationReady:true,associationMarkerPresent:true,draftEmpty:false,draftMatchesRequest:draft===payload.text};
      throw new Error('AX unavailable');
    }
    if (op === 'capture') return { pngBase64: Buffer.from('fixture').toString('base64'), desktopRect: rect };
    if (op === 'recognize') return { texts: [row(marker, .3), row('DeepSeek-V4.1-Flash', .1), row(draft || (occupied ? 'existing draft' : '输入消息'), .75)] };
    if (op === 'type') { draft = payload.text; if (typeFails) throw new Error('type acknowledgement lost'); }
    if (op === 'key') { submissions++; if (sendFails) throw new Error('send acknowledgement lost'); }
    return {};
  }, async cancel() {} };
  let planCalls = 0;
  const desktop = new DesktopService({ native, persist: async task => journal.push(structuredClone(task)),
    strategies: { preferVisual: async () => false, record: async (_, value) => outcomes.push(value) },
    planner: async () => ++planCalls === 1 ? { action: 'type', text: 'placeholder', focus: { x: .5, y: .8 } } : { action: 'key', key: 'enter', purpose: 'submit' },
    observeWorkBuddy: async () => ({ taskId: 4, messageKey: 'old', sessionId: 's1', status: 'ok' }) });
  desktop.task = { id: 'visual-test', target: 'workbuddy', goal: 'test', scene: 'life', domain: 'life', visibilityFloor: 1,
    associationMarker: marker, sessionId: 's1', monitorTaskId: 4, monitorMessageKey: 'old', workModel: 'deepseek-v4.1-flash',
    handoffSent: true, followUpRound: 0, status: 'review', steps: [], submittedAt: Date.now() - 5000 };
  desktop.ensureWorkBuddyMonitor = async () => true;
  const result = await desktop.followUp({ text: '补充数据' });
  return { result, desktop, calls, journal, outcomes, submissions };
}
(async () => {
  const ok = await scenario();
  assert.equal(ok.result.ok, true, ok.result.error);
  assert.deepEqual(ok.calls.filter(x => ['workbuddyInspect', 'capture', 'click', 'type', 'key'].includes(x)), ['workbuddyInspect', 'workbuddyInspect', 'capture', 'click', 'type', 'capture', 'workbuddyInspect', 'key']);
  assert.equal(ok.submissions, 1);
  assert.equal(ok.desktop.task.previousMonitorMessageKey, 'old');
  assert(ok.journal.some(t => t.followUpPending?.state === 'unknown' && t.followUpRound === 1));
  assert.deepEqual(ok.outcomes, ['failed']);
  const unreadable=await scenario({readbackFails:true});assert.equal(unreadable.result.ok,false);assert.equal(unreadable.submissions,0);assert.equal(unreadable.desktop.task.followUpPending.state,'draft-unknown');
  const occupied = await scenario({ occupied: true });
  assert.equal(occupied.result.ok, false); assert(!occupied.calls.includes('type'));
  const unknown = await scenario({ typeFails: true });
  assert.equal(unknown.result.ok, false); assert.equal(unknown.submissions, 0);
  assert.equal(unknown.desktop.task.followUpPending.state, 'draft-unknown');
  assert.equal((await unknown.desktop.followUp({ text: '再试一次' })).ok, false);
  assert.equal(unknown.calls.filter(x => x === 'capture').length, 2);
  const send = await scenario({ sendFails: true });
  assert.equal(send.result.ok, false); assert.equal(send.submissions, 1);
  assert.equal(send.desktop.task.followUpPending.state, 'unknown');
  assert.equal((await send.desktop.followUp({ text: '再试一次' })).ok, false);
  console.log('Visual recovery checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
