'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRecallSession,FIND,READ,recallFragment}=require('../src/main/conversation-recall');
const {createContextSession,CONTEXT_TOOL}=require('../src/main/context-assembler');
const {encodeTaskContext,taskContextEvidence,mergeTaskContextEvidence,ownerContext}=require('../src/main/work-order');
function fixture(){
 const row={id:'owner-source',kind:'message',state:'active',ts:1,domain:'work',visibilityFloor:0,value:{role:'user',characterId:'owner',content:'已展示的原文。'.repeat(1800)+'UNPRESENTED_ROW_TAIL',sources:[]}};
 const memory={ready:true,generation:1,sceneEpoch:1,getSettings:()=>({enabled:true}),clock:()=>10,decode:r=>r,db:{request:async()=>({rows:[row]})},recall:async()=>[row],knowledge:{projectMemories:async rows=>rows,applyResolutions:async()=>({facts:[]})}};
 return {memory,row};
}
test('recall exports only bounded successful outputs and clones them without rereading originals',async()=>{
 const {memory}=fixture();let live=true,reads=0;const original=memory.db.request;memory.db.request=async(...args)=>{reads++;return original(...args);};
 const session=createRecallSession(memory,{scene:'life',isCurrent:()=>live}),found=await session.run(FIND,{query:'原文'}),read=await session.run(READ,{id:'owner-source'}),before=reads;
 const handoff=session.handoff();assert.equal(reads,before);assert.deepEqual(handoff.entries,[{tool:FIND,result:found},{tool:READ,result:read}]);assert.deepEqual(handoff.sourceIds,['owner-source']);
 assert(!JSON.stringify(handoff).includes('UNPRESENTED_ROW_TAIL'));handoff.entries[1].result.content='changed';assert.equal(session.handoff().entries[1].result.content,read.content);
 await session.run(READ,{id:'owner-source',offset:2200});await session.run(READ,{id:'owner-source',offset:4400});await session.run(READ,{id:'owner-source',offset:6600});assert.equal(session.handoff().entries.length,4);
 live=false;assert.throws(()=>session.handoff(),{code:'E_ABORTED'});
});
test('context exports only admitted bounded module values and never infers source IDs from task state',async()=>{
 let loads=0,live=true;const session=createContextSession({isCurrent:()=>live,fragments:[{id:'task_status',parameters:{maxTokens:500},load:async()=>{loads++;return [{id:'ordinary-task-id',status:'waiting',goal:'已呈现任务状态'}];}}]});
 const result=await session.run(CONTEXT_TOOL,{modules:[{id:'task_status'}]},{admit:()=>{}}),before=loads;
 assert.deepEqual(session.handoff().modules,result.modules);assert.deepEqual(session.handoff().sourceIds,[]);assert.equal(loads,before);
 const copy=session.handoff();copy.modules.task_status[0].goal='changed';assert.notEqual(session.handoff().modules.task_status[0].goal,'changed');
 await assert.rejects(session.run(CONTEXT_TOOL,{modules:[{id:'task_status',refresh:true}]},{admit:()=>{throw Error('not admitted');}}));assert.deepEqual(session.handoff().modules,result.modules);
 live=false;assert.throws(()=>session.handoff(),{code:'E_ABORTED'});
});
test('recall used by a context module exports the actually presented module rather than hidden search hits',async()=>{
 const {memory}=fixture(),recall=createRecallSession(memory,{scene:'life'}),context=createContextSession({fragments:[recallFragment(recall)]});
 const result=await context.run(CONTEXT_TOOL,{modules:[{id:'memory_search',query:'原文',limit:1}]});
 assert.deepEqual(recall.handoff().entries,[]);assert.deepEqual(context.handoff().modules,result.modules);assert(!JSON.stringify(context.handoff()).includes('UNPRESENTED_ROW_TAIL'));
});
test('fixed dynamic fields survive private task handoff and merging with only host-bound explicit sources',()=>{
 const recall={entries:[{tool:READ,result:{content:'实际呈现的历史授权原话'}}],sourceIds:['owner-source']},context={modules:{task_status:[{id:'ordinary-task-id',goal:'actual state'}]},sourceIds:[]};
 const encoded=encodeTaskContext({messages:[],text:'',sourceIds:[],dynamic:{recall,context}}),evidence=taskContextEvidence(encoded,{sourceIds:['owner-source']});
 assert.deepEqual(evidence.sourceIds,['owner-source']);assert.deepEqual(evidence.dynamic.recall.entries,recall.entries);assert.deepEqual(evidence.dynamic.context.modules,context.modules);
 assert(!evidence.sourceIds.includes('ordinary-task-id'));assert.equal(ownerContext(evidence),'');
 assert.throws(()=>taskContextEvidence(encoded,{sourceIds:[]}),/宿主来源绑定/);
 const merged=mergeTaskContextEvidence(evidence,evidence);assert.equal(merged.dynamic.recall.entries.length,1);assert.deepEqual(merged.dynamic.context.modules,context.modules);
});
