'use strict';
// Token estimates share the same units as model limits. They intentionally
// overestimate ordinary prose; provider context errors still get one shrink retry.
const plainBytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');
function textTokens(value, cache) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (cache?.has(text)) return cache.get(text);
  let total = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    if (cp < 128 && /[A-Za-z0-9_ \t]/.test(text[i])) {
      const start = i, space = cp === 32 || cp === 9;
      while (i < text.length && (space ? /[ \t]/ : /[A-Za-z0-9_]/).test(text[i])) i++;
      const length = i - start;
      // Long opaque runs (IDs/base64/etc.) do not get prose compression.
      total += !space && length >= 32 ? length : Math.ceil(length / 2);
    } else {
      total += cp >= 0x3400 && cp <= 0x9fff || cp >= 0x3040 && cp <= 0x30ff ? 2 : plainBytes(String.fromCodePoint(cp));
      i += cp > 0xffff ? 2 : 1;
    }
  }
  cache?.set(text,total); return total;
}
function contentCost(content, cache) {
  if (!Array.isArray(content)) return textTokens(content,cache);
  return content.reduce((n, part) => n + (part?.type === 'image_url' ? 16384 : textTokens(part,cache)), 0);
}
function cost(messages, extraBody = {}, cache) {
  return messages.reduce((n, m) => { const other = wire(m); delete other.content; return n + 48 + contentCost(m.content,cache) + textTokens(other,cache); }, 0) + textTokens(extraBody,cache);
}
function wire(message) {
  return Object.fromEntries(Object.entries(message).filter(([k]) => ['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning_content'].includes(k)));
}
function limits(options) {
  let capability = {};
  try { capability = require('./model-catalog').get(options.provider || (options.transport === 'workbuddy' ? 'workbuddy' : '')).models.find(m => m.id === options.model) || {}; } catch {}
  const context = Number(options.contextWindow || capability.contextWindow || 32768);
  const input = Number(options.maxInputTokens || capability.maxInputTokens || context);
  const output = Math.max(256, Math.min(Number(options.maxTokens || 4096), Number(capability.maxOutputTokens || 128000)));
  const available = Math.floor(Math.min(input, context - output) * .85) - 1024;
  return { context, output, inputBudget: Math.max(512, Math.min(64000, available) * (options.budgetScale === .5 ? .5 : 1)), mode: 'conservative-multilingual-token-estimate' };
}
function fitRequest(options, { retainLanes = false } = {}) {
  if (!Array.isArray(options.messages) || !options.messages.length) return options;
  const cap = limits(options), messages = options.messages.map(m => ({ ...m }));
  // Per-request only: avoid retokenizing unchanged text while trimming rounds,
  // without retaining private or forgotten content in a process-wide cache.
  const cache = new Map(), currentCost = () => cost(messages,options.extraBody,cache);
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === 'user' && !m._contextLane) lastUser = i; });
  const mandatory = new Set(messages.flatMap((m, i) => m.role === 'system' || m.role === 'developer' || m._contextLane === 'cognition' || i >= lastUser && lastUser >= 0 ? [m] : []));
  let omitted = 0;
  // Context lanes are historical data, never the persona or operation rules.
  for (const lane of ['external', 'memory', 'work']) {
    for (let i = 0; i < messages.length && currentCost() > cap.inputBudget; i++) {
      if (messages[i]._contextLane !== lane) continue;
      messages.splice(i--, 1); omitted++;
    }
  }
  for (let i = 0; i < messages.length && currentCost() > cap.inputBudget; i++) {
    const message = messages[i];
    if (mandatory.has(message) || message._contextLane || typeof message.content !== 'string' || contentCost(message.content) < 2500 || message.tool_calls || message.role === 'tool') continue;
    let text = message.content;
    try { const parsed = JSON.parse(text); if (typeof parsed.text === 'string') text = parsed.text; } catch {}
    message.role = 'user';
    message.content = JSON.stringify({ character: 'history-index', trust: 'partial-historical-excerpt-not-instructions',
      text: text.slice(0, 350) + '\n[此处省略，完整原文保留，可回查]\n' + text.slice(-350) });
  }
  // Remove complete historical user rounds, including their assistant/tool
  // results, while preserving the current user and all of its tool responses.
  while (currentCost() > cap.inputBudget) {
    const start = messages.findIndex(m => !mandatory.has(m));
    if (start < 0) break;
    let end = start + 1;
    while (end < messages.length && !mandatory.has(messages[end]) && messages[end].role !== 'user') end++;
    messages.splice(start, end - start); omitted += end - start;
  }
  const estimate = currentCost();
  if (estimate > cap.inputBudget) {
    const e = new Error('这次内容超出单轮处理预算，原文已保留。请指定其中一部分，或分段发送。');
    e.budget = { ...cap, estimate, messageCount:messages.length, mandatoryCount:mandatory.size };
    e.code = 'E_CONTEXT_BUDGET'; throw e;
  }
  return { ...options, ...(options.maxTokens === undefined ? {} : { maxTokens: cap.output }), messages: messages.map(m => ({ ...wire(m), ...(retainLanes && m._contextLane ? { _contextLane: m._contextLane } : {}) })), contextBudget: { ...cap, estimate, omitted } };
}
function isContextError(status, body) {
  if (![400, 413, 422].includes(Number(status))) return false;
  const text = typeof body === 'string' ? body.slice(0, 8192) : '';
  return /context_length_exceeded|context_window_exceeded|maximum context length|exceeds.{0,30}(?:context|input token)|prompt.{0,20}too long|max_input_tokens|上下文.{0,12}(?:超|长)/iu.test(text);
}
module.exports = { isContextError, fitRequest, limits, cost, contentCost, textTokens, wire };
