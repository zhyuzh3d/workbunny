import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountBoperSettings, boperView, cleanBoperError } from '../src/renderer/boper-settings.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.disabled = false; this.open = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
}
globalThis.document = { createElement: tag => new Element(tag) };
const all = root => [root, ...root.children.flatMap(all)];
const find = (root, text) => all(root).find(el => el.textContent === text);
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(initial, scene = 'life') {
  let listener; const calls = []; let currentScene = scene; let control = async () => initial;
  const root = new Element('root');
  const ui = mountBoperSettings(root, { boperStatus: async () => initial, boperControl: action => { calls.push(action); return control(action); }, on: fn => { listener = fn; } }, { getScene: () => currentScene, onChooseScene: () => calls.push('scene') });
  return { root, ui, calls, event: listener, setScene: value => { currentScene = value; ui.refreshView(); }, setControl: fn => { control = fn; } };
}
const ready = { enabled: true, state: 'ready', backend: 'virtual-hid', permissions: { screenCaptureAllowed: true } };

test('first setup, approval and ready expose the appropriate next actions', async () => {
  const f = setup({ enabled: false, state: 'ready' }); await tick();
  assert(find(f.root, '尚未启用虚拟键鼠')); assert(find(f.root, '启用虚拟键鼠')); assert(!find(f.root, '关闭虚拟模式'));
  const waiting = { enabled: true, state: 'faulted', native: { installed: true, helperConnected: true, connected: false }, setupGuide: { approvalPath: ['通用', '驱动扩展'] } };
  f.setControl(async () => waiting); find(f.root, '启用虚拟键鼠').onclick(); await tick();
  assert.deepEqual(f.calls, ['enable']); assert(find(f.root, '打开授权设置')); assert(find(f.root, '我已允许，重新检测')); assert(find(f.root, '授权位置：通用 › 驱动扩展'));
  f.event({ type: 'boper', ...ready }); assert(find(f.root, '已就绪，可以使用')); assert(!find(f.root, '本次输入验证已通过。'));
});

test('fault, installation and update are distinguished without claiming every fault is permission', () => {
  assert.equal(boperView({ enabled: true, state: 'fault', error: { message: 'failure' } }).kind, 'fault');
  assert.equal(boperView({ enabled: true, state: 'install-required', native: { installed: false, updateRequired: true } }).kind, 'install');
  assert.equal(boperView({ enabled: true, state: 'update-required' }).kind, 'update');
  assert.equal(boperView({ enabled: true, state: 'faulted', native: { helperConnected: false } }).kind, 'unavailable');
});

test('verification requires life, disables controls while running, and only reports actual success', async () => {
  const f = setup(ready, 'work'); await tick();
  assert(find(f.root, '开始验证').disabled); find(f.root, '前往场景设置').onclick(); assert.deepEqual(f.calls, ['scene']);
  f.setScene('life'); let finish; f.setControl(() => new Promise(resolve => { finish = resolve; }));
  find(f.root, '开始验证').onclick(); assert(find(f.root, '正在验证输入')); assert(find(f.root, '开始验证').disabled);
  assert(!find(f.root, '本次输入验证已通过。')); finish(ready); await tick();
  assert(find(f.root, '本次输入验证已通过。')); assert.deepEqual(f.calls, ['scene', 'test']);
  f.setScene('work'); assert(find(f.root, '开始验证').disabled);
});

test('Electron error wrappers are removed and failure is shown as expandable detail', async () => {
  assert.equal(cleanBoperError(new Error("Error invoking remote method 'pet:boper-control': Error: 安装失败")), '安装失败');
  const f = setup({ enabled: false, state: 'ready' }); await tick();
  f.setControl(async () => { throw Error("Error invoking remote method 'pet:boper-control': Error: 安装失败"); });
  find(f.root, '启用虚拟键鼠').onclick(); await tick();
  assert(find(f.root, '操作未完成，请查看详情后重试。')); assert(find(f.root, '技术详情')); assert(find(f.root, '安装失败'));
});


test('failed verification does not claim success', async () => {
  const f = setup(ready); await tick();
  f.setControl(async () => { throw Error('验证未完成'); });
  find(f.root, '开始验证').onclick(); await tick();
  assert(find(f.root, '操作未完成，请查看详情后重试。'));
  assert(!find(f.root, '本次输入验证已通过。'));
});

test('guide defaults open before readiness and retains an explicit choice across updates', async () => {
  const f = setup({ enabled: false, state: 'ready' }); await tick();
  const guide = () => all(f.root).find(el => el.tagName === 'details' && el.children[0]?.textContent === '首次使用说明');
  assert.equal(guide().open, true);
  guide().children[0].onclick(); guide().open = false;
  f.event({ type: 'boper', enabled: true, state: 'requires-approval' });
  assert.equal(guide().open, false);
  f.event({ type: 'boper', ...ready }); assert.equal(guide().open, false);
  guide().children[0].onclick(); guide().open = true; f.ui.refreshView();
  assert.equal(guide().open, true);
  const fresh = setup(ready); await tick();
  assert.equal(all(fresh.root).find(el => el.tagName === 'details' && el.children[0]?.textContent === '首次使用说明').open, false);
});

test('each operation displays its own in-progress explanation', async () => {
  for (const [state, label, title, description] of [
    [{ enabled: false, state: 'ready' }, '启用虚拟键鼠', '正在启用虚拟键鼠', '请完成安装及可能出现的 macOS 授权提示。'],
    [ready, '重新检测', '正在重新检测', '请稍候。'],
    [{ enabled: true, state: 'requires-approval' }, '打开授权设置', '正在打开授权设置', '请稍候。'],
    [ready, '关闭虚拟模式', '正在关闭虚拟键鼠', '请稍候。'],
    [ready, '开始验证', '正在验证输入', '请暂停使用键盘和鼠标，验证约需 15 秒。'],
  ]) {
    const f = setup(state); await tick(); let finish;
    f.setControl(() => new Promise(resolve => { finish = resolve; }));
    find(f.root, label).onclick();
    assert(find(f.root, title), title); assert(find(f.root, description), description);
    if (label === '开始验证') assert(!find(f.root, '请完成安装及可能出现的 macOS 授权提示。'));
    finish(state); await tick();
  }
});


test('screen permission is queried only on page activation and validation waits for permission and life', async () => {
  const unknown = { enabled: true, state: 'ready', setupGuide: { screenApprovalPath: '系统设置 → 屏幕录制' } };
  const f = setup(unknown, 'work'); await tick();
  assert.deepEqual(f.calls, []); assert(find(f.root, '开始验证').disabled);
  let allowed = false;
  f.setControl(async action => ({ ...unknown, permissions: { screenCaptureAllowed: allowed } }));
  f.ui.activate(); await tick();
  assert.deepEqual(f.calls, ['permissions']); assert(find(f.root, '未允许'));
  f.ui.activate(); await tick(); assert.deepEqual(f.calls, ['permissions']);
  find(f.root, '允许识别屏幕').onclick(); await tick();
  assert(find(f.root, '仍未允许，请前往系统设置 → 屏幕录制允许 WorkBunny，然后重新检测。'));
  assert(!find(f.root, '本次输入验证已通过。'));
  allowed = true; find(f.root, '允许识别屏幕').onclick(); await tick();
  assert(find(f.root, '已允许')); assert(find(f.root, '开始验证').disabled);
  f.setScene('life'); assert.equal(find(f.root, '开始验证').disabled, false);
  assert(!find(f.root, '本次输入验证已通过。'));
  f.ui.deactivate(); f.ui.activate(); await tick();
  assert.deepEqual(f.calls, ['permissions', 'authorize_screen', 'authorize_screen', 'permissions']);
});

test('refresh checks permissions again and preserves them when later status events omit them', async () => {
  const f = setup(ready); await tick();
  f.setControl(async action => action === 'permissions' ? { ...ready, permissions: { screenCaptureAllowed: false } } : { enabled: true, state: 'ready' });
  find(f.root, '重新检测').onclick(); await tick();
  assert.deepEqual(f.calls, ['refresh', 'permissions']);
  assert(find(f.root, '未允许')); assert(find(f.root, '开始验证').disabled);
  f.event({ type: 'boper', enabled: true, state: 'ready' });
  assert(find(f.root, '未允许')); assert(find(f.root, '开始验证').disabled);
});

test('permission request has its own progress copy', async () => {
  const f = setup({ ...ready, permissions: { screenCaptureAllowed: false } }); await tick();
  let finish; f.setControl(() => new Promise(resolve => { finish = resolve; }));
  find(f.root, '允许识别屏幕').onclick();
  assert(find(f.root, '正在请求屏幕识别权限')); assert(find(f.root, '请按 macOS 提示操作。'));
  finish(ready); await tick(); assert(find(f.root, '已允许'));
});


test('a screen authorization error still explains where to allow access', async () => {
  const f = setup({ ...ready, permissions: { screenCaptureAllowed: false } }); await tick();
  f.setControl(async () => { throw Error('请求未完成'); });
  find(f.root, '允许识别屏幕').onclick(); await tick();
  assert(find(f.root, '如尚未允许，请前往系统设置 → 隐私与安全性 → 屏幕录制允许 WorkBunny，然后重新检测。'));
  assert(find(f.root, '开始验证').disabled);
});
