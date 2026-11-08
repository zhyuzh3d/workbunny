'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {RULE,PRODUCTION_ROUTING_RULE,makeActionGate}=require('../src/main/dialogue-actions');
const {AgentInterpreter,AGENT_INSTRUCTION}=require('../src/main/agent-interpreter');
const {loadSoftwarePackages}=require('../src/main/software-skill-package');
// Stub decisions exercise prompt delivery, source fidelity and routing protocol.
// They do not claim real-model classification or reproduce the unknown ASR text.
const cases=[
 {name:'full spoken production request',text:'Bunny，我早上老不知道给孩子吃什么，你帮我安排个周一到周五的早餐，再列个买菜清单。',goal:'安排周一到周五的孩子早餐并列出采购清单'},
 {name:'synthetic shortened request with a known goal',text:'我早上老不知道给孩子吃什么，你帮我安排周一到周五的早餐。',goal:'安排周一到周五的孩子早餐'},
 {name:'synthetic shortened fragment with its object supplied by current context',text:'我早上老不知道给孩子吃什么，你帮我安排周一到周五的。',context:'本轮正在讨论孩子早上的餐食。',goal:'安排周一到周五的孩子早餐'},
 {name:'another life-use text deliverable without a software name',text:'请整理一份下周出行准备清单，按出发前和随身物品分类。',goal:'整理按出发前和随身物品分类的出行准备清单'}
];
for(const sample of cases)test(sample.name+' retains the actual input and can enter the default WorkBuddy task path',async()=>{
 assert(RULE.includes(PRODUCTION_ROUTING_RULE));assert(AGENT_INSTRUCTION.includes(PRODUCTION_ROUTING_RULE));assert(!PRODUCTION_ROUTING_RULE.includes('早餐'));
 const shown=[],gate=makeActionGate(text=>shown.push(text));gate.push(JSON.stringify({kind:'action',intent:{action:'agent'}}));gate.flush();assert.equal(gate.intent.action,'agent');assert.equal(shown.join(''),'');
 let captured;const interpreter=new AgentInterpreter({skills:{catalog:()=>[{id:'work.delegate'}],get:()=>({id:'work.delegate',subjectApplications:['workbuddy']})},request:async options=>{
  captured=JSON.parse(options.messages.find(m=>m.role==='user').content);assert(options.messages[0].content.includes(PRODUCTION_ROUTING_RULE));
  return {response:{text:JSON.stringify({kind:'task',task:{skill:'work.delegate',goal:sample.goal,subjects:[{application:'workbuddy'}],workRequest:{goal:sample.goal,criteria:'交付本轮要求的完整结果',output:'text'},delivery:{channel:'speech'},workContext:{mode:'none'}}})}};
 }});
 const result=await interpreter.interpret(sample.text,{context:sample.context||''});assert.equal(captured.currentOwnerRequest,sample.text);assert.equal(captured.routingPolicy.defaultApplication,'workbuddy');assert.equal(result.task.skill,'work.delegate');assert.equal(result.task.workRequest.goal,sample.goal);
 if(sample.name.includes('shortened'))assert(!JSON.stringify(result).includes('采购'),'an absent tail is not invented');
});
test('background-only uncertainty and direct factual discussion can remain chat without creating an empty deliverable',async()=>{
 for(const text of ['我早上老不知道给孩子吃什么。','我只想随口聊两个想法，不用做完整计划。','这个概念是什么意思？']){
  const interpreter=new AgentInterpreter({skills:{catalog:()=>[]},request:async options=>{assert(options.messages[0].content.includes('未要求代做完整成果'));return {response:{text:JSON.stringify({kind:'chat',text:'按实际已知内容回应，必要时询问缺项。'})}};}});
  assert.equal((await interpreter.interpret(text)).kind,'chat');
 }
});
test('the reported shortened voice fragment can clarify the intended deliverable without inventing an unrecognized tail',async()=>{
 const received='我早上老不知道给孩子。吃什么你帮我安排个周一到周五';let captured;
 const interpreter=new AgentInterpreter({skills:{catalog:()=>[{id:'work.delegate'}]},request:async options=>{captured=JSON.parse(options.messages.find(m=>m.role==='user').content);assert(options.messages[0].content.includes(PRODUCTION_ROUTING_RULE));return {response:{text:JSON.stringify({kind:'chat',text:'你是想安排孩子周一到周五早上的餐食吗？'})}};}});
 const result=await interpreter.interpret(received);assert.equal(captured.currentOwnerRequest,received);assert.equal(result.kind,'chat');assert.equal(result.task,undefined);assert(!result.text.includes('清单'));assert(result.text.length<40);
});
test('the packaged common experience carries the same semantic boundary with a verified manifest',()=>{
 const common=loadSoftwarePackages().find(p=>p.id==='common');assert(common);assert(common.instructions.includes('供后续使用的一份完整成果'));assert(common.instructions.includes('直接回答'));assert(common.instructions.includes('不能把没收到的尾句'));
});
