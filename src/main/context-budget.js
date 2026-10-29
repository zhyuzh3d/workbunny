'use strict';
// A conservative text estimate, not a provider-specific tokenizer. Recheck the
// final wire request, including tool rounds and format repair, at each transport.
const plainBytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');
function contentCost(content) {
  if (!Array.isArray(content)) return plainBytes(content);
  return content.reduce((n, part) => n + (part?.type === 'image_url' ? 16384 : plainBytes(part)), 0);
}
function cost(messages, extraBody = {}) {
  return messages.reduce((n, m) => { const other = wire(m); delete other.content; return n + 48 + contentCost(m.content) + plainBytes(other); }, 0) + plainBytes(extraBody);
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
  return { context, output, inputBudget: Math.max(512, Math.min(64000, available) * (options.budgetScale === .5 ? .5 : 1)), mode: 'conservative-utf8-text-estimate' };
}
function fitRequest(options, { retainLanes = false } = {}) {
  if (!Array.isArray(options.messages) || !options.messages.length) return options;
  const cap = limits(options), messages = options.messages.map(m => ({ ...m }));
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === 'user' && !m._contextLane) lastUser = i; });
  const mandatory = new Set(messages.flatMap((m, i) => m.role === 'system' || m.role === 'developer' || m._contextLane === 'cognition' || i >= lastUser && lastUser >= 0 ? [m] : []));
  let omitted = 0;
  // Context lanes are historical data, never the persona or operation rules.
  for (const lane of ['external', 'memory', 'work']) {
    for (let i = 0; i < messages.length && cost(messages, options.extraBody) > cap.inputBudget; i++) {
      if (messages[i]._contextLane !== lane) continue;
      messages.splice(i--, 1); omitted++;
    }
  }
  for (let i = 0; i < messages.length && cost(messages, options.extraBody) > cap.inputBudget; i++) {
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
  while (cost(messages, options.extraBody) > cap.inputBudget) {
    const start = messages.findIndex(m => !mandatory.has(m));
    if (start < 0) break;
    let end = start + 1;
    while (end < messages.length && !mandatory.has(messages[end]) && messages[end].role !== 'user') end++;
    messages.splice(start, end - start); omitted += end - start;
  }
  const estimate = cost(messages, options.extraBody);
  if (estimate > cap.inputBudget) {
    const e = new Error('当前请求与必要规则超过模型输入预算，原文已保留。请分段指定要处理的部分或选择更大上下文模型。');
    e.code = 'E_CONTEXT_BUDGET'; throw e;
  }
  return { ...options, ...(options.maxTokens === undefined ? {} : { maxTokens: cap.output }), messages: messages.map(m => ({ ...wire(m), ...(retainLanes && m._contextLane ? { _contextLane: m._contextLane } : {}) })), contextBudget: { ...cap, estimate, omitted } };
}
function isContextError(status, body) {
  if (![400, 413, 422].includes(Number(status))) return false;
  const text = typeof body === 'string' ? body.slice(0, 8192) : '';
  return /context_length_exceeded|context_window_exceeded|maximum context length|exceeds.{0,30}(?:context|input token)|prompt.{0,20}too long|max_input_tokens|上下文.{0,12}(?:超|长)/iu.test(text);
}
module.exports = { isContextError, fitRequest, limits, cost, contentCost, wire };
