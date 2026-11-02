'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ConversationCursor}=require('../src/main/conversation-cursor');
const {conversationSkill}=require('../src/main/conversation-skill');
const {ConversationBrain}=require('../src/main/conversation-brain');
const {AgentRuntime}=require('../src/main/agent-runtime');
const {ToolRegistry}=require('../src/main/agent-tools');
const {SkillRegistry}=require('../src/main/agent-skills');
const message=(text,direction='incoming')=>({text,direction,kind:'text',time:'',incomingVerified:direction==='incoming',observedVerified:true});
test('cursor ignores history and own replies but treats a later repeated text as a new message',()=>{
 const cursor=new ConversationCursor();assert(cursor.observe([message('old')]).baseline);
 assert.deepEqual(cursor.observe([message('old'),message('hello')]).messages.map(m=>m.text),['hello']);
 cursor.noteSent('received');assert.equal(cursor.observe([message('old'),message('hello'),message('received','outgoing')]).messages.length,0);
 assert.equal(cursor.observe([message('old'),message('hello'),message('received','outgoing'),message('hello')]).messages.length,1);
});
test('owner inbox excludes Bunny echo even when all bubbles are outgoing',()=>{
 const c=new ConversationCursor();c.observe([message('old','outgoing')],{ownerChannel:true});c.noteSent('ack');
 assert.equal(c.observe([message('old','outgoing'),message('ack','outgoing')],{ownerChannel:true}).messages.length,0);
 assert.equal(c.observe([message('old','outgoing'),message('ack','outgoing'),message('new job','outgoing')],{ownerChannel:true}).messages[0].text,'new job');
});
test('message identity survives quote and punctuation transcription changes while preserving numeric values',()=>{
 const c=new ConversationCursor();c.observe([message('已核验：内容与“Test passed.”一致，共43字节。','outgoing')]);
 assert.deepEqual(c.observe([message('已核验: 内容与"Test passed."一致,共43字节','outgoing'),message('New Cedar deadline is Thursday.')]).messages.map(m=>m.text),['New Cedar deadline is Thursday.']);
 const numbers=new ConversationCursor();numbers.observe([message('Version 1.2')]);assert(numbers.observe([message('Version 12')]).uncertain);
});
test('consecutive identical messages are counted and an uncertain view cannot consume the original baseline',()=>{
 const c=new ConversationCursor();c.observe([message('same')]);assert.equal(c.observe([message('same'),message('same')]).messages.length,1);
 const original=c.snapshot().baseline;assert(c.observe([message('unrelated view')]).uncertain);assert.deepEqual(c.snapshot().baseline,original);
 assert.equal(c.observe([message('same'),message('same'),message('finally new')]).messages[0].text,'finally new');
});
function harness({behavior='reply',brain,completion='manual',subjects=[{application:'wechat',recipient:'Alice'}]}={}){
 let visible=[message('old')],busy=false;const sent=[],reports=[],records=new Map(),tools=new ToolRegistry();let now=1000;
 tools.register({name:'conversation.observe',description:'pixels',effect:'read',capabilities:['conversation.read'],scope:a=>a,execute:async()=>({headerMatched:true,changed:true,messages:visible,draft:''})});
 tools.register({name:'conversation.open',description:'open',effect:'read',capabilities:['screen.input'],scope:a=>a,execute:async()=>({ok:true})});
 tools.register({name:'conversation.send',description:'send',effect:'write',capabilities:['conversation.send'],scope:a=>a,execute:async a=>{sent.push(a.message);visible=[...visible,message(a.message,'outgoing')];return {ok:true,verified:true,receipt:{at:now}};}});
 tools.register({name:'memory.related',description:'related shared memories',effect:'read',capabilities:['memory.read'],scope:a=>a,execute:async()=>({items:[]})});
 tools.register({name:'owner.dispatch',description:'owner',effect:'write',capabilities:['owner.command'],scope:a=>a,execute:async()=>({ok:true,verified:true})});
 const decisions=[],skills=new SkillRegistry(tools).register(conversationSkill({brain:{decide:async args=>{decisions.push(args);return brain?brain(args):{decision:'reply',reply:'reply '+args.incoming.map(m=>m.text).join('+'),summary:'noted',completed:false,progress:{},unknown:[]};}},canOperate:async()=>!busy}));
 const journal={put:async t=>{records.set(t.id,structuredClone(t));},list:async()=>[],authorized:async t=>records.has(t.id)};
 const runtime=new AgentRuntime({journal,tools,skills,report:async r=>reports.push(r),epoch:()=>1,clock:()=>now,autoSchedule:false});
 const start=()=>runtime.start({skill:'conversation.manage',goal:'照看会话',subjects,completion,parameters:{behavior}}, {role:'owner',verified:true,sources:['owner'],scene:'life'});
 return {runtime,start,sent,reports,decisions,records,setVisible:v=>{visible=v;},incoming:(...texts)=>{visible=[...visible,...texts.map(t=>message(t))];},setBusy:v=>{busy=v;},advance:()=>{now+=60000;}};
}
test('continuous conversation batches new messages, uses prior context, waits while busy and replies once',async()=>{
 const h=harness(),{id}=await h.start();await h.runtime.tick(id);h.incoming('one','two');await h.runtime.tick(id);
 const durable=h.records.get(id);assert.equal(durable.inbox.length,1);assert.equal(durable.state.conversations[Object.keys(durable.state.conversations)[0]].cursor.sequence,2);
 h.setBusy(true);await h.runtime.tick(id);assert.equal(h.sent.length,0);assert.equal(h.runtime.tasks.get(id).inbox.length,1);
 h.setBusy(false);await h.runtime.tick(id);assert.deepEqual(h.sent,['reply one+two']);assert.equal(h.decisions.length,1,'busy retries reuse the persisted reply');
 assert(h.decisions[0].conversation.cursor.recent.some(m=>m.text==='old'));
 await h.runtime.tick(id);assert.equal(h.sent.length,1);
 h.advance();h.incoming('three');await h.runtime.tick(id);await h.runtime.tick(id);assert.equal(h.sent.length,2);
});
test('advertisements are ignored and never sent or repeatedly reported',async()=>{
 const h=harness({brain:()=>({decision:'ignore',reply:'',summary:'obvious advertising',completed:false,progress:{},unknown:[]})}),{id}=await h.start();
 await h.runtime.tick(id);h.incoming('SALE click now');await h.runtime.tick(id);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.equal(h.sent.length,0);assert.equal(h.reports.length,0);assert.equal(h.runtime.tasks.get(id).inbox.length,0);
});
test('a busy reply continues observing and merges later messages before its first send',async()=>{
 const h=harness(),{id}=await h.start();await h.runtime.tick(id);h.incoming('first');await h.runtime.tick(id);
 h.setBusy(true);await h.runtime.tick(id);assert.equal(h.decisions.length,1);
 h.incoming('later update');await h.runtime.tick(id);
 assert.equal(h.runtime.tasks.get(id).inbox.length,1);assert.equal(h.runtime.tasks.get(id).inbox[0].messages.length,2);
 assert.equal(h.records.get(id).inbox[0].messages.length,2);assert.equal(h.sent.length,0);
 h.setBusy(false);await h.runtime.tick(id);assert.deepEqual(h.sent,['reply first+later update']);
});
test('inquiry remains active after opening and finishes only after the goal is answered',async()=>{
 const h=harness({behavior:'inquiry',completion:'goal',brain:a=>a.phase==='opening'?{decision:'reply',reply:'I am Bunny. How is the project?',completed:false,progress:{},unknown:['progress'],summary:''}:{decision:'reply',reply:'Thank you.',completed:true,progress:{progress:'80%'},unknown:[],summary:'Alice said 80% complete.'}}),{id}=await h.start();
 await h.runtime.tick(id);assert.equal(h.sent.length,1);assert.equal(h.runtime.tasks.get(id).status,'waiting');
 h.advance();h.incoming('80%');await h.runtime.tick(id);await h.runtime.tick(id);
 assert.equal(h.runtime.tasks.get(id).status,'completed');assert(h.reports[0].text.includes('80%'));
});
test('an opening deferred while busy is not lost after the baseline was established',async()=>{
 const h=harness({behavior:'inquiry',brain:()=>({decision:'reply',reply:'Hello from Bunny',summary:'',completed:false,progress:{},unknown:[]})}),{id}=await h.start();
 h.setBusy(true);await h.runtime.tick(id);h.setBusy(false);await h.runtime.tick(id);assert.equal(h.sent.length,1);
});
test('reply generation receives actual previous messages and only supplied related memories',async()=>{
 let payload;const brain=new ConversationBrain({request:async options=>{payload=JSON.parse(options.messages[1].content);return {response:{text:JSON.stringify({decision:'reply',reply:'Okay.',summary:'confirmed',completed:false,progress:{},unknown:[]})}};}});
 await brain.decide({task:{goal:'ask progress',criteria:'answer',policy:'no commitments',parameters:{behavior:'reply'}},subject:{recipient:'Alice'},conversation:{cursor:{recent:[message('The project is called Alpha.')]},summary:'project conversation'},incoming:[message('It is done.')],memories:[{text:'Alice prefers concise messages',source:'owner'}]});
 assert.equal(payload.conversation[0].text,'The project is called Alpha.');assert.equal(payload.memories.length,1);
});
