'use strict';

const { extractTags } = require('./llm');

// A presentation boundary, not a blacklist of model answers. Ordinary numbers,
// names and words such as "action" remain valid speech. Program payloads and
// role/control delimiters belong to typed channels, never to the conversation.
function conversationText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000) throw new Error('对话正文为空或超长');
  const { clean } = extractTags(value);
  const text = clean.trim();
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
      /```|~~~|\{\s*(?:"(?:[^"\\]|\\.)*"|[A-Za-z_]\w*)\s*:|\[\s*(?:\{|"|true\b|false\b|null\b|-?\d+(?:\.\d+)?\s*[,\]])/u.test(text) ||
      /<\/?[A-Za-z_][^>]*>|<\|[^>]*\|>/u.test(text) ||
      /(?:^|\n)\s*(?:assistant|system|tool|function|analysis|action|intent|tool_call|function_call|arguments|reasoning_effort)\s*[:=]/iu.test(text) || /\[object Object\]/u.test(text)) {
    throw new Error('对话正文含程序专用数据');
  }
  return text;
}

function presentConversation(value, fallback = '') {
  try { return conversationText(value); } catch { return fallback; }
}
module.exports = { conversationText, presentConversation };
