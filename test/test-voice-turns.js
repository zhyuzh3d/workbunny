'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createVoiceTurns}=require('../src/main/voice-turns');
function fixture(options={}){
 let at=0,next=0,seq=0;const timers=new Map(),requests=[],remembered=[],errors=[],errorDetails=[];let invalidations=0;
 const c=createVoiceTurns({now:()=>at,setTimer:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:at+delay});return id;},clearTimer:id=>timers.delete(id),
  onRequest:token=>requests.push(token),onRemember:text=>{remembered.push(text);return {id:'fixture-receipt'};},onInvalidate:()=>invalidations++,onError:(error,details)=>{errors.push(error);errorDetails.push(details);},...options});
 function advance(ms){const end=at+ms;let loops=0;for(;;){const found=[...timers].filter(([,entry])=>entry.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!found)break;if(++loops>10000)throw Error('unbounded timer loop');at=found[1].at;timers.delete(found[0]);found[1].fn();}at=end;}
 function activity(state,quietSeconds=0,extra={}){return c.activity({state,quietSeconds,at,seq:++seq,recognizer:1,sourceGen:1,...extra});}
 function quietFor(ms,extra={}){for(let elapsed=100;elapsed<=ms;elapsed+=100){advance(100);activity('quiet',elapsed/1000,extra);}}
 return {c,advance,activity,quietFor,requests,remembered,errors,errorDetails,invalidations:()=>invalidations,now:()=>at,
  audioFinal:(extra={})=>c.audioFinal({recognizer:1,sourceGen:1,coveredSeq:seq,...extra})};
}
test('partial is display-only; a native final and the original three-second seal precede request and commit',async()=>{
 const f=fixture();f.c.partial('fixture question');f.advance(1000);assert.equal(f.requests.length,0);
 f.c.final('fixture question.');f.advance(1999);assert.equal(f.requests.length,0);f.advance(1);
 assert.equal(f.requests.length,1);assert.equal(await f.requests[0].waitForCommit(),true);
 f.requests[0].remember();f.requests[0].remember();assert.deepEqual(f.remembered,['fixture question.']);
});
test('multiple native segments before the seal retain their text in one request',async()=>{
 const f=fixture();f.c.partial('first segment');f.c.final('first segment.');f.advance(500);f.c.partial('second segment');f.c.final('second segment.');
 f.advance(2999);assert.equal(f.requests.length,0);f.advance(1);assert.equal(f.requests.length,1);
 assert.equal(f.requests[0].text,'first segment.\nsecond segment.');assert.equal(await f.requests[0].waitForCommit(),true);assert.deepEqual(f.remembered,[]);
});
test('new text revokes the old semantic request and retains its confirmed prefix until the combined revision is accepted',async()=>{
 const f=fixture();f.c.partial('first question');f.c.final('first question.');f.advance(3000);const old=f.requests[0];
 f.c.partial('second question');assert.deepEqual(f.remembered,[]);assert.equal(old.isCurrent(),false);assert.equal(await old.waitForCommit(),false);
 f.c.final('second question.');f.advance(3000);f.requests[1].remember();assert.deepEqual(f.remembered,['first question.\nsecond question.']);
});
test('a changed final uses the corrected text and a fresh text seal without ever requesting its provisional words',()=>{
 const f=fixture();f.c.partial('provisional instruction');f.advance(3500);assert.equal(f.requests.length,0);
 f.c.final('corrected instruction.');f.advance(2999);assert.equal(f.requests.length,0);f.advance(1);assert.equal(f.requests[0].text,'corrected instruction.');
});
test('reset cancels issued and queued callbacks',async()=>{
 const f=fixture();f.c.final('confirmed fixture');f.advance(3000);const old=f.requests[0];f.c.reset();
 assert.equal(old.isCurrent(),false);assert.equal(await old.waitForCommit(),false);f.advance(10000);assert.equal(f.requests.length,1);
});
test('a partial without a request has its own bounded confirmation deadline',()=>{
 const f=fixture();f.c.partial('unconfirmed fixture');f.advance(7999);assert.equal(f.requests.length,0);assert(f.c.snapshot());f.advance(1);
 assert.equal(f.c.snapshot(),null);assert.equal(f.errors.length,1);assert.deepEqual(f.remembered,[]);
});
test('punctuation-only partial and final updates do not restart the text seal',()=>{
 const f=fixture();f.c.partial('fixture question');f.advance(1500);f.c.partial('fixture question ?');f.advance(1000);f.c.final('fixture question?');f.advance(500);
 assert.equal(f.requests.length,1);assert.equal(f.c.snapshot().lastTextAt,0);f.c.final('fixture question?');f.advance(1000);assert.equal(f.requests.length,1);
});
test('delayed partial revisions preserve the full turn and never request or remember its truncated prefix',()=>{
 const f=fixture();f.c.partial('first provisional portion');f.advance(3500);f.c.partial('first provisional portion with the remaining condition');
 f.advance(1000);assert.equal(f.requests.length,0);assert.deepEqual(f.remembered,[]);
 f.c.final('first provisional portion with the remaining condition.');f.advance(2000);assert.equal(f.requests.length,1);assert.match(f.requests[0].text,/remaining condition/);
});
test('abstracted continuous-speech diagnostic timing never requests either stalled partial revision',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('synthetic first provisional portion');
 for(let i=0;i<30;i++){f.advance(100);f.activity('active');}
 f.c.partial('synthetic first provisional portion and remainder');
 for(let i=0;i<20;i++){f.advance(100);f.activity(i===19?'quiet':'active',i===19?.08:0);}
 assert.equal(f.requests.length,0);assert.equal(f.c.snapshot().finalized,false);assert.deepEqual(f.remembered,[]);
});
test('fresh quiet shorter than the required pause cannot approve a sealed native final',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('fixture speech');f.c.final('fixture speech.');f.advance(3000);f.activity('quiet',.08);f.advance(0);
 assert.equal(f.requests.length,0);f.advance(100);f.activity('quiet',1);f.advance(0);assert.equal(f.requests.length,1);
});
test('same-recognizer successor analyzer quiet may seal an already confirmed prior analyzer',async()=>{
 const f=fixture({requireActivity:()=>true});f.activity('active');f.c.partial('fixture speech');f.c.final('fixture speech.');f.quietFor(3000,{sourceGen:3});
 assert.equal(f.requests.length,1);assert.equal(await f.requests[0].waitForCommit(),true);
});
test('old epoch, analyzer and sequence events cannot revoke or approve newer evidence',()=>{
 const f=fixture({requireActivity:true});f.activity('quiet',1,{recognizer:2,sourceGen:3});f.c.final('fixture speech');f.quietFor(3000,{recognizer:2,sourceGen:3});
 const token=f.requests[0];assert(token.isCurrent());
 assert.equal(f.activity('active',0,{recognizer:1,sourceGen:9}),false);assert.equal(f.activity('active',0,{seq:0,recognizer:2,sourceGen:3}),false);
 assert.equal(f.activity('active',0,{recognizer:2,sourceGen:1}),false);assert(token.isCurrent());
 f.activity('unknown',0,{recognizer:2,sourceGen:3});assert.equal(token.isCurrent(),true);assert.equal(token.canCommit(),false);assert.equal(f.requests.length,1);
 assert.equal(f.activity('quiet',10,{seq:0,recognizer:2,sourceGen:3}),false);f.advance(0);assert.equal(f.requests.length,1);
});
test('active without new text preserves the semantic request but cannot use the old final to cover new audio',async()=>{
 const f=fixture({requireActivity:true});f.activity('quiet',1);f.c.final('prior confirmed phrase');f.quietFor(3000);const token=f.requests[0];
 f.activity('active');assert.equal(token.isCurrent(),true);assert.equal(token.canCommit(),false);assert.equal(f.invalidations(),0);
 f.quietFor(1000);assert.equal(f.requests.length,1);assert.equal(f.c.snapshot().awaitingAudioFinal,true);assert.deepEqual(f.remembered,[],'activity cannot persist the old final');
});
test('activity before a request requires another native final even after quiet recovers',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('confirmed prefix');f.c.final('confirmed prefix.');f.advance(1000);f.activity('active');f.quietFor(3000);
 assert.equal(f.requests.length,0);assert.equal(f.c.snapshot().awaitingAudioFinal,true);
 f.c.final('confirmed prefix.');f.advance(0);assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'confirmed prefix.');
});
test('post-final activity in a successor analyzer stays unconfirmed and reaches the original bounded failure',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('synthetic confirmed prefix');f.c.final('synthetic confirmed prefix.');
 f.advance(34);f.activity('active',0,{sourceGen:3});f.quietFor(5000,{sourceGen:3});
 assert.equal(f.requests.length,0);assert.equal(f.c.snapshot().awaitingAudioFinal,true);assert.equal(f.errors.length,0);
 f.advance(2966);assert.equal(f.c.snapshot(),null);assert.equal(f.errors.length,1);assert.equal(f.requests.length,0);assert.deepEqual(f.remembered,[]);
 assert.equal(f.errorDetails[0].reason,'confirmation-timeout');assert.equal(f.errorDetails[0].awaitingAudioFinal,true);assert.equal(f.errorDetails[0].segments,1);
});
test('a genuinely finalized empty successor covers ambient activity and admits the preserved words once',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('synthetic owner request');f.c.final('synthetic owner request.');
 f.advance(34);f.activity('active',0,{sourceGen:3});f.quietFor(1500,{sourceGen:3});
 assert.equal(f.requests.length,0);assert.equal(f.c.snapshot().waitingAudio,true);
 assert.equal(f.audioFinal({sourceGen:3}),true);f.quietFor(1500,{sourceGen:5});
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'synthetic owner request.');assert.equal(f.errors.length,0);
 assert.equal(f.audioFinal({sourceGen:3}),false);f.quietFor(5000,{sourceGen:5});assert.equal(f.requests.length,1);
});
test('empty coverage reopens the existing accepted token without repeating semantic inference',async()=>{
 const f=fixture({requireActivity:true});f.c.final('synthetic confirmed owner request');f.quietFor(3000);const token=f.requests[0];
 f.activity('active',0,{sourceGen:3});const waiting=token.waitForCommit();f.quietFor(1000,{sourceGen:3});
 assert.equal(token.canCommit(),false);assert.equal(f.audioFinal({sourceGen:3}),true);assert.equal(await waiting,true);
 assert.equal(token.canCommit(),true);assert.equal(f.requests.length,1);assert.equal(f.invalidations(),0);
});
test('empty audio confirmed near the text deadline cannot strand a confirmed turn behind its own covered activity',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('synthetic complete owner request');
 f.advance(500);f.activity('active');f.c.final('synthetic complete owner request');
 f.advance(500);f.activity('active',0,{sourceGen:3});
 for(let i=0;i<54;i++){f.advance(100);f.activity('active',0,{sourceGen:3});}
 f.quietFor(1200,{sourceGen:3});assert.equal(f.now(),7600);assert.equal(f.requests.length,0);
 assert.equal(f.audioFinal({sourceGen:3}),true);f.advance(0);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'synthetic complete owner request');assert.equal(f.requests[0].canCommit(),true);
 f.quietFor(1000,{sourceGen:5});assert.equal(f.errors.length,0);assert.equal(f.requests.length,1);
});
test('empty coverage restores the previous speech seal without shortening it or creating another semantic request',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('synthetic confirmed words');
 f.advance(500);f.activity('active');f.c.final('synthetic confirmed words');
 f.advance(100);f.activity('active',0,{sourceGen:3});f.quietFor(1000,{sourceGen:3});assert.equal(f.audioFinal({sourceGen:3}),true);
 f.advance(0);assert.equal(f.requests.length,0);f.quietFor(1800,{sourceGen:5});assert.equal(f.requests.length,0);
 f.quietFor(100,{sourceGen:5});assert.equal(f.now(),3500);assert.equal(f.requests.length,1);
 f.activity('active',0,{sourceGen:5});assert.equal(f.requests[0].canCommit(),false);
 f.quietFor(1000,{sourceGen:5});assert.equal(f.audioFinal({sourceGen:5}),true);f.advance(0);
 assert.equal(f.requests[0].canCommit(),true);assert.equal(f.requests.length,1);assert.equal(f.errors.length,0);
});
test('empty final never manufactures words, clears a partial, or revives an ended turn',()=>{
 const idle=fixture({requireActivity:true});idle.activity('active');idle.quietFor(1000);assert.equal(idle.audioFinal(),false);assert.equal(idle.requests.length,0);
 const partial=fixture({requireActivity:true});partial.c.final('synthetic confirmed prefix');partial.activity('active');partial.c.partial('synthetic unconfirmed condition');partial.quietFor(1000);
 assert.equal(partial.audioFinal(),false);assert.equal(partial.c.snapshot().finalized,false);assert.equal(partial.requests.length,0);
 partial.c.reset();assert.equal(partial.audioFinal(),false);partial.advance(10000);assert.equal(partial.requests.length,0);
});
test('empty final must cover the exact current native sequence and source, while later active still closes the gate',()=>{
 const f=fixture({requireActivity:true});f.c.final('synthetic confirmed prefix');f.activity('active');f.quietFor(1000);
 for(const extra of [{sourceGen:0},{sourceGen:2},{recognizer:0},{recognizer:2},{coveredSeq:1},{coveredSeq:999},{coveredSeq:NaN}]){
  assert.equal(f.audioFinal(extra),false);assert.equal(f.c.snapshot().waitingAudio,true);
 }
 f.activity('unknown');assert.equal(f.audioFinal(),false);f.activity('quiet',1);assert.equal(f.audioFinal(),true);
 f.activity('active',0,{sourceGen:3});assert.equal(f.c.snapshot().waitingAudio,true);f.quietFor(4000,{sourceGen:3});assert.equal(f.requests.length,0);
});
test('a later empty generation cannot erase an earlier uncovered segment rejected by speaker or echo filtering',()=>{
 const f=fixture({requireActivity:true});f.c.final('synthetic authenticated prefix');
 f.activity('active',0,{sourceGen:3});f.quietFor(1000,{sourceGen:3});
 // Gen 3 finished with words, but its partial/final did not pass the pipeline.
 f.activity('active',0,{sourceGen:5});f.quietFor(1000,{sourceGen:5});
 assert.equal(f.audioFinal({sourceGen:5}),false);assert.equal(f.c.snapshot().waitingAudio,true);f.quietFor(3000,{sourceGen:5});assert.equal(f.requests.length,0);
});
test('unknown and stale activity close effects without revoking semantic tokens or repeating the request',async()=>{
 for(const state of ['unknown','stale']){
  const f=fixture({requireActivity:true});f.activity('quiet',1);f.c.final('confirmed fixture');f.quietFor(3000);const token=f.requests[0];
  if(state==='unknown')f.activity('unknown');else f.advance(501);
  assert.equal(token.isCurrent(),true);assert.equal(token.canCommit(),false);assert.equal(token.remember(),undefined);assert.deepEqual(f.remembered,[]);assert.equal(f.invalidations(),0);
  let settled=false;const waiting=token.waitForCommit().then(value=>{settled=true;return value;});await Promise.resolve();assert.equal(settled,false);
  f.activity('quiet',2);assert.equal(await waiting,true);assert.equal(token.canCommit(),true);assert.equal(f.requests.length,1);
 }
});
test('new-sequence malformed time becomes an unknown veto rather than preserving prior quiet',()=>{
 const f=fixture({requireActivity:true});f.activity('quiet',1);f.c.final('confirmed fixture');f.quietFor(3000);const token=f.requests[0];
 assert.equal(f.activity('quiet',10,{at:Infinity}),false);assert.equal(token.isCurrent(),true);assert.equal(token.canCommit(),false);assert.deepEqual(f.remembered,[]);
});
test('continuous activity and unchanged text never renew the confirmation deadline',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('pending fixture');
 for(let i=0;i<90;i++){f.advance(100);f.activity('active');f.c.partial('pending fixture');}
 assert.equal(f.requests.length,0);assert.equal(f.c.snapshot(),null);assert.equal(f.errors.length,1);
});
test('healthy quiet idle never creates a turn or error, while missing activity bounds a final too',()=>{
 const idle=fixture({requireActivity:true});idle.quietFor(20000);assert.equal(idle.c.snapshot(),null);assert.equal(idle.errors.length,0);
 const f=fixture({requireActivity:true});f.c.final('confirmed but no activity');f.advance(8000);assert.equal(f.requests.length,0);assert.equal(f.c.snapshot(),null);assert.equal(f.errors.length,1);
});
test('graceful code-zero restart preserves a final until fresh successor-epoch quiet seals it',()=>{
 const f=fixture({requireActivity:true});f.activity('quiet',1);f.c.partial('last confirmed phrase');f.c.final('last confirmed phrase.');f.advance(100);
 f.c.recognizerStopped({graceful:true});assert.equal(f.c.snapshot().finalized,true);f.activity('quiet',1,{recognizer:2,sourceGen:1});
 f.quietFor(3000,{recognizer:2,sourceGen:1});assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'last confirmed phrase.');assert.equal(f.errors.length,0);
});
test('a restarted recognizer cannot carry an unconfirmed partial into a new epoch',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('unconfirmed old phrase');f.advance(100);f.activity('quiet',1,{recognizer:2});
 assert.equal(f.c.snapshot(),null);assert.equal(f.errors.length,1);f.quietFor(3000,{recognizer:2});assert.equal(f.requests.length,0);
});
test('noise never requests or reports an error; configured short answers still need a final',()=>{
 const noise=fixture();noise.c.partial('...');noise.c.final('...');noise.advance(8000);assert.equal(noise.requests.length,0);assert.equal(noise.errors.length,0);
 const short=fixture({allowShort:()=>true});short.c.partial('嗯');short.advance(1000);assert.equal(short.requests.length,0);short.c.final('嗯');short.advance(2000);assert.equal(short.requests.length,1);
});
test('confirmation timeout reports only fixed metadata after cancelling the turn and offers speech or text recovery',()=>{
 const events=[],privateText='synthetic-private-transcript-canary';
 const f=fixture({sessionId:'fixture-session',onError:(message,metadata)=>{assert.equal(f.c.snapshot(),null);events.push({message,metadata});}});
 f.activity('active',0,{recognizer:4,sourceGen:7});f.c.partial(privateText);f.advance(8000);
 assert.equal(events.length,1);assert.match(events[0].message,/未提交/);assert.match(events[0].message,/完整重说/);assert.match(events[0].message,/输入文字/);
 assert.deepEqual(events[0].metadata,{reason:'confirmation-timeout',turn:1,turnId:'fixture-session:1',admitted:false,awaitingAudioFinal:false,finalized:false,
  partialChars:privateText.length,segments:0,chars:privateText.length,lastTextAt:0,recognizer:4,sourceGen:7});
 assert(!JSON.stringify(events).includes(privateText));assert.equal(f.requests.length,0);assert.deepEqual(f.remembered,[]);
 f.advance(10000);assert.equal(events.length,1,'one timeout must not create a recurring recovery request');
});
test('missing activity never fabricates a recognizer identity for timeout recovery',()=>{
 const f=fixture({requireActivity:true});f.c.partial('synthetic pending words');f.advance(8000);
 assert.equal(f.errorDetails[0].reason,'confirmation-timeout');assert.equal(f.errorDetails[0].recognizer,null);assert.equal(f.errorDetails[0].sourceGen,null);
});
test('recognizer cancellation reasons cannot be mistaken for a confirmation-timeout retry',()=>{
 const stopped=fixture({requireActivity:true});stopped.activity('active');stopped.c.partial('synthetic stopped words');stopped.c.recognizerStopped();
 assert.equal(stopped.errorDetails[0].reason,'recognizer-stopped');stopped.advance(10000);assert.equal(stopped.errorDetails.length,1);
 const changed=fixture({requireActivity:true});changed.activity('active');changed.c.partial('synthetic changed words');changed.activity('quiet',1,{recognizer:2});
 assert.equal(changed.errorDetails[0].reason,'recognizer-changed');assert.equal(changed.errorDetails[0].recognizer,1);
});
test('a real continuation with a delayed final cannot execute the confirmed prefix before the complete suffix',()=>{
 const f=fixture({requireActivity:true});f.activity('active');f.c.partial('synthetic confirmed prefix');f.c.final('synthetic confirmed prefix.');
 f.advance(1000);f.activity('active',0,{sourceGen:3});f.quietFor(3000,{sourceGen:3});assert.equal(f.requests.length,0);
 f.c.partial('synthetic continued condition');f.quietFor(2000,{sourceGen:3});assert.equal(f.requests.length,0);
 f.c.final('synthetic continued condition.');f.quietFor(1000,{sourceGen:3});f.advance(0);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'synthetic confirmed prefix.\nsynthetic continued condition.');assert.equal(f.errors.length,0);
});
test('a slow semantic computation survives raw unknown and resumes effects with the same accepted token',async()=>{
 const f=fixture({requireActivity:true});f.c.final('synthetic admitted request');f.quietFor(7000);const token=f.requests[0];
 assert.equal(token.accepted,true);assert.equal(token.isCurrent(),true);f.activity('unknown');
 let done=false;const pending=token.waitForCommit().then(value=>{done=true;return value;});
 for(let i=0;i<70;i++){f.advance(100);f.activity('unknown');}
 await Promise.resolve();assert.equal(done,false);assert.equal(token.isCurrent(),true);assert.equal(f.errors.length,0,'the old text deadline does not apply to an admitted turn');
 f.activity('quiet',2,{sourceGen:3});assert.equal(await pending,true);assert.equal(token.canCommit(),true);assert.equal(f.requests.length,1);assert.equal(f.invalidations(),0);
});
test('post-admission active requires a new final and times out eight seconds after the first gate closure',async()=>{
 const trace=[],f=fixture({requireActivity:true,onTrace:event=>trace.push(event)});f.c.final('synthetic admitted request');f.quietFor(3000);const token=f.requests[0];
 f.advance(100);f.activity('active');const pending=token.waitForCommit();
 f.quietFor(7900,{sourceGen:3});assert.equal(f.now(),11000);assert.equal(f.errors.length,0);assert.equal(token.isCurrent(),true);assert.equal(token.canCommit(),false);
 assert.equal(f.c.snapshot().finalized,true);assert.equal(f.c.snapshot().waitingAudio,true);assert.equal(f.requests.length,1);
 f.advance(99);assert.equal(f.errors.length,0);f.advance(1);assert.equal(await pending,false);assert.equal(f.invalidations(),1);assert.equal(f.c.snapshot(),null);
 assert.equal(f.errorDetails[0].reason,'commit-timeout');assert.equal(f.errorDetails[0].admitted,true);assert.equal(f.errorDetails[0].finalized,true);assert.match(f.errors[0],/前句已经确认/);assert.match(f.errors[0],/待提交操作/);
 assert(trace.some(event=>event.stage==='turn-invalidated'&&event.reasonCode===6));
 const closed=trace.find(event=>event.stage==='turn-gate-closed');assert.equal(closed.reasonCode,8);assert.equal(closed.activityAgeMs,0);assert(Number.isFinite(closed.activitySeq));assert.equal(closed.quietSeconds,0);
 f.advance(10000);assert.equal(f.errors.length,1);assert.equal(await token.waitForCommit(),false);
});
test('a later covering final may reopen an active-closed gate without creating another semantic request',async()=>{
 const f=fixture({requireActivity:true});f.c.final('synthetic confirmed request');f.quietFor(3000);const token=f.requests[0];
 f.activity('active');const first=token.waitForCommit(),second=token.waitForCommit();f.quietFor(1500,{sourceGen:3});assert.equal(token.canCommit(),false);
 f.c.final('synthetic confirmed request.');assert.equal(await first,true);assert.equal(await second,true);assert.equal(token.isCurrent(),true);assert.equal(f.requests.length,1);assert.equal(f.invalidations(),0);
});
test('real text continuation invalidates the admitted revision and preserves its prefix for the next complete request',async()=>{
 const trace=[],f=fixture({requireActivity:true,onTrace:event=>trace.push(event)});f.c.final('synthetic confirmed prefix');f.quietFor(3000);const old=f.requests[0];
 f.activity('active');const pending=old.waitForCommit();f.advance(300);f.c.partial('synthetic added condition');
 assert.equal(old.isCurrent(),false);assert.equal(await pending,false);assert.equal(f.invalidations(),1);assert.deepEqual(f.remembered,[]);
 f.c.final('synthetic added condition.');f.quietFor(3000,{sourceGen:3});assert.equal(f.requests.length,2);assert.equal(f.requests[1].text,'synthetic confirmed prefix\nsynthetic added condition.');
 assert(trace.some(event=>event.stage==='turn-invalidated'&&event.reasonCode===1));assert.equal(await old.waitForCommit(),false);
});
test('unknown and fresh quiet flapping never repeats an admitted semantic request',()=>{
 const f=fixture({requireActivity:true});f.c.final('synthetic admitted request');f.quietFor(3000);const token=f.requests[0];
 for(let i=0;i<90;i++){f.advance(100);f.activity(i%2?'quiet':'unknown',2);}
 assert.equal(f.requests.length,1);assert.equal(token.isCurrent(),true);assert.equal(token.canCommit(),true);assert.equal(f.errors.length,0);assert.equal(f.invalidations(),0);
});
test('reset, recognizer stop and a real recognizer epoch change reject old and late commit waiters',async()=>{
 for(const operation of ['reset','stop','epoch']){
  const trace=[],f=fixture({requireActivity:true,onTrace:event=>trace.push(event)});f.c.final('synthetic admitted request');f.quietFor(3000);const token=f.requests[0];f.activity('unknown');const pending=token.waitForCommit();
  if(operation==='reset')f.c.reset();else if(operation==='stop')f.c.recognizerStopped({graceful:true});else f.activity('quiet',2,{recognizer:2});
  assert.equal(await pending,false);assert.equal(await token.waitForCommit(),false);assert.equal(token.isCurrent(),false);
  assert.equal(f.c.snapshot(),null);assert.equal(f.invalidations(),1);assert(trace.some(event=>event.stage==='turn-invalidated'&&event.reasonCode==={reset:2,stop:4,epoch:3}[operation]));
 }
});
test('an aborted commit waiter leaves the semantic token and other waiters intact',async()=>{
 const f=fixture({requireActivity:true});f.c.final('synthetic admitted request');f.quietFor(3000);const token=f.requests[0];f.activity('unknown');
 const controller=new AbortController(),aborted=token.waitForCommit({signal:controller.signal}),other=token.waitForCommit();controller.abort();assert.equal(await aborted,false);assert.equal(token.isCurrent(),true);
 f.activity('quiet',2);assert.equal(await other,true);assert.equal(f.requests.length,1);assert.equal(f.invalidations(),0);
});
test('already remembered facts remain preserved when a later acoustic gate times out',()=>{
 const f=fixture({requireActivity:true});f.c.final('synthetic admitted request');f.quietFor(3000);f.requests[0].remember();f.activity('active');f.quietFor(8000);
 assert.deepEqual(f.remembered,['synthetic admitted request']);assert.equal(f.errorDetails[0].reason,'commit-timeout');assert.doesNotMatch(f.errors[0],/未提交交办/);
});
test('successful final effects retire the input without aborting submitted speech or timing out on later ambient audio',async()=>{
 const trace=[],f=fixture({requireActivity:true,onTrace:event=>trace.push(event)});f.c.final('synthetic completed request');f.quietFor(3000);const token=f.requests[0];
 token.remember();assert.equal(token.complete(),true);assert.equal(token.completed,true);assert.equal(token.complete(),false);assert.equal(f.c.snapshot(),null);
 assert.equal(token.isCurrent(),false);assert.equal(token.canCommit(),false);assert.equal(await token.waitForCommit(),false);assert.equal(token.remember(),undefined);
 for(let i=0;i<100;i++){f.advance(100);f.activity(i%2?'unknown':'active');}
 assert.equal(f.errors.length,0);assert.equal(f.requests.length,1);assert.equal(f.invalidations(),0);assert.deepEqual(f.remembered,['synthetic completed request']);
 assert(trace.some(event=>event.stage==='turn-completed'&&event.reasonCode===11));
 f.c.partial('synthetic next request');f.c.final('synthetic next request.');f.quietFor(3000);assert.equal(f.requests.length,2);assert.equal(f.requests[1].text,'synthetic next request.');
 assert.equal(token.complete(),false);assert.equal(f.requests[1].isCurrent(),true,'an old completion cannot retire the next turn');
});
test('completion after a successful effect can retire a just-closed gate and release late waiters without cancellation',async()=>{
 const f=fixture({requireActivity:true});f.c.final('synthetic completed request');f.quietFor(3000);const token=f.requests[0];token.remember();
 f.activity('active');const pending=token.waitForCommit();assert.equal(token.canCommit(),false);assert.equal(token.complete(),true);assert.equal(await pending,false);
 f.advance(20000);assert.equal(f.errors.length,0);assert.equal(f.invalidations(),0);assert.equal(f.requests.length,1);assert.deepEqual(f.remembered,['synthetic completed request']);
});
test('intentional skip may complete, while invalidated and reset tokens cannot mark a newer input completed',()=>{
 const f=fixture();f.c.final('synthetic intentionally skipped request');f.advance(3000);const skipped=f.requests[0];skipped.skip();assert.equal(skipped.complete(),true);assert.deepEqual(f.remembered,[]);
 f.c.final('synthetic interrupted request');f.advance(3000);const interrupted=f.requests[1];f.c.reset();assert.equal(interrupted.complete(),false);assert.equal(interrupted.completed,false);
 f.c.final('synthetic later request');f.advance(3000);assert.equal(interrupted.complete(),false);assert.equal(f.requests[2].isCurrent(),true);
});
