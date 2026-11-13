'use strict';

const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const control = action => object({ action: { const: action } }, ['action']);
const intent = { anyOf: [
  require('./hearing-hotword-tools').ACTION_SCHEMA,
  object({ action: { const: 'avatar_select' }, avatar: { type: 'integer', minimum: 1, maximum: 512 }, reply: string(500) }, ['action', 'avatar']),
  ...['stop', 'status', 'resume'].map(control),
  object({ action: { const: 'self_update' }, ops: { type: 'array', minItems: 1, maxItems: 8, items: object({ op: { enum: ['add', 'replace', 'remove', 'lock', 'unlock', 'lock_all', 'unlock_all'] }, entryId: string(100), text: string(400), facet: { enum: ['identity', 'trait', 'value', 'behavior', 'interest'] }, condition: string(160), lock: { type: 'boolean' } }, ['op']) } }, ['action', 'ops']),
  ...['remember', 'learn_experience'].map(action => object({ action: { const: action }, content: string(1200), quotes: { type: 'array', minItems: 1, maxItems: 4, items: string(500) } }, ['action', 'content', 'quotes'])),
  ...['watch_pause', 'watch_resume', 'watch_stop', 'watch_status'].map(action => object({ action: { const: action }, recipient: string(100), id: string(100) }, ['action'])),
  object({ action: { const: 'contact_alias' }, recipient: string(100), alias: string(100) }, ['action', 'recipient', 'alias']),
  object({ action: { const: 'task_notifications' }, enabled: { type: 'boolean' }, recipient: string(100) }, ['action', 'enabled']),
  object({ action: { const: 'start' }, target: { enum: ['workbuddy', 'wechat'] }, goal: string(3000), criteria: string(1200), recipient: string(100),
    operation: { enum: ['send', 'read', 'draft', 'open', 'general'] }, message: string(3000),
    watch: object({ completion: { enum: ['manual', 'first_match'] }, mode: { enum: ['notify', 'reply'] }, policy: string(1200), intervalSeconds: { type: 'integer', minimum: 10, maximum: 300 },
      durationMinutes: { type: 'integer', minimum: 1, maximum: 10080 } }, ['mode', 'policy']),
  }, ['action', 'target', 'goal', 'criteria']),
] };
const schema = { anyOf: [
  { ...object({ kind: { const: 'chat' }, text: { ...string(8000), minLength: 0, description: '自然对话正文。动作或情绪控制仅放<m>单个分类ID或具体动作ID</m>、<e>单个情绪ID</e>标签中；分类和具体ID不拼接，控制ID不写入普通正文。仅有有效performance时可为空。' },
    performance: { ...string(600), description: '可选的本次表演要求，一两句，不含密码或密钥；要求本身不显示或朗读。' } }, ['kind', 'text']),
    anyOf: [{ properties: { text: { minLength: 1 } } }, { required: ['performance'] }] },
  object({ kind: { const: 'action' }, intent }, ['kind', 'intent']),
  object({ kind: { const: 'skip' } }, ['kind']),
] };

// Transport capabilities choose the wire format. This never replaces the shared
// local validator: JSON mode alone can return any JSON value, including scalars.
const CAPABILITIES = Object.freeze({ workbuddy: 'json_object', deepseek: 'json_object', grok: 'json_schema' });
function responseFormat(provider, capability = CAPABILITIES[provider] || 'json_object', { cognitive = false,allowTurnDisposition=false } = {}) {
  const c = require('./dialogue-cognition');
  const replySchema=allowTurnDisposition?{anyOf:[{...schema.anyOf[0],properties:{...schema.anyOf[0].properties,turnDisposition:{enum:['keep','replace']}},required:['kind','text','turnDisposition']},...schema.anyOf.slice(1)]}:schema;
  const cognitionSchema = object({ protocol: { const: 'dialogue-v2' }, stages: { type: 'array', minItems: 3, maxItems: 3, items: { anyOf: [
    object({ stage: { const: 'review' }, grade: { enum: c.GRADES }, note: { type: 'string', maxLength: 300 }, grasp: { enum: c.GRASP }, pace: { enum: c.PACE } }, ['stage', 'grade', 'note', 'grasp', 'pace']),
    object({ stage: { const: 'reply' }, reply: replySchema }, ['stage', 'reply']),
    object({ stage: { const: 'prediction' }, expect: { anyOf: [{ type: 'string', maxLength: 400 }, { type: 'null' }] },
      basis: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 256 } } }, ['stage', 'expect', 'basis']),
  ] } } }, ['protocol', 'stages']);
  return capability === 'json_schema' ? { type: 'json_schema', json_schema: { name: 'workbunny_reply', strict: true, schema: cognitive ? cognitionSchema : replySchema } } : { type: 'json_object' };
}
function validateReply(raw, { allowActions = true, cognitive = false, allowEmptyVoiceDecision = false,allowTurnDisposition=false } = {}) {
  if (cognitive) return require('./dialogue-cognition').decode(raw, inner => validateReply(inner, { allowActions,allowEmptyVoiceDecision,allowTurnDisposition }));
  let disposition;
  if(allowTurnDisposition){
    let value;try{value=require('./dialogue-actions').parseStrictJson(raw);}catch{}
    if(value?.kind==='chat'){
      disposition=Object.hasOwn(value,'turnDisposition')?value.turnDisposition:'keep';
      if(!['keep','replace'].includes(disposition))throw Object.assign(new Error('语音轮次处理方式无效'),{code:'E_REPLY_PROTOCOL'});
      if(Object.hasOwn(value,'turnDisposition')){const {turnDisposition,...inner}=value;raw=JSON.stringify(inner);}
    }
  }
  if(allowEmptyVoiceDecision&&allowActions){
    let value;try{value=require('./dialogue-actions').parseStrictJson(raw);}catch{}
    if(value&&value.kind==='chat'&&typeof value.text==='string'&&!value.text.trim()&&Object.keys(value).length===2)return {text:'',skipped:true};
  }
  const { makeActionGate } = require('./dialogue-actions');
  let text = '';
  const gate = makeActionGate(delta => { text += delta; }, { requireEnvelope: true });
  gate.push(raw); gate.flush();
  if (gate.error || (!allowActions && (gate.controlled || gate.performance || !text.trim()))) {
    const error = new Error('模型回复未通过对话协议校验'); error.code = 'E_REPLY_PROTOCOL'; throw error;
  }
  const parsed = require('./dialogue-actions').parseStrictJson(raw);
  return { text, ...(parsed.kind === 'chat' && parsed.text !== text ? { taggedText: parsed.text } : {}), intent: gate.intent, skipped: gate.skipped,
    ...(gate.performance ? { performance: gate.performance } : {}),
    ...(disposition?{turnDisposition:disposition}:{}) };
}

// Cognition is optional metadata. If only that metadata is invalid, a strictly
// validated, unambiguous chat can still be delivered. Never recover actions or
// skip decisions or performance requests from an invalid envelope.
function recoverCognitiveChat(raw,{allowTurnDisposition=false}={}) {
  let value;
  try { value = require('./dialogue-actions').parseStrictJson(raw); } catch { return null; }
  let inner = value;
  if (value && value.protocol === 'dialogue-v2' && Array.isArray(value.stages) &&
      value.stages.length === 3 && Object.keys(value).every(k => ['protocol', 'stages'].includes(k))) {
    const replies = value.stages.filter(x => x && typeof x === 'object' && !Array.isArray(x) && x.stage === 'reply');
    if (replies.length !== 1 || Object.keys(replies[0]).some(k => !['stage', 'reply'].includes(k))) return null;
    inner = replies[0].reply;
  }
  if (!inner || inner.kind !== 'chat' || Object.hasOwn(inner, 'performance')) return null;
  const innerRaw = JSON.stringify(inner);
  try {
    const validated = validateReply(innerRaw, { allowActions: false,allowTurnDisposition });
    return validated.text && !validated.intent && !validated.skipped ? { ...validated, innerRaw,...(allowTurnDisposition?{turnDisposition:'keep'}:{}) } : null;
  } catch { return null; }
}
function dialogueHistory(messages) {
  return messages.map(message => ({ ...message, ...require('./message-identity').wire(message) }));
}

module.exports = { responseFormat, validateReply, recoverCognitiveChat, dialogueHistory, schema, CAPABILITIES };
