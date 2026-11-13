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
 const delta=c.observe([message('old','outgoing'),{...message('[文件]','outgoing'),kind:'file',fileName:'result.txt'}],{ownerChannel:true,sentMessages:[{id:'file-1',kind:'file',text:'［ᕱᕱ］ result.txt'}]});
 assert.equal(delta.messages.length,0);assert.equal(c.snapshot().recent.at(-1).origin,'bunny');
});
test('uncertain message order reobserves the visible exact conversation without repetitive navigation',async()=>{
 const observations=[],h=harness({observe:(args,messages)=>{observations.push(args);return {headerMatched:true,changed:true,messages,draft:''};}}),{id}=await h.start();await h.runtime.tick(id);h.setVisible([message('different screen')]);await h.runtime.tick(id);assert.equal(h.runtime.tasks.get(id).status,'waiting');await h.runtime.tick(id);
 const task=h.runtime.tasks.get(id);assert.equal(task.status,'waiting');assert(observations.at(-1).force===true);assert.equal(h.sent.length,0);
 const opens=Object.values(task.operations).filter(op=>op.tool==='conversation.open').length;await h.runtime.tick(id);
 assert.equal(Object.values(task.operations).filter(op=>op.tool==='conversation.open').length,opens,'later uncertain reads do not repeat navigation');
 h.setVisible([message('old'),message('fresh verified')]);await h.runtime.tick(id);assert.equal(task.inbox.length,1);assert.equal(task.inbox[0].messages[0].text,'fresh verified');
});
function harness({behavior='reply',brain,completion='manual',subjects=[{application:'wechat',recipient:'Alice'}],observe,transcribe,onOpen,channelDialogue=false}={}){
 let visible=[message('old')],busy=false,opened=!onOpen;const sent=[],reports=[],records=new Map(),tools=new ToolRegistry();let now=1000;
 tools.register({name:'conversation.observe',description:'pixels',effect:'read',capabilities:['conversation.read'],scope:a=>a,execute:async a=>!opened?{headerMatched:false,changed:true,messages:[],draft:''}:observe?observe(a,visible):({headerMatched:true,changed:true,messages:visible,draft:''})});
 tools.register({name:'conversation.open',description:'open',effect:'read',capabilities:['screen.input'],scope:a=>a,execute:async(_args,context)=>{const result=await onOpen?.(context);opened=true;return result||{ok:true};}});
 tools.register({name:'conversation.transcribe',description:'voice',effect:'read',capabilities:['screen.input','conversation.read'],scope:a=>a,execute:async a=>transcribe?transcribe(a):({pending:true})});
 tools.register({name:'conversation.send',description:'send',effect:'write',capabilities:['conversation.send'],scope:a=>a,execute:async a=>{sent.push(a.message);visible=[...visible,message(a.message,'outgoing')];return {ok:true,verified:true,receipt:{at:now}};}});
 tools.register({name:'memory.related',description:'related shared memories',effect:'read',capabilities:['memory.read'],scope:a=>a,execute:async()=>({items:[]})});
 tools.register({name:'owner.dispatch',description:'owner',effect:'write',capabilities:['owner.command'],scope:a=>a,execute:async()=>({ok:true,verified:true})});
 tools.register({name:'conversation.save',description:'save',effect:'write',capabilities:['conversation.read'],scope:a=>a,execute:async()=>({ok:true,verified:true})});
 const decisions=[],skills=new SkillRegistry(tools).register(conversationSkill({brain:{decide:async args=>{decisions.push(args);return brain?brain(args):{decision:'reply',reply:'reply '+args.incoming.map(m=>m.text).join('+'),summary:'noted',completed:false,progress:{},unknown:[]};}},canOperate:async()=>!busy,channelDialogue,ownerBindings:()=>true}));
 const journal={put:async t=>{records.set(t.id,structuredClone(t));},list:async()=>[],authorized:async t=>records.has(t.id)};
 const runtime=new AgentRuntime({journal,tools,skills,report:async r=>reports.push(r),epoch:()=>1,clock:()=>now,autoSchedule:false});
 const start=()=>runtime.start({skill:'conversation.manage',goal:'照看会话',subjects,completion,parameters:{behavior}}, {role:'owner',verified:true,sources:['owner'],scene:'life'});
 return {runtime,start,sent,reports,decisions,records,setVisible:v=>{visible=v;},incoming:(...texts)=>{visible=[...visible,...texts.map(t=>message(t))];},setBusy:v=>{busy=v;},advance:(ms=60000)=>{now+=ms;}};
}
test('active preparation retains one action and recovery through repeated navigation timeouts instead of restarting passive polling',async()=>{
 let h;const actions=[],diagnoses=[];
 h=harness({behavior:'inquiry',onOpen:context=>{actions.push(context.action);h.advance(20000);throw Error('synthetic planning timeout');}});
 h.runtime.diagnoseRepair=async info=>{diagnoses.push(info);return {action:diagnoses.length===1?'change_method':'ask_owner',source:'llm',nextStep:'synthetic alternative observation'};};
 const {id}=await h.start();await h.runtime.tick(id);const task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0];
 assert(run);assert.equal(run.attempts,1);assert.equal(diagnoses.length,1);const startedAt=run.progress.startedAt;
 await h.runtime.tick(id);assert.equal(diagnoses.length,2);assert.equal(diagnoses[0].kind,'stall');assert.equal(run.attempts,2);assert.equal(task.status,'waiting');
 assert.equal(run.progress.startedAt,startedAt);assert(diagnoses[1].progress.elapsedMs>=40000);
 await h.runtime.tick(id);assert.equal(task.status,'waiting');assert.equal(run.recovery.action,'wait');h.advance(4000);await h.runtime.tick(id);assert.equal(task.status,'needs_attention');assert.equal(diagnoses.length,3);assert.equal(actions[2].recovery.action,'change_method');
 assert.equal(actions[1].recovery.nextStep,'synthetic alternative observation');assert.match(actions[2].recovery.nextStep,/获准的观察角度/u,'an early ask-owner opinion cannot substitute for the next actual verification');assert.equal(Object.values(task.actionRuns).length,1);assert.equal(h.sent.length,0);
 await h.runtime.tick(id);assert.equal(actions.length,4);await h.runtime.close();
});
test('successful preparation retires its active action and healthy passive watching does not accumulate stall recovery',async()=>{
 const h=harness(),{id}=await h.start();let diagnoses=0;h.runtime.diagnoseRepair=async()=>{diagnoses++;return {action:'ask_owner',source:'llm'};};
 await h.runtime.tick(id);const task=h.runtime.tasks.get(id),run=Object.values(task.actionRuns)[0];assert.equal(run.status,'completed');
 for(let i=0;i<6;i++){h.advance();await h.runtime.tick(id);}
 assert.equal(diagnoses,0);assert.equal(task.status,'waiting');assert.equal(Object.values(task.actionRuns).length,1);assert.equal(h.sent.length,0);await h.runtime.close();
});
test('a successful navigation claim contradicted by the observed target reaches action recovery without consuming another conversation',async()=>{
 let wrong=true,opens=0,h;const recoveries=[];
 h=harness({onOpen:context=>{if(++opens===2){assert.equal(context.task.state.outcomeFeedback.at(-1).observed.target,'Different fixture');assert.equal(context.action.recovery.action,'change_method');wrong=false;}return {ok:true,executionClaim:{completed:true,evidence:'The requested fixture was opened',physicalId:'synthetic-open'}};},observe:(_args,visible)=>wrong?{headerMatched:false,headerText:'Different fixture',changed:true,observationId:'wrong-observation',messages:[message('other-contact-body-canary')]}:{headerMatched:true,headerText:'Alice',changed:true,messages:visible}});
 h.runtime.diagnoseRepair=async info=>{recoveries.push(info);return {action:'change_method',source:'llm',nextStep:'Use the preserved observed mismatch to choose the exact requested target'};};
 const {id}=await h.start();await h.runtime.tick(id);const task=h.runtime.tasks.get(id),state=Object.values(task.state.conversations)[0];
 assert.equal(recoveries.length,1);assert.equal(recoveries[0].kind,'stall');assert.equal(recoveries[0].code,'E_NO_PROGRESS');assert(!JSON.stringify(recoveries).includes('Different fixture'),'ordinary diagnostics contain no contact title');assert.equal(state.cursor.ready,undefined);assert.equal(task.inbox.length,0);assert.equal(h.sent.length,0);assert(!JSON.stringify(task).includes('other-contact-body-canary'));
 const feedback=task.state.outcomeFeedback[0];assert.equal(feedback.expected.target,'Alice');assert.equal(feedback.observed.target,'Different fixture');assert.equal(feedback.execution.claimedCompleted,true);assert(feedback.execution.operationId);
 await h.runtime.tick(id);assert.equal(opens,2);assert.equal(state.cursor.ready,true);assert.equal(Object.values(task.actionRuns).length,1);h.incoming('real fixture input');await h.runtime.tick(id);await h.runtime.tick(id);assert.deepEqual(h.sent,['reply real fixture input']);await h.runtime.close();
});
test('owner stop isolates a late target-mismatch observation from the retired preparation',async()=>{
 let entered,release;const started=new Promise(resolve=>entered=resolve),h=harness({onOpen:()=>({ok:true,executionClaim:{completed:true}}),observe:()=>{entered();return new Promise(resolve=>release=resolve);}}),{id}=await h.start();
 const pending=h.runtime.tick(id);await started;await h.runtime.stop(h.runtime.tasks.get(id));await pending;release({headerMatched:false,headerText:'Late different fixture',changed:true,messages:[message('late-other-body')]});await new Promise(resolve=>setImmediate(resolve));
 const task=h.runtime.tasks.get(id);assert.equal(task.status,'stopped');assert.equal(task.state.outcomeFeedback,undefined);assert.equal(task.inbox.length,0);assert.deepEqual(h.sent,[]);assert(!JSON.stringify(task).includes('Late different fixture'));await h.runtime.close();
});
test('pause and restore retain active preparation progress without input until explicit resume',async()=>{
 let h;let opens=0;h=harness({onOpen:()=>{opens++;h.advance(20000);throw Error('synthetic planning timeout');}});
 h.runtime.diagnoseRepair=async()=>({action:'change_method',source:'llm'});
 const {id}=await h.start();await h.runtime.tick(id);await h.runtime.control('pause',id);const saved=h.records.get(id),run=Object.values(saved.actionRuns)[0];
 const restored=new AgentRuntime({journal:{put:async t=>h.records.set(t.id,structuredClone(t)),list:async()=>[structuredClone(saved)],authorized:async()=>true},tools:h.runtime.tools,skills:h.runtime.skills,epoch:()=>1,clock:h.runtime.clock,autoSchedule:false});
 await restored.restore();await restored.tick(id);assert.equal(restored.tasks.get(id).status,'paused');assert.equal(opens,1);
 assert.equal(Object.values(restored.tasks.get(id).actionRuns)[0].progress.startedAt,run.progress.startedAt);
 await restored.control('resume',id);await restored.tick(id);assert.equal(opens,2);assert.equal(Object.values(restored.tasks.get(id).actionRuns).length,1);
 assert.equal(h.sent.length,0);await restored.close();await h.runtime.close();
});
test('failed active preparation has bounded fallback when the recovery service is unavailable',async()=>{
 let h;let opens=0;h=harness({onOpen:({action})=>{opens++;action.progress.observe('synthetic.observation',{page:opens});h.advance(20000);throw Error('synthetic planning timeout');}});
 const {id}=await h.start();for(let i=0;i<9;i++){await h.runtime.tick(id);h.advance(4000);}
 const task=h.runtime.tasks.get(id);assert.equal(opens,7);assert.equal(task.status,'needs_attention');assert.equal(Object.values(task.actionRuns)[0].recoveryState.totalAttempts,6);
 assert.equal(h.sent.length,0);assert(h.reports.some(r=>/自动恢复预算已到/.test(r.text)));await h.runtime.close();
});
test('pausing during active recovery rejects a late decision and cannot restart preparation',async()=>{
 let h,entered,release;const at=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let opens=0;
 h=harness({onOpen:()=>{opens++;h.advance(20000);throw Error('synthetic planning timeout');}});
 h.runtime.diagnoseRepair=async()=>{entered();await gate;return {action:'change_method',source:'llm',nextStep:'late synthetic advice'};};
 const {id}=await h.start();const pending=h.runtime.tick(id);await at;await h.runtime.control('pause',id);release();await pending;
 await h.runtime.tick(id);const task=h.runtime.tasks.get(id);assert.equal(task.status,'paused');assert.equal(opens,1);assert.equal(Object.values(task.actionRuns)[0].recovery,undefined);
 assert.equal(h.sent.length,0);await h.runtime.close();
});
test('a revised goal retires its superseded preparation without leaving a stale idle action',async()=>{
 let h;h=harness({onOpen:()=>{h.advance(20000);throw Error('synthetic planning timeout');}});
 const {id}=await h.start();await h.runtime.tick(id);const task=h.runtime.tasks.get(id),old=Object.values(task.actionRuns)[0];
 await h.runtime.update(id,{goal:'synthetic revised goal'},{role:'owner',verified:true,sources:['new-owner-request'],scene:'life'});await h.runtime.tick(id);
 assert.equal(old.status,'cancelled');const current=Object.values(task.actionRuns).find(run=>run.id!==old.id);assert.equal(current.attempts,1);assert.equal(current.activePhase,'prepare:1');
 assert.equal(h.sent.length,0);await h.runtime.close();
});
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
 await h.runtime.tick(id); // The new observation first cancels the old response worker.
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

test('goal completion is assessed after the real receipt, independently of the unsent decision',async t=>{
 for(const completed of [true,false]){
  const h=harness({completion:'goal',brain:args=>args.phase==='post-send'?{decision:'ignore',reply:'',summary:'Actual result assessed',completed,progress:{},unknown:[]}:{decision:'reply',reply:'Acknowledged',summary:'Not yet sent',completed:!completed,progress:{},unknown:[]}});t.after(()=>h.runtime.close());
  const {id}=await h.start();await h.runtime.tick(id);h.incoming('A new synthetic message');await h.runtime.tick(id);await h.runtime.tick(id);
  assert.deepEqual(h.sent,['Acknowledged']);assert.deepEqual(h.decisions.map(args=>args.phase||'incoming'),['incoming','post-send']);assert.equal(h.decisions[1].deliveryReceipt.verified,true);assert(h.decisions[1].deliveryReceipt.receipt);
  assert.equal(h.runtime.tasks.get(id).status,completed?'completed':'waiting');
 }
});

test('failed post-send assessment retries only judgment against the confirmed send and persists it',async()=>{
 const {subjectKey}=require('../src/main/conversation-skill'),subject={application:'wechat',recipient:'Synthetic Contact'},receipt={operationId:'verified-send',submittedAt:1000,sentText:'Acknowledged'},decision={decision:'reply',reply:'Acknowledged',summary:'Pending send',completed:false,progress:{},unknown:[]};
 const event={key:'event',type:'conversation.messages',subjectKey:subjectKey(subject),messages:[message('New synthetic message')],decision};
 const task={id:'synthetic-post-send',completion:'goal',parameters:{behavior:'reply'},subjects:[subject],state:{},operations:{send:{effect:'write',status:'confirmed',key:'reply:event'}},inbox:[event],schedule:{intervalSeconds:3,activeIntervalSeconds:3},counters:{wakes:1}};
 let sends=0,assessments=0,reports=0;
 const skill=conversationSkill({canOperate:async()=>true,brain:{decide:async args=>{assert.equal(args.phase,'post-send');assert.deepEqual(args.deliveryReceipt.receipt,receipt);if(++assessments===1)throw Object.assign(Error('synthetic assessment timeout'),{code:'E_MODEL_TIMEOUT'});return {decision:'ignore',reply:'',summary:'Real result completes the goal',completed:true,progress:{},unknown:[]};}}});
 const context={task,event,clock:()=>2000,now:2000,signal:new AbortController().signal,checkpoint:async()=>{},report:async()=>{reports++;},call:async operation=>{assert.equal(operation.tool,'conversation.send');sends++;return {verified:true,receipt};}};
 await assert.rejects(skill.run(context),{code:'E_MODEL_TIMEOUT'});assert.equal(sends,1);assert.equal(reports,0);assert.notEqual(task.state.conversations[subjectKey(subject)].completed,true);
 const recovered={...context,completedCall:()=>({verified:true,receipt})};assert.equal((await skill.run(recovered)).status,'completed');assert.equal(sends,1);assert.equal(assessments,2);assert.equal(event.completionAssessment.completed,true);
 await skill.run(recovered);assert.equal(assessments,2,'stored judgment is reused for the same goal revision');
});

test('post-send brain uses task inference budget, requires a receipt and cannot propose a new send',async()=>{
 const requests=[],task={goal:'Respond and finish when the authorized objective is satisfied',criteria:'Real reply received',policy:'Only the authorized conversation',parameters:{behavior:'reply'}},subject={application:'synthetic',recipient:'Synthetic Contact'},conversation={cursor:{recent:[]}};
 const brain=new ConversationBrain({request:async options=>{requests.push(options);return {response:{text:JSON.stringify({decision:'ignore',reply:'',summary:'Verified result satisfies the objective',completed:true,progress:{},unknown:[]})}};}});
 await assert.rejects(brain.decide({task,subject,conversation,phase:'post-send'}),{code:'E_CONVERSATION_RECEIPT'});assert.equal(requests.length,0);
 const deliveryReceipt={verified:true,receipt:{operationId:'confirmed-send',submittedAt:1000}},result=await brain.decide({task,subject,conversation,phase:'post-send',deliveryReceipt});assert.equal(result.completed,true);assert.equal(requests[0].timeoutMs,90000);assert.deepEqual(JSON.parse(requests[0].messages[1].content).deliveryReceipt,deliveryReceipt);
 brain.request=async()=>({response:{text:JSON.stringify({decision:'reply',reply:'Do not send again',summary:'Wrong phase',completed:true,progress:{},unknown:[]})}});
 await assert.rejects(brain.decide({task,subject,conversation,phase:'post-send',deliveryReceipt}),{code:'E_MODEL_SCHEMA'});
});

test('stop and a changed goal reject late post-send judgments without another input',async()=>{
 for(const change of ['stop','goal']){
  const {subjectKey}=require('../src/main/conversation-skill'),subject={application:'wechat',recipient:'Synthetic Contact'},gate=Promise.withResolvers(),entered=Promise.withResolvers(),controller=new AbortController();
  const event={key:'event',type:'conversation.messages',subjectKey:subjectKey(subject),messages:[message('New synthetic message')],decision:{decision:'reply',reply:'Acknowledged',summary:'Pending',completed:false,progress:{},unknown:[]}};
  const task={id:'synthetic-late-assessment',completion:'goal',parameters:{behavior:'reply'},subjects:[subject],state:{},operations:{send:{effect:'write',status:'confirmed',key:'reply:event'}},inbox:[event],schedule:{intervalSeconds:3,activeIntervalSeconds:3},counters:{wakes:1}};
  const skill=conversationSkill({canOperate:async()=>true,brain:{decide:async()=>{entered.resolve();return gate.promise;}}});
  const pending=skill.run({task,event,clock:()=>2000,now:2000,signal:controller.signal,checkpoint:async()=>{},report:async()=>assert.fail('late judgment cannot report completion'),call:async()=>assert.fail('confirmed send must not replay'),completedCall:()=>({verified:true,receipt:{operationId:'verified-send',submittedAt:1000}})});
  await entered.promise;if(change==='stop')controller.abort();else task.state.goalRevision=1;gate.resolve({decision:'ignore',reply:'',summary:'Late',completed:true,progress:{},unknown:[]});
  await assert.rejects(pending);assert.equal(event.completionAssessment,undefined);assert.notEqual(task.state.conversations[subjectKey(subject)].completed,true);
 }
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
test('ordinary uncertain incoming text reaches the task brain without compulsory rechecking or changing its evidence',async()=>{
 for(const behavior of ['reply','inquiry']){
  const reads=[],h=harness({behavior,observe:(args,messages)=>{reads.push(args);return {headerMatched:true,changed:true,messages,draft:''};}}),{id}=await h.start();
  await h.runtime.tick(id);const before=h.sent.length;h.setVisible([message('old'),{...message('new'),incomingVerified:false,observedVerified:false,visualEvidence:{confidence:.95,textBounds:null,seenText:false,localDirection:null}}]);await h.runtime.tick(id);await h.runtime.tick(id);
  assert.deepEqual(h.sent.slice(before),['reply new']);assert.equal(h.runtime.tasks.get(id).inbox.length,0);assert(!Object.values(h.runtime.tasks.get(id).operations).some(op=>op.key.startsWith('verify-message:')),'ordinary replies do not schedule another message-verification model call');
  const input=h.decisions.at(-1).incoming[0];assert.equal(input.incomingVerified,false);assert.equal(input.observedVerified,false);assert.equal(input.visualEvidence.seenText,false);
  await h.runtime.close();
 }
});
test('owner stop cancels a delayed decision for uncertain ordinary incoming text',async()=>{
 let release,entered;const started=new Promise(resolve=>entered=resolve),h=harness({brain:()=>{entered();return new Promise(resolve=>release=resolve);}}),{id}=await h.start();
 await h.runtime.tick(id);h.setVisible([message('old'),{...message('new'),incomingVerified:false,observedVerified:false}]);await h.runtime.tick(id);
 const running=h.runtime.tick(id);await started;await h.runtime.stop(h.runtime.tasks.get(id));await running;
 release({decision:'reply',reply:'late reply',summary:'late',completed:false,progress:{},unknown:[]});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(h.sent,[]);assert.equal(h.runtime.tasks.get(id).status,'stopped');await h.runtime.close();
});
test('multiple voice messages are transcribed in order before one reply',async()=>{
 const seen=[];const h=harness({transcribe:async a=>{seen.push(a.sequence);return {verified:true,text:'语音'+a.sequence};}}),{id}=await h.start();
 await h.runtime.tick(id);h.setVisible([message('old'),{...message('[语音]'),kind:'voice'},{...message('[语音]'),kind:'voice'}]);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.deepEqual(seen,[1,2]);assert.deepEqual(h.sent,['reply 语音1+语音2']);
});
test('ordinary unread media reaches the task brain without pretending it was transcribed',async()=>{
 for(const behavior of ['reply','inquiry'])for(const kind of ['voice','image','file','other']){
  const h=harness({behavior,transcribe:async()=>({blocked:true,reason:'no readable transcript'}),brain:args=>({decision:'reply',reply:args.phase?'Hello':'收到，谢谢',summary:'acknowledged receipt only',completed:false,progress:{},unknown:[]})}),{id}=await h.start();
  await h.runtime.tick(id);const before=h.sent.length;h.setVisible([message('old'),...h.sent.map(text=>message(text,'outgoing')),{...message('[media]'),kind,incomingVerified:false,observedVerified:false}]);await h.runtime.tick(id);await h.runtime.tick(id);
  assert.deepEqual(h.sent.slice(before),['收到，谢谢'],behavior+':'+kind);const observed=h.decisions.at(-1).incoming[0];assert.equal(observed.kind,kind);assert.equal(observed.text,'[media]');assert.equal(observed.fromVoice,undefined);assert.equal(observed.incomingVerified,false);assert.equal(observed.observedVerified,false);assert.equal(h.runtime.tasks.get(id).inbox.length,0);await h.runtime.close();
 }
});
test('untranscribed media alone cannot enter legacy bound-owner command dispatch',async()=>{
 const h=harness({behavior:'owner',transcribe:async()=>({blocked:true})}),{id}=await h.start();await h.runtime.tick(id);
 h.setVisible([message('old'),{...message('unread command'),kind:'voice'}]);await h.runtime.tick(id);await h.runtime.tick(id);
 assert.equal(h.decisions.length,0);assert(!Object.values(h.runtime.tasks.get(id).operations).some(op=>op.tool==='owner.dispatch'));assert.deepEqual(h.sent,[]);await h.runtime.close();
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
 assert.equal(result.value.ok,true);assert.equal(calls.length,2);assert.equal(calls[1].maxTokens,8192);assert.deepEqual(calls[1].messages,calls[0].messages);
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
 const decision={decision:'reply',reply:'I have your task and will run it.',summary:'accepted',completed:false,progress:{},unknown:[],ownerAction:{type:'task'},ownerCommand:{sequences:[1]}},event={key:'owner-task',type:'conversation.messages',subjectKey:subjectKey(subject),messages:[message('Run this actual task')]};
 const task={id:'owner-listener',parameters:{behavior:'reply'},subjects:[subject],scene:'life',completion:'manual',state:{},operations:{},schedule:{intervalSeconds:3,activeIntervalSeconds:3},inbox:[event],counters:{wakes:1}};
 const skill=conversationSkill({channelDialogue:true,canOperate:async()=>true,brain:{decide:async()=>decision}});assert(skill.capabilitiesFor(task).includes('owner.command'));
 let failAck=true,confirmed=false;
 const receipt={operationId:'ack-operation',submittedAt:Date.now(),sentText:decision.reply};
 const call=async action=>{if(action.tool==='conversation.observe')return {headerMatched:true,changed:false,messages:[],draft:''};if(action.tool==='conversation.send'){order.push('ack');if(failAck)throw Error('acknowledgment not delivered');confirmed=true;return {verified:true,receipt};}if(action.tool==='owner.dispatch'){assert(confirmed,'work cannot start before the owner receives acknowledgment');assert.equal(action.key,'owner:'+event.key);order.push('dispatch');return {ok:true,taskId:'new-task'};}throw Error('unexpected tool '+action.tool);};
 const context={task,event,clock:Date.now,now:Date.now(),signal:new AbortController().signal,checkpoint:async()=>{},report:async()=>{},call};
 await assert.rejects(skill.run(context),/not delivered/);assert.deepEqual(order,['ack']);
 failAck=false;await skill.run(context);assert.deepEqual(order,['ack','ack','dispatch']);
 order.length=0;await skill.run({...context,completedCall:(_key,tool)=>tool==='conversation.send'?{verified:true,receipt}:null});assert.deepEqual(order,['dispatch'],'a recovered acknowledgment proceeds through the existing dispatch ledger without sending it again');
});

test('an observed same-channel successor cancels planning and merges pending text and voice without accepting a late decision',async()=>{
 for(const behavior of ['reply','owner']){
  let release,entered;const at=new Promise(resolve=>entered=resolve);let count=0;
  const h=harness({behavior,channelDialogue:behavior==='owner',brain:args=>{
   if(++count===1){entered(args.signal);return new Promise(resolve=>release=resolve);}
   return {decision:'reply',reply:'combined '+args.incoming.map(m=>m.text).join('+'),summary:'combined',completed:false,progress:{},unknown:[]};
  }}),{id}=await h.start();await h.runtime.tick(id);h.incoming('first');await h.runtime.tick(id);
  const prior=h.runtime.tick(id),signal=await at,task=h.runtime.tasks.get(id),key=Object.keys(task.state.conversations)[0];
  h.incoming('second');const cursor=new ConversationCursor(task.state.conversations[key].cursor),delta=cursor.observe([message('old'),message('first'),message('second')]);
  assert((await h.runtime.enqueue(id,{key:'new-observed-event',type:'conversation.messages',subjectKey:key,ownerChannel:behavior==='owner',messages:delta.messages},
    {advance:target=>{target.state.conversations[key].cursor=cursor.snapshot();}})).ok);
  assert(signal.aborted);await prior;assert.equal(task.inbox.length,2);assert.equal(h.sent.length,0);
  await h.runtime.tick(id);assert.deepEqual(h.sent,['combined first+second']);assert.equal(task.inbox.length,0);
  assert.equal(h.decisions[1].incomingBatches.length,2);
  release({decision:'reply',reply:'obsolete',summary:'obsolete',completed:false,progress:{},unknown:[]});await Promise.resolve();await Promise.resolve();assert.deepEqual(h.sent,['combined first+second']);
  await h.runtime.close();
 }
});
