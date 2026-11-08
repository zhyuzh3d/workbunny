'use strict';
// Token estimates share the same units as model limits. They intentionally
// overestimate ordinary prose; provider context errors still get one shrink retry.
const MAX_INPUT_TOKENS = 256000;
const DEFAULT_CONTEXT_TOKENS = 32768;
const PROTOCOL_RESERVE_TOKENS = 1024;
const IMAGE_ESTIMATE_TOKENS = 16384;
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
// Optional excerpts only. Convert a token allowance to a Unicode-safe prefix
// by measuring its content, never by assuming tokens equal characters/bytes.
function textPrefixWithinBudget(text, tokenBudget) {
  if(typeof text!=='string'||!Number.isSafeInteger(tokenBudget)||tokenBudget<0)throw new TypeError('可选文本额度须为非负整数token');
  if(textTokens(text)<=tokenBudget)return text;
  const characters=Array.from(text);let low=0,high=characters.length;
  while(low<high){const mid=Math.ceil((low+high)/2);if(textTokens(characters.slice(0,mid).join(''))<=tokenBudget)low=mid;else high=mid-1;}
  return characters.slice(0,low).join('');
}
function contentCost(content, cache) {
  if (!Array.isArray(content)) return textTokens(content,cache);
  return content.reduce((n, part) => n + (part?.type === 'image_url' ? IMAGE_ESTIMATE_TOKENS : textTokens(part,cache)), 0);
}
function cost(messages, extraBody = {}, cache) {
  return messages.reduce((n, m) => { const other = wire(m); delete other.content; return n + 48 + contentCost(m.content,cache) + textTokens(other,cache); }, 0) + textTokens(extraBody,cache);
}
function diagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of ['context','output','inputLimit','inputBudget','requestedInputBudget','maximumInputBudget','protocolReserve','uncertaintyReserve','estimate','messageCount','mandatoryCount','imageCount','imageEstimate','textEstimate','requestBytes','systemEstimate']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return Object.keys(result).length ? result : undefined;
}
function wire(message) {
  return Object.fromEntries(Object.entries(message).filter(([k]) => ['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning_content'].includes(k)));
}
function limits(options) {
  let capability = {};
  try { capability = require('./model-catalog').get(options.provider || (options.transport === 'workbuddy' ? 'workbuddy' : '')).models.find(m => m.id === options.model) || {}; } catch {}
  const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):undefined;
  const context = positive(options.contextWindow) || positive(capability.contextWindow) || positive(capability.maxInputTokens) || DEFAULT_CONTEXT_TOKENS;
  const input = positive(options.maxInputTokens) || positive(capability.maxInputTokens) || context;
  const output = Math.min(positive(options.maxTokens)||4096,positive(options.maxOutputTokens)||positive(capability.maxOutputTokens)||128000);
  const requestedInputBudget=options.inputBudgetTokens===undefined?MAX_INPUT_TOKENS:options.inputBudgetTokens;
  if(!Number.isSafeInteger(requestedInputBudget)||requestedInputBudget<512||requestedInputBudget>MAX_INPUT_TOKENS)throw Object.assign(new Error('输入额度须为512至256000之间的整数，单位为token'),{code:'E_CONTEXT_CONFIGURATION'});
  // Count protocol/tool content in cost(); keep extra room for tokenization
  // uncertainty, chat framing, and the complete requested output separately.
  const usable=Math.max(0,Math.min(input,context-output));
  const uncertaintyReserve=Math.ceil(usable*.15),protocolReserve=PROTOCOL_RESERVE_TOKENS;
  const maximumInputBudget=Math.max(0,Math.min(MAX_INPUT_TOKENS,usable-uncertaintyReserve-protocolReserve));
  const inputBudget=Math.floor(Math.min(requestedInputBudget,maximumInputBudget)*(options.budgetScale===.5?.5:1));
  return {context,output,inputLimit:input,inputBudget,requestedInputBudget,maximumInputBudget,protocolReserve,uncertaintyReserve,
    unit:'tokens',mode:'conservative-multilingual-token-estimate'};
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
  const imageCount = messages.reduce((n,m) => n + (Array.isArray(m.content) ? m.content.filter(p => p?.type === 'image_url').length : 0), 0);
  const measured={...cap,estimate,messageCount:messages.length,mandatoryCount:mandatory.size,
    imageCount,imageEstimate:imageCount*IMAGE_ESTIMATE_TOKENS,textEstimate:estimate-imageCount*IMAGE_ESTIMATE_TOKENS,
    requestBytes:plainBytes({messages:messages.map(wire),extraBody:options.extraBody||{}}),
    systemEstimate:messages.filter(m=>['system','developer'].includes(m.role)).reduce((n,m)=>n+contentCost(m.content,cache),0)};
  if (estimate > cap.inputBudget) {
    const e = new Error('当前模型请求超出可用上下文预算；原始资料已保留，需要核对模型容量或减少附加上下文后继续。');
    e.budget = measured;
    e.diagnostic = { operation:'model-request',method:'context-budget',
      ...(typeof options.model === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/u.test(options.model) ? {model:options.model}:{}),budget:diagnostic(e.budget) };
    e.code = 'E_CONTEXT_BUDGET'; throw e;
  }
  return { ...options, maxTokens:cap.output, messages: messages.map(m => ({ ...wire(m), ...(retainLanes && m._contextLane ? { _contextLane: m._contextLane } : {}) })), contextBudget: { ...measured, omitted } };
}
function isContextError(status, body) {
  if (![400, 413, 422].includes(Number(status))) return false;
  const text = typeof body === 'string' ? body.slice(0, 8192) : '';
  return /context_length_exceeded|context_window_exceeded|maximum context length|exceeds.{0,30}(?:context|input token)|prompt.{0,20}too long|max_input_tokens|上下文.{0,12}(?:超|长)/iu.test(text);
}
module.exports = { MAX_INPUT_TOKENS, DEFAULT_CONTEXT_TOKENS, IMAGE_ESTIMATE_TOKENS, isContextError, fitRequest, limits, cost, contentCost, textTokens, textPrefixWithinBudget, wire, diagnostic };
