'use strict';

function sanitizeFinishReason(value) {
  if (typeof value !== 'string') return null;
  const safe = value.trim().toLowerCase();
  if (!safe) return null;
  return ['stop', 'length', 'max_tokens', 'max_output_tokens', 'token_limit', 'content_filter', 'tool_calls', 'function_call', 'error', 'cancelled', 'timeout'].includes(safe) ? safe : 'other';
}
function sanitizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    const n = value[key];
    if (Number.isSafeInteger(n) && n >= 0) result[key] = n;
  }
  if (typeof value.credit === 'number' && Number.isFinite(value.credit) && value.credit >= 0) result.credit = value.credit;
  return Object.keys(result).length ? result : null;
}
function hasReasoningContent(value) {
  return !!value && typeof value === 'object' && [value.reasoning_content, value.reasoning].some(v => typeof v === 'string' && v.length > 0);
}
const MAX_TOOL_CALLS = 4;
const MAX_TOOL_ARGUMENTS = 8000;
function toolProtocolError() {
  const error = new Error('模型工具调用格式无效，请重试。');
  error.code = 'E_TOOL_PROTOCOL';
  return error;
}
function appendToolCall(calls, index, fragment) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_TOOL_CALLS ||
      !fragment || typeof fragment !== 'object' || Array.isArray(fragment)) throw toolProtocolError();
  let call = calls.get(index);
  if (!call) {
    if (calls.size >= MAX_TOOL_CALLS) throw toolProtocolError();
    call = { id: '', type: 'function', hasType: false, name: '', arguments: '' };
    calls.set(index, call);
  }
  if (fragment.id !== undefined) {
    if (typeof fragment.id !== 'string' || call.id.length + fragment.id.length > 200) throw toolProtocolError();
    call.id += fragment.id;
  }
  if (fragment.type !== undefined) {
    if (fragment.type !== 'function') throw toolProtocolError();
    call.hasType = true;
  }
  const fn = fragment.function;
  if (fn !== undefined) {
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) throw toolProtocolError();
    if (fn.name !== undefined) {
      if (typeof fn.name !== 'string' || call.name.length + fn.name.length > 128) throw toolProtocolError();
      call.name += fn.name;
    }
    if (fn.arguments !== undefined) {
      if (typeof fn.arguments !== 'string' || call.arguments.length + fn.arguments.length > MAX_TOOL_ARGUMENTS)
        throw toolProtocolError();
      call.arguments += fn.arguments;
    }
  }
}
function collectCompleteToolCalls(fragments) {
  if (!Array.isArray(fragments) || fragments.length > MAX_TOOL_CALLS) throw toolProtocolError();
  const calls = new Map();
  fragments.forEach((fragment, i) => appendToolCall(calls, i, fragment));
  return finishToolCalls(calls);
}
function finishToolCalls(calls) {
  const result = [];
  const ids = new Set();
  for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (index !== result.length || !call.hasType ||
        typeof call.id !== 'string' || !call.id || !/^[A-Za-z0-9_.:-]{1,200}$/.test(call.id) || ids.has(call.id) ||
        typeof call.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(call.name) ||
        typeof call.arguments !== 'string' || !call.arguments || call.arguments.length > MAX_TOOL_ARGUMENTS)
      throw toolProtocolError();
    let parsed;
    try { parsed = JSON.parse(call.arguments); } catch { throw toolProtocolError(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw toolProtocolError();
    ids.add(call.id);
    result.push({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } });
  }
  if (result.length > MAX_TOOL_CALLS) throw toolProtocolError();
  return result;
}

const OUTPUT_LIMITS = new Set(['length', 'max_tokens', 'max_output_tokens', 'token_limit']);

class ChatResponse {
  constructor(model, { label = '模型', onDelta } = {}) {
    Object.assign(this, { model, label, onDelta });
    this.raw = '';
    this.explicitContent = false;
    this.usage = null;
    this.finishReason = null;
    this.hasReasoning = false;
    this.done = false;
    this.streamedCalls = new Map();
    this.completeCalls = null;
  }

  event(event) {
    if (!event || typeof event !== 'object' || this.done) return;
    const data = event.data?.choices ? event.data : event;
    if (typeof data.model === 'string') this.model = data.model;
    if (data.usage) this.usage = sanitizeUsage(data.usage);
    const choice = data.choices?.[0];
    if (!choice) return;
    this.finishReason = sanitizeFinishReason(choice.finish_reason ?? choice.finishReason) ?? this.finishReason;
    const { delta, message } = choice;
    this.hasReasoning ||= hasReasoningContent(delta) || hasReasoningContent(message);
    const content = delta?.content ?? (!this.raw ? message?.content : undefined);
    if(typeof content==='string')this.explicitContent=true;
    if (typeof content === 'string' && content) {
      this.raw += content;
      this.onDelta?.(content);
    }
    if (delta?.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw toolProtocolError();
      for (const fragment of delta.tool_calls) appendToolCall(this.streamedCalls, fragment?.index, fragment);
    }
    if (message?.tool_calls !== undefined) {
      if (this.completeCalls) throw toolProtocolError();
      this.completeCalls = collectCompleteToolCalls(message.tool_calls);
    }
  }

  line(line) {
    if (this.done || !line.startsWith('data:')) return;
    const text = line.slice(5).trim();
    if (text === '[DONE]') { this.done = true; return; }
    if (!text) return;
    let event;
    try { event = JSON.parse(text); }
    catch {
      if (/"tool_calls"|"function"|"arguments"/u.test(text)) throw toolProtocolError();
      return;
    }
    this.event(event);
  }

  result() {
    const { model, usage, finishReason, hasReasoning } = this;
    const toolCalls = this.completeCalls ?? (this.streamedCalls.size ? finishToolCalls(this.streamedCalls) : []);
    if (finishReason === 'tool_calls' && !toolCalls.length) throw toolProtocolError();
    const limited = OUTPUT_LIMITS.has(finishReason);
    const raw = toolCalls.length ? '' : this.raw;
    if (toolCalls.length && limited || !toolCalls.length && !raw.trim()) {
      const error = new Error(limited ? this.label + ' 输出达到 token 上限，整理结果不完整。' : this.label + ' 没有返回可用回答，请重试。');
      throw Object.assign(error, { code: limited ? 'E_OUTPUT_LIMIT' : 'E_EMPTY_RESPONSE', finishReason, usage, hasReasoning,
        completedEmptyContent:!limited&&finishReason==='stop'&&this.explicitContent&&!hasReasoning });
    }
    if (toolCalls.length && ['content_filter', 'error', 'cancelled', 'timeout'].includes(finishReason)) throw toolProtocolError();
    return { raw, model, usage, finishReason, hasReasoning, ...(toolCalls.length ? { toolCalls } : {}) };
  }
}

function parseChatBody(body, model = 'hy3') {
  const response = new ChatResponse(model, { label: 'WorkBuddy' });
  let object;
  try { object = JSON.parse(body); } catch {}
  if (object !== undefined) response.event(object);
  else for (const line of body.split('\n')) response.line(line);
  return response.result();
}

module.exports = { ChatResponse, parseChatBody, sanitizeUsage };
