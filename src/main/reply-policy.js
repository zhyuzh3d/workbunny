'use strict';

const RULE = '\n语音回复约定：对你说的话直接给最终答复，简短自然；明显属于环境闲聊则只输出 <skip>。称呼你、询问你、接续你刚才的话都直接回答。禁止输出判断过程、是否回复的结论、计划或“我先判断”等过渡句。回复或跳过在本次输出中完成。';

function makeReplyGate(onText) {
  let prefix = '', state = 'pending';
  function push(text) {
    if (state === 'skip') return;
    if (state === 'reply') { onText(text); return; }
    prefix += text;
    const compact = prefix.replace(/\s/g, '').toLowerCase();
    if (!compact) return;
    if (compact.startsWith('<skip>') || compact.startsWith('<skip/>')) { state = 'skip'; prefix = ''; return; }
    if (['<skip>', '<skip/>'].some((token) => token.startsWith(compact))) return;
    state = 'reply'; onText(prefix); prefix = '';
  }
  return { push, flush() { if (state === 'pending' && prefix.trim()) { state = 'reply'; onText(prefix); prefix = ''; } },
    get skipped() { return state === 'skip'; } };
}
module.exports = { RULE, makeReplyGate };
