'use strict';

const { responseFormat, validateReply, recoverCognitiveChat } = require('./reply-format');
const { makeSentenceSplitter } = require('./llm');

const MAX_REPAIRS = 1;
const BASE_REMINDER = [
  '应用外层回复协议：只返回一个 JSON 对象，不要代码围栏或对象外文字。',
  '聊天格式：{"kind":"chat","text":"..."}；动作格式：{"kind":"action","intent":{...}}；不应回答时：{"kind":"skip"}。',
  '按原请求的用户意图作答；这条格式要求只是包装回复，不是新的工作任务。',
].join('\n');
const REPAIR_REMINDER = [
  '上一输出未通过应用回复协议。请从原始对话重新作答，只输出一个完整、合法且无额外字段的 JSON 对象。',
  '必须严格使用 {"kind":"chat","text":"..."}、{ "kind":"action","intent":{...} } 或 {"kind":"skip"} 之一；不要复述格式说明，不要代码围栏。',
].join('\n');

function protocolError(stage) {
  const error = new Error('模型回复未通过对话协议校验，请重试。');
  error.code = 'E_REPLY_PROTOCOL';
  if (['json', 'envelope', 'review', 'reply', 'prediction'].includes(stage)) error.protocolStage = stage;
  return error;
}

function timeoutError() {
  const error = new Error('模型回复请求超时，请重试。');
  error.code = 'E_REPLY_TIMEOUT';
  return error;
}

function cloneMessagesWithReminder(messages, reminder) {
  if (!Array.isArray(messages) || !messages.length) throw protocolError();
  const cloned = messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw protocolError();
    const copy = { ...message };
    if (Array.isArray(message.content)) copy.content = message.content.map(part => part && typeof part === 'object' ? { ...part } : part);
    return copy;
  });
  let index = -1;
  for (let i = cloned.length - 1; i >= 0; i--) {
    if (cloned[i].role === 'user') { index = i; break; }
  }
  if (index < 0) throw protocolError();
  const content = cloned[index].content;
  if (typeof content === 'string') cloned[index].content = `${content}\n\n${reminder}`;
  else if (Array.isArray(content)) cloned[index].content = [...content, { type: 'text', text: reminder }];
  else throw protocolError();
  return cloned;
}

function active(request) {
  return !request.signal?.aborted && (typeof request.isCurrent !== 'function' || request.isCurrent());
}

function throwAborted() {
  const error = new Error('aborted');
  error.code = 'ABORT_ERR';
  throw error;
}

function makeChatOptions(request, messages) {
  const options = { ...request, messages };
  // No provider callback may observe an unvalidated completion. Deliver the
  // supported text callbacks only after the complete envelope passes validation.
  for (const key of Object.keys(options)) {
    if (/^on[A-Z]/.test(key) && typeof options[key] === 'function') delete options[key];
  }
  delete options.isCurrent;
  const provider = request.provider || (request.transport === 'workbuddy' ? 'workbuddy' : undefined);
  options.extraBody = {
    ...(request.extraBody || {}),
    response_format: request.cognitive ? responseFormat(provider, undefined, { cognitive: true }) : request.extraBody?.response_format || responseFormat(provider),
  };
  return options;
}

function safeChatFallbackOptions(request) {
  // Remove the conflicting higher-level protocol instructions from the
  // original system prompt. A fallback cannot perform or claim an action.
  const cognition = require('./dialogue-cognition');
  const actionRule = require('./dialogue-actions').RULE;
  const messages = request.messages.map(message => message.role === 'system' && typeof message.content === 'string'
    ? { ...message, content: message.content.replace(actionRule, '').replace(cognition.SELF_RULE, '').replace(cognition.RULE, '') }
    : { ...message });
  const rule = '本次是普通对话恢复。只返回一个 JSON 对象 {"kind":"chat","text":"给用户的自然回复"}，不要外层协议或额外字段。此轮无法执行任何操作，不得声称已执行；用户要求操作时明确说明暂时无法执行。不要泄露思考或内部格式。';
  const system = messages.find(message => message.role === 'system' && typeof message.content === 'string');
  if (system) system.content += '\n' + rule;
  else messages.unshift({ role: 'system', content: rule });
  const options = makeChatOptions({ ...request, cognitive: false, extraBody: { ...request.extraBody, response_format: { type: 'json_object' } } }, messages);
  delete options.extraBody.tools; delete options.extraBody.tool_choice;
  delete options.recallSession; delete options.searchCache; options.webSearch = false;
  return options;
}

/**
 * Request and locally validate one complete outer reply envelope before any
 * UI, TTS, or action-facing callback sees model output. JSON mode is a prompt /
 * transport hint, not an authorization boundary or a protocol guarantee.
 */
async function requestReply({ chat, request, maxRepairs = MAX_REPAIRS, allowActions = true, clock = Date.now } = {}) {
  if (typeof chat !== 'function' || !request || typeof request !== 'object') throw new TypeError('chat and request are required');
  const repairs = Math.min(MAX_REPAIRS, Math.max(0, Number.isFinite(maxRepairs) ? Math.floor(maxRepairs) : MAX_REPAIRS));
  const requestedTimeout = Number(request.timeoutMs || 55000);
  const totalTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 55000;
  const deadline = clock() + totalTimeoutMs;
  const originalDelta = request.onDelta;
  const originalSentence = request.onSentence;
  let repaired = false, formatRepairs = 0, contextRetried = false;

  for (let attempt = 0; attempt <= repairs + 1; attempt++) {
    if (!active(request)) throwAborted();
    const remainingTimeout = deadline - clock();
    if (remainingTimeout <= 0) throw timeoutError();
    const base = request.cognitive ? require('./dialogue-cognition').RULE : BASE_REMINDER;
    const reminder = formatRepairs === 0 ? base : `${base}\n上一输出未通过格式校验，请按原始请求重新生成完整协议，不能重排上一输出。`;
    const messages = cloneMessagesWithReminder(request.messages, reminder);
    let result;
    // Transport errors are allowed through unchanged and are never retried as
    // formatting failures. Only the local validator can trigger one repair.
    const options = makeChatOptions(request, messages);
    if (contextRetried) options.budgetScale = .5;
    options.timeoutMs = Math.min(totalTimeoutMs, remainingTimeout);
    try {
      result = await chat(options);
    } catch (error) {
      if (active(request) && deadline - clock() <= 0) throw timeoutError();
      if (active(request) && error.code === 'E_CONTEXT_WINDOW' && !contextRetried) { contextRetried = true; continue; }
      throw error;
    }
    if (!active(request)) throwAborted();
    if (deadline - clock() <= 0) throw timeoutError();
    const raw = typeof result?.raw === 'string' ? result.raw : (typeof result?.text === 'string' ? result.text : '');
    let validated, cognitionDegraded = false, cognitionFailureStage, fallbackUsed = false;
    try {
      validated = validateReply(raw, { allowActions, cognitive: request.cognitive === true });
    } catch (error) {
      if (error?.code !== 'E_REPLY_PROTOCOL') throw error;
      cognitionFailureStage = error.protocolStage;
      validated = request.cognitive ? recoverCognitiveChat(raw) : null;
      if (validated) cognitionDegraded = true;
      else {
        if (formatRepairs < repairs && active(request)) { formatRepairs++; repaired = true; continue; }
        if (!request.cognitive || !repairs) throw protocolError(error.protocolStage);
        if (!active(request)) throwAborted();
        const remaining = deadline - clock();
        if (remaining <= 0) throw timeoutError();
        const fallback = safeChatFallbackOptions(request);
        fallback.timeoutMs = remaining;
        result = await chat(fallback);
        if (!active(request)) throwAborted();
        if (deadline - clock() <= 0) throw timeoutError();
        const fallbackRaw = typeof result?.raw === 'string' ? result.raw : (typeof result?.text === 'string' ? result.text : '');
        try { validated = validateReply(fallbackRaw, { allowActions: false }); }
        catch (fallbackError) { if (fallbackError?.code === 'E_REPLY_PROTOCOL') throw protocolError(error.protocolStage); throw fallbackError; }
        if (!validated.text || validated.intent || validated.skipped) throw protocolError(error.protocolStage);
        validated.innerRaw = fallbackRaw;
        cognitionDegraded = true;
        repaired = true;
        fallbackUsed = true;
      }
    }
    if (!active(request)) throwAborted();

    const visibleRaw = validated.innerRaw || raw;
    if (typeof originalDelta === 'function' && !request.deferPresentation) originalDelta(visibleRaw);
    if (!request.deferPresentation && typeof originalSentence === 'function' && validated.text) {
      const splitter = makeSentenceSplitter(originalSentence);
      splitter.push(validated.text);
      splitter.flush();
    }
    const tags = require('./llm').extractTags(validated.taggedText || validated.text || '');
    return { ...result, raw: visibleRaw, text: tags.clean, motions: tags.motions, emos: tags.emos, cognition: validated.cognition,
      attempts: attempt + 1 + (fallbackUsed ? 1 : 0), protocolVerified: !cognitionDegraded, reply: validated, repaired,
      ...(cognitionDegraded ? { cognitionDegraded: true, ...(cognitionFailureStage ? { cognitionFailureStage } : {}) } : {}), ...(contextRetried ? { contextRetried: true } : {}) };
  }
  throw protocolError();
}

module.exports = { requestReply };
