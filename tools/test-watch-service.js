'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const { WatchService, incomingDelta } = require('../src/main/watch-service');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeJournal(log = []) {
  const watches = new Map(), events = new Map(), receipts = new Map();
  return {
    watches, events, receipts, log,
    eventId(watchId, identity) { return 'event-' + crypto.createHash('sha256').update(`${watchId}\0${identity}`).digest('hex'); },
    async saveWatch(watch) {
      log.push(['saveWatch', watch.id, watch.status, watch.pendingSend || null]);
      watches.set(watch.id, structuredClone(watch));
      return watches.get(watch.id);
    },
    async listWatches() { return [...watches.values()].map(w => structuredClone(w)); },
    async saveEvent(watch, event) {
      assert.equal(event.id, this.eventId(watch.id, event.identityString), 'service must pass identityString with every event');
      const current = events.get(event.id) || {};
      const value = { ...current, ...structuredClone(event), taskType: 'watch-event', watchId: watch.id,
        privacyEpoch: watch.privacyEpoch, sources: [watch.id] };
      delete value.identityString;
      events.set(event.id, value); log.push(['saveEvent', event.id, event.phase, event.reportStatus || null]);
      return structuredClone(value);
    },
    async getEvent(id) { const value = events.get(id); return value ? structuredClone(value) : null; },
    async receipt(event, text) {
      assert(events.has(event.id), 'receipt must reference a persisted event');
      const old = receipts.get(event.id);
      if (old && old.text !== text) throw new Error('receipt id collision');
      const inserted = !old;
      if (!old) receipts.set(event.id, { id: 'receipt-' + event.id, text, sources: [event.id] });
      log.push(['receipt', event.id, inserted]);
      return { record: structuredClone(receipts.get(event.id)), inserted };
    },
  };
}

function makeHarness({ mode = 'notify', clock = () => 1000, epoch = () => 9, ready = () => true,
  frames = [], views = [], execute, propose, canOperate, report } = {}) {
  const log = [], journal = makeJournal(log), sensor = {
    samples: 0, commits: 0, forgets: 0, closes: 0,
    async sample(w, options) { this.samples++; log.push(['sample', options.reset]); return frames.shift() || { changed: false, baseline: false }; },
    async commit() { this.commits++; log.push(['commit']); },
    async forget() { this.forgets++; log.push(['forget']); },
    async close() { this.closes++; },
  };
  const reports = [], executions = [], proposals = [];
  const svc = new WatchService({ journal, sensor, clock, epoch, ready, autoSchedule: false,
    canOperate: canOperate || (async () => true),
    inspect: async () => { log.push(['inspect']); return views.shift() || { headerMatched: true, messages: [] }; },
    execute: async (watch, request) => { executions.push(request); log.push(['execute', request.operation]); return execute ? execute(watch, request) : { ok: true }; },
    propose: async (watch, message, signal) => { proposals.push({ watch, message, signal }); log.push(['propose', message.text]); return propose ? propose(watch, message, signal) : { reply: null }; },
    report: async item => { reports.push(item); log.push(['report', item.eventId]); return report ? report(item) : undefined; },
  });
  return { svc, journal, sensor, log, reports, executions, proposals };
}

async function start(h, options = {}) {
  const result = await h.svc.start({ recipient: '合成联系人', goal: '关注新消息并汇报', criteria: '',
    watch: { mode: options.mode || 'notify', policy: '只处理普通事务', ...(options.durationMinutes === undefined ? {} : { durationMinutes: options.durationMinutes }) },
    sources: ['source-message-id'] });
  assert(result.ok, result.error);
  return h.svc.items.get(result.id);
}

const incoming = (key, text, time = '10:00') => ({ key, text, time, direction: 'incoming' });
const frame = (extra = {}) => ({ changed: true, baseline: false, geometryChanged: false, ...extra });

async function testEmptyBaselineAndNoChange() {
  const h = makeHarness({ frames: [frame({ baseline: true }), { changed: false, baseline: false }, frame()],
    views: [{ headerMatched: true, messages: [] }, { headerMatched: true, messages: [incoming('m1', '你好')] }] });
  const w = await start(h);
  await h.svc.tick(w.id);
  assert.equal(h.svc.items.get(w.id).baselineReady, true, 'an empty conversation establishes a durable baseline once');
  await h.svc.tick(w.id);
  assert.equal(h.sensor.samples, 2);
  assert.equal(h.log.filter(row => row[0] === 'inspect').length, 1, 'unchanged frame skips inspect');
  await h.svc.tick(w.id);
  assert.equal(h.reports.length, 1, 'message arriving after an empty baseline is treated as new');
  assert.equal(h.reports[0].sources.length, 1);
  assert.equal(h.reports[0].eventId, [...h.journal.events.keys()][0]);
}

async function testMultiMessageAndStableDedupe() {
  const h = makeHarness({ frames: [frame({ baseline: true }), frame(), frame()], views: [
    { headerMatched: true, messages: [incoming('old', '较早消息', '09:00')] },
    { headerMatched: true, messages: [incoming('old', '较早消息', '09:00'), incoming('new-a', '第一条', '10:01'), incoming('new-b', '第二条', '10:02')] },
    { headerMatched: true, messages: [incoming('old', '较早消息', '09:00'), incoming('new-a', '第一条', '10:01'), incoming('new-b', '第二条', '10:02')] },
  ] });
  const w = await start(h);
  await h.svc.tick(w.id); await h.svc.tick(w.id); await h.svc.tick(w.id);
  assert.equal(h.reports.length, 2, 'multiple incoming messages are handled individually, identical next poll is deduped');
  assert.equal(h.journal.events.size, 2);
  assert.deepEqual([...h.journal.events.values()].map(event => event.phase), ['observed', 'observed']);
  assert(h.journal.log.some(row => row[0] === 'commit'), 'baseline and durable event checkpoint precede sensor commit');
}

async function testNotifyPolicyAndCompletion() {
  const h = makeHarness({ mode: 'notify', frames: [frame({ baseline: true }), frame(), frame()], views: [
    { headerMatched: true, messages: [] },
    { headerMatched: true, messages: [incoming('n1', '闲聊', '10:01')] },
    { headerMatched: true, messages: [incoming('n1', '闲聊', '10:01'), incoming('n2', '会议时间变了', '10:02')] },
  ], propose: async (_watch, message) => message.text.includes('会议')
    ? { notify: true, reply: '不能发送', complete: true, note: '会议变更' }
    : { notify: false, reply: '', complete: false, note: '不符合通知条件' } });
  const w = await start(h); h.svc.items.get(w.id).completion = 'first_match';
  await h.svc.tick(w.id); await h.svc.tick(w.id); await h.svc.tick(w.id);
  assert.equal(h.proposals.length, 2, 'notify mode evaluates policy only for new text events');
  assert.equal(h.reports.length, 1, 'notify=false suppresses the nonmatching event');
  assert.equal(h.executions.filter(x => x.operation === 'send').length, 0, 'notify mode never sends even if proposer returns reply text');
  assert.equal(h.svc.items.get(w.id).status, 'expired', 'complete=true ends after successful owner notification');
  assert.equal(h.svc.items.get(w.id).note, '已满足本次关注的完成条件');
  assert([...h.journal.events.values()].some(event => event.phase === 'filtered'));
}

async function testCompletionOutboxRecovery() {
  const delivery = deferred();
  const h = makeHarness({ frames: [frame({ baseline: true }), frame()], views: [
    { headerMatched: true, messages: [] }, { headerMatched: true, messages: [incoming('done-event', '等到确认后结束')] },
  ], propose: async () => ({ notify: true, complete: true }), report: () => delivery.promise });
  const w = await start(h); h.svc.items.get(w.id).completion = 'first_match'; await h.svc.tick(w.id);
  const activeTick = h.svc.tick(w.id);
  while (!h.reports.length) await new Promise(resolve => setTimeout(resolve, 0));
  const savedWatch = structuredClone(h.journal.watches.get(w.id));
  const [savedEventId, savedEvent] = [...h.journal.events.entries()][0];
  assert.equal(savedWatch.pendingCompletionEventId, savedEventId, 'completion intent is durable before report delivery');
  h.svc.invalidate();
  delivery.resolve(); await activeTick;

  const restored = makeHarness();
  restored.journal.watches.set(w.id, savedWatch);
  restored.journal.events.set(savedEventId, structuredClone(savedEvent));
  restored.journal.receipts.set(savedEventId, structuredClone(h.journal.receipts.get(savedEventId)));
  await restored.svc.restore();
  assert.equal(restored.svc.items.get(w.id).status, 'expired', 'recovered successful report completes the persistent task');
  assert.equal(restored.sensor.samples, 0);
  assert.equal(restored.executions.length, 0);
}

function testDeltaAmbiguity() {
  assert.deepEqual(incomingDelta([], [incoming('x', 'same')], false), { messages: [], baseline: true });
  assert.deepEqual(incomingDelta([], [incoming('x', 'same')], true).messages.map(m => m.key), ['x']);
  const repeated = incomingDelta(['x'], [incoming('x', 'same'), incoming('x', 'same')], true);
  assert.equal(repeated.uncertain, true, 'ambiguous repeated text is not silently treated as a new message');
  assert.equal(repeated.messages.length, 0);
  assert.deepEqual(incomingDelta(['a'], [incoming('a', 'a'), incoming('b', 'b'), incoming('c', 'c')], true).messages.map(m => m.key), ['b', 'c']);
  assert.equal(incomingDelta(['old'], [incoming('unrelated', 'text')], true).uncertain, true);
}

async function testGeometryChangeIsNotMessage() {
  const h = makeHarness({ frames: [frame({ baseline: true }), frame({ geometryChanged: true })],
    views: [{ headerMatched: true, messages: [incoming('old', '基线消息')] }] });
  const w = await start(h);
  await h.svc.tick(w.id); await h.svc.tick(w.id);
  assert.equal(h.log.filter(row => row[0] === 'inspect').length, 1, 'layout change resets baseline without OCR/model inspection');
  assert.equal(h.reports.length, 0);
  assert.equal(h.svc.items.get(w.id).baselineReady, false);
}

async function testUnstableFrameAndNonTextMessages() {
  const h = makeHarness({ mode: 'reply', frames: [frame({ baseline: true }), { changed: false, baseline: false, unstable: true }, frame()], views: [
    { headerMatched: true, messages: [] }, { headerMatched: true, messages: [
      { direction: 'incoming', kind: 'voice', text: '[语音消息]', time: '10:01' },
    ] },
  ], propose: async () => ({ reply: '不应调用' }) });
  const w = await start(h, { mode: 'reply' });
  await h.svc.tick(w.id); await h.svc.tick(w.id);
  assert.equal(h.log.filter(row => row[0] === 'inspect').length, 1, 'unstable sample skips inspection');
  assert.equal(h.sensor.commits, 1, 'unstable sample does not advance beyond the initial baseline cursor');
  assert.match(h.svc.items.get(w.id).note, /仍在变化/);
  await h.svc.tick(w.id);
  assert.equal(h.proposals.length, 0, 'voice messages do not enter reply proposal');
  assert.equal(h.executions.filter(x => x.operation === 'send').length, 0);
  assert.equal(h.reports.length, 1);
  assert.match(h.reports[0].text, /语音消息/);
  assert(!h.reports[0].text.includes('[语音消息]'), 'report labels the message kind without inventing or quoting its contents');
}

async function testPersistedEventPreventsReproposal() {
  const h = makeHarness({ mode: 'reply', frames: [frame({ baseline: true }), frame(), frame()], views: [
    { headerMatched: true, messages: [] }, { headerMatched: true, messages: [incoming('m1', '帮我确认时间')] },
    { headerMatched: true, messages: [incoming('m1', '帮我确认时间')] },
  ], propose: async () => ({ reply: null, note: '需要用户判断' }) });
  const w = await start(h, { mode: 'reply' });
  await h.svc.tick(w.id);
  // Keep the real fake journal method, but simulate a crash after its first durable event write.
  let throwAfterWrite = true;
  const original = h.journal.saveEvent.bind(h.journal);
  h.journal.saveEvent = async (watch, event) => {
    const result = await original(watch, event);
    if (throwAfterWrite && event.phase === 'observed') { throwAfterWrite = false; throw new Error('simulated interruption after event commit'); }
    return result;
  };
  await h.svc.tick(w.id);
  assert.equal(h.journal.events.size, 1, 'event durable before interruption');
  await h.svc.tick(w.id);
  assert.equal(h.proposals.length, 0, 'same detected event is not proposed again after durable event ID exists');
  assert.equal(h.journal.events.size, 1);
}

async function testUnknownSendAndPendingRestore() {
  const h = makeHarness({ mode: 'reply', frames: [frame({ baseline: true }), frame()], views: [
    { headerMatched: true, messages: [] }, { headerMatched: true, messages: [incoming('m1', '几点出发？')] },
  ], propose: async () => ({ reply: '我确认后回复你。' }), execute: async (_w, req) => req.operation === 'send' ? { ok: false } : { ok: true } });
  const w = await start(h, { mode: 'reply' });
  await h.svc.tick(w.id); await h.svc.tick(w.id);
  const paused = h.svc.items.get(w.id);
  assert.equal(paused.status, 'paused');
  assert(paused.pendingSend, 'uncertain send anchor remains persisted');
  assert.equal(h.reports.length, 1, 'paused unknown send still produces owner report');
  const event = h.journal.events.get(paused.pendingSend);
  assert.equal(event.phase, 'send_unknown', 'report delivery does not overwrite send phase');
  assert.equal(event.reportStatus, 'reported');
  assert.match((await h.svc.control('resume', { id: w.id })).error, /不会自动重发/);

  const restored = makeHarness({ epoch: () => 9 });
  const interruptedBeforeReport = structuredClone(paused); delete interruptedBeforeReport.pendingSendReported;
  restored.journal.watches.set(w.id, interruptedBeforeReport);
  restored.journal.events.set(event.id, structuredClone(event));
  await restored.svc.restore();
  const afterRestart = restored.svc.items.get(w.id);
  assert.equal(afterRestart.status, 'paused');
  assert.equal(afterRestart.pendingSend, paused.pendingSend, 'restore preserves pending send anchor');
  assert.equal(restored.sensor.samples, 0);
  assert.equal(restored.executions.length, 0, 'restore never resumes or replays send');
  assert.equal(restored.reports.length, 1, 'restored unknown send is reported');
  await restored.svc.restore();
  assert.equal(restored.reports.length, 1, 'successful unknown-send report is not repeated on another restore');

  const crashBetweenEventAndWatchWrite = makeHarness({ epoch: () => 9 });
  const rootWithOnlyEventLink = structuredClone(paused);
  delete rootWithOnlyEventLink.pendingSend; delete rootWithOnlyEventLink.pendingSendReported; delete rootWithOnlyEventLink.userInterventionAt;
  rootWithOnlyEventLink.pendingEventIds = [event.id]; rootWithOnlyEventLink.status = 'active';
  crashBetweenEventAndWatchWrite.journal.watches.set(w.id, rootWithOnlyEventLink);
  crashBetweenEventAndWatchWrite.journal.events.set(event.id, { ...structuredClone(event), phase: 'send_pending' });
  await crashBetweenEventAndWatchWrite.svc.restore();
  assert.equal(crashBetweenEventAndWatchWrite.svc.items.get(w.id).status, 'paused');
  assert.equal(crashBetweenEventAndWatchWrite.svc.items.get(w.id).pendingSend, event.id,
    'restore reconstructs the unknown-send anchor from the event if root checkpoint was interrupted');
  assert.equal(crashBetweenEventAndWatchWrite.executions.length, 0);
}

async function testPauseDuringOpenAndPropose() {
  const opening = deferred();
  const h = makeHarness({ execute: async (_w, req) => req.operation === 'open' ? opening.promise : { ok: true },
    frames: [frame({ baseline: true })], views: [{ headerMatched: true, messages: [] }] });
  const w = await start(h);
  const ticking = h.svc.tick(w.id);
  while (!h.executions.length) await new Promise(resolve => setTimeout(resolve, 0));
  await h.svc.control('pause', { id: w.id });
  assert.equal(h.svc.items.get(w.id).status, 'paused');
  const samplesBefore = h.sensor.samples;
  const resumed = await h.svc.control('resume', { id: w.id });
  assert.equal(resumed.ok, true);
  opening.resolve({ ok: true }); await ticking;
  assert.equal(h.sensor.samples, samplesBefore, 'late open completion cannot continue into screenshot after pause');
  assert.equal(h.svc.items.get(w.id).status, 'waiting', 'old finally cannot overwrite the new resume state');

  const proposing = deferred();
  const second = makeHarness({ mode: 'reply', frames: [frame({ baseline: true }), frame()], views: [
    { headerMatched: true, messages: [] }, { headerMatched: true, messages: [incoming('p1', '要不要现在出发？')] },
  ], propose: () => proposing.promise });
  const w2 = await start(second, { mode: 'reply' }); await second.svc.tick(w2.id);
  const waiting = second.svc.tick(w2.id);
  while (!second.proposals.length) await new Promise(resolve => setTimeout(resolve, 0));
  await second.svc.control('pause', { id: w2.id });
  proposing.resolve({ reply: '现在出发。' }); await waiting;
  assert.equal(second.executions.filter(x => x.operation === 'send').length, 0, 'late proposal cannot send after pause');
  assert.equal(second.svc.items.get(w2.id).status, 'paused');
  assert.equal(second.reports.length, 0, 'explicit pause suppresses stale-event reporting');
}

async function testPauseWhileCheckingIdleGuard() {
  const idle = deferred();
  let idleCalled = false;
  const h = makeHarness({ canOperate: () => { idleCalled = true; return idle.promise; } });
  const w = await start(h);
  const tick = h.svc.tick(w.id);
  while (!idleCalled) await new Promise(resolve => setTimeout(resolve, 0));
  await h.svc.control('pause', { id: w.id });
  idle.resolve(true); await tick;
  assert.equal(h.executions.length, 0, 'late idle approval cannot open the chat after pause');
  assert.equal(h.svc.items.get(w.id).status, 'paused');
}

async function testPauseDuringSendNeverReportsOrReplays() {
  const sending = deferred();
  const h = makeHarness({ mode: 'reply', frames: [frame({ baseline: true }), frame()], views: [
    { headerMatched: true, messages: [] }, { headerMatched: true, messages: [incoming('s1', '请回复')] },
  ], propose: async () => ({ reply: '已收到。' }), execute: async (_w, req) => req.operation === 'send' ? sending.promise : { ok: true } });
  const w = await start(h, { mode: 'reply' }); await h.svc.tick(w.id);
  const tick = h.svc.tick(w.id);
  while (!h.executions.some(x => x.operation === 'send')) await new Promise(resolve => setTimeout(resolve, 0));
  const pendingId = h.svc.items.get(w.id).pendingSend;
  assert(pendingId, 'send intent is durable before execute is called');
  await h.svc.control('stop', { id: w.id });
  sending.resolve({ ok: true }); await tick;
  assert.equal(h.svc.items.get(w.id).status, 'stopped');
  assert.equal(h.svc.items.get(w.id).pendingSend, pendingId, 'stop preserves the unresolved send anchor');
  assert.equal(h.reports.length, 0, 'user stop suppresses reports from the in-flight old event');
  assert.equal(h.executions.filter(x => x.operation === 'send').length, 1, 'late completion is never replayed');
  const restored = makeHarness();
  restored.journal.watches.set(w.id, structuredClone(h.svc.items.get(w.id)));
  restored.journal.events.set(pendingId, structuredClone(h.journal.events.get(pendingId)));
  await restored.svc.restore();
  assert.equal(restored.svc.items.get(w.id).status, 'stopped', 'restart retains explicit user stop');
  assert.equal(restored.svc.items.get(w.id).pendingSend, pendingId);
  assert.equal(restored.reports.length, 0, 'restart does not report old event after user stop');
}

async function testEpochInvalidationAndWindowSwitch() {
  let generation = 9;
  const proposing = deferred();
  const h = makeHarness({ mode: 'reply', epoch: () => generation, frames: [frame({ baseline: true }), frame()], views: [
    { headerMatched: true, messages: [] }, { headerMatched: true, messages: [incoming('e1', '几点见？')] },
  ], propose: () => proposing.promise });
  const w = await start(h, { mode: 'reply' }); await h.svc.tick(w.id);
  const tick = h.svc.tick(w.id);
  while (!h.proposals.length) await new Promise(resolve => setTimeout(resolve, 0));
  const writeCount = h.log.filter(row => row[0] === 'saveWatch').length;
  generation++;
  proposing.resolve({ reply: '下午见。' }); await tick;
  assert.equal(h.executions.filter(x => x.operation === 'send').length, 0);
  assert.equal(h.log.filter(row => row[0] === 'saveWatch').length, writeCount, 'stale epoch performs no write after awaited proposal');

  const switched = makeHarness({ frames: [frame({ changed: false, windowChanged: true })], views: [] });
  const w2 = await start(switched); await switched.svc.tick(w2.id);
  assert.equal(switched.log.filter(row => row[0] === 'inspect').length, 0, 'window change is not sent to inspection');
  assert.equal(switched.reports.length, 0);
}

async function testExpirationAndDeltaReports() {
  let now = 1000;
  const h = makeHarness({ clock: () => now, frames: [frame({ baseline: true })], views: [{ headerMatched: true, messages: [] }] });
  const w = await start(h, { durationMinutes: 1 }); await h.svc.tick(w.id);
  now += 60001; await h.svc.tick(w.id);
  assert.equal(h.svc.items.get(w.id).status, 'expired');
  assert.equal(h.sensor.samples, 1, 'expired tasks are not sampled again');

  const invalid = makeHarness();
  assert.equal((await invalid.svc.start({ recipient: 'x', goal: 'watch', watch: { mode: 'notify', policy: 'notify', durationMinutes: NaN }, sources: ['s'] })).ok, false);
}

async function main() {
  await testEmptyBaselineAndNoChange();
  await testMultiMessageAndStableDedupe();
  await testNotifyPolicyAndCompletion();
  await testCompletionOutboxRecovery();
  testDeltaAmbiguity();
  await testGeometryChangeIsNotMessage();
  await testUnstableFrameAndNonTextMessages();
  await testPersistedEventPreventsReproposal();
  await testUnknownSendAndPendingRestore();
  await testPauseDuringOpenAndPropose();
  await testPauseWhileCheckingIdleGuard();
  await testPauseDuringSendNeverReportsOrReplays();
  await testEpochInvalidationAndWindowSwitch();
  await testExpirationAndDeltaReports();
  console.log('WatchService state-machine checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
