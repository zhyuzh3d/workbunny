'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {AgentInterpreter}=require('../src/main/agent-interpreter'),{requestVerification}=require('../src/main/verification-transport'),{chatWithTransport}=require('../src/main/workbuddy');
function fixture(transport){
 const wires=[],request=options=>requestVerification(options,{selectFree:async()=> 'hy3',chat:options=>chatWithTransport(options,async params=>{
  const wire=JSON.parse(Buffer.from(params.body_b64,'base64').toString('utf8'));wires.push(wire);await transport?.(wire,wires.length);
  return {body:JSON.stringify({model:wire.model,choices:[{message:{content:JSON.stringify({kind:'chat',text:'Synthetic request understood'})},finish_reason:'stop'}]})};
 })});
 return {wires,request,interpreter:new AgentInterpreter({skills:{catalog:()=>[]},request})};
}
test('Task interpretation starts with the proven structured-output budget on the actual wire without changing ordinary text defaults',async()=>{
 const f=fixture();const result=await f.interpreter.interpret('Understand this synthetic task');assert.equal(result.kind,'chat');assert.equal(f.wires.length,1);assert.equal(f.wires[0].max_tokens,8192);assert.equal(f.wires[0].reasoning_effort,'low');
 await f.request({messages:[{role:'user',content:'Ordinary synthetic text'}]});assert.equal(f.wires[1].max_tokens,2048);
});
test('the larger interpretation budget still uses existing bounded response recovery and Task repair profiles',async()=>{
 const f=fixture((_wire,n)=>{if(n===1)throw Object.assign(Error('synthetic broker output size limit'),{code:'E_PAYLOAD_TOO_LARGE'});});
 await f.interpreter.interpret('Understand this synthetic task');assert.deepEqual(f.wires.map(wire=>wire.max_tokens),[8192,2048]);
 const tuned=fixture();await tuned.interpreter.interpret('Understand this synthetic task',{repairProfile:{maxTokens:4096}});assert.equal(tuned.wires[0].max_tokens,4096);
});
test('stop cancels the interpretation response recovery before another actual request',async()=>{
 const controller=new AbortController(),f=fixture(()=>{controller.abort();throw Object.assign(Error('synthetic output size limit'),{code:'E_PAYLOAD_TOO_LARGE'});});
 await assert.rejects(f.interpreter.interpret('Understand this synthetic task',{signal:controller.signal}));assert.equal(f.wires.length,1);
});
