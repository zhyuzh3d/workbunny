'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createVoiceTurns}=require('../src/main/voice-turns');
function fixture(){let at=0,next=0;const timers=new Map(),requests=[],remembered=[];let invalidations=0;
 const c=createVoiceTurns({now:()=>at,setTimer:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:at+delay});return id;},clearTimer:id=>timers.delete(id),onRequest:t=>requests.push(t),onRemember:t=>remembered.push(t),onInvalidate:()=>invalidations++});
 function advance(ms){const end=at+ms;while(true){const entries=[...timers].filter(([,x])=>x.at<=end).sort((a,b)=>a[1].at-b[1].at);if(!entries.length)break;const[id,x]=entries[0];at=x.at;timers.delete(id);x.fn();}at=end;}
 return {c,advance,requests,remembered,invalidations:()=>invalidations};}
test('request begins at one second, final confirmation does not duplicate it, commit waits for three seconds',async()=>{
 const f=fixture();f.c.partial('你在吗');f.advance(999);assert.equal(f.requests.length,0);f.advance(1);assert.equal(f.requests.length,1);
 let committed=false;f.requests[0].waitForCommit().then(v=>committed=v);f.advance(100);f.c.final('你在吗？');f.advance(1899);await Promise.resolve();assert.equal(committed,false);
 f.advance(1);await Promise.resolve();assert.equal(committed,true);assert.equal(f.requests.length,1);
});
test('continuation in three seconds merges segments and immediately rejects the old response',async()=>{
 const f=fixture();f.c.partial('帮我总结');f.advance(1000);const old=f.requests[0];f.c.final('帮我总结。');f.advance(500);f.c.partial('然后列出待办');
 assert.equal(old.isCurrent(),false);assert.equal(await old.waitForCommit(),false);assert.equal(f.invalidations(),1);
 f.advance(1000);assert.equal(f.requests[1].text,'帮我总结。\n然后列出待办');assert.deepEqual(f.remembered,[]);
 f.c.final('然后列出待办。');f.advance(2000);assert.equal(await f.requests[1].waitForCommit(),true);
});
test('a new turn preserves an unanswered prior user turn, discards its response, and avoids double history',async()=>{
 const f=fixture();f.c.partial('第一轮问题');f.advance(1000);f.c.final('第一轮问题。');f.advance(2200);const old=f.requests[0];
 f.c.partial('第二轮问题');assert.deepEqual(f.remembered,['第一轮问题。']);assert.equal(old.isCurrent(),false);
 f.advance(1000);f.c.final('第二轮问题。');f.advance(2000);f.requests[1].remember();f.requests[1].remember();
 assert.deepEqual(f.remembered,['第一轮问题。','第二轮问题。']);
});
test('a changed final cancels provisional words; no reply can commit without a final',async()=>{
 const f=fixture();f.c.partial('打开邮件');f.advance(1000);const old=f.requests[0];let settled=false;old.waitForCommit().then(()=>settled=true);
 f.advance(2500);await Promise.resolve();assert.equal(settled,false);
 f.c.final('不要打开邮件。');assert.equal(old.isCurrent(),false);f.advance(0);
 assert.equal(f.requests[1].text,'不要打开邮件。');assert.equal(await f.requests[1].waitForCommit(),true);
});
test('reset cancels active and queued callbacks',()=>{
 const f=fixture();f.c.partial('你好');f.advance(1000);const old=f.requests[0];f.c.reset();assert.equal(old.isCurrent(),false);f.advance(10000);assert.equal(f.requests.length,1);
});
test('missing final is bounded; recognizer exit cancels unconfirmed text but preserves confirmed responses',async()=>{
 const f=fixture();f.c.partial('未确认的原文');f.advance(1000);const old=f.requests[0];f.advance(8000);assert.equal(old.isCurrent(),false);assert.equal(await old.waitForCommit(),false);assert.equal(f.c.snapshot(),null);
 f.c.partial('下一句');f.advance(1000);const next=f.requests[1];f.c.recognizerStopped();assert.equal(next.isCurrent(),false);
 f.c.partial('已经确认');f.c.final('已经确认。');f.advance(1000);const final=f.requests[2];f.c.recognizerStopped();assert.equal(final.isCurrent(),true);f.advance(2000);assert.equal(await final.waitForCommit(),true);
});
test('partial punctuation confirmation does not cancel an already issued request or restart the pause',()=>{
 const f=fixture();f.c.partial('你确定啊');f.advance(1000);const request=f.requests[0];f.c.partial('你确定啊 ？');f.advance(1000);assert.equal(f.requests.length,1);assert.equal(request.isCurrent(),true);f.c.final('你确定啊？');f.advance(1000);assert.equal(f.requests.length,1);assert.equal(request.isCurrent(),true);
});
