'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {TOPIC_BOUNDARY_RULE,RULE}=require('../src/main/dialogue-actions');
const {requestReply}=require('../src/main/reply-request');
const {ConversationBrain}=require('../src/main/conversation-brain');
const {AgentInterpreter,AGENT_INSTRUCTION}=require('../src/main/agent-interpreter');
const {workOrder,workMessage}=require('../src/main/work-order');
const {failureNote}=require('../src/main/task-presentation');
const {loadSoftwarePackages}=require('../src/main/software-skill-package');
// These fixtures verify actual prompt/data paths and preserved effects. Stub
// answers do not establish real-model compliance with the semantic guidance.
for(const current of ['Bunny\n之前的先放一边','先搁置前面的内容，我想说另一件事。'])test('owner-channel requests retain current wording and the shared topic boundary: '+current,async()=>{
 let prompt;
 const brain=new ConversationBrain({request:async options=>{prompt=options.messages;return {response:{text:JSON.stringify({decision:'reply',reply:'好，你说。',summary:'转向当前内容',completed:false,progress:{},unknown:[],ownerAction:{type:'none'}})}};}});
 const result=await brain.decide({task:{goal:'接收主人发言',parameters:{},state:{}},subject:{application:'wechat'},conversation:{},incoming:[{text:current}],channelContext:{permission:{owner:true},messages:[{role:'assistant',text:'旧事项仍有待处理'}]}});
 assert(prompt[0].content.includes(TOPIC_BOUNDARY_RULE));assert.equal(JSON.parse(prompt[1].content).incoming[0].text,current);assert.equal(result.ownerAction,undefined);
});
test('core reply protocol recovery retains semantic boundaries and original routing capability',async()=>{
 const current='之前的先放一边';let calls=0;
 const result=await requestReply({chat:async options=>{
  if(++calls<3)return {raw:'invalid'};
  const system=options.messages.find(m=>m.role==='system').content;assert(system.includes(TOPIC_BOUNDARY_RULE));assert(system.includes(RULE));assert(!system.includes('无法执行任何操作'));assert(options.messages.at(-1).content.includes(current));
  return {raw:JSON.stringify({kind:'chat',text:'好，你说。'})};
 },request:{cognitive:true,messages:[{role:'system',content:RULE+'\n'+require('../src/main/dialogue-cognition').RULE},{role:'user',content:current}]}});
 assert.equal(calls,3);assert.equal(result.cognitionDegraded,true);assert.equal(result.reply.text,'好，你说。');
});
test('execution interpretation receives receiver-focused guidance without altering original owner input',async()=>{
 const current='制作一份示例家庭开销Word文档，含表格和饼图。';let input;
 const interpreter=new AgentInterpreter({skills:{catalog:()=>[{id:'work.delegate'}],get:()=>({id:'work.delegate',subjectApplications:['workbuddy']})},request:async options=>{
  assert(options.messages[0].content.includes(TOPIC_BOUNDARY_RULE));assert(AGENT_INSTRUCTION.includes('不把渠道选择理由当制作背景'));assert(AGENT_INSTRUCTION.includes('不以识别过程的免责声明代替核实'));
  input=JSON.parse(options.messages[1].content);return {response:{text:JSON.stringify({kind:'task',task:{skill:'work.delegate',goal:current,subjects:[{application:'workbuddy'}],workRequest:{goal:current,context:'采用示例数据，金额单位为元',criteria:'表格合计与饼图比例一致',output:'files'}}})}};
 }});
 const result=await interpreter.interpret(current,{perception:require('../src/main/perception').speech()});assert.equal(input.currentOwnerRequest,current);assert.equal(input.perception.channel,'microphone');
 const message=workMessage({...result.task,associationMarker:'[workbunny:fixture]'},workOrder(result.task));assert(message.includes('金额单位为元'));assert(!message.includes('microphone'));assert(!message.includes('语音可能有识别偏差'));
 const literal='逐字保留“语音可能有识别偏差”，并分析ASR过程';assert(workOrder({goal:literal,context:'任务材料中的金额待核实'}).includes(literal));
});
test('partial input progress is presented precisely without releasing an uncertain write operation',()=>{
 const task={skill:'work.delegate',state:{workCheckpoint:{phase:'draft-ready',submitAttempted:false,handoffSent:false}},operations:{write:{status:'intent',effect:'write'}}},before=structuredClone(task);
 assert.equal(failureNote(task,Error('发送前检查未通过'),{unknown:true}),'原稿已填写，尚未提交；发送前检查未通过');assert.deepEqual(task,before);
 for(const phase of ['input-unknown','submission-unknown']){task.state.workCheckpoint.phase=phase;assert.match(failureNote(task,Error('fixture'),{unknown:true}),/操作结果不确定/);}
});
test('packaged experience separates current dialogue focus, business context and internal processing',()=>{
 const packages=loadSoftwarePackages(),common=packages.find(p=>p.id==='common'),work=packages.find(p=>p.id==='workbuddy');assert(common.instructions.includes('不主动复述、催办或追问旧任务参数'));assert(common.instructions.includes('不删词或改写'));assert(work.instructions.includes('不转述Bunny的语音识别'));assert(work.instructions.includes('文字属于实际任务材料'));
});
