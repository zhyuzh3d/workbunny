'use strict';

const SUBMISSION_ACTION_PROTOCOL = `nextAction must be null or exactly one of these submission action forms:
1. One send-button click: {"action":"click","purpose":"submit","x":0.85,"y":0.90}
2. Enter in an editor that is already focused: {"action":"key","key":"enter","modifiers":[],"purpose":"submit"}
   The only other allowed key is "return". Do not add modifiers.
3. Only when focusing the existing editor is necessary, one focus click followed by one Enter submit:
   {"action":"click","x":0.45,"y":0.80,"then":[{"action":"key","key":"enter","modifiers":[],"purpose":"submit"}]}
   The focus click has no purpose field. The then array has exactly one key action and no nested then.
Every x and y must be a finite normalized number with 0 <= n < 1, using the current screenshot.
An optional reason string may explain an action; a click may explicitly use "button":"left".
Use null when evidence is insufficient. Use only the exact action names "click" and "key"; aliases are invalid.
Do not type, clear, replace or recreate the draft, open a new task, use a right click, use shortcuts, submit twice, or add wait/done actions. No other fields or additional steps are allowed.`;

function actualType(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
function schemaError(value, expected, field='nextAction') {
  return Object.assign(new Error('提交动作不符合已定义的桌面协议'), {
    code: 'E_MODEL_SCHEMA',
    schemaAudit: { protocol: 'desktop-submission', field, expected, actualType: actualType(value) },
  });
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function knownFields(value, fields) { return Object.keys(value).every(key => fields.includes(key)); }
function submitKey(value) {
  return record(value) && value.action === 'key' && value.purpose === 'submit' &&
    ['enter', 'return'].includes(value.key) && Array.isArray(value.modifiers) && value.modifiers.length === 0 && value.then === undefined;
}
function validateSubmissionAction(value, validateAction) {
  if (value === null) return null;
  if (!record(value)) throw schemaError(value, 'submission-action-or-null');
  if (!['click','key'].includes(value.action)) throw schemaError(value.action,'click-or-key','nextAction.action');
  if(value.action==='click'&&Array.isArray(value.then)&&value.then.length===1&&record(value.then[0])&&value.then[0].action!=='key')
    throw schemaError(value.then[0].action,'key','nextAction.then[0].action');
  const keyFields = ['action', 'key', 'modifiers', 'purpose', 'reason'];
  const clickFields = ['action', 'x', 'y', 'purpose', 'button', 'reason', 'then'];
  let shape;
  try {
    if (value.action === 'key' && knownFields(value, keyFields) &&
        (value.modifiers === undefined || Array.isArray(value.modifiers) && value.modifiers.length === 0)) shape = 'key';
    else if (value.action === 'click' && knownFields(value, clickFields) &&
        (value.button === undefined || value.button === 'left')) {
      if (value.purpose === 'submit' && value.then === undefined) shape = 'click';
      else if (value.purpose === undefined && Array.isArray(value.then) && value.then.length === 1) {
        const next = value.then[0];
        if (record(next) && knownFields(next, keyFields) && next.action === 'key' &&
            (next.modifiers === undefined || Array.isArray(next.modifiers) && next.modifiers.length === 0)) shape = 'focus-key';
      }
    }
    if (!shape) throw schemaError(value, 'submit-click-or-enter-or-focus-enter');
    const action = validateAction(structuredClone(value));
    if (shape === 'key' && submitKey(action)) return structuredClone(action);
    if (shape === 'click' && action.action === 'click' && action.purpose === 'submit' && action.then === undefined) return structuredClone(action);
    if (shape === 'focus-key' && action.action === 'click' && action.purpose === undefined &&
        Array.isArray(action.then) && action.then.length === 1 && submitKey(action.then[0])) return structuredClone(action);
  } catch { /* Parser details and unknown model strings never enter diagnostics. */ }
  throw schemaError(value, 'submit-click-or-enter-or-focus-enter');
}

module.exports = { SUBMISSION_ACTION_PROTOCOL, validateSubmissionAction };
