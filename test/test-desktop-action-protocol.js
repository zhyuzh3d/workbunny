'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAction } = require('../src/main/desktop-service');
const { SUBMISSION_ACTION_PROTOCOL, validateSubmissionAction } = require('../src/main/desktop-action-protocol');
const key = () => ({ action: 'key', key: 'enter', modifiers: [], purpose: 'submit' });
const click = () => ({ action: 'click', x: .8, y: .9, purpose: 'submit' });
const focus = () => ({ action: 'click', x: .4, y: .8, then: [key()] });
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('three supported submission forms normalize into fresh actions without changing their input', () => {
  let validations = 0;
  for (const input of [click(), { ...click(), button: 'left' }, key(), { ...key(), key: 'RETURN' }, focus()]) {
    const before = structuredClone(input); freeze(input);
    const result = validateSubmissionAction(input, value => { validations++; return validateAction(value); });
    assert.deepEqual(input, before);
    assert.notEqual(result, input);
    assert.equal(result.action, input.action);
    if (result.then) { assert.notEqual(result.then, input.then); assert.notEqual(result.then[0], input.then[0]); assert.equal(result.then[0].purpose, 'submit'); }
    else assert.equal(result.purpose, 'submit');
  }
  assert.equal(validations, 5);
  assert.equal(validateSubmissionAction(null, () => assert.fail('null must not invoke the action parser')), null);
  for (const example of SUBMISSION_ACTION_PROTOCOL.match(/\{[^\n]+\}/gu)) assert.doesNotThrow(() => validateSubmissionAction(JSON.parse(example), validateAction));
});

test('unsupported shapes cannot introduce input, shortcuts, extra steps or aliases', () => {
  const privateCanary = 'private-model-action-canary';
  const invalid = [undefined, [], 'click', 1, true, {}, { action: privateCanary },
    { ...focus(), then: [{ action: privateCanary }] },
    { action: 'type', text: privateCanary }, { action: 'wait' }, { action: 'done', completed: false },
    { action: 'key', key: 'backspace', modifiers: [], purpose: 'submit' },
    { ...key(), modifiers: ['cmd'] }, { ...key(), modifiers: 'cmd' }, { ...key(), purpose: 'navigation' },
    { ...key(), then: [] }, { ...click(), button: 'right' }, { ...focus(), button: 'right' },
    { ...click(), x: -1 }, { ...click(), x: 1 }, { ...click(), y: Infinity }, { ...click(), x: '0.5' },
    { action: 'click', x: .4, y: .8 }, { ...click(), then: [key()] }, { ...click(), then: [] },
    { ...focus(), then: [] }, { ...focus(), then: [key(), key()] },
    { ...focus(), then: [click()] }, { ...focus(), then: [{ ...key(), then: [] }] },
    { ...focus(), then: [{ ...key(), modifiers: ['shift'] }] },
    { ...focus(), then: [{ ...key(), purpose: undefined }] },
    { ...click(), text: privateCanary }, { ...focus(), then: [{ ...key(), extra: privateCanary }] },
  ];
  for (const input of invalid) {
    const before = structuredClone(input);
    assert.throws(() => validateSubmissionAction(input, validateAction), error => {
      assert.equal(error.code, 'E_MODEL_SCHEMA');
      assert.equal(error.schemaAudit.protocol, 'desktop-submission');
      assert.match(error.schemaAudit.field, /^nextAction(?:\.action|\.then\[0\]\.action)?$/u);
      assert.match(error.schemaAudit.expected, /^[a-z-]+$/u);
      assert(!JSON.stringify(error).includes(privateCanary));
      assert(!error.message.includes(privateCanary));
      return true;
    });
    assert.deepEqual(input, before);
  }
});

test('upstream parser failures are replaced with a safe audit rather than copied', () => {
  const secret = 'private-parser-error-canary';
  assert.throws(() => validateSubmissionAction(key(), () => { throw Object.assign(Error(secret), { schemaAudit: { secret } }); }), error =>
    error.code === 'E_MODEL_SCHEMA' && !JSON.stringify(error).includes(secret) && !error.message.includes(secret));
});
