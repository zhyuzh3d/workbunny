import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogueTopForHead } from '../src/renderer/dialogue-placement.mjs';
test('dialogue starts just above the stationary character and keeps space to read', () => {
  assert.equal(dialogueTopForHead(300, 800, 1), 282);
  assert.equal(dialogueTopForHead(500, 800, .5), 488);
  assert.equal(dialogueTopForHead(420, 1200, 2), 392);
  assert.equal(dialogueTopForHead(790, 800, 1), 620);
  assert.equal(dialogueTopForHead(-20, 800, 1), 10);
  assert.equal(dialogueTopForHead(NaN, 800, 1), 10);
});
