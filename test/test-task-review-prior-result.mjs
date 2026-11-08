import test from 'node:test';
import assert from 'node:assert/strict';
import presentation from '../src/main/task-presentation.js';
import {taskCard} from '../src/renderer/task-card.mjs';
import {taskActivity} from '../src/renderer/task-activity.mjs';
import {createTaskControls} from '../src/renderer/task-controls.mjs';
const {taskPresentation}=presentation;
function fixture(status='needs_attention'){
 return {id:'logical',skill:'work.delegate',goal:'fixture work',status,workJobId:'physical',state:{job:{jobId:'physical'},
  workCheckpoint:{phase:'draft-ready',submissionRound:1,submitAttempted:false,handoffSent:false,priorSubmission:{handoffSent:true},
   capabilities:{reviewPriorResult:{available:true,jobId:'physical',submissionRound:1,priorSubmissionRound:0}}}},operations:{}};
}
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.disabled=false;}
 get childElementCount(){return this.children.length;}
 append(...children){this.children.push(...children);}
 setAttribute(){}
 querySelector(){return null;}
}
const document={createElement:tag=>new Element(tag)};
function buttons(card){const result=new Map();const visit=node=>{if(node.tag==='button')result.set(node.dataset.operation,node);node.children.forEach(visit);};visit(card);return result;}
function publicTask(task){return {id:task.id,skill:task.skill,goal:task.goal,status:task.status,workJobId:task.workJobId,presentation:taskPresentation(task)};}
test('a verified capability supplies a secondary review request for both paused and attention tasks without claiming completion',()=>{
 for(const status of ['paused','needs_attention']){
  const task=fixture(status),before=structuredClone(task),view=taskPresentation(task);
  assert.equal(view.secondaryAction.operation,'reviewPriorResult');assert.equal(view.secondaryAction.label,'保留补充草稿，重新核验原成果');
  assert.match(view.secondaryAction.detail,/不会发送或清空编辑器/);assert.match(view.secondaryAction.detail,/是否完成由核验结果决定/);
  assert.equal(view.finished,false);if(status==='paused')assert.equal(view.statusLabel,'已暂停跟进');assert.deepEqual(task,before);
 }
});
test('unknown, dispatched, stopped, terminal or mismatched capabilities never expose this action',()=>{
 const changes=[
  t=>delete t.state.workCheckpoint.capabilities,
  t=>t.state.workCheckpoint.capabilities.reviewPriorResult.available=false,
  t=>t.state.workCheckpoint.capabilities.reviewPriorResult.jobId='other',
  t=>t.state.workCheckpoint.capabilities.reviewPriorResult.submissionRound=2,
  t=>t.state.workCheckpoint.capabilities.reviewPriorResult.priorSubmissionRound=1,
  t=>t.state.workCheckpoint.phase='input-unknown',
  t=>t.state.workCheckpoint.phase='submission-unknown',
  t=>t.state.workCheckpoint.submitAttempted=true,
  t=>t.state.workCheckpoint.handoffSent=true,
  t=>t.state.workCheckpoint.priorSubmission.handoffSent=false,
  t=>t.state.stopRequest={phase:'pending'},
  t=>t.stopRequest={phase:'confirmed'},
  ...['running','waiting','completed','stopped','expired','failed'].map(status=>t=>t.status=status)
 ];
 for(const change of changes){const task=fixture();change(task);assert.equal(taskPresentation(task).secondaryAction,undefined);}
});
test('legacy attention text never authorizes this action, but a refreshed host capability needs no new attention schema',()=>{
 const task=fixture();task.state.workAttention={code:'E_GUI_POINTER_BLOCKED',report:'legacy draft preserved'};
 delete task.state.workCheckpoint.capabilities;assert.equal(taskPresentation(task).secondaryAction,undefined);
 task.state.workCheckpoint.capabilities={reviewPriorResult:{available:true,jobId:'physical',submissionRound:1,priorSubmissionRound:0}};
 assert.equal(taskPresentation(task).secondaryAction.operation,'reviewPriorResult');
 delete task.state.workAttention;assert.equal(taskPresentation(task).secondaryAction.operation,'reviewPriorResult');
});
test('the shared card sends only the explicit review operation and keeps pause and stop available during its pending request',()=>{
 const calls=[],task=publicTask(fixture()),card=taskCard(task,{document,onAction:operation=>calls.push(operation)}),controls=buttons(card);
 assert.equal(controls.get('reviewPriorResult').disabled,false);controls.get('reviewPriorResult').onclick();assert.deepEqual(calls,['reviewPriorResult']);
 const pending=buttons(taskCard(task,{document,pending:true}));assert.equal(pending.get('reviewPriorResult').disabled,true);assert.equal(pending.get('pause').disabled,false);assert.equal(pending.get('stop').disabled,false);
 const paused=buttons(taskCard(publicTask(fixture('paused')),{document,pending:true}));assert.equal(paused.get('reviewPriorResult').disabled,true);assert.equal(paused.get('stop').disabled,false);
 assert.equal(buttons(taskCard(task,{document,external:true})).has('reviewPriorResult'),false);
 const unsupported={...task,presentation:{...task.presentation,secondaryAction:{operation:'arbitrary-operation',label:'untrusted'}}};
 assert.equal(buttons(taskCard(unsupported,{document})).has('arbitrary-operation'),false);
});
test('activity preserves the same capability on the logical card and hides duplicate executor rows',()=>{
 const task=publicTask(fixture()),rows=taskActivity({agent:{tasks:[task]},desktop:{task:{id:'physical',status:'paused',sources:['logical']}},
  work:{tasks:[{bunnyTaskId:'physical',sessionId:'bound',taskId:1,status:'ok',endedAt:1000}]},now:1500});
 assert.equal(rows.length,1);assert.equal(rows[0].ref.source,'agent');assert.equal(rows[0].terminal,false);
 const controls=buttons(taskCard(rows[0].record,{document,external:rows[0].ref.source!=='agent'}));assert(controls.has('reviewPriorResult'));
});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('the review request is deduplicated and its late acknowledgement cannot overtake stop',async()=>{
 const controls=createTaskControls(),review=deferred(),stop=deferred();let calls=0;
 const pending=controls.run('task','reviewPriorResult',()=>{calls++;return review.promise;});
 assert.equal(controls.run('task','reviewPriorResult',()=>assert.fail('duplicate review')),pending);assert.match(controls.messages.get('task'),/请求重新核验/);
 const stopped=controls.run('task','stop',()=>stop.promise);stop.resolve({ok:true,message:'explicit local stop'});await stopped;
 review.resolve({ok:true,message:'late review'});await pending;assert.equal(calls,1);assert.equal(controls.messages.get('task'),'explicit local stop');assert.equal(controls.pending.size,0);
});
test('a successful request acknowledgement reports no acceptance of the business result',async()=>{
 const controls=createTaskControls();await controls.run('task','reviewPriorResult',async()=>({ok:true}));
 assert.equal(controls.messages.get('task'),'本次原成果核验请求已结束，请查看任务当前状态。');
 await controls.run('task','reviewPriorResult',async()=>({ok:true,message:'原成果仍缺证据，补充草稿已保留'}));
 assert.equal(controls.messages.get('task'),'原成果仍缺证据，补充草稿已保留');
});
