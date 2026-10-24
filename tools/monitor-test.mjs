#!/usr/bin/env node
/* 多会话回归：两个 WorkBuddy 任务同时在跑，监控必须同时看见，不能只认最后一个。
 * 用法：node tools/monitor-test.mjs
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Monitor, taskName } = require('../src/main/monitor.js');

const ROOT = '/tmp/wb-mon-test';
const now = Date.now();

function reset() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const d of ['proj-a', 'proj-b']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}

/* 一条会话 = 一行一个事件 */
function writeSession(dir, id, rows) {
  const f = path.join(ROOT, dir, `${id}.jsonl`);
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}

const run = (at, task, extra = {}) => ({ type: 'message', role: 'user', timestamp: at, content: `<user_query>${task}</user_query>${extra.tail || ''}` });
const call = (at) => ({ type: 'function_call', timestamp: at, name: 'edit' });
const say = (at, text) => ({ type: 'message', role: 'assistant', timestamp: at, content: text });

function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

reset();
const fileA = writeSession('proj-a', 'sessA', [run(now - 90e3, '改一下登录页的样式'), call(now - 80e3), call(now - 70e3)]);
const fileB = writeSession('proj-b', 'sessB', [run(now - 40e3, '把测试全跑一遍'), call(now - 30e3)]);
/* 后台任务完成通知（系统注入的 user 消息）不能算新任务，也不能拿去当任务名 */
const notice = {
  type: 'message', role: 'user', timestamp: now - 35e3,
  content: '<task-notification>\n<task-id>Py8wwg</task-id>\n<status>completed</status>\n<summary>Background command done</summary>\n</task-notification>\n\nUse the TaskOutput tool with task_id="Py8wwg"',
};
fs.appendFileSync(fileA, JSON.stringify(notice) + '\n');

const m = new Monitor();
m.start(ROOT);

const v1 = m.view;
check('两个会话都挂上了', m.sessions.size === 2, `sessions=${m.sessions.size}`);
check('两个任务都在跑', v1.running.length === 2, `running=${v1.running.length}`);
check('primary 是最新动过的那个', v1.primary && v1.primary.sessionId === 'sessB', v1.primary && v1.primary.sessionId);
const aSnap = [...m.sessions.values()].find((e) => e.snap.sessionId === 'sessA').snap;
check('后台任务通知没被当成新任务', !!aSnap.task && aSnap.task.userText.includes('改一下登录页'), aSnap.task ? aSnap.task.userText.slice(0, 20) : '-');
check('任务名里没有尖括号标签', !taskName(aSnap.task).includes('<'), taskName(aSnap.task));

const ctx1 = m.context();
check('战况里两件事都写了', ctx1.includes('改一下登录页') && ctx1.includes('把测试全跑一遍'));
check('战况说了"同时"', /同时在做 2 件/.test(ctx1));

/* A 交付了：加一段最终答复，静默 3.2 秒后应算完成，B 还得在跑 */
let doneEvent = null;
m.on('taskDone', (s) => { doneEvent = s; });
fs.appendFileSync(fileA, JSON.stringify(say(Date.now(), '样式改好了，顺手把按钮对齐了。')) + '\n');

const t0 = Date.now();
await new Promise((r) => setTimeout(r, 2200));   // 等一轮扫描读到新行
const midRun = m.view.running.length;
await new Promise((r) => setTimeout(r, 2600));   // 再等静默判定（IDLE_MS=3200）

check('A 交付后 taskDone 触发', !!doneEvent, doneEvent ? `sessionId=${doneEvent.sessionId}` : '没触发');
check('A 交付不误伤 B：还在跑 1 件', m.view.running.length === 1, `running=${m.view.running.length}（读到时=${midRun}）`);
check('剩下的那个是 B', m.view.running[0] && m.view.running[0].sessionId === 'sessB', m.view.running[0] && m.view.running[0].sessionId);
check('A 的结局记为 ok', !!(doneEvent && doneEvent.task.status === 'ok'), doneEvent ? doneEvent.task.status : '-');

const ctx2 = m.context();
check('战况：B 在跑 + A 刚做完', ctx2.includes('把测试全跑一遍') && ctx2.includes('样式改好了'));

m.stop();
console.log('\n── context() 第二步 ──');
console.log(ctx2);
console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · ${process.exitCode ? '有失败' : '全过'}`);
