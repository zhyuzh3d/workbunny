'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {verifyDelivery}=require('../src/main/secretary');
const answer=value=>({response:{text:JSON.stringify(value)},model:'fixture'});
const task={goal:'交付完整可用成果',userRequest:'原目标和新增要求都必须满足',monitorSessionId:'bound',monitorSummary:'前轮实际成果'};
const reviewContext={ownerEvidence:{request:task.userRequest},submissionRecovery:{available:true,proofId:'proof',round:1,priorRound:0,draftText:'保留的完整补充稿'}};
test('the same delivery review explicitly chooses whether to retain an unsent supplement',async()=>{
 const value=await verifyDelivery({task,reviewContext,request:async options=>{
  const input=JSON.parse(options.messages[1].content[0].text);
  assert.equal(input.reviewContext.ownerEvidence.request,task.userRequest);
  assert.equal(input.reviewContext.submissionRecovery.draftText,'保留的完整补充稿');
  assert.match(options.messages[0].content,/不能丢弃主人新增或尚未完成的要求/);
  return answer({verdict:'pass',report:'原成果满足当前目标。',recoveryAction:'abandon-unsent-supplement'});
 }});
 assert.equal(value.recoveryAction,'abandon-unsent-supplement');assert.equal(value.verdict,'pass');
 const retained=await verifyDelivery({task,reviewContext,request:async()=>answer({verdict:'need_user',report:'补充意图还需核实。',recoveryAction:'retain-draft'})});
 assert.equal(retained.recoveryAction,'retain-draft');
});
test('unqualified, implicit, contradictory and unknown recovery choices cannot commit abandonment',async()=>{
 for(const value of [
  {verdict:'pass',report:'fixture'},
  {verdict:'pass',report:'fixture',recoveryAction:'other'},
  {verdict:'revise',report:'fixture',followUp:'still required',recoveryAction:'abandon-unsent-supplement'}
 ])await assert.rejects(verifyDelivery({task,reviewContext,request:async()=>answer(value)}),/恢复决定/);
 await assert.rejects(verifyDelivery({task,request:async()=>answer({verdict:'pass',report:'fixture',recoveryAction:'abandon-unsent-supplement'})}),/格式/);
});
