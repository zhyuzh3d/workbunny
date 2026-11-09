'use strict';

// Private synthetic display for the submission-recovery tests. A fake VLM reads
// the scene attached to the exact supplied pixels; no window, AX or OCR API is
// present. This exercises the real VisualSession and its native input proof.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { raster, bitmap, crop, encode } = require('./visual-fixture.cjs');
const { requestVerification } = require('../../src/main/verification-transport');

function recoveryVisual({ initial = {}, onCall = () => {}, onSubmit = async () => {}, onDraftCheck = () => {} } = {}) {
  const state = {
    identity: 'synthetic-work-account', available: true, mode: 'home',
    marker: '[workbunny:initial-fixture]', model: 'deepseek-v4.1-flash',
    draftText: '', focused: false, sendVisible: true, ...initial
  };
  const calls = [], judgments = [], locations = [], snapshots = new Map();
  let beforeNextCapture = null;
  const rect = { x: 0, y: 0, width: 1000, height: 800 };
  const identityRegion = { x: .02, y: .02, width: .2, height: .1 };
  const composerRegion = { x: .2, y: .7, width: .7, height: .25 };
  function paint(image, region, value) {
    const color = [...crypto.createHash('sha256').update(JSON.stringify(value)).digest().subarray(0, 3), 255];
    for (let y = Math.floor(region.y * image.height); y < Math.ceil((region.y + region.height) * image.height); y++)
      for (let x = Math.floor(region.x * image.width); x < Math.ceil((region.x + region.width) * image.width); x++)
        image.data.set(color, (y * image.width + x) * 4);
  }
  function capture() {
    beforeNextCapture?.(); beforeNextCapture = null;
    const visible = structuredClone(state), image = raster();
    paint(image, identityRegion, visible.identity);
    paint(image, { x: .02, y: .2, width: .7, height: .45 }, [visible.mode, visible.marker, visible.model, visible.available]);
    paint(image, composerRegion, [visible.draftText, visible.focused, visible.sendVisible]);
    const pngBase64 = encode(image).toString('base64'); snapshots.set(pngBase64, visible);
    return { pngBase64, width: image.width, height: image.height, desktopRect: rect, backend: 'CGDisplayStream', capturedAt: Date.now() };
  }
  function scene(options) {
    const parts = options.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    const url = parts.find(part => part.type === 'image_url')?.image_url?.url;
    assert.match(url || '', /^data:image\/png;base64,/u, 'the VLM must receive actual display pixels');
    const visible = snapshots.get(url.slice(url.indexOf(',') + 1));
    assert(visible, 'the VLM may only inspect a scene that was actually captured');
    return visible;
  }
  const native = {
    close: async () => {}, cancel: async () => {},
    request: async (op, args = {}) => {
      calls.push({ op, a: args }); onCall(op, args);
      if (op === 'displayCapture') return capture();
      assert.equal(op, 'displayInput', 'recovery may not discover windows, inspect AX or use legacy input');
      assert(args.visualEvidence?.frameId, 'native input requires the actual visual-frame proof');
      assert.deepEqual(args.visualEvidence.displayRect, rect);
      assert(['click', 'key'].includes(args.action), 'recovery may only focus and submit the preserved draft');
      if (args.action === 'click') { state.focused = true; return { performed: true }; }
      assert.equal(args.key, 'enter'); assert.deepEqual(args.modifiers, []);
      assert.equal(state.focused, true, 'Enter must target the visibly focused original editor');
      await onSubmit(args); return { performed: true };
    }
  };
  const verificationRequest = async (options, dependencies) => {
    const visible = scene(options), system = options.messages[0].content;
    if (dependencies?.chat) return requestVerification(options, { ...dependencies, selectFree: async () => 'hy3' });
    if (system.includes('定位指定软件')) {
      const previous = locations.at(-1), sameIdentity = !previous || previous.identity === visible.identity;
      locations.push(visible);
      return { response: { text: JSON.stringify({
        software: 'WorkBuddy', available: visible.available, unique: true, active: true,
        sameIdentity, confidence: .99, region: { x: 0, y: 0, width: 1, height: 1 },
        mainRegion: { x: 0, y: 0, width: 1, height: 1 }, identityRegion,
        monitorRegions: [{ x: .02, y: .2, width: .88, height: .75 }],
        focusRegion: visible.focused ? composerRegion : null,
        focusEvidence: visible.focused ? 'Synthetic caret is visible in the preserved draft editor' : '',
        texts: [{ text: 'DeepSeek-V4.1-Flash', x: .6, y: .85, width: .2, height: .02, confidence: 1 }],
        evidence: 'Synthetic WorkBuddy heading and stable work-account identity are visible',
        reason: visible.available ? '' : 'The synthetic target is obscured'
      }) } };
    }
    assert(system.includes('只根据实际截图核对给定操作前提'), 'unexpected visual judgment contract');
    const input = JSON.parse(options.messages[1].content.find(part => part.type === 'text').text);
    const evidence = input.evidence || {}, action = evidence.action;
    let matched = visible.available && (evidence.expectedText === undefined || evidence.expectedText === visible.draftText) &&
      (evidence.mode === undefined || evidence.mode === visible.mode) &&
      (evidence.marker === undefined || evidence.marker === visible.marker) &&
      (evidence.workModel === undefined || evidence.workModel === visible.model);
    if (action?.action === 'key') matched &&= action.key === 'enter' && !action.modifiers.length && visible.focused;
    if (action?.action === 'click') matched &&= action.purpose === 'submit' ? visible.sendVisible :
      action.x >= composerRegion.x && action.x <= composerRegion.x + composerRegion.width &&
      action.y >= composerRegion.y && action.y <= composerRegion.y + composerRegion.height;
    judgments.push({ input, visible, matched });
    if (input.question.startsWith('只根据实际画面核实：')) onDraftCheck({ visible, input, afterCapture: action => { beforeNextCapture = action; } });
    return { response: { text: JSON.stringify({ matched, evidence: matched ? 'The captured original draft, round, model and visible action conditions match' : 'The captured draft, identity, focus or round has a visible conflict' }) } };
  };
  return { state, native, calls, judgments, locations, bitmap, imageCrop: crop, verificationRequest };
}

module.exports = { recoveryVisual };
