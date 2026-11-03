'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {WorkBuddyStopper}=require('../src/main/workbuddy-stop'),{GuiLease}=require('../src/main/gui-lease');
function fixture(){
 const snap={sessionId:'session',sessionTitle:'实验',task:{id:1,status:'running',userText:'This is the exact isolated cancellation experiment',bunnyTaskId:'11111111-2222-4333-8444-555555555555'}},calls=[];let stopped=false,matched=true;
 const lease=new GuiLease(),native={request:async(op,args)=>{calls.push({op,args});if(op==='frontmost')return {application:{bundleId:'com.tencent.workbuddy.mac',pid:10},windows:[{bundleId:'com.tencent.workbuddy.mac',pid:10,layer:0,rect:{width:800},windowId:20}]};if(op==='workbuddyStop'){if(args.inspect)return {matched,stopCount:stopped?0:1};stopped=true;return {performed:true};}return {ok:true};}};
 const stopper=new WorkBuddyStopper({native,lease,lookup:()=>snap,wait:async()=>{},confirmed:async()=>{snap.task.status='stopped';}});
 return {stopper,snap,calls,lease,setMatched:value=>{matched=value;}};
}
test('stop is deduplicated, verifies the exact round and observed disappearance, and releases the shared GUI lease',async()=>{
 const h=fixture(),target={sessionId:'session',taskId:1};const replies=await Promise.all([h.stopper.stop(target),h.stopper.stop(target)]);
 assert(replies.every(r=>r.verified));assert.equal(h.snap.task.status,'stopped');assert.equal(h.calls.filter(c=>c.op==='workbuddyStop'&&!c.args.inspect).length,1);assert(h.lease.isFree());assert(!h.calls.some(c=>c.op==='activate'),'a matching background WorkBuddy chat uses AX without stealing foreground');
});
test('a changed round or mismatched conversation never receives a stop click',async()=>{
 const h=fixture();await assert.rejects(h.stopper.stop({sessionId:'session',taskId:2}),/轮次/);h.setMatched(false);
 await assert.rejects(h.stopper.stop({sessionId:'session',taskId:1}),/核对/);assert.equal(h.calls.filter(c=>c.op==='workbuddyStop'&&!c.args.inspect).length,0);assert(h.lease.isFree());
});
