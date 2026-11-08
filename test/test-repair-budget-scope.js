'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const budget=require('../src/main/context-budget'),repair=require('../src/main/self-repair');
// Sanitized transport-shape fixture: mandatory rules + current JSON data + one
// image. Match the observed estimate, not the original private request body.
function visualRequest(estimate=44476,more={}){
 const payload={goal:'fixture full goal',criteria:'fixture acceptance criteria',outboundText:'fixture exact outbound [workbunny:fixture]',associationMarker:'[workbunny:fixture]',
  confirmedEffects:[{id:'confirmed-fixture',status:'confirmed'}],tools:[{name:'fixture allowed tool'}],operatingKnowledge:[{instructions:'fixture selected experience'}],currentFrame:{id:'fixture-frame'},visibleText:'x'.repeat(100)};
 const request={provider:'workbuddy',model:'deepseek-v4.1-flash',contextWindow:300000,maxInputTokens:1000000,maxTokens:2048,thinking:'high',extraBody:{reasoning_effort:'high',response_format:{type:'json_object'}},
  messages:[{role:'system',content:require('../src/main/bunny-principles')+'\n'+require('../src/main/action-progress').GUIDANCE},
   {role:'user',content:[{type:'text',text:JSON.stringify(payload)},{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+'A'.repeat(100000)}}]}],...more};
 // Opaque ASCII runs have a linear conservative estimate. Calibrate the
 // fixture's current observation to the measured total without private text.
 for(let i=0;i<4;i++){
  const delta=estimate-budget.cost(request.messages,request.extraBody);
  if(!delta)break;
  payload.visibleText='x'.repeat(payload.visibleText.length+delta);
  request.messages[1].content[0].text=JSON.stringify(payload);
 }
 assert.equal(budget.cost(request.messages,request.extraBody),estimate);
 return request;
}
const legacyProfiles=[{budgetScale:.5},{responseLevel:1},{budgetScale:.5,responseLevel:1},{budgetScale:.5,responseLevel:1,contextLevel:2}];
test('the observed 44476-token visual shape fits current verified capacity with every legacy profile combination',()=>{
 const request=visualRequest(),original=JSON.stringify(request),base=budget.limits(request);
 assert(base.inputBudget>44476);
 for(const profile of legacyProfiles){
  const repaired=repair.applyProfile(request,profile),fit=budget.fitRequest(repaired);
  assert.equal(repaired.budgetScale,undefined);assert.equal(fit.contextBudget.inputBudget,base.inputBudget);assert.equal(fit.contextBudget.estimate,44476);
  assert.deepEqual(JSON.parse(repaired.messages[1].content[0].text),JSON.parse(request.messages[1].content[0].text));
  assert.deepEqual(repaired.messages[1].content[1],request.messages[1].content[1]);
 }
 assert.equal(JSON.stringify(request),original);
});
test('persistent context repairs discard a legacy half-ceiling without changing the caller profile',()=>{
 const prior={budgetScale:.5,contextLevel:1,schemaHint:true},original={...prior};
 for(const code of ['E_CONTEXT_BUDGET','E_CONTEXT_WINDOW']){
  const next=repair.applyAction(prior,'compact_context',{code});assert.equal(next.budgetScale,undefined);assert.equal(next.contextLevel,2);assert.equal(next.schemaHint,true);
 }
 assert.deepEqual(prior,original);
});
test('response repairs constrain output and thinking while preserving the actual input ceiling',()=>{
 const request=visualRequest(44476,{maxTokens:8192}),profile=repair.applyAction({budgetScale:.5},'compact_response',{code:'E_PAYLOAD_TOO_LARGE'}),repaired=repair.applyProfile(request,profile);
 assert.equal(profile.budgetScale,undefined);assert.equal(repaired.maxTokens,2048);assert.equal(repaired.thinking,'low');assert.equal(repaired.extraBody.reasoning_effort,'low');assert.equal(repaired.budgetScale,undefined);
 assert.equal(budget.fitRequest(repaired).contextBudget.inputBudget,budget.limits({...request,maxTokens:2048}).inputBudget);
});
test('an explicit one-request half budget remains local and effective without entering the profile',()=>{
 const base=visualRequest(),ceiling=budget.limits(base).inputBudget,request=visualRequest(Math.floor(ceiling*.75));
 for(const profile of legacyProfiles){
  const local=repair.applyProfile({...request,budgetScale:.5},profile);
  assert.equal(local.budgetScale,.5);assert.equal(budget.limits(local).inputBudget,Math.floor(ceiling/2));
  assert.throws(()=>budget.fitRequest(local),{code:'E_CONTEXT_BUDGET'});
  assert.equal(repair.applyProfile(request,profile).budgetScale,undefined);assert.doesNotThrow(()=>budget.fitRequest(repair.applyProfile(request,profile)));
 }
 assert.equal(request.budgetScale,undefined);
});
test('a genuine request above the configured input ceiling is still rejected',()=>{
 const options={contextWindow:1000000,maxInputTokens:1000000},ceiling=budget.limits({...visualRequest(),...options}).inputBudget,request=visualRequest(Math.ceil(ceiling)+2048,options);
 for(const profile of legacyProfiles)assert.throws(()=>budget.fitRequest(repair.applyProfile(request,profile)),e=>e.code==='E_CONTEXT_BUDGET'&&e.budget.estimate>e.budget.inputBudget);
});
test('smaller verified and unknown model capacities remain enforced',()=>{
 for(const options of [{contextWindow:12000,maxInputTokens:11000},{contextWindow:undefined,maxInputTokens:undefined,model:'unknown-fixture-model'}]){
  const request=visualRequest(44476,options);
  for(const profile of legacyProfiles)assert.throws(()=>budget.fitRequest(repair.applyProfile(request,profile)),{code:'E_CONTEXT_BUDGET'});
 }
});
test('the newest chosen output recovery replaces an incompatible older strategy without mutating it',()=>{
 const options={messages:[{role:'user',content:'fixture evidence'}],maxTokens:2048,thinking:'high'},old={responseLevel:2,schemaHint:true};
 const expanded=repair.applyAction(old,'increase_output',{code:'E_OUTPUT_LIMIT'});
 assert.equal(repair.applyProfile(options,expanded).maxTokens,8192);assert.equal(expanded.responseLevel,undefined);assert.deepEqual(old,{responseLevel:2,schemaHint:true});
 const compact=repair.applyAction(expanded,'compact_response',{code:'E_PAYLOAD_TOO_LARGE'});
 assert.equal(repair.applyProfile(options,compact).maxTokens,2048);assert.equal(compact.maxTokens,undefined);assert.equal(expanded.maxTokens,8192);assert.equal(compact.schemaHint,true);
});
