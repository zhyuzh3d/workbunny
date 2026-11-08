'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractResultLinks, resultLinkCandidates, normalizeResultLinks, selectResultLinks, resultLinks, validResultURL } = require('../src/main/result-links');
const { workResult, deliveryText } = require('../src/main/task-result');
const { deliverResult } = require('../src/main/result-delivery');
const { observeWorkBuddy } = require('../src/main/workbuddy-observation');
const { DesktopService } = require('../src/main/desktop-service');
const { verifyDelivery } = require('../src/main/secretary');
const url = 'https://fixture.invalid/game?sharecode=Ab%2b9%2F0&mode=play#start';
const reference = 'https://reference.invalid/manual';
const report = '网页已做好，实际作品入口已返回。';
const final = '作品：[打开游戏](' + url + ')\n参考资料：' + reference;
const model = value => ({ model: 'offline-fixture', response: { text: JSON.stringify(value) } });

test('source extraction preserves complete URL bytes and stable IDs without opening a network connection', () => {
  const links = extractResultLinks(final);
  assert.equal(links.length, 2); assert.equal(links[0].url, url);
  assert.equal(extractResultLinks(url)[0].id, links[0].id);
  assert.equal(normalizeResultLinks([...links, ...links]).length, 2);
  assert.equal(extractResultLinks('https://fixture.invalid/a(b)?q=a%2B#x)')[0].url, 'https://fixture.invalid/a(b)?q=a%2B#x');
  for (const bad of ['javascript:alert(1)', 'file:///tmp/a', 'data:text/html,test', 'https://user:pass@fixture.invalid/', 'https://fixture.invalid/\nnext']) assert.equal(validResultURL(bad), false);
});
test('balanced Markdown presentation is excluded while literal URL bytes remain unchanged',()=>{
 const plain='https://fixture.invalid/game?share=A%2Bb&pattern=a*b#start';
 for(const source of ['**'+plain+'**','***'+plain+'***','__'+plain+'__','_'+plain+'_','*'+plain+'*','~~'+plain+'~~','**分享入口：'+plain+'**','**[打开游戏]('+plain+')**']){
  assert.deepEqual(extractResultLinks(source).map(link=>link.url),[plain],source);
 }
 const literal='https://fixture.invalid/game?glob=**&part=a_b#tail*';
 for(const source of [literal,'`'+literal+'`','[入口]('+literal+')','<'+literal+'>'])assert.deepEqual(extractResultLinks(source).map(link=>link.url),[literal],source);
 const trailing='https://fixture.invalid/game?glob=**';
 assert.equal(extractResultLinks(trailing)[0].url,trailing,'unwrapped legal stars are not trimmed');
 assert.equal(extractResultLinks('`'+trailing+'`')[0].url,trailing,'code content is literal URL data');
 assert.equal(extractResultLinks('**'+plain+'*')[0].url,plain+'*','unbalanced markers do not justify URL rewriting');
});
test('cached malformed candidates are corrected only by matching presentation evidence',()=>{
 const plain='https://fixture.invalid/game?code=Ab%2B#play',wrapped='**'+plain+'**';
 const candidates=resultLinkCandidates([{url:plain+'**',label:'游戏'}],wrapped);
 assert.equal(candidates.length,1);assert.equal(candidates[0].url,plain);assert.equal(candidates[0].id,extractResultLinks(plain)[0].id);assert.equal(candidates[0].label,'游戏');
 assert.equal(resultLinkCandidates([{url:plain+'**'}],plain+'**')[0].url,plain+'**');
});
test('verification can select a presented URL without asking the executor to rewrite Markdown',async()=>{
 const plain='https://fixture.invalid/game?share=Keep%2BThis#play';let calls=0;
 const task={goal:'交付公开网页入口',monitorSessionId:'bound',monitorSummary:'已发布：**'+plain+'**',monitorLinks:[{url:plain+'**'}]};
 const checked=await verifyDelivery({task,request:async options=>{
  calls++;const input=JSON.parse(options.messages[1].content[0].text);assert.equal(input.candidateLinks.length,1);assert.equal(input.candidateLinks[0].url,plain);
  return model({verdict:'pass',report:'已返回成果入口。',linkIds:[input.candidateLinks[0].id]});
 }});assert.equal(calls,1);assert.equal(checked.verdict,'pass');assert.deepEqual(checked.links,[{url:plain}]);assert.equal(checked.followUp,undefined);
});

test('selection uses only source IDs and explicit absence never revives reference URLs', () => {
  const candidates = extractResultLinks(final);
  assert.deepEqual(selectResultLinks(candidates, [candidates[0].id]), [{ url }]);
  assert.deepEqual(selectResultLinks(candidates, []), []);
  assert.throws(() => selectResultLinks(candidates, ['invented']), { code: 'E_RESULT_LINKS' });
  assert.throws(() => selectResultLinks(candidates, [url]), { code: 'E_RESULT_LINKS' });
  assert.deepEqual(resultLinks({ links: [], text: final }), []);
  assert.deepEqual(resultLinks({ text: url }), [{ url }], 'legacy results recover their actual executor-text entry');
  assert.deepEqual(resultLinks({ summary: url }), [], 'a summary alone is not executor evidence');
});

test('the bound full reply retains links before observation and desktop summary truncation', async () => {
  const long = 'x'.repeat(7000) + '\n' + final;
  const monitor = { sessions: new Map([['fixture', { snap: { sessionId: 'session', lastEventAt: 300,
    task: { id: 'row', bunnyTaskId: 'physical', startedAt: 100, endedAt: 300, status: 'ok', summary: long } } }]]) };
  const physical = { id: 'physical', target: 'workbuddy', sessionId: 'session', submittedAt: 90, startedAt: 90, draftInsertedAt: 90 };
  const record = observeWorkBuddy(monitor, physical);
  assert(record); assert.equal(record.summary.length, 6000); assert(!record.summary.includes(url));
  assert(record.links.some(link => link.url === url));
  for (const method of ['tryBindVisualWorkBuddyMonitor', 'monitorWorkBuddy']) {
    const context = { task: { ...physical }, running: true, generation: 1, observeWorkBuddy: async () => record,
      assertLive() {}, journal: async () => {}, update(value) { Object.assign(this.task, value); } };
    assert.equal(await DesktopService.prototype[method].call(context, 1), true);
    assert.equal(context.task.monitorSummary.length, 5900); assert(!context.task.monitorSummary.includes(url));
    assert(context.task.monitorLinks.some(link => link.url === url));
  }
});

test('one existing verification round selects real result IDs even beyond the compacted answer', async () => {
  const candidates = extractResultLinks(final), task = { goal: 'Publish a webpage', userRequest: 'Give me its usable website address',
    monitorSessionId: 'session', monitorSummary: 'x'.repeat(3000) + '\n' + final + '\n' + 'x'.repeat(5000), monitorLinks: candidates };
  let calls = 0;
  const verification = await verifyDelivery({ task, request: async options => {
    calls++; const input = JSON.parse(options.messages[1].content[0].text);
    assert(!input.executorReport.includes(url), 'the selected URL is not dependent on the compacted prose');
    assert.equal(input.candidateLinks[0].url, url);
    assert(options.messages[0].content.includes('不重写网址、不发明链接'));
    return model({ verdict: 'pass', report, linkIds: [input.candidateLinks[0].id] });
  } });
  assert.equal(calls, 1); assert.deepEqual(verification.links, [{ url }]);
  assert.deepEqual(workResult(task, verification).links, [{ url }]);
  await assert.rejects(verifyDelivery({ task, request: async () => model({ verdict: 'pass', report, linkIds: ['invented'] }) }), { code: 'E_RESULT_LINKS' });
  const none = await verifyDelivery({ task, request: async () => model({ verdict: 'pass', report, linkIds: [] }) });
  assert.deepEqual(workResult(task, none).links, []);
  const legacy = await verifyDelivery({ task, request: async () => model({ verdict: 'pass', report }) });
  assert.equal(legacy.links.length, 2, 'older verification output without selection still has its source candidates');
});

test('local and WeChat delivery preserve selected complete URLs while speech stays concise', async () => {
  const result = workResult({ monitorSummary: final }, { report, links: [{ url, label: '游戏' }] });
  const reports = [], local = { state: { result } };
  await deliverResult({ task: local, checkpoint: async () => {}, report: async (...args) => reports.push(args) });
  assert(reports[0][0].includes(url)); assert(!reports[0][0].includes(reference));
  assert.deepEqual(reports[0][2], { links: [{ url, label: '游戏' }], speechText: report });
  assert.equal(local.state.delivery.status, 'queued');
  const sent = [], remote = { delivery: { channel: 'wechat', recipient: 'fixture-owner', includeFiles: false }, state: { result } };
  await deliverResult({ task: remote, checkpoint: async () => {}, call: async action => { sent.push(action); return { receipt: { fixture: true } }; } });
  assert.equal(sent.length, 1); assert(sent[0].args.message.includes(url)); assert(!sent[0].args.message.includes(reference));
  assert.equal(remote.state.delivery.status, 'delivered');
  const noLink = workResult({ monitorSummary: final }, { report, links: [] });
  assert.equal(deliveryText(noLink), report);
});

test('delivery size overflow is explicit and cannot silently truncate a URL or mark it sent', async () => {
  const result = { summary: 'x'.repeat(2990), links: [{ url }] }, task = { delivery: { channel: 'wechat', recipient: 'fixture-owner' }, state: { result } };
  assert.throws(() => deliveryText(result), { code: 'E_RESULT_DELIVERY_SIZE' });
  let sent = false;
  await assert.rejects(deliverResult({ task, checkpoint: async () => {}, call: async () => { sent = true; } }), { code: 'E_RESULT_DELIVERY_SIZE' });
  assert.equal(sent, false); assert.equal(task.state.delivery.status, 'pending');
  assert.deepEqual(resultLinkCandidates([{ url, label: 'Game' }], url).map(link => link.url), [url]);
});
