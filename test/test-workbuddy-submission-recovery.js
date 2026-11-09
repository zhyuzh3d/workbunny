'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DesktopService}=require('../src/main/desktop-service');
const {inspectWorkBuddySubmission}=require('../src/main/workbuddy-observation');
const {recoveryVisual}=require('./support/workbuddy-recovery-visual-fixture.cjs');
function fixture({complete=true,unknown=false,changedDraft=false,lateRecord=false,cancelReview=false,lateAfterAuthorization=false,changeAtAuthorization=false,cancelAtAuthorization=false}={}){
 let sent=0,inspections=0,proofs=0,reviews=0,authorized=0;const parent=new AbortController();
 const visual=recoveryVisual({initial:{mode:'conversation',marker:'[workbunny:old]',draftText:'exact existing draft [workbunny:new]'},onSubmit:async()=>{sent++;},onDraftCheck:({input,afterCapture})=>{assert.equal(input.evidence.marker,'[workbunny:old]');if(changedDraft&&++inspections===1)afterCapture(()=>{visual.state.draftText='changed protected draft';});}}),calls=visual.calls;
 let service;const record=()=>({sessionId:'same-session',taskId:2,messageKey:'new-message',status:'ok',summary:'real fixture reply',startedAt:service.task.submittedAt,updatedAt:Date.now()});
 service=new DesktopService({...visual,persist:async()=>{},inspectWorkBuddySubmission:async()=>({complete,cursor:{bytes:100,ino:1},record:sent||lateRecord&&++proofs>1||lateAfterAuthorization&&authorized>=2?record():null}),observeWorkBuddy:async()=>sent?record():null,
  modelRequest:async()=>{reviews++;if(cancelReview)parent.abort();return {text:JSON.stringify({observed:unknown?'unknown':'not_applied',reason:unknown?'缺少可靠的接收状态证据':'完整会话无本轮消息，当前编辑器仍保留这一轮完整原文',nextAction:unknown?null:{action:'click',x:.3,y:.82,then:[{action:'key',key:'enter',modifiers:[],purpose:'submit'}]}})};}});
 service.task={id:'round',bunnyTaskId:'round',target:'workbuddy',scene:'life',domain:'work',visibilityFloor:1,goal:'complete the existing work',workModel:'deepseek-v4.1-flash',sessionId:'same-session',monitorSessionId:'same-session',associationMarker:'[workbunny:new]',continuationOf:{associationMarker:'[workbunny:old]',round:0},outboundText:'exact existing draft [workbunny:new]',handoffSent:true,submittedAt:1,followUpRound:1,followUpPending:{state:'sent',submittedAt:1},followUpAwaitingMonitor:true,steps:[{action:'key',purpose:'submit',method:'visual',state:'input-sent',at:1}],scope:{...service.visualFor('workbuddy').identity(),target:'workbuddy'}};
 return {service,parent,calls,visual,sent:()=>sent,reviews:()=>reviews,authorized:()=>authorized,recover:()=>service.recoverWorkBuddySubmission({signal:parent.signal,authorize:async()=>{authorized++;if(authorized===2){if(changeAtAuthorization)visual.state.draftText='authorization-time protected draft';if(cancelAtAuthorization)parent.abort();}}})};
}
test('Bunny reviews actual non-application and submits the same draft once without rewriting or creating another round',async()=>{
 const h=fixture(),original=h.service.task.outboundText;try{const result=await h.recover();assert.equal(result.ok,true,result.error);assert.equal(result.verified,true);assert.equal(h.sent(),1);assert.equal(h.authorized(),2);assert.equal(h.service.task.followUpRound,1);assert.equal(h.service.task.outboundText,original);assert.equal(h.service.task.effectReviews[0].observed,'not_applied');assert.equal(h.service.task.followUpPending.state,'observed');assert(!h.calls.some(c=>['type','workbuddyFill'].includes(c.op)));assert(h.calls.every(c=>['displayCapture','displayInput'].includes(c.op)));assert.deepEqual(h.calls.filter(c=>c.op==='displayInput').map(c=>c.a.action),['click','key']);assert(h.visual.judgments.some(j=>j.input.evidence.mode==='conversation'&&j.visible.marker==='[workbunny:old]'));}finally{await h.service.close();}
});
for(const [name,options] of [['incomplete log',{complete:false}],['changed draft',{changedDraft:true}],['cancelled judgment',{cancelReview:true}]])test(name+' cannot authorize another submit',async()=>{
 const h=fixture(options);try{const result=await h.recover();assert.equal(result.ok,false);assert.equal(h.sent(),0);}finally{await h.service.close();}
});
test('a newly arriving external receipt wins over a planned recovery and avoids all resend',async()=>{
 const h=fixture({lateRecord:true});try{const result=await h.recover();assert.equal(result.ok,true,result.error);assert.equal(h.sent(),0);assert.equal(h.service.task.followUpPending.state,'observed');}finally{await h.service.close();}
});
test('an inconclusive judgment is cached for unchanged evidence instead of repeatedly asking or submitting',async()=>{
 const h=fixture({unknown:true});try{for(let i=0;i<2;i++){const result=await h.recover();assert.equal(result.needsEvidence,true);}assert.equal(h.reviews(),1);assert.equal(h.sent(),0);}finally{await h.service.close();}
});
test('negative log evidence requires an exact file, inode and complete line boundary',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-read-boundary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'session.jsonl');fs.writeFileSync(file,'{}\n');const stat=fs.statSync(file),entry={file,ino:stat.ino,offset:stat.size,priming:false,reader:{atBoundary:true},snap:{sessionId:'bound',task:{id:1,messageKey:'old-message'},history:[]}},monitor={sessions:new Map([['file',entry]])},task={id:'round',sessionId:'bound',previousMonitorMessageKey:'old-message',submittedAt:1};
 assert.equal((await inspectWorkBuddySubmission(monitor,task)).complete,true);entry.reader.atBoundary=false;assert.equal((await inspectWorkBuddySubmission(monitor,task)).complete,false);entry.reader.atBoundary=true;fs.appendFileSync(file,'partial');assert.equal((await inspectWorkBuddySubmission(monitor,task)).complete,false);entry.offset=fs.statSync(file).size;entry.ino++;assert.equal((await inspectWorkBuddySubmission(monitor,task)).complete,false);
});
test('the recovery input budget stops an unchanged round without blocking later read-only receipts',async()=>{
 const h=fixture();try{const hash=require('node:crypto').createHash('sha256').update(h.service.task.outboundText).digest('hex');for(let i=0;i<2;i++)h.service.task.steps.push({method:'reviewed-recovery',round:1,outboundHash:hash,state:'input-sent'});const result=await h.recover();assert.equal(result.needsEvidence,true);assert.equal(h.sent(),0);assert.equal(h.reviews(),0);assert(!h.calls.some(c=>c.op==='displayInput'));}finally{await h.service.close();}
});

for(const [name,options] of [['authorization-time draft change',{changeAtAuthorization:true}],['cancellation before final dispatch',{cancelAtAuthorization:true}]])test(name+' preserves the draft and prevents another submit',async()=>{
 const h=fixture(options);try{const result=await h.recover();assert.equal(result.ok,false);assert.equal(h.sent(),0);}finally{await h.service.close();}
});
test('a receipt arriving during the authorization check prevents a planned recovery send',async()=>{const h=fixture({lateAfterAuthorization:true});try{const result=await h.recover();assert.equal(result.ok,true,result.error);assert.equal(h.sent(),0);}finally{await h.service.close();}});
test('concurrent recovery requests share one in-flight action and cannot double-submit',async()=>{const h=fixture();try{const [first,second]=await Promise.all([h.recover(),h.recover()]);assert.equal(first.ok,true,first.error);assert.equal(second.ok,false);assert.equal(h.sent(),1);}finally{await h.service.close();}});

test('dropped JSON events prevent negative absence proof even at the file boundary',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-log-integrity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'bound.jsonl');fs.writeFileSync(file,'not-json\n');const stat=fs.statSync(file),{Monitor}=require('../src/main/monitor'),monitor=new Monitor();t.after(()=>monitor.stop());const entry=monitor.attach({file,size:stat.size,ino:stat.ino});await monitor.readNew(entry);assert.equal(entry.reader.atBoundary,true);assert.equal(entry.integrityUnknown,true);const result=await inspectWorkBuddySubmission(monitor,{id:'round',sessionId:'bound',submittedAt:1});assert.equal(result.complete,false);assert.equal(result.needsEvidence,true);
});
