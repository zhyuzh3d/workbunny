'use strict';
const { test } = require('node:test'), assert = require('assert/strict');
const { SessionGate } = require('../src/main/session-gate');
test('locked startup never calls keychain, and unlock is loaded once', async () => {
  let locked = true, keychainCalls = 0, stopped = 0;
  const gate = new SessionGate({ readLocked: async () => locked, onLocked: () => { stopped++; }, onUnlocked: () => { keychainCalls++; } });
  await gate.start(); assert.equal(keychainCalls, 0); assert.equal(stopped, 1);
  await gate.refresh(); assert.equal(stopped, 1);
  locked = false; await gate.refresh(); await gate.refresh(); assert.equal(keychainCalls, 1);
  gate.lock(); assert.equal(stopped, 2); gate.close();
});
test('failed lock status fails closed without touching encrypted memory', async () => {
  let keychainCalls = 0;
  const gate = new SessionGate({ readLocked: async () => { throw Error('native unavailable'); }, onLocked() {}, onUnlocked: () => { keychainCalls++; } });
  await gate.start(); assert.equal(gate.locked, true); assert.equal(keychainCalls, 0); gate.close();
});
test('a lock event invalidates an older in-flight unlocked result', async () => {
  let resolve, calls = 0;
  const gate = new SessionGate({ readLocked: () => new Promise(r => { resolve = r; }), onLocked() {}, onUnlocked() { calls++; } });
  const pending = gate.refresh(); gate.lock(); resolve(false); await pending;
  assert.equal(calls, 0); assert.equal(gate.locked, true); gate.close();
});
test('closing while status is pending cannot reopen the vault', async () => {
  let resolve, calls = 0;
  const gate = new SessionGate({ readLocked: () => new Promise(r => { resolve = r; }), onLocked() {}, onUnlocked() { calls++; } });
  const pending = gate.start(); gate.close(); resolve(false); await pending;
  assert.equal(calls, 0); assert.equal(gate.timer, null);
});
