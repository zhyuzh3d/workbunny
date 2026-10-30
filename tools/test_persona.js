'use strict';
/* 人设快速评测：直接调模型，看语气是否到位。
   用法：node tools/test_persona.js            # 跑内置用例
        node tools/test_persona.js "自定义问题"  # 单问
*/
const path = require('path');
const config = require('../src/main/config.js');
const llm = require('../src/main/llm.js');

config.setPath(path.join(__dirname, '..', '.data', 'dev', 'config.json'));

const CASES = [
  '在吗',
  '给我讲个短笑话',
  '你叫什么名字？',
  '我写代码写得眼睛疼',
  '这个正则为什么匹配不到？',
  '夸你一句，你真好用',
  '帮我把这个文件删了',
  '今天几号？',
];

const CTX = `当前任务：把 VRM 桌宠的语音链路接进 Electron
主人最后说的话：帮我看下 标准 CHP 服务 的 TTS 为什么没声音
助手刚答完：端口 8020 的 Bearer key 取错了容器，换成 qwen3-tts 那个就通了`;

(async () => {
  const c = config.load();
  const sys = config.buildSystemPrompt(CTX);
  const one = process.argv[2];
  const list = one ? [one] : CASES;

  for (const q of list) {
    const t0 = Date.now();
    try {
      const r = await llm.chat({
        ...c.llm,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: q },
        ],
      });
      const ms = Date.now() - t0;
      const mt = (r.motions || []).length ? `  [动作 ${r.motions.join(',')}]` : '';
      const me = (r.emos || []).length ? `  [表情 ${r.emos.join(',')}]` : '';
      const len = (r.text || '').length;
      console.log(`\nQ: ${q}`);
      console.log(`A: ${r.text}${mt}${me}`);
      console.log(`   (${ms}ms · ${len}字${len > 56 ? ' ⚠太长' : ''}${/不是我的|无法|请自行|本职|还需要我/.test(r.text || '') ? ' ⚠推脱/客服腔' : ''})`);
    } catch (e) {
      console.log(`\nQ: ${q}\n   ERROR ${e.message}`);
    }
  }
})();
