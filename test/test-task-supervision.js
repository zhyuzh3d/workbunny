'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { TaskSupervision, explicitEstimate } = require('../src/main/task-supervision');
const MINUTE=60000;
test('local estimates recognize explicit times, overdue does not require silence and reminders deduplicate', () => {
  let now=1000;const s=new TaskSupervision({clock:()=>now});
  const snap={sessionId:'one',lastEventAt:now,task:{id:1,userText:'预计2分钟完成检查',startedAt:now,status:'running'}};
  s.observe([snap]);now+=3*MINUTE;snap.lastEventAt=now;s.observe([snap]);
  const e=s.take();assert.equal(e.kind,'overdue');assert.match(e.text,/仍在运行/);s.acknowledge(e);s.observe([snap]);assert.equal(s.take(),null);
  assert.equal(explicitEstimate('预计还需 5 分钟').remaining,true);assert.equal(explicitEstimate('命令超时5分钟'),null);
});
test('a busy owner can receive queued reminders later, while recovered stalls and stale notices are removed', () => {
  let now=1000;const s=new TaskSupervision({clock:()=>now});const snap={sessionId:'one',lastEventAt:now,task:{id:1,userText:'检查',startedAt:now,status:'running'}};
  s.observe([snap]);now+=6*MINUTE;s.observe([snap]);assert(s.pending.some(e=>e.kind==='stall'));
  snap.lastEventAt=now;s.observe([snap]);assert(!s.pending.some(e=>e.kind==='stall'));
  snap.task.waitingForUser=true;s.observe([snap]);assert.equal(s.take().kind,'waiting');
});
test('one failed command does not alert; repeated errors do, bound task completion is not announced twice', () => {
  let now=1000;const s=new TaskSupervision({clock:()=>now});const snap={sessionId:'one',lastEventAt:now,task:{id:1,bunnyTaskId:'owned',userText:'开发',startedAt:now,status:'running',consecutiveFailures:1}};
  s.observe([snap]);now+=20000;snap.lastEventAt=now;s.observe([snap]);assert.equal(s.take(),null);
  snap.task.consecutiveFailures=3;s.observe([snap]);assert.equal(s.take().kind,'repeated-errors');
  snap.task.status='ok';snap.task.endedAt=now;s.observe([snap]);assert.equal(s.take(),null);
});
