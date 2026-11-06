'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { approveInput } = require('../src/main/wechat-conversation-input');
const { DesktopService } = require('../src/main/desktop-service');

const box = (x, y, width, height) => ({ x, y, width, height });
const ocr = (text, x, y, width = .08) => ({ text, ...box(x, y, width, .018), confidence: .99 });
const heading = ocr('Fixture contact', .37, .04);
const task = { recipient: 'Fixture contact', operation: 'send', message: 'Test reply' };
const snapshot = (revision, ...rows) => ({ revision, ocr: [heading, ...rows] });
const review = (kind, region, location) => async kinds => {
  assert(kinds.includes(kind));
  return { kind, box: region, location };
};
const denied = { code: 'E_WECHAT_CONVERSATION_INPUT', dispatched: false };

test('the conversation guard checks the actual UI target and denies links disguised as navigation or submission', async () => {
  const shot = snapshot(1, ocr('Fixture contact', .15, .24), ocr('发送', .65, .5), ocr('发送', .88, .92));
  const open = await approveInput({ action: { action: 'click', x: .2, y: .25 }, task, shot, review: review('contact', box(.13, .22, .16, .05)) });
  assert.equal(open.action.x, .19);
  await assert.rejects(approveInput({ action: { action: 'click', x: .7, y: .51 }, task, shot, review: review('contact', box(.13, .22, .16, .05)) }), denied);
  await assert.rejects(approveInput({ action: { action: 'click', purpose: 'submit', x: .7, y: .51 }, task, shot, review: review('send', box(.63, .48, .15, .06)) }), denied);
  await assert.rejects(approveInput({ action: { action: 'key', key: 'enter', modifiers: [] }, task, shot, review: async () => assert.fail() }), denied);
  await assert.rejects(approveInput({ action: { action: 'click', button: 'right', x: .6, y: .4 }, task, shot, review: async () => assert.fail() }), denied);
  const reply = await approveInput({ action: { action: 'type', purpose: 'task', text: task.message, focus: { x: .6, y: .5 } },
    task, shot, review: review('composer', box(.4, .72, .42, .12)) });
  assert(reply.action.focus.y > .72, 'typing uses the verified editor instead of a supplied bubble coordinate');
  const send = await approveInput({ action: { action: 'key', key: 'enter', purpose: 'submit', modifiers: [] },
    task, shot, review: review('send', box(.86, .90, .12, .07)) });
  assert.equal(send.action.action, 'click');
  assert(send.action.y > .9);
});

test('transcription accepts only a new menu and its native transcription item', async () => {
  const voice = { ...task, operation: 'read', readRequest: { kind: 'voice-transcript', sequence: 12 } };
  const before = snapshot(1);
  const right = await approveInput({ task: voice, shot: before, action: { action: 'click', button: 'right', x: .5, y: .33 },
    review: review('voice', box(.43, .30, .16, .08)) });
  assert.equal(right.next, 'menu');
  const state = { stage: right.next, revision: before.revision, shot: before };
  const action = { action: 'click', x: .57, y: .41 };
  const verifyMenu = review('transcribe', box(.52, .39, .16, .045));
  await assert.rejects(approveInput({ action, task: voice, shot: before, state, review: verifyMenu }), denied);
  await assert.rejects(approveInput({ action, task: voice, shot: snapshot(2, ocr('识别图中二维码', .53, .4)), state, review: verifyMenu }), denied);
  const convert = await approveInput({ action, task: voice, shot: snapshot(2, ocr('转文字', .53, .4)), state, review: verifyMenu });
  assert.equal(convert.menu, true);
  assert.equal(convert.next, null);
});

test('file reception follows a checked menu and a host-chosen save location', async () => {
  const directory = '/private/tmp/wb-fixture';
  const file = { ...task, operation: 'read', readRequest: { kind: 'attachment-save', fileName: 'notes.txt', destination: { directory } } };
  const before = snapshot(1, ocr('notes.txt', .45, .32));
  const right = await approveInput({ action: { action: 'click', button: 'right', x: .49, y: .33 },
    task: file, shot: before, review: review('file', box(.42, .30, .21, .08)) });
  assert.equal(right.next, 'menu');
  const menu = snapshot(2, ocr('另存为…', .53, .4));
  const saveAs = await approveInput({ action: { action: 'click', x: .57, y: .41 }, task: file,
    shot: menu, state: { stage: right.next, revision: before.revision, shot: before }, review: review('saveAs', box(.52, .39, .16, .045)) });
  assert.equal(saveAs.next, 'saveDialog');
  const dialog = snapshot(3, ocr('存储为：', .3, .25), ocr('取消', .45, .7), ocr('保存', .60, .7));
  const go = await approveInput({ action: { action: 'key', key: 'g', modifiers: ['cmd', 'shift'] }, task: file,
    shot: dialog, state: { stage: saveAs.next, revision: menu.revision }, review: review('saveDialog', box(.38, .25, .24, .04)) });
  const folder = snapshot(4, ocr('前往文件夹：', .33, .3));
  const type = await approveInput({ action: { action: 'type', purpose: 'file-path', text: '/other' }, task: file,
    shot: folder, state: { stage: go.next, revision: dialog.revision }, review: review('folderField', box(.35, .36, .3, .05)) });
  assert.equal(type.action.text, directory);
  const enter = await approveInput({ action: { action: 'key', key: 'enter', modifiers: [] }, task: file,
    shot: snapshot(5, ...folder.ocr.slice(1), ocr(directory, .37, .43, .2)),
    state: { stage: type.next, revision: folder.revision }, review: review('folderChoice', box(.36, .41, .3, .06), box(.36, .41, .3, .06)) });
  assert.equal(enter.next, 'destination');
  const save = { action: 'click', x: .64, y: .71 };
  const saveReview = review('save', box(.59, .68, .1, .05), box(.35, .42, .2, .06));
  await assert.rejects(approveInput({ action: save, task: file, shot: { ...dialog, revision: 6 },
    state: { stage: enter.next, revision: 5 }, review: saveReview }), denied);
  const saved = await approveInput({ action: save, task: file, shot: snapshot(6, ...dialog.ocr.slice(1), ocr('wb-fixture', .39, .44)),
    state: { stage: enter.next, revision: 5 }, review: saveReview });
  assert.equal(saved.next, 'submitted');
});

test('native dispatch rejects a fabricated menu in the chat and rechecks the grant after observation', async () => {
  const rect = { x: 0, y: 0, width: 800, height: 600 };
  const bundleId = 'com.tencent.xinWeChat';
  const root = { pid: 20, windowId: 30, bundleId, rect };
  const popup = { ...root, windowId: 31, rect: { x: 400, y: 200, width: 180, height: 100 } };
  const effects = [];
  let menuVisible = false, revokeOnCapture = false, current = true;
  const service = new DesktopService({
    bitmap: () => ({ width: 100, height: 100, data: Buffer.alloc(40000) }),
    native: { request: async (name, input) => {
      if (name === 'frontmost') return { application: root, windows: menuVisible ? [popup, root] : [root] };
      if (name === 'capture') {
        if (revokeOnCapture) current = false;
        return { backend: 'CGDisplayStream', desktopRect: rect, pngBase64: 'YQ==', capturedAt: Date.now() };
      }
      effects.push({ name, input });
      return { performed: true };
    } },
    sensitivePolicy: { checkChannel: () => { if (!current) throw require('../src/main/dialogue-channels').stale(); } },
  });
  service.task = { scene: 'life', domain: 'life', visibilityFloor: 1, recipient: task.recipient, channelConversation: true, channelAuthorization: { account: '20:30', scene: 'life' } };
  service.running = true;
  service.generation = 1;
  service.conversationInputState = { windows: [30] };
  const shot = { ...snapshot(2, ocr('转文字', .54, .4)), sourcePixels: Buffer.from('a'), at: Date.now(), rect, sceneWindows: [root, popup] };
  const action = { action: 'click', x: .58, y: .41 };
  const approval = { action, shot, target: box(.54, .4, .08, .018), related: [heading], menu: true, next: null };
  service.screenshot = shot;
  await assert.rejects(service.act(action, root, shot, 1), denied);
  await assert.rejects(service.act(action, root, shot, 1, { approval }), denied);
  menuVisible = true;
  revokeOnCapture = true;
  await assert.rejects(service.act(action, root, shot, 1, { approval }), { code: 'E_CHANNEL_CHANGED' });
  assert.deepEqual(effects, []);
  current = true;
  revokeOnCapture = false;
  await service.act(action, root, shot, 1, { approval });
  assert.equal(effects[0].input.windowId, 31);
});

test('the normal reply executor rejects a message-area click and continues with a scoped reply', async () => {
  const rect = { x: 0, y: 0, width: 800, height: 600 };
  const window = { pid: 20, windowId: 30, bundleId: 'com.tencent.xinWeChat', layer: 0, rect };
  const inputs = [];
  let step = 0, draft = false, sent = false;
  const service = new DesktopService({
    native: { request: async (name, input) => {
      if (name === 'frontmost') return { application: window, windows: [window] };
      if (name === 'capture') return { backend: 'CGDisplayStream', desktopRect: rect, pngBase64: 'YQ==', capturedAt: Date.now() };
      if (name === 'activate') return { activated: true };
      inputs.push({ name, input });
      if (name === 'type') draft = true;
      if (name === 'click' && input.y > 540) sent = true;
      return { performed: true };
    } },
    planner: async () => {
      if (++step === 1) return { action: 'click', x: .6, y: .4 };
      if (step === 2) return { action: 'type', text: 'Different model text', then: [{ action: 'key', key: 'enter', purpose: 'submit' }] };
      assert(sent);
      return { action: 'done', completed: true, evidence: 'Confirmed the new reply', receipt: { observed: 'delivered', basis: 'New reply visible' } };
    },
    modelRequest: async options => {
      const { allowed } = JSON.parse(options.messages.at(-1).content[0].text);
      if (allowed.composer) return { text: JSON.stringify({ kind: 'composer', box: box(.4, .72, .42, .12) }) };
      assert(allowed.send);
      return { text: JSON.stringify({ kind: 'send', box: box(.86, .90, .12, .07) }) };
    },
    bitmap: () => ({ width: 100, height: 100, data: Buffer.alloc(40000) }),
  });
  service.task = { ...task, id: 'managed-reply', channelConversation: true, channelAuthorization: { account: '20:30', scene: 'life' },
    scene: 'life', domain: 'life', visibilityFloor: 1, target: 'wechat', goal: 'Reply', steps: [], workModel: 'hy3', startedAt: Date.now() };
  service.running = true;
  service.generation = 1;
  service.controller = new AbortController();
  let revision = 0;
  service.capture = async () => service.screenshot = {
    ...snapshot(++revision, ocr('发送', .88, .92), ...(draft ? [ocr(task.message, .46, .78)] : [])),
    sourcePixels: Buffer.from('a'), at: Date.now(), rect, preview: 'data:image/png;base64,YQ==',
  };
  await service.runOwned(1, { ...service.task });
  assert.equal(service.task.sendState, 'confirmed');
  assert.deepEqual(inputs.map(input => input.name), ['click', 'type', 'click']);
  assert.equal(inputs[1].input.text, task.message);
  assert(inputs[0].input.y > 400);
});
