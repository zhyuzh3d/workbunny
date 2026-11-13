'use strict';
const {remainingWaitMs,pauseFor}=require('../src/main/action-progress');
const test=require('node:test'),assert=require('node:assert/strict');
test('planned checking deducts model latency and an external cancellation interrupts a long wait',async()=>{
 assert.equal(remainingWaitMs(9000,1000,4000),6000);assert.equal(remainingWaitMs(9000,1000,12000),0);
 const controller=new AbortController(),pending=pauseFor(72000,controller.signal);controller.abort();await assert.rejects(pending,e=>e.code==='E_ABORTED');
});
const {ActionProgress}=require('../src/main/action-progress');
test('forcing the same observation or relocating without changed facts does not renew recovery evidence',()=>{
 let now=0;const progress=new ActionProgress({},()=>now),result={headerMatched:false,changed:true,messages:[]};
 assert(progress.observe('conversation.observe',{tool:'conversation.observe',args:{force:false,relocate:false},result}));now=20000;
 assert.equal(progress.observe('conversation.observe',{tool:'conversation.observe',args:{force:true,relocate:true},result}),false);
 assert.equal(progress.snapshot().withoutProgressMs,20000);
});
test('fresh reasoning on existing facts does not renew the no-progress clock',()=>{
 let now=0;const progress=new ActionProgress({},()=>now);progress.observe('screen.observe',{status:'pending'});
 for(let i=0;i<3;i++){now+=6000;assert.equal(progress.observe('evidence.assess',{result:{trust:'interpretation-not-authorization',interpretation:'new opinion '+i}}),false);}
 assert.equal(progress.snapshot().withoutProgressMs,18000);assert(progress.reviewDue());
});
test('logical time and measured model cost survive retries and persistence, while frame metadata is not progress',async()=>{
 let now=1000;const state={},p=new ActionProgress(state,()=>now);
 p.observe('screen.observe',{frameId:'first',at:1,texts:['AI ready']});
 await p.measure('model',async()=>{now+=2000;});now+=1000;
 const restored=new ActionProgress(JSON.parse(JSON.stringify(state)),()=>now);
 assert.equal(restored.snapshot().elapsedMs,3000);assert.equal(restored.snapshot().spent.model,2000);
 restored.stage('different-label');assert.equal(restored.observe('screen.observe',{frameId:'second',at:999,note:'checking again',metrics:{samples:999},texts:['AI ready']}),false);
 assert.equal(restored.snapshot().withoutProgressMs,3000);assert(!JSON.stringify(state).includes('AI ready'),'only evidence digests are retained');
});
test('repeated evidence triggers bounded recovery without resetting logical time; explicit waits and new facts are handled separately',()=>{
 let now=1000;const p=new ActionProgress({},()=>now);p.observe('verify',{ready:false});
 for(let review=0;review<2;review++){now+=16000;p.observe('verify',{ready:false});p.observe('verify',{ready:false});assert(p.reviewDue());p.reviewed();}
 now+=16000;assert(p.exhausted());assert.equal(p.blocked().code,'E_NO_PROGRESS');assert(p.snapshot().elapsedMs>=48000);
 p.wait('external');assert.equal(p.reviewDue(),false);assert.equal(p.exhausted(),false);
 p.wait(null);assert(p.exhausted());p.observe('verify',{ready:true});assert.equal(p.exhausted(),false);assert.equal(p.snapshot().reviews,0);
 assert(p.snapshot().elapsedMs>=48000,'new evidence does not restart overall action time');
});
test('cycling earlier evidence or changing the method name does not manufacture progress',()=>{
 let now=1000;const p=new ActionProgress({},()=>now);p.observe('first',{state:'A'});now+=1000;p.observe('second',{state:'B'});now+=20000;
 p.observe('renamed',{state:'A'});p.observe('another-name',{state:'B'});assert.equal(p.snapshot().withoutProgressMs,20000);assert(p.reviewDue());
});
test('fresh observation identifiers do not renew unchanged message facts but actual message or result changes do',()=>{
 let now=1000;const p=new ActionProgress({},()=>now),observation=i=>({observationId:'observation-'+i,captureId:'capture-'+i,at:now,messages:[{text:'1',incomingVerified:false,observedVerified:false,observedAt:now,perception:{evidenceId:'pixels-'+i},visualEvidence:{observationId:'pixels-'+i,confidence:.95}}]});
 assert(p.observe('conversation.observe',observation(0)));
 for(let i=1;i<=3;i++){now+=6000;assert.equal(p.observe('conversation.observe',observation(i)),false);}
 assert.equal(p.snapshot().withoutProgressMs,18000);assert(p.reviewDue());
 const changed=observation(4);changed.messages[0].text='2';assert(p.observe('conversation.observe',changed));assert.equal(p.snapshot().withoutProgressMs,0);
 now+=2000;assert(p.observe('conversation.send',{verified:true,submitted:true}));assert.equal(p.snapshot().withoutProgressMs,0);
});
test('unchanged target conflicts ignore provenance and completion opinions while a genuinely corrected target is new evidence',()=>{
 let now=1000;const p=new ActionProgress({},()=>now),observation=i=>({headerMatched:false,headerText:'Different fixture',observationId:'observation-'+i,visualFeedback:{checks:[{frameId:'frame-'+i,captureId:'after-'+i,baselineCaptureId:'before-'+i,operationTrace:{session:'session-'+i,incidentId:'incident-'+i,seq:i},identityChanged:true,targetChanged:true}]}});
 assert(p.observe('conversation.observe',observation(0)));for(let i=1;i<=3;i++){now+=6000;assert.equal(p.observe('conversation.observe',observation(i)),false);assert.equal(p.observe('conversation.open',{result:{trust:'interpretation-not-authorization',executionClaim:{completed:true,evidence:'A new completion opinion '+i}}}),false);}
 assert.equal(p.snapshot().withoutProgressMs,18000);assert(p.reviewDue());assert(!JSON.stringify(p.state).includes('Different fixture'));
 assert(p.observe('conversation.observe',{headerMatched:true,headerText:'Expected fixture'}));assert.equal(p.snapshot().withoutProgressMs,0);
});
test('legitimate waiting is accounted separately and cannot cause an immediate false stall after resuming',()=>{
 let now=1000;const p=new ActionProgress({},()=>now);p.observe('observe',{ready:false});p.observe('observe',{ready:false});p.observe('observe',{ready:false});
 now+=5000;p.wait('gui');now+=600000;const restored=new ActionProgress(JSON.parse(JSON.stringify(p.state)),()=>now);restored.wait(null);now+=1000;
 assert.equal(restored.snapshot().elapsedMs,606000);assert.equal(restored.snapshot().waitingMs,600000);assert.equal(restored.snapshot().withoutProgressMs,6000);assert.equal(restored.reviewDue(),false);
});
test('changing failed methods and error descriptions cannot renew the progress clock',()=>{
 let now=1000;const p=new ActionProgress({},()=>now);p.observe('screen.observe',{visible:'same real page'});const evidence=[...p.state.evidence];
 for(let i=0;i<3;i++){now+=6000;assert.equal(p.observe('method-'+i,{tool:'method-'+i,args:{attempt:i},error:'E_UNAVAILABLE_'+i}),false);}
 assert.deepEqual(p.state.evidence,evidence);assert.equal(p.snapshot().withoutProgressMs,18000);assert(p.reviewDue());
 assert.equal(p.observe('inspect',{result:{ok:false,error:'E_OTHER'}}),false);
 assert.equal(p.observe('screen.observe',{visible:'new real page'}),true);
});
