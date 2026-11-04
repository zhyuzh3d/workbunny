'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('verified self-channel inputs can replace an older reply, while Bunny echoes and ordinary outgoing history cannot',()=>{
 const {hasNewInput}=require('../src/main/conversation-cursor'),message={direction:'outgoing',kind:'text',observedVerified:true,origin:'screen'};
 assert.equal(hasNewInput({messages:[message]}),false);
 assert.equal(hasNewInput({ownerChannel:true,messages:[message]}),true);
 assert.equal(hasNewInput({ownerChannel:true,messages:[{...message,origin:'bunny'}]}),false);
 assert.equal(hasNewInput({messages:[{direction:'incoming',incomingVerified:true}]}),true);
});
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
test('a newly recognized message reacts immediately and the next poll waits from completion time',async()=>{
 let h;h=harness({brain:()=>{h.advance();return {decision:'reply',reply:'received',summary:'noted',completed:false,progress:{},unknown:[]};}});
 const {id}=await h.start();await h.runtime.tick(id);h.incoming('new');await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).nextCheckAt,h.runtime.clock());
 await h.runtime.tick(id);const task=h.runtime.tasks.get(id);assert.equal(task.nextCheckAt,h.runtime.clock()+3000);assert.equal(task.state.conversations[Object.keys(task.state.conversations)[0]].lastSentAt,h.runtime.clock());
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
test('a weak visual anchor followed by a previous Bunny reply cannot replay history as new messages',()=>{
 const c=new ConversationCursor();c.observe([message('old'),message('request')]);c.noteSent('previous reply',{operationId:'sent-1'});
 c.observe([message('old'),message('request'),message('previous reply','outgoing'),message('new voice')]);
 const state=c.snapshot();state.baseline=[state.baseline.at(-1)];const recovered=new ConversationCursor(state),before=recovered.snapshot();
 const result=recovered.observe([message('new voice'),message('old'),message('request'),message('previous reply','outgoing'),message('new voice')]);
 assert.equal(result.uncertain,true);assert.deepEqual(recovered.snapshot(),before);
});
test('file-card labels and sizes may vary without hiding a following real text message',()=>{
 const c=new ConversationCursor(),file=text=>({...message(text,'outgoing'),kind:'file'});
 c.observe([message('completed','outgoing'),file('[文件] owner-result.txt 22B')]);
 const delta=c.observe([message('completed','outgoing'),file('[文件]'),message('BUNNY SOAK 1')]);
 assert.equal(delta.uncertain,undefined);assert.deepEqual(delta.messages.map(m=>m.text),['BUNNY SOAK 1']);
 assert.equal(c.observe([message('completed','outgoing'),file('owner-result.txt 22字节'),message('BUNNY SOAK 1')]).messages.length,0);
});
test('a verified outgoing file card matches the delivery outbox by its separate visible filename',()=>{
 const c=new ConversationCursor();c.observe([message('old','outgoing')],{ownerChannel:true});
 const delta=c.observe([message('old','outgoing'),{...message('[文件]','outgoing'),kind:'file',fileName:'result.txt'}],{ownerChannel:true,sentMessages:[{id:'file-1',kind:'file',text:'［Bunny］ result.txt'}]});
 assert.equal(delta.messages.length,0);assert.equal(c.snapshot().recent.at(-1).origin,'bunny');
});
test('uncertain message order reobserves the visible exact conversation without repetitive navigation',async()=>{
 const observations=[],h=harness({observe:(args,messages)=>{observations.push(args);return {headerMatched:true,changed:true,messages,draft:''};}}),{id}=await h.start();await h.runtime.tick(id);h.setVisible([message('different screen')]);await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).status,'waiting');await h.runtime.tick(id);
 const task=h.runtime.tasks.get(id);assert.equal(task.status,'waiting');assert(observations.at(-1).force===true);assert.equal(h.sent.length,0);
 const opens=Object.values(task.operations).filter(op=>op.tool==='conversation.open').length;await h.runtime.tick(id);
 assert.equal(Object.values(task.operations).filter(op=>op.tool==='conversation.open').length,opens,'later uncertain reads do not repeat navigation');
 h.setVisible([message('old'),message('fresh verified')]);await h.runtime.tick(id);assert.equal(task.inbox.length,1);assert.equal(task.inbox[0].messages[0].text,'fresh verified');
});
function harness({behavior='reply',brain,completion='manual',subjects=[{application:'wechat',recipient:'Alice'}],observe,transcribe,onOpen}={}){
 let visible=[message('old')],busy=false;const sent=[],reports=[],records=new Map(),tools=new ToolRegistry();let now=1000;
 tools.register({name:'conversation.observe',description:'pixels',effect:'read',capabilities:['conversation.read'],scope:a=>a,execute:async a=>observe?observe(a,visible):({headerMatched:true,changed:true,messages:visible,draft:''})});
 tools.register({name:'conversation.open',description:'open',effect:'read',capabilities:['screen.input'],scope:a=>a,execute:async()=>{onOpen?.();return {ok:true};}});
 tools.register({name:'conversation.transcribe',description:'voice',effect:'read',capabilities:['screen.input','conversation.read'],scope:a=>a,execute:async a=>transcribe?transcribe(a):({pending:true})});
 tools.register({name:'conversation.send',description:'send',effect:'write',capabilities:['conversation.send'],scope:a=>a,execute:async a=>{sent.push(a.message);visible=[...visible,message(a.message,'outgoing')];return {ok:true,verified:true,receipt:{at:now}};}});
 tools.register({name:'memory.related',description:'related shared memories',effect:'read',capabilities:['memory.read'],scope:a=>a,execute:async()=>({items:[]})});
 tools.register({name:'owner.dispatch',description:'owner',effect:'write',capabilities:['owner.command'],scope:a=>a,execute:async()=>({ok:true,verified:true})});
 const decisions=[],skills=new SkillRegistry(tools).register(conversationSkill({brain:{decide:async args=>{decisions.push(args);return brain?brain(args):{decision:'reply',reply:'reply '+args.incoming.map(m=>m.text).join('+'),summary:'noted',completed:false,progress:{},unknown:[]};}},canOperate:async()=>!busy}));
 const journal={put:async t=>{records.set(t.id,structuredClone(t));},list:async()=>[],authorized:async t=>records.has(t.id)};
 const runtime=new AgentRuntime({journal,tools,skills,report:async r=>reports.push(r),epoch:()=>1,clock:()=>now,autoSchedule:false});
 const start=()=>runtime.start({skill:'conversation.manage',goal:'照看会话',subjects,completion,parameters:{behavior}}, {role:'owner',verified:true,sources:['owner'],scene:'life'});
 return {runtime,start,sent,reports,decisions,records,setVisible:v=>{visible=v;},incoming:(...texts)=>{visible=[...visible,...texts.map(t=>message(t))];},setBusy:v=>{busy=v;},advance:(ms=60000)=>{now+=ms;}};
}
test('a prepared reply retries GUI admission each second without waiting for the monitor period or regenerating its answer',async()=>{
 const h=harness(),{id}=await h.start();await h.runtime.tick(id);h.incoming('reply promptly');await h.runtime.tick(id);
 const task=h.runtime.tasks.get(id);task.schedule.intervalSeconds=60;
 h.setBusy(true);await h.runtime.tick(id);const first=task.nextCheckAt;
 h.advance(1000);await h.runtime.tick();assert.equal(task.nextCheckAt,first+1000);assert.equal(h.decisions.length,1);assert.equal(task.inbox.length,1);
 h.setBusy(false);h.advance(1000);await h.runtime.tick();assert.deepEqual(h.sent,['reply reply promptly']);assert.equal(h.decisions.length,1);assert.equal(task.inbox.length,0);await h.runtime.close();
});
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

test('a shared scene revision is processed even after another observer marked it unchanged',async()=>{
 let rev='first';const h=harness({observe:(_a,visible)=>({headerMatched:true,changed:false,revision:rev,messages:visible,draft:''})}),{id}=await h.start();
 await h.runtime.tick(id);h.incoming('new');rev='second';await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).inbox.length,1);
 await h.runtime.tick(id);assert.deepEqual(h.sent,['reply new']);
});
test('voice stays queued while transcription is pending and replies once with verified text',async()=>{
 let calls=0;const h=harness({transcribe:async a=>{calls++;return calls===1?{requested:true,pending:true}:{verified:true,text:'你好，明天见'};}}),{id}=await h.start();
 await h.runtime.tick(id);h.setVisible([message('old'),{...message('[语音]'),kind:'voice'}]);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.equal(h.sent.length,0);assert.equal(h.runtime.tasks.get(id).inbox.length,1);assert(Object.values(h.runtime.tasks.get(id).inbox[0].voiceStates)[0].requestedAt);
 await h.runtime.tick(id);assert.deepEqual(h.sent,['reply 你好，明天见']);assert.equal(h.runtime.tasks.get(id).inbox.length,0);
});
test('a delayed voice transcription is rechecked and retried without abandoning the message',async()=>{
 const seen=[];const h=harness({transcribe:async a=>{seen.push(a.requested);return seen.length<4?{requested:true,pending:true}:{verified:true,text:'语音已识别'};}}),{id}=await h.start();
 await h.runtime.tick(id);h.setVisible([message('old'),{...message('[语音]'),kind:'voice'}]);await h.runtime.tick(id);await h.runtime.tick(id);
 for(let i=0;i<3;i++){h.advance();await h.runtime.tick(id);}
 assert.equal(seen.length,4);assert(seen.every(flag=>flag!==true),'no stale requested flag can force a blind wait');assert.deepEqual(h.sent,['reply 语音已识别']);assert.equal(h.runtime.tasks.get(id).status,'waiting');await h.runtime.close();
});
test('consecutive text and voice messages are combined in order and answered once',async()=>{
 const calls=[];const h=harness({transcribe:async a=>{calls.push(a.sequence);return {verified:true,text:'voice '+a.sequence};}}),{id}=await h.start();
 await h.runtime.tick(id);h.setVisible([message('old'),message('first'),{...message('[语音]'),kind:'voice'},message('last')]);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.deepEqual(h.sent,['reply first+voice 2+last']);assert.deepEqual(calls,[2]);assert.equal(h.runtime.tasks.get(id).inbox.length,0);
});
test('separate new messages can be answered without an artificial default delay',async()=>{
 const h=harness(),{id}=await h.start();await h.runtime.tick(id);h.incoming('one');await h.runtime.tick(id);await h.runtime.tick(id);
 h.incoming('two');await h.runtime.tick(id);await h.runtime.tick(id);assert.deepEqual(h.sent,['reply one','reply two']);
});

test('an unread badge uses the already visible new message without unnecessary navigation',async()=>{
 let unread=false,opens=0;const h=harness({observe:(_a,visible)=>({headerMatched:true,changed:false,unread,messages:visible,draft:''}),onOpen:()=>{opens++;unread=false;}}),{id}=await h.start();
 await h.runtime.tick(id);const before=opens;unread=true;h.incoming('hello');await h.runtime.tick(id);assert.equal(opens,before);assert.equal(h.runtime.tasks.get(id).inbox.length,1);await h.runtime.tick(id);assert.deepEqual(h.sent,['reply hello']);
});
test('an initially unverified text is retained, visually rechecked and replied to',async()=>{
 let allow=false;const h=harness({observe:(args,visible)=>({headerMatched:true,changed:true,messages:visible.map(m=>m.text==='new'&&args.force&&allow?{...m,incomingVerified:true}:m),draft:''})}),{id}=await h.start();
 await h.runtime.tick(id);h.setVisible([message('old'),{...message('new'),incomingVerified:false}]);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.equal(h.sent.length,0);assert.equal(h.runtime.tasks.get(id).inbox.length,1);allow=true;await h.runtime.tick(id);
 assert.deepEqual(h.sent,['reply new']);assert.equal(h.runtime.tasks.get(id).inbox.length,0);
});
test('multiple voice messages are transcribed in order before one reply',async()=>{
 const seen=[];const h=harness({transcribe:async a=>{seen.push(a.sequence);return {verified:true,text:'语音'+a.sequence};}}),{id}=await h.start();
 await h.runtime.tick(id);h.setVisible([message('old'),{...message('[语音]'),kind:'voice'},{...message('[语音]'),kind:'voice'}]);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.deepEqual(seen,[1,2]);assert.deepEqual(h.sent,['reply 语音1+语音2']);
});
test('a reply from a delayed decision executes once even if subsequent samples are quiet',async()=>{
 let finish,entered;const startedDecision=new Promise(r=>entered=r),decision=new Promise(r=>finish=r);let changed=true,revision='base';
 const h=harness({observe:(_a,visible)=>({headerMatched:true,changed,revision,messages:visible,draft:''}),brain:async()=>{entered();return decision;}}),{id}=await h.start();
 await h.runtime.tick(id);h.incoming('new');revision='new';await h.runtime.tick(id);
 const running=h.runtime.tick(id);await startedDecision;changed=false;await h.runtime.tick(id);assert.equal(h.sent.length,0);
 finish({decision:'reply',reply:'received',summary:'done',completed:false,progress:{},unknown:[]});await running;await h.runtime.tick(id);
 assert.deepEqual(h.sent,['received']);assert.equal(h.runtime.tasks.get(id).inbox.length,0);
});
test('an exhausted model output budget retries the same observation with a bounded larger budget',async()=>{
 const calls=[],{checkedJSON}=require('../src/main/agent-json');
 const result=await checkedJSON({messages:[{role:'user',content:'fixture'}]},value=>value,{request:async options=>{calls.push(options);if(calls.length===1)throw Object.assign(Error('limited'),{code:'E_OUTPUT_LIMIT'});return {response:{text:'{"ok":true}'}};}});
 assert.equal(result.value.ok,true);assert.equal(calls.length,2);assert.equal(calls[1].maxTokens,4096);assert.deepEqual(calls[1].messages,calls[0].messages);
});

test('a repeated voice around an old timeline never causes the old timeline to be enqueued again',()=>{
 const voice={...message('[语音]'),kind:'voice'};
 const c=new ConversationCursor();c.observe([voice]);const before=c.snapshot();
 const result=c.observe([voice,message('earlier text'),message('previous reply','outgoing'),voice]);
 assert.equal(result.uncertain,true);assert.deepEqual(c.snapshot(),before);
});

test('a repeated multi-message sequence after an intact baseline remains a real new event',()=>{
 const c=new ConversationCursor();c.observe([message('A'),message('B')]);
 assert.deepEqual(c.observe([message('A'),message('B'),message('A'),message('B')]).messages.map(m=>m.text),['A','B']);
});

test('a unique complete text remains locatable when neighboring media recognition changes',()=>{
 const {locateObserved,messageKey}=require('../src/main/conversation-cursor');
 const target={...message('Unique new request'),sequence:7};target.key=messageKey(target);
 const other={...message('old media'),kind:'voice'};other.key=messageKey(other);
 const state={recent:[other,target],baseline:[other.key,target.key]};
 assert.equal(locateObserved(state,[message('different old text'),message('Unique new request')],7).text,'Unique new request');
 assert.equal(locateObserved(state,[message('Unique new request'),message('Unique new request')],7),null);
});

test('authenticated task dispatch follows the confirmed acknowledgment and recovers without resending it',async()=>{
 const {conversationSkill,subjectKey}=require('../src/main/conversation-skill'),subject={application:'wechat',recipient:'Contact'},order=[];
 const decision={decision:'reply',reply:'I have your task and will run it.',summary:'accepted',completed:false,progress:{},unknown:[],ownerAction:{type:'task'}},event={key:'owner-task',type:'conversation.messages',subjectKey:subjectKey(subject),messages:[message('Run this actual task')]};
 const task={id:'owner-listener',parameters:{behavior:'reply'},subjects:[subject],scene:'life',completion:'manual',state:{},operations:{},schedule:{intervalSeconds:3,activeIntervalSeconds:3},inbox:[event],counters:{wakes:1}};
 const skill=conversationSkill({channelDialogue:true,canOperate:async()=>true,brain:{decide:async()=>decision}});assert(skill.capabilitiesFor(task).includes('owner.command'));
 let failAck=true,confirmed=false;
 const receipt={operationId:'ack-operation',submittedAt:Date.now(),sentText:decision.reply};
 const call=async action=>{if(action.tool==='conversation.observe')return {headerMatched:true,changed:false,messages:[],draft:''};if(action.tool==='conversation.send'){order.push('ack');if(failAck)throw Error('acknowledgment not delivered');confirmed=true;return {verified:true,receipt};}if(action.tool==='owner.dispatch'){assert(confirmed,'work cannot start before the owner receives acknowledgment');assert.equal(action.key,'owner:'+event.key);order.push('dispatch');return {ok:true,taskId:'new-task'};}throw Error('unexpected tool '+action.tool);};
 const context={task,event,clock:Date.now,now:Date.now(),signal:new AbortController().signal,checkpoint:async()=>{},report:async()=>{},call};
 await assert.rejects(skill.run(context),/not delivered/);assert.deepEqual(order,['ack']);
 failAck=false;await skill.run(context);assert.deepEqual(order,['ack','ack','dispatch']);
 order.length=0;await skill.run({...context,completedCall:()=>({verified:true,receipt})});assert.deepEqual(order,['dispatch'],'a recovered acknowledgment proceeds through the existing dispatch ledger without sending it again');
});
