'use strict';
const { test } = require('node:test'), assert = require('assert/strict');
const { SessionGate, readSessionLocked } = require('../src/main/session-gate');
test('the session-only native parser rejects an unavailable dictionary and recovers without querying the OS', t => {
  if(process.platform!=='darwin')return t.skip('requires the Swift Foundation runtime');
  const source=require('node:fs').readFileSync(require.resolve('../native/desktop.swift'),'utf8');
  const error=source.slice(source.indexOf('struct DesktopError:'),source.indexOf('struct CaptureUnavailableError:'));
  const parser=source.slice(source.indexOf('func checkedSessionLockState('),source.indexOf('func sessionLocked()'));
  const program='import Foundation\n'+error+'\n'+parser+`\n
    do { _ = try checkedSessionLockState(nil); fatalError("unavailable state was accepted") }
    catch let error as DesktopError { precondition(error.code == "E_SESSION_STATE_UNAVAILABLE" && error.dispatched == false) }
    let absent = try checkedSessionLockState([:])
    let locked = try checkedSessionLockState(["CGSSessionScreenIsLocked": true])
    let unlocked = try checkedSessionLockState(["CGSSessionScreenIsLocked": false])
    precondition(absent == false && locked == true && unlocked == false)
    print("session-parser-ok")
  `;
  const output=require('node:child_process').execFileSync('xcrun',['swift','-e',program],{encoding:'utf8',timeout:20000});
  assert.equal(output.trim(),'session-parser-ok');
});
test('session polling reads only native lock state and preserves lock/unlock lifecycle transitions', async () => {
  const calls = [], events = []; let locked = true;
  const native = { request: async (op, args, timeoutMs) => { calls.push({op,args,timeoutMs}); return {sessionLocked:locked}; } };
  const gate = new SessionGate({readLocked:()=>readSessionLocked(native),onLocked:()=>events.push('locked'),onUnlocked:()=>events.push('unlocked')});
  try {
    await gate.start(); await gate.refresh(); locked=false; await gate.refresh(); await gate.refresh();
    assert.deepEqual(events,['locked','unlocked']);
    assert.equal(calls.length,4); assert(calls.every(call=>call.op==='sessionState'&&call.timeoutMs===8000));
    assert(calls.every(call=>Object.keys(call.args).length===0),'lock checks carry no target or permission request');
  } finally { gate.close(); }
});
test('session read errors and malformed states fail closed and recover only on a confirmed unlocked state', async () => {
  for (const response of [null,{}, {sessionLocked:null}, {sessionLocked:0}, {sessionLocked:'false'}, Object.assign(Error('native unavailable'),{code:'E_SESSION_STATE_UNAVAILABLE'})]) {
    let result=response,unlocked=0,locked=0;
    const native={request:async()=>{if(result instanceof Error)throw result;return result;}};
    const gate=new SessionGate({readLocked:()=>readSessionLocked(native),onLocked:()=>locked++,onUnlocked:()=>unlocked++});
    try {
      await gate.start(); assert.equal(gate.locked,true); assert.equal(locked,1); assert.equal(unlocked,0);
      result={sessionLocked:false}; await gate.refresh(); await gate.refresh(); assert.equal(unlocked,1);
    } finally { gate.close(); }
  }
});
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
