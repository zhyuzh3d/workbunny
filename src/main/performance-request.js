'use strict';

const { parseStrictJson } = require('./strict-json');
const { createReplyStream, fields, valueEnd } = require('./reply-stream');
const { conversationText } = require('./conversation-text');
const { containsSecret } = require('./conversation-input');
const { createBoundedWait } = require('./bounded-wait');

const RULE = '本次是Bunny的一次身体表演选择。只依据本次要求和完整编号目录选择最合适的一个动作。目录中的道具等条件必须满足；可以通过已有坐下或起身动作改变姿态。编号0表示没有合适动作，不能编造目录外能力。一次只播放所选的现有完整动作，不会临时拼接编舞；补充对话按所选动作的目录含义表达，不照搬要求中未被所选动作支持的细节。只返回JSON对象 {"motion":整数编号,"text":"可选的自然对话正文"}。正文可以为空，按要求自然表达，不必总说话、不固定道歉、不复读要求、不输出动作标签或程序数据，不声称尚未执行的动作已经完成。没有匹配时可以自然说明当前动作库的局限。不得发起工具或更多模型调用。';
const fail = (code, message) => Object.assign(new Error(message), { code });

function validatePerformance(raw, snapshot) {
  let value;
  try { value = parseStrictJson(raw); } catch { throw fail('E_PERFORMANCE_PROTOCOL', '表演回复格式不正确'); }
  if (!value || Array.isArray(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'motion') || !Object.hasOwn(value, 'text') ||
      !Number.isSafeInteger(value.motion) || value.motion < 0 || value.motion > snapshot.motions.length ||
      typeof value.text !== 'string' || value.text.length > 2000 || containsSecret(value.text) || /<\/?m(?:\s|>)/iu.test(value.text)) {
    throw fail('E_PERFORMANCE_PROTOCOL', '表演回复编号或正文不正确');
  }
  let text = '';
  try { if (value.text.trim()) text = conversationText(value.text); }
  catch { throw fail('E_PERFORMANCE_PROTOCOL', '表演正文含程序数据'); }
  return { motion: value.motion, text };
}

// Project only the JSON string at the root text field into the existing chat
// stream. Catalog numbers and internal instructions never enter presentation.
function performanceStream(options) {
  const stream = createReplyStream({ ...options, cognitive: false });
  let raw = '', projected = '';
  return {
    push(delta) {
      raw += String(delta || '');
      if (raw.length > 32768) return;
      const start = raw.search(/\S/u);
      if (raw[start] !== '{') return;
      const range = fields(raw, start)?.get('text');
      if (!range || raw[range.start] !== '"') return;
      const end = valueEnd(raw, range.start);
      if (end === -2) return;
      const next = '{"kind":"chat","text":' + raw.slice(range.start, end > 0 ? end : raw.length) + (end > 0 ? '}' : '');
      if (next.startsWith(projected)) { stream.push(next.slice(projected.length)); projected = next; }
    },
    finish: text => stream.finish(text),
    get text() { return stream.text; },
  };
}

async function requestPerformance({ chat, llmOptions = {}, prompt, snapshot, signal, isCurrent = () => true,
  streamText = true, onTextDelta, onTextSentence, timeoutMs = 20000 } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 600 || containsSecret(prompt)) throw fail('E_PERFORMANCE_INPUT', '表演要求不正确');
  const wait = createBoundedWait({ signal, timeoutMs, code: 'E_PERFORMANCE_TIMEOUT', message: '这次表演选择暂未完成' });
  const current = () => !wait.signal.aborted && isCurrent();
  const check = () => { if (!current()) throw fail('ABORT_ERR', '表演已取消'); };
  const messages = [{ role: 'system', content: RULE + '\n完整动作目录：\n' + snapshot.promptText },
    { role: 'user', content: prompt.trim() }];
  const schema = { type: 'object', additionalProperties: false, properties: {
    motion: { type: 'integer', minimum: 0, maximum: snapshot.motions.length }, text: { type: 'string', maxLength: 2000 },
  }, required: ['motion', 'text'] };
  const response_format = llmOptions.provider === 'grok'
    ? { type: 'json_schema', json_schema: { name: 'bunny_performance', strict: true, schema } } : { type: 'json_object' };
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      check();
      const stream = performanceStream({ isCurrent: current, onDelta: onTextDelta, onSentence: onTextSentence });
      const result = await wait.run(innerSignal => chat({ ...llmOptions, priority: 'foreground', messages,
        signal: innerSignal, timeoutMs, maxTokens: 1024, webSearch: false,
        extraBody: { ...llmOptions.extraBody, response_format },
        onDelta: streamText ? (delta, metadata) => { if (current() && metadata?.complete !== true) stream.push(delta); } : undefined }));
      check();
      let reply;
      try { reply = validatePerformance(result.raw ?? result.text ?? '', snapshot); }
      catch (error) {
        if (error.code !== 'E_PERFORMANCE_PROTOCOL' || stream.text || attempt === 2) throw error;
        messages.push({ role: 'user', content: '上一输出未通过格式校验。请依据原要求重新选择，只返回含motion整数编号和text字符串的JSON对象，不加其他字段。' });
        continue;
      }
      if (streamText && reply.text) stream.finish(reply.text);
      return { ...reply, attempts: attempt };
    }
  } finally { wait.close(); }
}

module.exports = { requestPerformance, validatePerformance, performanceStream, RULE };
