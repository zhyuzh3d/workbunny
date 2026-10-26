'use strict';

const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const control = action => object({ action: { const: action } }, ['action']);
const intent = { anyOf: [
  ...['stop', 'status', 'resume'].map(control),
  ...['watch_pause', 'watch_resume', 'watch_stop', 'watch_status'].map(action => object({ action: { const: action }, recipient: string(100), id: string(100) }, ['action'])),
  object({ action: { const: 'contact_alias' }, recipient: string(100), alias: string(100) }, ['action', 'recipient', 'alias']),
  object({ action: { const: 'start' }, target: { enum: ['workbuddy', 'wechat'] }, goal: string(3000), criteria: string(1200), recipient: string(100),
    operation: { enum: ['send', 'read', 'draft', 'open', 'general'] }, message: string(3000),
    watch: object({ completion: { enum: ['manual', 'first_match'] }, mode: { enum: ['notify', 'reply'] }, policy: string(1200), intervalSeconds: { type: 'integer', minimum: 10, maximum: 300 },
      durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 } }, ['mode', 'policy']),
  }, ['action', 'target', 'goal', 'criteria']),
] };
const schema = { anyOf: [
  object({ kind: { const: 'chat' }, text: string(8000) }, ['kind', 'text']),
  object({ kind: { const: 'action' }, intent }, ['kind', 'intent']),
  object({ kind: { const: 'skip' } }, ['kind']),
] };

// Transport capabilities choose the wire format. This never replaces the shared
// local validator: JSON mode alone can return any JSON value, including scalars.
const CAPABILITIES = Object.freeze({ workbuddy: 'json_object', deepseek: 'json_object', grok: 'json_schema' });
function responseFormat(provider, capability = CAPABILITIES[provider] || 'json_object') {
  return capability === 'json_schema' ? { type: 'json_schema', json_schema: { name: 'workbunny_reply', strict: true, schema } } : { type: 'json_object' };
}
function validateReply(raw, { allowActions = true } = {}) {
  const { makeActionGate } = require('./dialogue-actions');
  let text = '';
  const gate = makeActionGate(delta => { text += delta; }, { requireEnvelope: true });
  gate.push(raw); gate.flush();
  if (gate.error || (!allowActions && (gate.controlled || !text.trim()))) {
    const error = new Error('模型回复未通过对话协议校验'); error.code = 'E_REPLY_PROTOCOL'; throw error;
  }
  return { text, intent: gate.intent, skipped: gate.skipped };
}
function dialogueHistory(messages) {
  return messages.map(message => message.role === 'assistant' ? { ...message, content: JSON.stringify({ kind: 'chat', text: message.content }) } : { ...message });
}
module.exports = { responseFormat, validateReply, dialogueHistory, schema, CAPABILITIES };
