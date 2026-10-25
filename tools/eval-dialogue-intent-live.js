'use strict';
// Explicit read-only model evaluation. Never starts DesktopService or sends a UI action.
const fs = require('fs'), os = require('os'), path = require('path');
const wb = require('../src/main/workbuddy');
const config = require('../src/main/config');
const { freeModel } = require('../src/main/workbuddy-free');
const { RULE, makeActionGate } = require('../src/main/dialogue-actions');

const cases = [
  ['work', '帮我交给WorkBuddy一个任务：只回复“对话代办验收通过”，不要使用工具。', 'start', 'workbuddy'],
  ['social', '帮我在微信文件传输助手发一句“早上好，这是Bunny测试”。', 'start', 'wechat'],
  ['missing-project', '把这份项目的代码审查交给WorkBuddy，检查完告诉我主要问题。', null],
  ['explicit-project', '把 /tmp/workbunny-demo 项目的代码审查交给WorkBuddy，检查完告诉我主要问题。', 'start', 'workbuddy'],
  ['stop', '暂停你现在的代办操作。', 'stop'],
  ['progress', '刚才交代你的事情进展怎么样？', 'status'],
  ['resume', '继续刚才那件代办，请保留原任务，不重复发送。', 'resume'],
  ['continue-chat', '继续讲刚才的故事，先别操作软件。', null],
  ['chat', '今天能陪我说说话吗？', null],
  ['question', '你是怎么操作微信的？', null],
  ['quote', '我在文章里看见一句话：“帮我在微信文件传输助手发一句你好”。你觉得这种交互设计怎么样？先讨论，不执行。', null],
  ['hypothetical', '如果以后让你帮我操作WorkBuddy，是不是就更方便？现在先不用做。', null],
  ['recipient-missing', '帮我发条微信，说我晚点到。', null],
  ['plain-work-question', 'WorkBuddy和你有什么区别？', null],
  ['missing-project-code', '帮我分析这个项目有没有明显bug并修一下，完成后给我验收。', null],
  ['explicit-code', '帮我让WorkBuddy分析 /tmp/workbunny-demo 项目有没有明显bug并修一下，完成后给我验收。', 'start', 'workbuddy'],
];

(async () => {
  const model = process.argv[2] || await freeModel();
  if (!['hy3', 'deepseek-v4.1-flash'].includes(model)) throw new Error('Only the explicitly approved evaluation models are allowed');
  config.setPath(path.join(os.homedir(), 'Library/Application Support/workbunny/config.json'));
  const results = [];
  const file = path.join(os.tmpdir(), `workbunny-040-intent-${model}.json`);
  for (const [name, text, action, target] of cases) {
    if (process.argv[3] && process.argv[3] !== name) continue;
    const start = Date.now(); let visible = '';
    const gate = makeActionGate(delta => { visible += delta; });
    const state = action === 'resume' || name === 'continue-chat' ? '当前有一个WorkBuddy测试代办，status=paused，截图核对暂时失败，原任务和草稿仍保留。'
      : ['stop', 'status'].includes(action) ? '当前代理状态：正在监视WorkBuddy执行测试回复任务，已发出，尚未完成。' : '当前没有正在处理的代办。';
    let response;
    try { response = await wb.chat({ model, thinking: 'low', maxTokens: 4096,
      extraBody: { reasoning_effort: 'low', response_format: { type: 'json_object' } }, messages: [
      { role: 'system', content: config.buildSystemPrompt(state) + '\n\n' + RULE },
      { role: 'user', content: text },
    ] }); } catch (error) { response = { raw: '', model, failure: error.message }; }
    gate.push(response.raw || response.text); gate.flush();
    const ok = !response.failure && !gate.error && (gate.intent?.action || null) === action && (!target || gate.intent?.target === target);
    const item = { name, ok, expected: action, actual: gate.intent?.action || null, target: gate.intent?.target || null,
      ms: Date.now() - start, model: response.model, error: response.failure || gate.error || null, response: response.raw || response.text, visible };
    results.push(item);
    fs.writeFileSync(file, JSON.stringify(results, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ name, ok, actual: item.actual, target: item.target, model: item.model, ms: item.ms, error: item.error }));
  }
  fs.writeFileSync(file, JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: results.filter(r => r.ok).length, total: results.length, file }));
  if (results.some(r => !r.ok)) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
