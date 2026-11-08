'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ActionLifecycle}=require('../src/main/action-lifecycle');
test('a narrative judgment cannot reopen a committed write or make a newer event replay it',async()=>{
 const lifecycle=new ActionLifecycle(),a=lifecycle.start({id:'a',taskId:'task',scope:'target',eventKey:'one',policy:'newer-event'});await a.commit();assert.equal(a.reconcile,undefined);await assert.rejects(a.retryBeforeEffect(),/只有确认未发令/);assert.equal(a.phase,'committed');
 lifecycle.supersede({taskId:'task',scope:'target',eventKey:'two'});assert.equal(a.signal.aborted,false);assert.equal(a.phase,'committed');a.finish();
});
test('only a newer event for the same declared scope supersedes a preparing action',()=>{
 const manager=new ActionLifecycle(),a=manager.start({id:'a',taskId:'1',scope:'wechat:alice',eventKey:'a1',policy:'newer-event'}),b=manager.start({id:'b',taskId:'2',scope:'wechat:bob',eventKey:'b1',policy:'newer-event'}),independent=manager.start({id:'c',taskId:'3',scope:'wechat:alice',policy:'independent'});
 assert.equal(manager.supersede({taskId:'2',scope:'wechat:bob',eventKey:'b2'}),1);assert(b.signal.aborted);assert.equal(a.signal.aborted,false);assert.equal(independent.signal.aborted,false);
 assert.equal(manager.supersede({taskId:'1',scope:'wechat:alice',eventKey:'a1'}),0);assert.equal(manager.supersede({taskId:'1',scope:'wechat:alice',eventKey:'a2'}),1);assert(a.signal.aborted);a.finish();b.finish();independent.finish();assert.equal(manager.active.size,0);
});
test('a protected draft stops at a checkpoint; a committed write finishes for verification',async()=>{
 const manager=new ActionLifecycle(),a=manager.start({id:'a',taskId:'1',scope:'alice',eventKey:'a1',policy:'newer-event'});await a.protect();manager.supersede({taskId:'1',scope:'alice',eventKey:'a2'});assert.equal(a.signal.aborted,false);assert.throws(()=>a.assertCurrent(),e=>e.code==='E_ACTION_SUPERSEDED');a.finish();
 const b=manager.start({id:'b',taskId:'2',scope:'alice',eventKey:'b1',policy:'newer-event'});await b.commit();manager.supersede({taskId:'2',scope:'alice',eventKey:'b2'});assert.equal(b.signal.aborted,false);assert.doesNotThrow(()=>b.assertCurrent());b.finish();
});
test('a proven pre-dispatch failure can retry, unless its event was superseded',async()=>{
 const manager=new ActionLifecycle(),a=manager.start({id:'a',taskId:'1',scope:'alice',eventKey:'a1',policy:'newer-event'});
 await a.protect();await a.retryBeforeEffect();assert.equal(a.phase,'preparing');await a.protect();
 manager.supersede({taskId:'1',scope:'alice',eventKey:'a2'});
 await assert.rejects(a.retryBeforeEffect(),e=>e.code==='E_ACTION_SUPERSEDED');a.finish();
 const b=manager.start({id:'b',taskId:'1'});await b.commit();
 await assert.rejects(b.retryBeforeEffect(),/只有确认未发令/);b.finish();
});
test('explicit cancellation affects only actions attached to that task signal',()=>{
 const manager=new ActionLifecycle(),parent=new AbortController(),other=new AbortController(),a=manager.start({id:'a',taskId:'1',parentSignal:parent.signal}),b=manager.start({id:'b',taskId:'2',parentSignal:other.signal});parent.abort();assert(a.signal.aborted);assert.equal(b.signal.aborted,false);a.finish();b.finish();
});
test('a matching contact event in a different task cannot cancel the original task action',()=>{
 const manager=new ActionLifecycle(),action=manager.start({id:'a',taskId:'task-a',scope:'wechat:alice',eventKey:'one',policy:'newer-event'});
 assert.equal(manager.supersede({taskId:'task-b',scope:'wechat:alice',eventKey:'two'}),0);assert.equal(action.signal.aborted,false);action.finish();
});
