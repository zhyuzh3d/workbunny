'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const budget=require('../src/main/context-budget');
const request=(text,more={})=>({contextWindow:1000000,maxInputTokens:1000000,maxTokens:4096,messages:[{role:'system',content:'fixture rules'},{role:'user',content:text}],...more});

test('256K is a token ceiling and short input never grows to fill it',()=>{
 const fitted=budget.fitRequest(request('短任务，保留原文。'));
 assert.equal(budget.MAX_INPUT_TOKENS,256000);assert.equal(fitted.contextBudget.unit,'tokens');assert.equal(fitted.contextBudget.inputBudget,256000);
 assert(fitted.contextBudget.estimate<1000);assert.equal(fitted.messages[1].content,'短任务，保留原文。');
 assert.equal(fitted.contextBudget.mode,'conservative-multilingual-token-estimate');
});
test('per-request input quotas can grow or shrink but remain below model input, context and output reservations',()=>{
 const options=request('fixture',{contextWindow:100000,maxInputTokens:60000,maxTokens:8000});
 const base=budget.limits(options),small=budget.limits({...options,inputBudgetTokens:8000}),large=budget.limits({...options,inputBudgetTokens:200000});
 assert.equal(small.inputBudget,8000);assert.equal(large.inputBudget,base.maximumInputBudget);
 assert(large.inputBudget+large.protocolReserve+large.uncertaintyReserve<=60000);
 assert(large.inputBudget+large.protocolReserve+large.uncertaintyReserve+large.output<=100000);
 assert.equal(budget.limits({...options,inputBudgetTokens:8000}).inputBudget,8000,'quotas never leak between requests');
 for(const value of [0,511,256001,NaN,Infinity,'256000'])assert.throws(()=>budget.fitRequest({...options,inputBudgetTokens:value}),{code:'E_CONTEXT_CONFIGURATION'});
});
test('unknown capacity stays conservative and tiny known models are never rounded above their real limit',()=>{
 const unknown=budget.limits({provider:'fixture-unknown',model:'unknown-model',maxTokens:2048});
 assert.equal(unknown.context,32768);assert.equal(unknown.inputBudget,25088);
 const tiny=request('must remain intact',{contextWindow:1024,maxInputTokens:1000,maxTokens:512});
 assert.equal(budget.limits(tiny).inputBudget,0);assert.throws(()=>budget.fitRequest(tiny),{code:'E_CONTEXT_BUDGET'});assert.equal(tiny.messages[1].content,'must remain intact');
 const limited=request('short',{contextWindow:10000,maxInputTokens:9000,maxOutputTokens:128});
 assert.equal(budget.fitRequest(limited).maxTokens,128,'wire output must match the output capacity actually reserved');
});
test('mixed Chinese, English, code, symbols and images use token estimates instead of a character or byte quota',()=>{
 const text='中文测试 English prose\nconst value = { key: "🙂", x: 42 };\n'+ 'opaque_identifier_'.repeat(8);
 const estimate=budget.textTokens(text);assert.notEqual(estimate,text.length);assert.notEqual(estimate,Buffer.byteLength(text));
 assert.equal(budget.textTokens('中文'),4);assert.equal(budget.textTokens('🙂'),4);assert.equal(budget.textTokens('x'.repeat(100)),100);
 const make=size=>request(null,{messages:[{role:'system',content:'rules'},{role:'user',content:[{type:'text',text},{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+'A'.repeat(size)}}]}]});
 const a=budget.fitRequest(make(10)),b=budget.fitRequest(make(200000));assert.equal(a.contextBudget.estimate,b.contextBudget.estimate);
 assert(b.contextBudget.estimate>=budget.IMAGE_ESTIMATE_TOKENS+estimate);assert.equal(b.messages[1].content[0].text,text);
});
test('optional excerpts convert token space to a measured Unicode prefix rather than a fixed character multiplier',()=>{
 for(const text of ['中文English混合🙂!'.repeat(100),'🙂'.repeat(100),'x'.repeat(100),'function example() { return "资料"; }'.repeat(100)]){
  const prefix=budget.textPrefixWithinBudget(text,101);assert(text.startsWith(prefix));assert(budget.textTokens(prefix)<=101);assert(!/[\uD800-\uDBFF]$/u.test(prefix));
 }
 assert.equal(budget.textPrefixWithinBudget('🙂',3),'');assert.equal(budget.textPrefixWithinBudget('完整原文',100),'完整原文');
});
test('near the ceiling protocol and tool payloads count and mandatory text is rejected intact rather than truncated',()=>{
 const empty=request(''),cap=budget.limits(empty).inputBudget;
 const overhead=budget.cost(empty.messages,{}),text='x'.repeat(cap-overhead);
 const fitted=budget.fitRequest(request(text));assert.equal(fitted.contextBudget.estimate,cap);
 const over=request(text+'x'),before=JSON.stringify(over);
 assert.throws(()=>budget.fitRequest(over),e=>e.code==='E_CONTEXT_BUDGET'&&e.budget.estimate===cap+1);
 assert.equal(JSON.stringify(over),before);
 assert.throws(()=>budget.fitRequest({...request(text),extraBody:{tools:[{type:'function',function:{name:'fixture',description:'fixture tool schema'}}]}}),{code:'E_CONTEXT_BUDGET'});
});
test('the actual transport returns numeric budget evidence for successful requests without retaining prompt content',async()=>{
 const {chatWithTransport}=require('../src/main/workbuddy');let wire;
 const result=await chatWithTransport({...request('private-budget-canary'),model:'fixture-model',inputBudgetTokens:10000},async params=>{
  wire=JSON.parse(Buffer.from(params.body_b64,'base64').toString());
  return {body:JSON.stringify({model:'fixture-model',choices:[{message:{content:'fixture response'},finish_reason:'stop'}]})};
 });
 assert.equal(result.contextBudget.inputBudget,10000);assert.equal(result.contextBudget.unit,'tokens');assert.equal(result.contextBudget.imageCount,0);
 assert.equal(wire.messages[1].content,'private-budget-canary');assert(!JSON.stringify(result.contextBudget).includes('private-budget-canary'));
 assert.equal(wire.max_tokens,result.contextBudget.output);
});
