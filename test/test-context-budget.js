'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const budget = require('../src/main/context-budget'), catalog = require('../src/main/model-catalog');
const schema = require('../src/main/reply-format').responseFormat('grok',undefined,{cognitive:true});
const fixedRules = require('../src/main/dialogue-actions').RULE + require('../src/main/dialogue-cognition').RULE;
function request(repeat, more={}) {
  return {provider:'grok',model:'grok-4.20-0309-non-reasoning',maxTokens:4096,
    messages:[{role:'system',content:fixedRules},{role:'user',_contextLane:'cognition',content:'本轮没有旧预测。'},
      {role:'user',content:'这是中文测试资料，内容保留在原来的位置。'.repeat(repeat)}],extraBody:{response_format:schema,tools:require('../src/main/conversation-recall').TOOLS},...more};
}
test('a legacy Grok cache gets documented capacity without a network call; long Chinese input stays intact',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bunny-context-budget-')),file=path.join(dir,'models.json');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(file,JSON.stringify({grok:{at:1,models:[{id:'grok-4.20-0309-non-reasoning',label:'Grok',thinking:[{id:'auto',label:'默认'}]}]}}));
  catalog.setPath(file);
  const options=request(1000),original=JSON.stringify(options),fitted=budget.fitRequest(options);
  assert.equal(fitted.contextBudget.context,1000000);
  assert.equal(fitted.contextBudget.inputBudget,64000,'keep a local spending ceiling instead of filling the million-token window');
  assert(Buffer.byteLength(JSON.stringify(options))>64000,'would fail even the old 64KB byte ceiling');
  assert.equal(fitted.messages.at(-1).content,options.messages.at(-1).content);
  assert.equal(fitted.messages[0].content,fixedRules);
  assert.equal(JSON.stringify(options),original,'wire fitting never edits original messages');
});
test('unknown models keep a conservative fallback but no longer count UTF8 bytes as tokens',()=>{
  const options=request(250,{model:'unknown-model',contextWindow:32768});
  const result=budget.fitRequest(options);
  assert(Buffer.byteLength(JSON.stringify(options))>result.contextBudget.inputBudget);
  assert(result.contextBudget.estimate<result.contextBudget.inputBudget);
  assert.equal(result.messages.at(-1).content,options.messages.at(-1).content);
  assert.equal(budget.textTokens('测试中文'),8);
  assert.equal(budget.textTokens('x'.repeat(100)),100,'opaque text is never discounted as prose');
});
test('genuinely oversized current input still fails without losing originals or leaking content into diagnostics',()=>{
  const options=request(6000),original=JSON.stringify(options);
  assert.throws(()=>budget.fitRequest(options),e=>e.code==='E_CONTEXT_BUDGET'&&e.budget.estimate>e.budget.inputBudget&&!JSON.stringify(e.budget).includes('中文测试'));
  assert.equal(JSON.stringify(options),original);
});
